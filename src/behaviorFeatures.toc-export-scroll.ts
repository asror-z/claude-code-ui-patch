// Ported from the smarts-claude-patch skill's standalone asset pairs:
//   "Chat Toc Feature.js" / "Chat Toc Feature.css"
//   "Chat Export Feature.js" / "Chat Export Feature.css"
//   "Chat Scroll Feature.js" / "Chat Scroll Feature.css"
// into this extension's inline-injection convention (see behaviorFeatures.ts).
//
// Three independent, unrelated toolbar-consumer features are registered from this
// one file (no cross-dependency between them): "toc" (outline/prompt-jump panel),
// "export" (copy chat as Markdown/HTML), and "scroll" (jump to first/latest message).
//
// Unlike the source skill's target (which runs inside a nested `active-frame`
// iframe and needs frame-hunting/frame-swap polling), this extension's webview has
// NO nested iframe — `document` IS the chat document — so all frame-search logic
// from the originals is dropped; window.__ccOnChatDoc(init) calls init(document,
// window) directly. Faro/telemetry calls are dropped too (replaced with plain
// console logging) since this build has no Faro wiring.
import { registerFeature } from "./behaviorFeatures";

// ---------------------------------------------------------------------------
// TOC (outline / prompt-jump panel)
// ---------------------------------------------------------------------------
const TOC_JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-toc] Chat Toc Feature loaded");
  } catch (e) {}

  var D = document;
  var W = window;

  // Same user-message selectors as UserStyle — keep them in sync.
  var USER_SELECTORS = [
    "[data-role='user']",
    "[data-message-author-role='user']",
    "[data-author='user']",
    "[data-testid*='user-message']",
    "[data-testid*='user_message']",
    "[class*='userMessage']",
    "[class*='UserMessage']",
    "[class*='user-message']",
    "[class*='message-user']",
    "[class*='userMessageContainer']",
  ];

  function findUserMessages() {
    var set = new Set();
    for (var i = 0; i < USER_SELECTORS.length; i++) {
      var nodes = D.querySelectorAll(USER_SELECTORS[i]);
      for (var j = 0; j < nodes.length; j++) set.add(nodes[j]);
    }
    var list = Array.from(set);
    // outermost-only (a bubble counted once)
    list = list.filter(function (el) {
      var p = el.parentElement;
      while (p) { if (set.has(p)) return false; p = p.parentElement; }
      return true;
    });
    // document order
    list.sort(function (a, b) {
      var pos = a.compareDocumentPosition(b);
      if (pos & 4) return -1; // a before b
      if (pos & 2) return 1;
      return 0;
    });
    return list;
  }

  function labelFor(el, i) {
    var t = (el.textContent || "").replace(/\\s+/g, " ").trim();
    if (t.length > 80) t = t.slice(0, 80) + "…";
    if (!t) t = "(empty prompt)";
    return (i + 1) + ". " + t;
  }

  function flash(el) {
    try {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (e) { try { el.scrollIntoView(); } catch (e2) {} }
    el.classList.add("cc-toc-flash");
    W.setTimeout(function () { el.classList.remove("cc-toc-flash"); }, 1100);
  }

  var toggleBtn = null;
  var panel = null;
  var listEl = null;
  var open = false;

  function ensureUI() {
    // Re-check the live DOM (React can strip appended nodes, and a fresh module
    // scope after a re-eval starts with null refs). Adopt an existing element if
    // one is already in the document so we never create a duplicate.
    if (toggleBtn && !D.body.contains(toggleBtn)) toggleBtn = null;
    if (panel && !D.body.contains(panel)) { panel = null; listEl = null; open = false; }
    if (!toggleBtn) toggleBtn = D.querySelector(".cc-toc-toggle");
    if (!panel) {
      panel = D.querySelector(".cc-toc-panel");
      if (panel) listEl = panel.querySelector(".cc-toc-list");
    }

    // ALWAYS destroy any standalone fixed fallback FAB — the toolbar is the ONLY home
    // for the Toc toggle. A leftover .cc-toc-toggle that is NOT a toolbar chip (from an
    // earlier frame / a view without the composer) is the stray floating ☰; nuke every
    // one, unconditionally.
    var strays = D.querySelectorAll(".cc-toc-toggle:not(.cc-toolbar-btn)");
    for (var sI = 0; sI < strays.length; sI++) { try { strays[sI].remove(); } catch (e) {} }
    if (toggleBtn && !toggleBtn.classList.contains("cc-toolbar-btn")) toggleBtn = null;
    if (!toggleBtn) toggleBtn = D.querySelector(".cc-toc-toggle.cc-toolbar-btn");

    if (!toggleBtn) {
      // Register into the shared toolbar. If it isn't parsed yet, queue and wait —
      // do NOT create a floating fallback (that is what caused the stray ☰).
      if (W.__ccToolbar && W.__ccToolbar.add) {
        toggleBtn = W.__ccToolbar.add({
          id: "toc", icon: "☰", label: "Chat outline — jump to a prompt",
          order: 20, onClick: function () { toggle(); },
        });
        if (toggleBtn && !toggleBtn.classList.contains("cc-toc-toggle")) toggleBtn.classList.add("cc-toc-toggle");
      } else {
        (W.__ccToolbarQueue = W.__ccToolbarQueue || []).push({
          id: "toc", icon: "☰", label: "Chat outline — jump to a prompt",
          order: 20, onClick: function () { toggle(); },
        });
      }
    }
    if (!panel) {
      panel = D.createElement("div");
      panel.className = "cc-toc-panel";
      panel.style.display = "none";
      var head = D.createElement("div");
      head.className = "cc-toc-head";
      var title = D.createElement("span");
      title.textContent = "Outline";
      head.appendChild(title);
      var actions = D.createElement("span");
      actions.className = "cc-toc-actions";
      // Assistant-headings toggle.
      var hbtn = D.createElement("button");
      hbtn.type = "button";
      hbtn.className = "cc-toc-headings-toggle";
      hbtn.textContent = "H";
      hbtn.setAttribute("aria-pressed", "false");
      hbtn.setAttribute("aria-label", "Toggle assistant headings");
      hbtn.setAttribute("title", "Toggle assistant headings in the outline");
      hbtn.addEventListener("click", function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        showHeadings = !showHeadings;
        hbtn.setAttribute("aria-pressed", showHeadings ? "true" : "false");
        hbtn.classList.toggle("cc-active", showHeadings);
        rebuild();
      });
      var close = D.createElement("button");
      close.type = "button";
      close.className = "cc-toc-close";
      close.textContent = "×";
      close.setAttribute("aria-label", "Close outline");
      close.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        setOpen(false);
      });
      actions.appendChild(hbtn);
      actions.appendChild(close);
      head.appendChild(actions);
      listEl = D.createElement("div");
      listEl.className = "cc-toc-list";
      panel.appendChild(head);
      panel.appendChild(listEl);
      D.body.appendChild(panel);
    }
  }

  function makeItem(text, el, cls) {
    var item = D.createElement("button");
    item.type = "button";
    item.className = "cc-toc-item" + (cls ? " " + cls : "");
    item.textContent = text;
    item.addEventListener("click", function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      flash(el); setOpen(false);
    });
    return item;
  }
  function makeGroupLabel(text) {
    var g = D.createElement("div");
    g.className = "cc-toc-group";
    g.textContent = text;
    return g;
  }

  // Assistant headings (##/### rendered as <h2>/<h3> inside assistant messages),
  // shown only when \`showHeadings\` is on (toggled from the panel header).
  var showHeadings = false;
  function findHeadings() {
    var out = [];
    var hs = D.querySelectorAll("[class*='markdown'] h2, [class*='markdown'] h3, [class*='prose'] h2, [class*='prose'] h3");
    for (var i = 0; i < hs.length; i++) {
      var t = (hs[i].textContent || "").replace(/\\s+/g, " ").trim();
      if (t) out.push({ el: hs[i], label: (hs[i].tagName === "H3" ? "  " : "") + t });
    }
    return out;
  }

  function rebuild() {
    if (!listEl) return;
    listEl.textContent = "";
    var any = false;

    // 1) Pinned messages (from the Pin feature), if any.
    var pins = (W.__ccPins && W.__ccPins.list) ? W.__ccPins.list() : [];
    if (pins.length) {
      listEl.appendChild(makeGroupLabel("Pinned"));
      for (var p = 0; p < pins.length; p++) {
        listEl.appendChild(makeItem("★ " + pins[p].label, pins[p].el, "cc-toc-pinned"));
      }
      any = true;
    }

    // 2) User prompts.
    var msgs = findUserMessages();
    if (msgs.length) {
      if (pins.length) listEl.appendChild(makeGroupLabel("Prompts"));
      for (var i = 0; i < msgs.length; i++) {
        listEl.appendChild(makeItem(labelFor(msgs[i], i), msgs[i]));
      }
      any = true;
    }

    // 3) Assistant headings (optional).
    if (showHeadings) {
      var heads = findHeadings();
      if (heads.length) {
        listEl.appendChild(makeGroupLabel("Headings"));
        for (var h = 0; h < heads.length; h++) {
          listEl.appendChild(makeItem(heads[h].label, heads[h].el, "cc-toc-heading"));
        }
        any = true;
      }
    }

    if (!any) {
      var empty = D.createElement("div");
      empty.className = "cc-toc-empty";
      empty.textContent = "No prompts yet";
      listEl.appendChild(empty);
    }
  }

  // The panel is position:fixed, so its "right" offset is measured from the
  // WHOLE CSS viewport — which, in this webview, can be noticeably WIDER
  // than the composer's own visually-bordered box (confirmed live via a
  // screenshot: a plain "right:16px" left the panel floating well past the
  // composer's right edge, out in open space). Align the panel's right edge
  // to the composer's OWN right edge instead of a flat viewport-relative
  // offset: the composer's action-footer row (".cc-toolbar" itself docks
  // into it, see behaviorToolbar.ts) spans the composer box corner to
  // corner, so its own getBoundingClientRect().right IS the composer's
  // right edge.
  function positionPanel() {
    if (!panel) return;
    var footer = D.querySelector("[class*='inputFooter']");
    if (!footer || !footer.getBoundingClientRect) return;
    var rect;
    try { rect = footer.getBoundingClientRect(); } catch (e) { return; }
    var viewportWidth = W.innerWidth || (D.documentElement && D.documentElement.clientWidth) || 0;
    if (!viewportWidth) return;
    var right = Math.max(0, viewportWidth - rect.right);
    panel.style.right = right + "px";
  }

  function setOpen(v) {
    open = v;
    if (!panel) return;
    if (v) positionPanel();
    panel.style.display = v ? "flex" : "none";
    if (toggleBtn) {
      toggleBtn.classList.toggle("cc-toc-active", v);
      toggleBtn.setAttribute("aria-expanded", v ? "true" : "false");
    }
    if (v) rebuild();
  }
  function toggle() { setOpen(!open); }

  var _bound = false;
  function bindGlobal() {
    if (_bound) return;
    _bound = true;
    // Escape closes; outside click closes.
    D.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && open) { setOpen(false); }
    });
    D.addEventListener("click", function (ev) {
      if (!open) return;
      if (panel && panel.contains(ev.target)) return;
      if (toggleBtn && toggleBtn.contains(ev.target)) return;
      setOpen(false);
    });
    // Rebuild the outline when pins change (from the Pin feature) while open.
    try { W.addEventListener("cc-pins-changed", function () { if (open) rebuild(); }); } catch (e) {}
    // Keep the panel's right edge pinned to the composer's own right edge if
    // the window/panel is resized while open.
    try { W.addEventListener("resize", function () { if (open) positionPanel(); }); } catch (e) {}
  }

  function run() {
    ensureUI();
    if (open) rebuild();
  }

  // Is a node our own UI (the panel/toggle)? Mutations confined to it must NOT
  // reschedule — rebuild() appends list items, which would otherwise loop the
  // observer forever (self-triggered childList churn).
  function isOwnUI(node) {
    var el = node && node.nodeType === 1 ? node : (node && node.parentElement);
    while (el) {
      if (el === panel || el === toggleBtn) return true;
      if (el.classList && (el.classList.contains("cc-toc-panel") || el.classList.contains("cc-toc-toggle"))) return true;
      el = el.parentElement;
    }
    return false;
  }

  var pending = null;
  function schedule(mutations) {
    // Ignore batches whose every mutation is inside our own UI (self-churn).
    if (mutations && mutations.length) {
      var external = false;
      for (var i = 0; i < mutations.length; i++) {
        if (!isOwnUI(mutations[i].target)) { external = true; break; }
      }
      if (!external) return;
    }
    if (pending) return;
    pending = W.setTimeout(function () {
      pending = null;
      try { run(); } catch (e) {}
    }, 200);
  }

  function init(doc, win) {
    D = doc;
    W = win || window;
    _bound = false;
    toggleBtn = null;
    panel = null;
    listEl = null;
    open = false;
    try { run(); bindGlobal(); } catch (e) {}
    try {
      var obs = new W.MutationObserver(schedule);
      obs.observe(D.body, { childList: true, subtree: true });
      try { W.__ccTocObs = obs; } catch (e) {}
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

const TOC_CSS = `
/* Chat TOC / Outline feature — a toolbar action + a prompt-list panel.
   The ☰ toggle normally lives INSIDE the shared toolbar (.cc-toolbar-btn); the
   rules below only style the STANDALONE fallback FAB (when the toolbar is absent),
   scoped with :not(.cc-toolbar-btn) so they never re-position the in-toolbar chip. */

.cc-toc-toggle:not(.cc-toolbar-btn) {
  position: fixed;
  right: 16px;
  bottom: 84px;
  z-index: 2147483000;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  border: 1px solid var(--cc-border, rgba(128, 128, 128, 0.35));
  background: var(--cc-surface-2, rgba(60, 60, 60, 0.9));
  color: var(--cc-fg, #ddd);
  box-shadow: var(--cc-shadow-sm, 0 2px 8px rgba(0, 0, 0, 0.35));
  opacity: 0.75;
  transition: opacity 0.12s ease, background 0.12s ease;
}
.cc-toc-toggle:not(.cc-toolbar-btn):hover,
.cc-toc-toggle.cc-toc-active:not(.cc-toolbar-btn) {
  opacity: 1;
  background: var(--cc-accent, #0e639c);
  color: var(--cc-accent-fg, #fff);
}

.cc-toc-panel {
  position: fixed;
  right: 16px;
  /* open ABOVE the toolbar pill row (toolbar is at bottom:84px, ~26px tall) */
  bottom: 116px;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  width: 320px;
  max-width: 80vw;
  max-height: 60vh;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.4));
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background, #252526));
  color: var(--vscode-foreground, #ddd);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
}

.cc-toc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  font-weight: 600;
  font-size: 12px;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
  background: var(--vscode-sideBarSectionHeader-background, rgba(128, 128, 128, 0.08));
}
.cc-toc-close {
  border: none;
  background: transparent;
  color: inherit;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  opacity: 0.7;
  padding: 0 2px;
}
.cc-toc-close:hover { opacity: 1; }

.cc-toc-list {
  overflow-y: auto;
  padding: 4px;
}
.cc-toc-item {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  color: inherit;
  font-size: 12px;
  line-height: 1.4;
  padding: 7px 9px;
  border-radius: 6px;
  cursor: pointer;
  white-space: normal;
  word-break: break-word;
}
.cc-toc-item:hover {
  background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.18));
}
.cc-toc-empty {
  padding: 12px;
  font-size: 12px;
  opacity: 0.6;
  text-align: center;
}

/* The flash applied to a jumped-to prompt. */
.cc-toc-flash {
  animation: ccTocFlash 1.1s ease;
  border-radius: 8px;
}
@keyframes ccTocFlash {
  0%, 100% { box-shadow: 0 0 0 0 rgba(14, 99, 156, 0); }
  25% { box-shadow: 0 0 0 3px var(--vscode-focusBorder, #0e639c); }
}
@media (prefers-reduced-motion: reduce) {
  .cc-toc-flash { animation: none; outline: 2px solid var(--vscode-focusBorder, #0e639c); }
}

/* v2.9 additions: header actions, group labels, pinned/heading rows. */
.cc-toc-head { gap: 8px; }
.cc-toc-actions { display: inline-flex; align-items: center; gap: 4px; }
.cc-toc-headings-toggle {
  border: 1px solid var(--cc-border, rgba(128,128,128,0.35));
  background: transparent;
  color: inherit;
  font-size: 11px;
  width: 20px; height: 20px;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.7;
}
.cc-toc-headings-toggle:hover,
.cc-toc-headings-toggle.cc-active { opacity: 1; background: var(--cc-accent, #0e639c); color: var(--cc-accent-fg, #fff); }
.cc-toc-group {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.5;
  padding: 8px 9px 2px;
}
.cc-toc-item.cc-toc-heading { padding-left: 18px; opacity: 0.85; }
.cc-toc-item.cc-toc-pinned { color: var(--cc-accent-2, #4daafc); }
`.trim();

registerFeature({ id: "toc", label: "Outline (Toc) — jump to a prompt", js: TOC_JS, css: TOC_CSS });

// ---------------------------------------------------------------------------
// EXPORT (copy chat as Markdown / HTML)
// ---------------------------------------------------------------------------
const EXPORT_JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-export] Chat Export Feature loaded");
  } catch (e) {}

  var D = document;
  var W = window;

  var USER_SELECTORS = [
    "[data-role='user']",
    "[data-message-author-role='user']",
    "[data-author='user']",
    "[data-testid*='user-message']",
    "[data-testid*='user_message']",
    "[class*='userMessage']",
    "[class*='UserMessage']",
    "[class*='user-message']",
    "[class*='message-user']",
    "[class*='userMessageContainer']",
  ];
  var MSG_SELECTORS = USER_SELECTORS.concat([
    "[class*='timelineMessage']",
    "[class*='assistantMessage']",
    "[class*='AssistantMessage']",
    "[class*='messageContainer']",
    "[class*='chatMessage']",
  ]);
  var EXCLUDE_RE = /messageInput|messagesContainer|messageGradient|fullEditor/;
  // Tool-chip containers whose collapsed bodies show only a summary label, never
  // prose — stripped from the export (version-proof substring set, like CopyButtons).
  var TOOL_SELECTOR = [
    "toolUse", "toolResult", "toolBody", "toolSummary", "toolItem",
    "toolName", "collapsibleToolCalls",
  ];

  function isUser(el) {
    for (var i = 0; i < USER_SELECTORS.length; i++) {
      try { if (el.matches && el.matches(USER_SELECTORS[i])) return true; } catch (e) {}
    }
    return false;
  }
  function isExcluded(el) {
    var cn = (el.getAttribute && el.getAttribute("class")) || "";
    return EXCLUDE_RE.test(cn);
  }
  function isInToolBlock(el) {
    var p = el;
    while (p) {
      var cn = (p.getAttribute && p.getAttribute("class")) || "";
      for (var i = 0; i < TOOL_SELECTOR.length; i++) {
        if (cn.indexOf(TOOL_SELECTOR[i]) !== -1) return true;
      }
      p = p.parentElement;
    }
    return false;
  }

  function messages() {
    var set = new Set();
    for (var i = 0; i < MSG_SELECTORS.length; i++) {
      var nodes = D.querySelectorAll(MSG_SELECTORS[i]);
      for (var j = 0; j < nodes.length; j++) set.add(nodes[j]);
    }
    var list = Array.from(set).filter(function (el) { return !isExcluded(el); });
    // outermost-only
    list = list.filter(function (el) {
      var p = el.parentElement;
      while (p) { if (set.has(p)) return false; p = p.parentElement; }
      return true;
    });
    list.sort(function (a, b) {
      var pos = a.compareDocumentPosition(b);
      if (pos & 4) return -1;
      if (pos & 2) return 1;
      return 0;
    });
    return list;
  }

  // The prose/content root of a message: prefer a markdown/prose/messageContent
  // container that is NOT a tool block; else the message itself.
  function contentRoot(el) {
    var cands = el.querySelectorAll("[class*='markdown'],[class*='prose'],[class*='messageContent']");
    for (var i = 0; i < cands.length; i++) {
      if (!isInToolBlock(cands[i])) return cands[i];
    }
    return el;
  }

  // Clone the content root, strip our own injected UI + every tool block, return
  // the cleaned clone (so exports carry only prose/code, never tool summaries or
  // our buttons).
  function cleanClone(root) {
    var clone = root.cloneNode(true);
    var junk = clone.querySelectorAll(
      ".cc-copy-group,.cc-code-bar,.cc-collapse-btn,.cc-toc-toggle,.cc-toc-panel,.cc-export-toggle,.cc-export-menu"
    );
    for (var i = 0; i < junk.length; i++) junk[i].remove();
    // strip tool blocks by class substring
    var all = clone.querySelectorAll("*");
    for (var k = 0; k < all.length; k++) {
      var cn = all[k].getAttribute("class") || "";
      for (var t = 0; t < TOOL_SELECTOR.length; t++) {
        if (cn.indexOf(TOOL_SELECTOR[t]) !== -1) { all[k].remove(); break; }
      }
    }
    return clone;
  }

  // --- dependency-free DOM -> Markdown walk (mirrors CopyButtons) -------------
  function mdOf(node) {
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1) return "";
    var tag = node.tagName.toLowerCase();
    var inner = childrenMd(node);
    switch (tag) {
      case "h1": return "\\n# " + inner + "\\n\\n";
      case "h2": return "\\n## " + inner + "\\n\\n";
      case "h3": return "\\n### " + inner + "\\n\\n";
      case "h4": return "\\n#### " + inner + "\\n\\n";
      case "h5": return "\\n##### " + inner + "\\n\\n";
      case "h6": return "\\n###### " + inner + "\\n\\n";
      case "p": return "\\n" + inner + "\\n\\n";
      case "br": return "  \\n";
      case "hr": return "\\n---\\n\\n";
      case "strong": case "b": return "**" + inner + "**";
      case "em": case "i": return "*" + inner + "*";
      case "code":
        if (node.parentElement && node.parentElement.tagName.toLowerCase() === "pre") return inner;
        return "\`" + inner + "\`";
      case "pre": {
        var codeEl = node.querySelector("code");
        var lang = "";
        var cls = (codeEl && codeEl.getAttribute("class")) || node.getAttribute("class") || "";
        var lm = /\\b(?:language|lang)-([\\w+#.-]+)/i.exec(cls);
        if (lm) lang = lm[1];
        var text = (codeEl ? codeEl.textContent : node.textContent) || "";
        return "\\n\`\`\`" + lang + "\\n" + text.replace(/\\n$/, "") + "\\n\`\`\`\\n\\n";
      }
      case "a": {
        var href = node.getAttribute("href") || "";
        return "[" + inner + "](" + href + ")";
      }
      case "ul": return "\\n" + listMd(node, false) + "\\n";
      case "ol": return "\\n" + listMd(node, true) + "\\n";
      case "li": return inner; // handled by listMd
      case "blockquote":
        return "\\n" + inner.split("\\n").map(function (l) { return l ? "> " + l : ">"; }).join("\\n") + "\\n\\n";
      case "img": {
        var alt = node.getAttribute("alt") || "";
        var src = node.getAttribute("src") || "";
        return "![" + alt + "](" + src + ")";
      }
      case "table": return "\\n" + tableMd(node) + "\\n";
      default: return inner;
    }
  }
  function childrenMd(node) {
    var out = "";
    for (var i = 0; i < node.childNodes.length; i++) out += mdOf(node.childNodes[i]);
    return out;
  }
  function listMd(list, ordered) {
    var items = [];
    var n = 1;
    for (var i = 0; i < list.children.length; i++) {
      var li = list.children[i];
      if (li.tagName.toLowerCase() !== "li") continue;
      var mark = ordered ? (n++ + ". ") : "- ";
      var body = childrenMd(li).trim().replace(/\\n{2,}/g, "\\n");
      items.push(mark + body);
    }
    return items.join("\\n");
  }
  function tableMd(table) {
    var rows = table.querySelectorAll("tr");
    var lines = [];
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].querySelectorAll("th,td");
      var cols = [];
      for (var c = 0; c < cells.length; c++) cols.push(childrenMd(cells[c]).trim().replace(/\\n/g, " "));
      lines.push("| " + cols.join(" | ") + " |");
      if (r === 0) lines.push("| " + cols.map(function () { return "---"; }).join(" | ") + " |");
    }
    return lines.join("\\n");
  }

  function tidyMd(s) {
    return s.replace(/\\n{3,}/g, "\\n\\n").trim();
  }

  function roleOf(el) { return isUser(el) ? "You" : "Claude"; }

  // The message's own timestamp, if the DateTime feature stamped it
  // (\`[data-cc-dt-time]\`). Empty string when DateTime is absent.
  function stampOf(el) {
    var t = el.querySelector && el.querySelector("[data-cc-dt-time]");
    var v = t && (t.getAttribute("data-cc-dt-time") || (t.textContent || "").trim());
    return v || "";
  }

  // A chat title for the export header — the first user prompt, truncated.
  function chatTitle() {
    var msgs = messages();
    for (var i = 0; i < msgs.length; i++) {
      if (isUser(msgs[i])) {
        var t = (msgs[i].textContent || "").replace(/\\s+/g, " ").trim();
        if (t) return t.length > 60 ? t.slice(0, 60) + "…" : t;
      }
    }
    return "Chat export";
  }

  function buildMarkdown() {
    var msgs = messages();
    var parts = ["# " + chatTitle(), "", "_Exported " + stamp(true) + "_", ""];
    for (var i = 0; i < msgs.length; i++) {
      var el = msgs[i];
      var body = tidyMd(mdOf(cleanClone(contentRoot(el))));
      if (!body) continue;
      var ts = stampOf(el);
      parts.push("## " + roleOf(el) + (ts ? " — " + ts : ""));
      parts.push("");
      parts.push(body);
      parts.push("");
    }
    return parts.join("\\n").replace(/\\n{3,}/g, "\\n\\n") + "\\n";
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function buildHtml() {
    var msgs = messages();
    var body = "";
    for (var i = 0; i < msgs.length; i++) {
      var el = msgs[i];
      var clone = cleanClone(contentRoot(el));
      var html = (clone.innerHTML || "").trim();
      if (!html) continue;
      var role = roleOf(el);
      var cls = role === "You" ? "you" : "claude";
      var ts = stampOf(el);
      var roleLine = esc(role) + (ts ? ' <span class="ts">' + esc(ts) + "</span>" : "");
      body += '<div class="turn ' + cls + '"><div class="role">' + roleLine + "</div>" + html + "</div>\\n";
    }
    var title = esc(chatTitle());
    return [
      "<!doctype html>",
      '<html><head><meta charset="utf-8">',
      "<title>" + title + "</title>",
      "<style>",
      "body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:820px;margin:0 auto;padding:24px;line-height:1.55;color:#1a1a1a;background:#fff;}",
      ".turn{margin:0 0 20px;padding:14px 16px;border-radius:10px;}",
      ".turn.you{background:#eef4ff;}",
      ".turn.claude{background:#f6f6f6;}",
      ".role{font-weight:700;font-size:12px;text-transform:uppercase;letter-spacing:.04em;opacity:.6;margin-bottom:6px;}",
      ".role .ts{font-weight:400;text-transform:none;letter-spacing:0;opacity:.7;margin-left:6px;}",
      ".meta{color:#888;font-size:12px;margin:0 0 20px;}",
      "pre{background:#0d1117;color:#e6edf3;padding:12px;border-radius:8px;overflow:auto;}",
      "code{font-family:ui-monospace,Consolas,monospace;font-size:.92em;}",
      "table{border-collapse:collapse;}td,th{border:1px solid #ccc;padding:4px 8px;}",
      "blockquote{border-left:3px solid #ccc;margin:0;padding:2px 12px;color:#555;}",
      "</style></head><body>",
      "<h1>" + title + "</h1>",
      '<p class="meta">Exported ' + esc(stamp(true)) + "</p>",
      body,
      "</body></html>",
    ].join("\\n");
  }

  function flog(kind, extra) {
    try { console.info("[cc-export] " + kind, extra || ""); } catch (e) {}
  }
  function toClipboard(text) {
    try {
      if (W.navigator && W.navigator.clipboard && W.navigator.clipboard.writeText) { W.navigator.clipboard.writeText(text); return true; }
    } catch (e) {}
    try {
      var ta = D.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.left = "-9999px";
      D.body.appendChild(ta); ta.focus(); ta.select(); var ok = D.execCommand("copy"); ta.remove(); return ok;
    } catch (e) { return false; }
  }
  function toast(msg) {
    try {
      if (W.KTTSwal && W.KTTSwal.toast) { W.KTTSwal.toast(msg); return; }
    } catch (e) {}
    // lightweight self-drawn toast (webview download is often blocked; tell the user)
    try {
      var t = D.createElement("div");
      t.textContent = msg;
      t.style.cssText = "position:fixed;bottom:96px;right:16px;z-index:2147483000;max-width:360px;padding:10px 14px;border-radius:8px;font-size:12px;background:var(--cc-surface,#252526);color:var(--cc-fg,#ddd);border:1px solid var(--cc-border,rgba(128,128,128,.4));box-shadow:0 6px 24px rgba(0,0,0,.45);";
      D.body.appendChild(t);
      W.setTimeout(function () { try { t.remove(); } catch (e) {} }, 4000);
    } catch (e) {}
  }

  // Download in a webview is unreliable (the vscode-webview sandbox often blocks a
  // blob/<a download> and data-URI open). So: try the blob download; ALWAYS also copy
  // the content to the clipboard as a guaranteed fallback, and tell the user + log the
  // outcome to the console (so the outcome is at least visible, not silently lost).
  function download(filename, text, mime) {
    var blobOk = false;
    try {
      var blob = new W.Blob([text], { type: mime });
      var url = W.URL.createObjectURL(blob);
      var a = D.createElement("a");
      a.href = url; a.download = filename; a.rel = "noopener";
      D.body.appendChild(a); a.click(); a.remove();
      W.setTimeout(function () { try { W.URL.revokeObjectURL(url); } catch (e) {} }, 2000);
      blobOk = true;
    } catch (e) { blobOk = false; }
    // Guaranteed fallback: the content is on the clipboard regardless, so it is never lost.
    var clipOk = toClipboard(text);
    flog("cc.export", { file: filename, bytes: (text || "").length, blob: blobOk, clipboard: clipOk });
    toast(
      blobOk
        ? ("Exporting " + filename + " (also copied to clipboard)")
        : (clipOk ? (filename + " copied to clipboard (webview blocked the file download — paste to save)")
                  : ("Export failed — could not download or copy " + filename))
    );
    return blobOk || clipOk;
  }

  function stamp(human) {
    var d = new (W.Date || Date)();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    if (human) {
      return (
        d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " +
        p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds())
      );
    }
    return (
      d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
    );
  }

  function exportMd() {
    download("chat-" + stamp() + ".md", buildMarkdown(), "text/markdown");
  }
  function exportHtml() {
    download("chat-" + stamp() + ".html", buildHtml(), "text/html");
  }

  var toggleBtn = null;
  var menu = null;
  var menuOpen = false;

  // Same fix as the TOC panel's positionPanel() (see its own comment): a
  // flat "right:16px" is measured from the whole CSS viewport, which can be
  // noticeably wider than the composer's own bordered box in this webview —
  // align the menu's right edge to the composer action-footer's real right
  // edge instead.
  function positionMenu() {
    if (!menu) return;
    var footer = D.querySelector("[class*='inputFooter']");
    if (!footer || !footer.getBoundingClientRect) return;
    var rect;
    try { rect = footer.getBoundingClientRect(); } catch (e) { return; }
    var viewportWidth = W.innerWidth || (D.documentElement && D.documentElement.clientWidth) || 0;
    if (!viewportWidth) return;
    var right = Math.max(0, viewportWidth - rect.right);
    menu.style.right = right + "px";
  }

  function setMenu(v) {
    menuOpen = v;
    if (v) positionMenu();
    if (menu) menu.style.display = v ? "flex" : "none";
    if (toggleBtn) {
      toggleBtn.classList.toggle("cc-export-active", v);
      toggleBtn.setAttribute("aria-expanded", v ? "true" : "false");
    }
  }

  function ensureUI() {
    if (toggleBtn && !D.body.contains(toggleBtn)) toggleBtn = null;
    if (menu && !D.body.contains(menu)) { menu = null; menuOpen = false; }
    // Adopt an existing element (fresh module scope after re-eval, or React strip).
    if (!toggleBtn) toggleBtn = D.querySelector(".cc-export-toggle");
    if (!menu) menu = D.querySelector(".cc-export-menu");

    // ALWAYS destroy any standalone fixed fallback FAB — the toolbar is the ONLY
    // home for the Export toggle. A leftover .cc-export-toggle that is NOT a toolbar
    // chip (from an earlier frame, or a race where the toolbar wasn't ready) is the
    // duplicate top-right ⭳; nuke every one of them, unconditionally.
    var strays = D.querySelectorAll(".cc-export-toggle:not(.cc-toolbar-btn)");
    for (var sI = 0; sI < strays.length; sI++) { try { strays[sI].remove(); } catch (e) {} }
    if (toggleBtn && !toggleBtn.classList.contains("cc-toolbar-btn")) toggleBtn = null;
    // adopt the toolbar's own button if it already exists
    if (!toggleBtn) toggleBtn = D.querySelector(".cc-export-toggle.cc-toolbar-btn");

    if (!toggleBtn) {
      // Register into the shared toolbar. If the toolbar isn't ready yet, queue and
      // wait — do NOT create a floating fallback (that is what caused the duplicate).
      if (W.__ccToolbar && W.__ccToolbar.add) {
        toggleBtn = W.__ccToolbar.add({
          id: "export", icon: "💾", label: "Copy the chat as Markdown or HTML",
          order: 30, onClick: function () { setMenu(!menuOpen); },
        });
        if (toggleBtn && !toggleBtn.classList.contains("cc-export-toggle")) toggleBtn.classList.add("cc-export-toggle");
      } else {
        // toolbar not parsed yet — queue our spec so it renders on drain, no FAB.
        (W.__ccToolbarQueue = W.__ccToolbarQueue || []).push({
          id: "export", icon: "💾", label: "Copy the chat as Markdown or HTML",
          order: 30, onClick: function () { setMenu(!menuOpen); },
        });
      }
    }
    if (!menu) {
      menu = D.createElement("div");
      menu.className = "cc-export-menu";
      menu.style.display = "none";
      // Two clipboard actions (webview file-download is unreliable, so we copy):
      // "Copy MD" and "Copy HTML".
      var mdItem = D.createElement("button");
      mdItem.type = "button";
      mdItem.className = "cc-export-item";
      mdItem.textContent = "Copy MD";
      mdItem.addEventListener("click", function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        try { copyMd(); } catch (e) {}
        setMenu(false);
      });
      var htmlItem = D.createElement("button");
      htmlItem.type = "button";
      htmlItem.className = "cc-export-item";
      htmlItem.textContent = "Copy HTML";
      htmlItem.addEventListener("click", function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        try { copyHtml(); } catch (e) {}
        setMenu(false);
      });
      menu.appendChild(mdItem);
      menu.appendChild(htmlItem);
      D.body.appendChild(menu);
    }
  }

  // Copy the whole-chat Markdown to the clipboard (scope+format option: to
  // clipboard rather than a file), with a hidden-textarea fallback.
  function copyMd() {
    var text = buildMarkdown();
    var ok = toClipboard(text);
    flog("cc.export.copy", { format: "md", bytes: text.length, clipboard: ok });
    toast(ok ? "Chat copied as Markdown" : "Copy failed");
    return ok;
  }
  function copyHtml() {
    var text = buildHtml();
    var ok = toClipboard(text);
    flog("cc.export.copy", { format: "html", bytes: text.length, clipboard: ok });
    toast(ok ? "Chat copied as HTML" : "Copy failed");
    return ok;
  }

  var _bound = false;
  function bindGlobal() {
    if (_bound) return;
    _bound = true;
    D.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && menuOpen) setMenu(false);
    });
    D.addEventListener("click", function (ev) {
      if (!menuOpen) return;
      if (menu && menu.contains(ev.target)) return;
      if (toggleBtn && toggleBtn.contains(ev.target)) return;
      setMenu(false);
    });
    // Keep the menu's right edge pinned to the composer's own right edge if
    // the window/panel is resized while open.
    try { W.addEventListener("resize", function () { if (menuOpen) positionMenu(); }); } catch (e) {}
  }

  // Expose the pure builders for the jsdom effect test.
  try {
    W.__ccExport = { buildMarkdown: buildMarkdown, buildHtml: buildHtml, copyMd: copyMd, copyHtml: copyHtml, chatTitle: chatTitle };
  } catch (e) {}

  function init(doc, win) {
    D = doc;
    W = win || window;
    _bound = false;
    toggleBtn = null;
    menu = null;
    menuOpen = false;
    try { ensureUI(); bindGlobal(); } catch (e) {}
    try { win.__ccExport = { buildMarkdown: buildMarkdown, buildHtml: buildHtml, copyMd: copyMd, copyHtml: copyHtml, chatTitle: chatTitle }; } catch (e) {}
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

const EXPORT_CSS = `
/* Chat Export feature — a toolbar action + a .md/.html/clipboard menu.
   The ⤓ toggle normally lives INSIDE the shared toolbar (.cc-toolbar-btn); the
   rules below only style the STANDALONE fallback FAB (toolbar absent), scoped with
   :not(.cc-toolbar-btn) so they never re-position the in-toolbar chip. */

.cc-export-toggle:not(.cc-toolbar-btn) {
  position: fixed;
  right: 40px;
  bottom: 84px;
  z-index: 2147483000;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  border: 1px solid var(--cc-border, rgba(128, 128, 128, 0.35));
  background: var(--cc-surface-2, rgba(60, 60, 60, 0.9));
  color: var(--cc-fg, #ddd);
  box-shadow: var(--cc-shadow-sm, 0 2px 8px rgba(0, 0, 0, 0.35));
  opacity: 0.75;
  transition: opacity 0.12s ease, background 0.12s ease;
}
.cc-export-toggle:not(.cc-toolbar-btn):hover,
.cc-export-toggle.cc-export-active:not(.cc-toolbar-btn) {
  opacity: 1;
  background: var(--cc-accent, #0e639c);
  color: var(--cc-accent-fg, #fff);
}

.cc-export-menu {
  position: fixed;
  right: 16px;
  /* open ABOVE the toolbar pill row */
  bottom: 116px;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  min-width: 130px;
  padding: 4px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.4));
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background, #252526));
  color: var(--vscode-foreground, #ddd);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
}
.cc-export-item {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  color: inherit;
  font-size: 12px;
  line-height: 1.4;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.cc-export-item:hover {
  background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.18));
}
`.trim();

registerFeature({ id: "export", label: "Export chat (Markdown / HTML)", js: EXPORT_JS, css: EXPORT_CSS });

// ---------------------------------------------------------------------------
// SCROLL (jump to first / latest message)
// ---------------------------------------------------------------------------
const SCROLL_JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-scroll] Chat Scroll Feature loaded");
  } catch (e) {}

  var D = document;
  var W = window;

  var MSG_SELECTORS = [
    "[class*='userMessageContainer']",
    "[class*='userMessage']",
    "[class*='timelineMessage']",
    "[class*='assistantMessage']",
    "[class*='messageContainer']",
    "[class*='chatMessage']",
  ];
  var EXCLUDE_RE = /messageInput|messagesContainer|messageGradient|fullEditor/;

  function allMessages() {
    var set = new Set();
    for (var i = 0; i < MSG_SELECTORS.length; i++) {
      var nodes = D.querySelectorAll(MSG_SELECTORS[i]);
      for (var j = 0; j < nodes.length; j++) {
        var el = nodes[j];
        var cn = (el.getAttribute("class") || "");
        if (!EXCLUDE_RE.test(cn)) set.add(el);
      }
    }
    var list = Array.from(set).filter(function (el) {
      var p = el.parentElement;
      while (p) { if (set.has(p)) return false; p = p.parentElement; }
      return true;
    });
    list.sort(function (a, b) {
      var pos = a.compareDocumentPosition(b);
      if (pos & 4) return -1; if (pos & 2) return 1; return 0;
    });
    return list;
  }

  // Find the actual SCROLL CONTAINER — the nearest ancestor of the messages that
  // genuinely scrolls (scrollHeight > clientHeight and overflow-y auto/scroll).
  // Setting its scrollTop directly is the reliable way to reach the very top/bottom;
  // scrollIntoView only brings an element into view, so it stops "a little" short.
  function scrollContainer() {
    // Prefer the extension's own messages/scroll container if present.
    var named = D.querySelector("[class*='messagesContainer'],[class*='scrollable'],[class*='conversation']");
    if (named && named.scrollHeight > named.clientHeight + 4) return named;
    // Else walk up from a message to the first scrollable ancestor.
    var msgs = allMessages();
    var node = msgs.length ? msgs[0] : null;
    var W2 = W;
    while (node) {
      try {
        var st = W2.getComputedStyle ? W2.getComputedStyle(node) : null;
        var oy = st ? st.overflowY : "";
        if (node.scrollHeight > node.clientHeight + 4 && (oy === "auto" || oy === "scroll" || oy === "overlay")) return node;
      } catch (e) {}
      node = node.parentElement;
    }
    // Fallbacks: the scrolling element / body.
    return D.scrollingElement || D.documentElement || D.body;
  }

  function scrollTo(which) {
    var msgs = allMessages();
    if (!msgs.length) return;
    var cont = scrollContainer();
    var target = which === "top" ? 0 : (cont ? cont.scrollHeight : 0);
    if (cont && typeof cont.scrollTo === "function") {
      try { cont.scrollTo({ top: target, behavior: "smooth" }); return; } catch (e) {}
    }
    if (cont) { try { cont.scrollTop = target; return; } catch (e) {} }
    // last-resort: scrollIntoView the edge message
    var el = which === "top" ? msgs[0] : msgs[msgs.length - 1];
    try { el.scrollIntoView({ behavior: "smooth", block: which === "top" ? "start" : "end" }); } catch (e) {}
  }

  function fallbackButton(cls, icon, label, onClick, bottom) {
    var b = D.createElement("button");
    b.type = "button";
    b.className = cls + " cc-btn";
    b.textContent = icon;
    b.setAttribute("aria-label", label);
    b.setAttribute("title", label);
    b.style.position = "fixed";
    b.style.right = "14px";
    b.style.bottom = bottom;
    b.style.zIndex = "2147483000";
    b.style.width = "34px"; b.style.height = "34px"; b.style.borderRadius = "50%";
    b.addEventListener("click", function (ev) { ev.preventDefault(); ev.stopPropagation(); onClick(); });
    D.body.appendChild(b);
    return b;
  }

  var _done = false;
  function ensureUI() {
    if (W.__ccToolbar && W.__ccToolbar.add) {
      // Toolbar owns these actions. Remove any stray standalone fallback buttons
      // (created on an earlier frame before the toolbar loaded) so they never double.
      var strays = D.querySelectorAll(".cc-scroll-top:not(.cc-toolbar-btn),.cc-scroll-bottom:not(.cc-toolbar-btn)");
      for (var sI = 0; sI < strays.length; sI++) { try { strays[sI].remove(); } catch (e) {} }
      W.__ccToolbar.add({ id: "scroll-top", icon: "⤒", label: "Scroll to the first message", order: 40, onClick: function () { scrollTo("top"); } });
      W.__ccToolbar.add({ id: "scroll-bottom", icon: "⤓", label: "Jump to the latest message", order: 41, onClick: function () { scrollTo("bottom"); } });
      var b = W.__ccToolbar.get && W.__ccToolbar.get("scroll-top");
      if (b) b.classList.add("cc-scroll-top");
      // scroll-bottom was missing its class entirely — with the scroll feature
      // toggled OFF, FOOTPRINT hid ⤒ (classed) but left ⤓ visible (classless).
      var b2 = W.__ccToolbar.get && W.__ccToolbar.get("scroll-bottom");
      if (b2) b2.classList.add("cc-scroll-bottom");
    } else if (!D.querySelector(".cc-scroll-top")) {
      fallbackButton("cc-scroll-top", "⤒", "Scroll to the first message", function () { scrollTo("top"); }, "96px");
      fallbackButton("cc-scroll-bottom", "⤓", "Jump to the latest message", function () { scrollTo("bottom"); }, "134px");
    }
    _done = true;
  }

  function init(doc, win) {
    D = doc; W = win || window; _done = false;
    try { ensureUI(); } catch (e) {}
  }

  register(init);

  function register(fn) {
    if (window.__ccOnChatDoc) { window.__ccOnChatDoc(fn); return; }
    (window.__ccPending = window.__ccPending || []).push(fn);
    var tries = 0;
    var t = setInterval(function () {
      if (window.__ccOnChatDoc) { clearInterval(t); return; }
      if (++tries >= 25) { clearInterval(t); try { fn(document, window); } catch (e) {} }
    }, 200);
  }
})();
`.trim();

const SCROLL_CSS = `
/* Chat Scroll feature — fallback floating buttons (only used when the shared
   toolbar is absent; when the toolbar is present these live inside it). */
.cc-scroll-top,
.cc-scroll-bottom {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  line-height: 1;
  box-shadow: var(--cc-shadow-sm, 0 2px 8px rgba(0, 0, 0, 0.35));
  opacity: 0.78;
}
.cc-scroll-top:hover,
.cc-scroll-bottom:hover { opacity: 1; }
`.trim();

registerFeature({ id: "scroll", label: "Scroll to first / latest message", js: SCROLL_JS, css: SCROLL_CSS });
