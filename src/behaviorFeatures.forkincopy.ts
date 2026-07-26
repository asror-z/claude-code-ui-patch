import { registerFeature } from "./behaviorFeatures";

const JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-forkincopy] Chat ForkInCopy Feature.js loaded");
  } catch (e) {}

  var GROUP_CLASS = "cc-copy-group"; // CopyButtons' own row — we dock a button into it
  var COPY_BTN_CLASS = "cc-copy-btn"; // CopyButtons' own button styling, reused so ours matches
  var BTN_MARK_ATTR = "data-cc-forkincopy-btn"; // marks OUR button inside the group
  var TIME_ATTR = "data-cc-dt-time"; // DateTime's per-message stamp anchor (CopyButtons' own anchor too)

  // D/W = the chat Document/Window (set by init()).
  var D = document;
  var W = window;

  var EXCLUDE_RE = /messageInput|messagesContainer|messageGradient|fullEditor|stickyHeader/i;

  // Claude Code's own "Message actions" (⤴) button + popup — identical selectors to
  // ForkConv's own (behaviorFeatures.forkconv.ts), reused here so both features stay
  // in lockstep if the native markup ever changes.
  var MSG_ACTIONS_SEL = "button[title='Message actions']";
  var POPUP_SEL = "[class*='popup_']";
  var POPUP_OPTION_SEL = "[class*='popupOption_']";
  var FORK_OPTION_RE = /fork/i;

  // Is \`el\` (a stamped [data-cc-dt-time] element) a USER message? Mirrors
  // CopyButtons' own isUserMessage() exactly, so both features classify every
  // message identically.
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

  // Every stamped message, in document order — the same anchor set ([data-cc-dt-time],
  // written by DateTime) CopyButtons itself sweeps.
  function stampedMessages() {
    var nodes = D.querySelectorAll ? D.querySelectorAll("[" + TIME_ATTR + "]") : [];
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      if (isExcluded(nodes[i])) continue;
      out.push(nodes[i]);
    }
    return out;
  }

  // Find, for a given OUTPUT message element, the nearest USER message that
  // precedes it in document order — the prompt that reply answers, and what a
  // fork "from here" forks from.
  function precedingUserMessage(outputEl) {
    var all = stampedMessages();
    var best = null;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el === outputEl) break;
      if (isUserMessage(el)) best = el;
    }
    return best;
  }

  function fireClick(el) {
    try {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: W }));
    } catch (e) {
      try { el.click(); } catch (e2) {}
    }
  }

  // Find the "Fork conversation from here" row inside an OPEN popup, by its own
  // visible text — never by position (mirrors ForkConv's own findForkOption()).
  function findForkOption(popupEl) {
    var opts = popupEl.querySelectorAll ? popupEl.querySelectorAll(POPUP_OPTION_SEL) : [];
    for (var i = 0; i < opts.length; i++) {
      var txt = (opts[i].textContent || "").trim();
      if (FORK_OPTION_RE.test(txt)) return opts[i];
    }
    return null;
  }

  // Click \`userEl\`'s own "Message actions" trigger, then poll (bounded, ~30 tries /
  // ~600ms) for its popup to mount and carry a "Fork conversation from here" row —
  // clicking it the instant it appears. Identical mechanics to ForkConv's own
  // forkFrom(), just invoked against the resolved PRECEDING user message rather than
  // the message the button itself sits on.
  function forkFrom(userEl) {
    var trigger = userEl.querySelector ? userEl.querySelector(MSG_ACTIONS_SEL) : null;
    if (!trigger) return;
    var stalePopup = userEl.querySelector ? userEl.querySelector(POPUP_SEL) : null;
    if (stalePopup) fireClick(trigger);
    fireClick(trigger);
    var tries = 0;
    var poll = W.setInterval(function () {
      tries++;
      var popupEl = userEl.querySelector ? userEl.querySelector(POPUP_SEL) : null;
      var forkOpt = popupEl ? findForkOption(popupEl) : null;
      if (forkOpt) {
        W.clearInterval(poll);
        fireClick(forkOpt);
        return;
      }
      if (tries >= 30) {
        W.clearInterval(poll);
        try {
          console.warn(
            "[cc-forkincopy] \\"Fork conversation from here\\" option never appeared — " +
              "the native popup markup likely changed; update FORK_OPTION_RE / POPUP_SEL " +
              "in Chat ForkInCopy Feature.js."
          );
        } catch (e) {}
      }
    }, 20);
  }

  // --- button ------------------------------------------------------------
  var SVG_FORK =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="12" r="2.5"/>' +
    '<path d="M6 8.5v7"/><path d="M8.2 7.2c3 1 5.6 2.6 7.4 4.3"/><path d="M8.2 16.8c3-1 5.6-2.6 7.4-4.3"/>' +
    "</svg>";

  function makeButton(userEl) {
    var b = D.createElement("button");
    b.type = "button";
    b.className = COPY_BTN_CLASS;
    b.setAttribute(BTN_MARK_ATTR, "1");
    b.innerHTML = SVG_FORK;
    b.setAttribute("title", "Fork conversation from here");
    b.setAttribute("aria-label", "Fork conversation from here");
    b.setAttribute("tabindex", "-1"); // don't steal tab order from the chat
    b.addEventListener("mousedown", function (e) {
      try { e.stopPropagation(); } catch (x) {}
    });
    b.addEventListener("click", function (ev) {
      try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
      forkFrom(userEl);
    });
    return b;
  }

  // Dock our fork button as the LAST child of CopyButtons' own .cc-copy-group row on
  // this output message — i.e. to the right of the time label + Markdown + HTML
  // buttons. Only when a preceding user message actually exists to fork from (a
  // reply's very first message in the chat has no earlier prompt).
  function ensureButton(outputEl) {
    var group = outputEl.querySelector ? outputEl.querySelector(":scope > ." + GROUP_CLASS) : null;
    if (!group) return; // CopyButtons hasn't attached its row here (yet) — nothing to dock into
    var userEl = precedingUserMessage(outputEl);
    var existing = group.querySelector ? group.querySelector("[" + BTN_MARK_ATTR + "]") : null;
    if (!userEl) {
      // No preceding user message (e.g. this output is the very first message) — remove
      // a stale button if one is somehow present, and add nothing.
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return;
    }
    if (existing) return; // React may re-render the group's children; re-added by the next sweep if stripped
    group.appendChild(makeButton(userEl));
  }

  function run() {
    var msgs = stampedMessages();
    for (var i = 0; i < msgs.length; i++) {
      if (isUserMessage(msgs[i])) continue; // only OUTPUT messages carry CopyButtons' row
      ensureButton(msgs[i]);
    }
  }

  // init(doc, win) — bootstrap hands us the chat document; bind + observe it.
  function init(doc, win) {
    D = doc;
    W = win || window;
    try { run(); } catch (e) {}
    try {
      if (W.__ccObserve) {
        W.__ccObserve(D.body, run, { ownClass: COPY_BTN_CLASS, ownAttrPrefix: "data-cc-forkincopy" });
      } else {
        new W.MutationObserver(run).observe(D.body, { childList: true, subtree: true });
      }
    } catch (e) {}
  }

  register(init);

  // Order-independent registration: if the bootstrap is already installed, hand
  // off now; otherwise queue onto window.__ccPending — the bootstrap drains it the
  // moment it installs. A last-resort timer covers the impossible case where no
  // bootstrap ever appears, running once against the current document.
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
/* ForkInCopy — an ADDITIVE fork button docked into CopyButtons' own time+Markdown+HTML
   row (.cc-copy-group), at the right end, on each assistant OUTPUT message. Clicking it
   forks the conversation from that output's PRECEDING user message, by proxying a click
   onto Claude Code's own native "Message actions" -> "Fork conversation from here" popup
   option on that user message (the same native action ForkConv's own left-docked button
   already uses — this is a second, independent entry point to the same native action,
   kept alongside it per explicit request rather than replacing it). Reuses CopyButtons'
   own .cc-copy-btn class so it matches the Markdown/HTML buttons' exact size/spacing/
   hover styling with no separate CSS needed beyond the accent color below. */

.cc-copy-btn[data-cc-forkincopy-btn="1"] {
  color: var(--vscode-textLink-foreground, #4ea1ff);
}
.cc-copy-btn[data-cc-forkincopy-btn="1"]:hover {
  color: #ffffff;
  background: var(--vscode-textLink-foreground, #4ea1ff);
  border-color: var(--vscode-textLink-foreground, #4ea1ff);
}
`.trim();

registerFeature({ id: "forkincopy", label: "Fork button in the Copy row (assistant replies)", js: JS, css: CSS });
