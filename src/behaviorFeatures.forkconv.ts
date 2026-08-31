import { registerFeature } from "./behaviorFeatures";

const JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-forkconv] Chat ForkConversation Feature.js loaded");
  } catch (e) {}

  var BTN_CLASS = "cc-forkconv-btn";
  var ATTACHED_ATTR = "data-cc-forkconv-attached"; // guard: message already has its button

  // D/W = the chat Document/Window (set by init()).
  var D = document;
  var W = window;

  // The user-bubble selector (mirrors UserStyle/UserCollapse's own robust list) —
  // restricted to USER prompts only, per this feature's scope.
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
  var EXCLUDE_RE = /messageInput|messagesContainer|messageGradient|fullEditor|stickyHeader/i;

  /*
   * Claude Code's own "Message actions" (⤴) button — a round icon-only button native to EVERY message, opening a dropdown POPUP with options like "Fork conversation from here" / "Rewind code to here".
   * Matched by its title attribute (stable, human-readable UI text), mirroring UserCollapse's own MSG_ACTIONS_SEL.
   */
  var MSG_ACTIONS_SEL = "button[title='Message actions']";
  // The popup itself and its option rows — version-proof CLASS-NAME SUBSTRING match (the
  // extension mints the hash suffix), mirroring UserCollapse's POPUP_SEL/POPUP_OPTION_SEL.
  var POPUP_SEL = "[class*='popup_']";
  var POPUP_OPTION_SEL = "[class*='popupOption_']";
  // The native option's own visible text — matched case-insensitively by substring, so a
  // future minor label change ("Fork chat from here" etc.) still matches on "fork".
  var FORK_OPTION_RE = /fork/i;

  function findUserMessages() {
    var set = new Set();
    for (var i = 0; i < USER_SELECTORS.length; i++) {
      var nodes = D.querySelectorAll ? D.querySelectorAll(USER_SELECTORS[i]) : [];
      for (var j = 0; j < nodes.length; j++) {
        var cn = (nodes[j].getAttribute && nodes[j].getAttribute("class")) || "";
        if (EXCLUDE_RE.test(cn)) continue;
        set.add(nodes[j]);
      }
    }
    var list = Array.from(set);
    // outermost-only, so a bubble is processed once
    return list.filter(function (el) {
      var p = el.parentElement;
      while (p) {
        if (set.has(p)) return false;
        p = p.parentElement;
      }
      return true;
    });
  }

  function fireClick(el) {
    try {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: W }));
    } catch (e) {
      try { el.click(); } catch (e2) {}
    }
  }

  // Find the "Fork conversation from here" row inside an OPEN popup, by its own
  // visible text — never by position, since a future native reorder must not
  // silently click the wrong option.
  function findForkOption(popupEl) {
    var opts = popupEl.querySelectorAll ? popupEl.querySelectorAll(POPUP_OPTION_SEL) : [];
    for (var i = 0; i < opts.length; i++) {
      var txt = (opts[i].textContent || "").trim();
      if (FORK_OPTION_RE.test(txt)) return opts[i];
    }
    return null;
  }

  /**
   * Click THIS message's own "Message actions" trigger, then poll (bounded, ~30 tries / ~600ms) for its popup to mount and carry a "Fork conversation from here" row — clicking it the instant it appears.
   * The popup is a deliberate, click-only React mount (never present until the trigger is clicked), so there is no way to pre-locate it; a short bounded poll is the same defensive pattern this file's own register() already uses for bootstrap hand-off, applied here to a native popup's own mount delay.
   * @param {Element} msgEl - The user message element to fork the conversation from.
   * @returns {void}
   */
  function forkFrom(msgEl) {
    var trigger = msgEl.querySelector ? msgEl.querySelector(MSG_ACTIONS_SEL) : null;
    if (!trigger) return;
    // If a popup is already open (e.g. the user had just opened it themselves),
    // close it first so we always start from a known, freshly-opened state.
    var stalePopup = msgEl.querySelector ? msgEl.querySelector(POPUP_SEL) : null;
    if (stalePopup) fireClick(trigger);
    fireClick(trigger);
    var tries = 0;
    var poll = W.setInterval(function () {
      tries++;
      var popupEl = msgEl.querySelector ? msgEl.querySelector(POPUP_SEL) : null;
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
            "[cc-forkconv] \\"Fork conversation from here\\" option never appeared — " +
              "the native popup markup likely changed; update FORK_OPTION_RE / POPUP_SEL " +
              "in Chat ForkConversation Feature.js."
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

  function makeButton(msgEl) {
    var b = D.createElement("button");
    b.type = "button";
    b.className = BTN_CLASS;
    b.innerHTML = SVG_FORK;
    b.setAttribute("title", "Fork conversation from here");
    b.setAttribute("aria-label", "Fork conversation from here");
    b.setAttribute("tabindex", "-1"); // don't steal tab order from the chat
    b.addEventListener("mousedown", function (e) {
      try { e.stopPropagation(); } catch (x) {}
    });
    b.addEventListener("click", function (ev) {
      try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
      forkFrom(msgEl);
    });
    return b;
  }

  function attach(msgEl) {
    if (msgEl.getAttribute(ATTACHED_ATTR) === "1") {
      // React may have stripped a prior button on re-render; re-check the live DOM.
      var live = msgEl.querySelector ? msgEl.querySelector(":scope > ." + BTN_CLASS) : null;
      if (live) return;
    }
    var btn = makeButton(msgEl);
    msgEl.setAttribute(ATTACHED_ATTR, "1");
    msgEl.appendChild(btn);
  }

  function run() {
    var msgs = findUserMessages();
    for (var i = 0; i < msgs.length; i++) attach(msgs[i]);
  }

  // init(doc, win) — bootstrap hands us the chat document; bind + observe it.
  function init(doc, win) {
    D = doc;
    W = win || window;
    try { run(); } catch (e) {}
    try {
      if (W.__ccObserve) {
        W.__ccObserve(D.body, run, { ownClass: BTN_CLASS, ownAttrPrefix: "data-cc-forkconv" });
      } else {
        new W.MutationObserver(run).observe(D.body, { childList: true, subtree: true });
      }
    } catch (e) {}
  }

  register(init);

  /**
   * Order-independent registration: if the bootstrap is already installed, hand off now; otherwise queue onto window.__ccPending — the bootstrap drains it the moment it installs.
   * A last-resort timer covers the impossible case where no bootstrap ever appears, running once against the current document.
   * @param {Function} fn - The init function to register against the chat document.
   * @returns {void}
   */
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
/*
 * ForkConversation — a small always-visible icon button docked to the LEFT of each of your own (user) messages.
 * Clicking it forks the conversation from that exact message, by proxying a click onto Claude Code's own native "Message actions" -> "Fork conversation from here" popup option (the same native action UserCollapse's own comment already documents living in that popup).
 *
 * The user-message bubble itself (UserStyle's [data-cc-user="1"]) is a right-aligned, fit-content, block-level card inside a full-width row.
 * To dock a button to its LEFT without touching that row's own layout, the message element becomes the positioning context (position:relative — the same class of !important override UserStyle already applies to this same element) and the button is absolutely positioned just outside its left edge, vertically centered.
 */

[class*="userMessageContainer"],
[class*="userMessage"] {
  position: relative;
}

.cc-forkconv-btn {
  position: absolute;
  top: 50%;
  right: 100%;
  transform: translateY(-50%);
  margin-right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 23px;
  height: 23px;
  padding: 0;
  cursor: pointer;
  color: var(--vscode-textLink-foreground, #4ea1ff);
  background: var(--vscode-toolbar-hoverBackground, rgba(130, 150, 255, 0.1));
  border: 1px solid transparent;
  border-radius: 7px;
  opacity: 0.82;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease,
    opacity 0.12s ease, transform 0.08s ease;
}

.cc-forkconv-btn svg {
  display: block;
  pointer-events: none;
}

.cc-forkconv-btn:hover {
  opacity: 1;
  color: #ffffff;
  background: var(--vscode-textLink-foreground, #4ea1ff);
  border-color: var(--vscode-textLink-foreground, #4ea1ff);
}

.cc-forkconv-btn:active {
  transform: translateY(-50%) translateY(0.5px) scale(0.96);
}

/* Never render on the composer/input/scroll containers, even if a stale attach guard
   lingers there from an earlier build. */
[data-cc-forkconv-attached][class*="messageInput"] > .cc-forkconv-btn,
[data-cc-forkconv-attached][class*="messagesContainer"] > .cc-forkconv-btn,
[data-cc-forkconv-attached][class*="messageGradient"] > .cc-forkconv-btn,
[data-cc-forkconv-attached][class*="fullEditor"] > .cc-forkconv-btn {
  display: none !important;
}
`.trim();

registerFeature({ id: "forkconv", label: "Fork Conversation button on your messages", js: JS, css: CSS });
