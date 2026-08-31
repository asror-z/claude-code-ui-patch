/*
 * MultiSelect — a checkbox on every assistant OUTPUT message's CopyButtons row (.cc-copy-group), plus a toolbar "Copy selected" action that copies the combined Markdown or HTML of every checked message to the clipboard in one shot.
 * Depends on CopyButtons (behaviorFeatures.copybuttons.ts) for both the row it docks into and the markdownOf()/htmlOf() extraction it reuses via window.__ccCopyButtons (exposed for exactly this purpose) — mirrors how ForkInCopy already docks into the same row.
 */
import { registerFeature } from "./behaviorFeatures";

const JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-multiselect] Chat MultiSelect Feature.js loaded");
  } catch (e) {}

  var GROUP_CLASS = "cc-copy-group"; // CopyButtons' own row — we dock a checkbox into it
  var CHK_MARK_ATTR = "data-cc-multiselect-chk"; // marks OUR checkbox inside the group
  var TIME_ATTR = "data-cc-dt-time"; // DateTime's per-message stamp anchor (CopyButtons' own anchor too)
  var EXCLUDE_RE = /messageInput|messagesContainer|messageGradient|fullEditor|stickyHeader/i;

  var D = document;
  var W = window;

  // Selected message elements, tracked by identity (a live Set survives
  // React re-renders of unrelated siblings; a stale/removed element is
  // pruned lazily whenever the selection is read).
  var selected = (typeof Set !== "undefined") ? new Set() : null;
  var selectedFallback = []; // used only if Set is somehow unavailable

  function addSel(el) {
    if (selected) selected.add(el);
    else if (selectedFallback.indexOf(el) === -1) selectedFallback.push(el);
  }
  function removeSel(el) {
    if (selected) selected.delete(el);
    else {
      var i = selectedFallback.indexOf(el);
      if (i !== -1) selectedFallback.splice(i, 1);
    }
  }
  function hasSel(el) {
    return selected ? selected.has(el) : selectedFallback.indexOf(el) !== -1;
  }
  function selList() {
    var all = selected ? Array.from(selected) : selectedFallback.slice();
    // prune anything no longer attached to the live document
    all = all.filter(function (el) { return el && D.body && D.body.contains(el); });
    // document order
    all.sort(function (a, b) {
      try { return (a.compareDocumentPosition(b) & 4) !== 0 ? -1 : 1; } catch (e) { return 0; }
    });
    return all;
  }
  function selCount() { return selList().length; }
  function clearSel() {
    var all = selected ? Array.from(selected) : selectedFallback.slice();
    if (selected) selected.clear(); else selectedFallback.length = 0;
    for (var i = 0; i < all.length; i++) {
      var chk = all[i].querySelector ? all[i].querySelector("[" + CHK_MARK_ATTR + "]") : null;
      if (chk) chk.checked = false;
    }
    updateToolbarLabel();
  }

  function isUserMessage(el) {
    var cn = (el.getAttribute && el.getAttribute("class")) || "";
    if (/userMessage/i.test(cn)) return true;
    try {
      var anc = el.closest && el.closest('[class*="userMessage"]');
      if (anc && anc !== el) return true;
    } catch (e) {}
    return false;
  }
  function isExcluded(el) {
    var cn = (el.getAttribute && el.getAttribute("class")) || "";
    return EXCLUDE_RE.test(cn);
  }
  function stampedOutputMessages() {
    var nodes = D.querySelectorAll ? D.querySelectorAll("[" + TIME_ATTR + "]") : [];
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      if (isExcluded(nodes[i]) || isUserMessage(nodes[i])) continue;
      out.push(nodes[i]);
    }
    return out;
  }

  function makeCheckbox(outputEl) {
    var chk = D.createElement("input");
    chk.type = "checkbox";
    chk.className = "cc-multiselect-chk";
    chk.setAttribute(CHK_MARK_ATTR, "1");
    chk.setAttribute("aria-label", "Select this reply for batch copy");
    chk.setAttribute("title", "Select this reply for batch copy");
    chk.checked = hasSel(outputEl);
    chk.addEventListener("mousedown", function (e) { try { e.stopPropagation(); } catch (x) {} });
    chk.addEventListener("click", function (e) { try { e.stopPropagation(); } catch (x) {} });
    chk.addEventListener("change", function () {
      if (chk.checked) addSel(outputEl); else removeSel(outputEl);
      updateToolbarLabel();
    });
    return chk;
  }

  function ensureCheckbox(outputEl) {
    var group = outputEl.querySelector ? outputEl.querySelector(":scope > ." + GROUP_CLASS) : null;
    if (!group) return; // CopyButtons hasn't attached its row here (yet)
    var existing = group.querySelector ? group.querySelector("[" + CHK_MARK_ATTR + "]") : null;
    if (existing) {
      // Keep the checked state in sync with our selection Set (React can
      // re-render the group and drop our checkbox's live checked property).
      existing.checked = hasSel(outputEl);
      return;
    }
    // FIRST child of the group — to the left of the time label — so it reads
    // as "select, then time, then copy actions" left-to-right.
    group.insertBefore(makeCheckbox(outputEl), group.firstChild);
  }

  function run() {
    var msgs = stampedOutputMessages();
    for (var i = 0; i < msgs.length; i++) ensureCheckbox(msgs[i]);
  }

  // --- batch copy --------------------------------------------------------
  function toClipboard(text) {
    try {
      if (W.navigator && W.navigator.clipboard && W.navigator.clipboard.writeText) {
        W.navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {}
    try {
      var ta = D.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      ta.style.pointerEvents = "none";
      D.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { D.execCommand("copy"); } catch (e) {}
      D.body.removeChild(ta);
      return true;
    } catch (e) { return false; }
  }

  function toast(msg) {
    try {
      var t = D.createElement("div");
      t.textContent = msg;
      t.className = "cc-multiselect-toast";
      D.body.appendChild(t);
      W.setTimeout(function () { try { t.remove(); } catch (e) {} }, 2400);
    } catch (e) {}
  }

  // Reuses CopyButtons' own markdownOf()/htmlOf() extraction (exposed on
  // window.__ccCopyButtons) rather than re-deriving DOM->text logic here —
  // both features must always agree on what a message's "content" is.
  function copySelected(format) {
    var msgs = selList();
    if (!msgs.length) { toast("No replies selected"); return; }
    var api = W.__ccCopyButtons;
    if (!api || typeof api.markdownOf !== "function" || typeof api.htmlOf !== "function") {
      toast("Copy unavailable — CopyButtons feature is off");
      return;
    }
    var parts = [];
    for (var i = 0; i < msgs.length; i++) {
      var piece = format === "html" ? api.htmlOf(msgs[i]) : api.markdownOf(msgs[i]);
      if (piece && piece.trim()) parts.push(piece.trim());
    }
    if (!parts.length) { toast("Nothing to copy"); return; }
    var text = format === "html"
      ? "<html>\\n<body>\\n" + parts.join("\\n<hr>\\n") + "\\n</body>\\n</html>"
      : parts.join("\\n\\n---\\n\\n");
    var ok = toClipboard(text);
    try {
      console.info("[cc-multiselect] copied", { format: format, count: parts.length, bytes: text.length, ok: ok });
    } catch (e) {}
    toast(ok ? ("Copied " + parts.length + " repl" + (parts.length === 1 ? "y" : "ies") + " as " + format.toUpperCase()) : "Copy failed");
  }

  // --- toolbar action ------------------------------------------------------
  var toolbarBtn = null;
  function updateToolbarLabel() {
    if (!toolbarBtn) toolbarBtn = (W.__ccToolbar && W.__ccToolbar.get) ? W.__ccToolbar.get("multiselect") : null;
    if (!toolbarBtn) return;
    var n = selCount();
    toolbarBtn.textContent = n > 0 ? ("\\u2611" + n) : "\\u2610";
    toolbarBtn.setAttribute(
      "title",
      n > 0
        ? ("Copy " + n + " selected repl" + (n === 1 ? "y" : "ies") + " (click: Markdown, shift-click: HTML)")
        : "Select replies (checkbox on each Copy row) to batch-copy them"
    );
  }

  function ensureToolbar() {
    var spec = {
      id: "multiselect",
      icon: "\\u2610",
      label: "Select replies (checkbox on each Copy row) to batch-copy them",
      order: 31, // right after Export (30), before Scroll (40/41)
      onClick: function (ev) {
        var n = selCount();
        if (n === 0) { toast("Check a reply's box first, then click here to copy"); return; }
        var isShift = !!(ev && ev.shiftKey);
        copySelected(isShift ? "html" : "markdown");
      },
    };
    if (W.__ccToolbar && W.__ccToolbar.add) {
      toolbarBtn = W.__ccToolbar.add(spec);
    } else {
      (W.__ccToolbarQueue = W.__ccToolbarQueue || []).push(spec);
    }
    updateToolbarLabel();
  }

  function init(doc, win) {
    D = doc;
    W = win || window;
    try { ensureToolbar(); } catch (e) {}
    try { run(); } catch (e) {}
    try {
      if (W.__ccObserve) {
        W.__ccObserve(D.body, run, { ownClass: "cc-multiselect-chk", ownAttrPrefix: "data-cc-multiselect" });
      } else {
        new W.MutationObserver(run).observe(D.body, { childList: true, subtree: true });
      }
    } catch (e) {}
    try {
      W.__ccMultiSelect = { selectedCount: selCount, clear: clearSel, copySelected: copySelected };
    } catch (e) {}
  }

  register(init);

  function register(fn) {
    if (window.__ccOnChatDoc) { window.__ccOnChatDoc(fn); return; }
    (window.__ccPending = window.__ccPending || []).push(fn);
    var tries = 0;
    var t = setInterval(function () {
      if (window.__ccOnChatDoc) { clearInterval(t); return; }
      if (++tries >= 25) {
        clearInterval(t);
        try { fn(document, window); } catch (e) {}
      }
    }, 200);
  }
})();
`.trim();

const CSS = `
/* MultiSelect — a checkbox docked as the FIRST child of CopyButtons' own
   .cc-copy-group row, plus a toolbar "N selected" action (styled by the
   shared .cc-toolbar-btn rules; no extra CSS needed for the toolbar chip). */
.cc-multiselect-chk {
  width: 13px;
  height: 13px;
  margin: 0 4px 0 0;
  cursor: pointer;
  accent-color: var(--vscode-textLink-foreground, #4ea1ff);
  vertical-align: middle;
}

.cc-multiselect-toast {
  position: fixed;
  right: 16px;
  bottom: 96px;
  z-index: 2147483000;
  max-width: 360px;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 12px;
  background: var(--cc-surface, #252526);
  color: var(--cc-fg, #ddd);
  border: 1px solid var(--cc-border, rgba(128, 128, 128, 0.4));
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
}
`.trim();

registerFeature({
  id: "multiselect",
  label: "Multi-select replies + batch copy (Markdown/HTML)",
  js: JS,
  css: CSS,
});
