// AutoScroll — a toolbar toggle that LOCKS the chat scroll position while a
// reply is streaming, the moment the user scrolls up to read earlier text.
//
// Claude Code's own webview keeps the scroll container pinned to the bottom
// while new content streams in (a native "stick to bottom" behavior we do not
// control and never try to suppress directly). The problem this feature
// solves: while the user has manually scrolled UP to re-read something
// mid-stream, that native pinning keeps yanking the view back down on every
// new chunk, making it impossible to read while a long reply is still being
// generated. There is no way to intercept Claude Code's own scroll writes
// (they happen inside its bundled, unpatched React reducer), so instead of
// fighting them, this feature repeatedly RE-APPLIES the user's own scroll
// position on a short interval whenever the toggle is "locked" and the user
// is not already at the bottom — a "hold the line" counter-scroll rather than
// a native scroll-event interception. When the toggle is "unlocked" (the
// default), this feature does nothing at all and native behavior is
// untouched.
import { registerFeature } from "./behaviorFeatures";

const JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-autoscroll] Chat AutoScroll Feature.js loaded");
  } catch (e) {}

  var D = document;
  var W = window;

  var STORAGE_KEY = "cc-autoscroll-locked";
  var NEAR_BOTTOM_PX = 80; // within this many px of the bottom counts as "at bottom"
  var HOLD_INTERVAL_MS = 120;

  var locked = false; // true = user has locked scroll (holding position while streaming)
  var toggleBtn = null;
  var holdTimer = null;
  var heldTop = null; // the scrollTop we are holding, while locked

  function readInitial() {
    try {
      var v = W.localStorage ? W.localStorage.getItem(STORAGE_KEY) : null;
      return v === "1";
    } catch (e) {
      return false;
    }
  }

  function persist() {
    try {
      if (W.localStorage) W.localStorage.setItem(STORAGE_KEY, locked ? "1" : "0");
    } catch (e) {}
  }

  // Find the real scrolling container — same walk-up-from-a-message technique
  // the Scroll feature already uses (behaviorFeatures.toc-export-scroll.ts),
  // duplicated here (these are separate injected IIFEs with no shared module
  // system) rather than imported.
  var MSG_SELECTORS = [
    "[class*='userMessageContainer']",
    "[class*='timelineMessage']",
    "[class*='assistantMessage']",
    "[class*='messageContainer']",
    "[class*='chatMessage']",
  ];
  function firstMessage() {
    for (var i = 0; i < MSG_SELECTORS.length; i++) {
      var el = D.querySelector(MSG_SELECTORS[i]);
      if (el) return el;
    }
    return null;
  }
  function scrollContainer() {
    var named = D.querySelector("[class*='messagesContainer'],[class*='scrollable'],[class*='conversation']");
    if (named && named.scrollHeight > named.clientHeight + 4) return named;
    var node = firstMessage();
    while (node) {
      try {
        var st = W.getComputedStyle ? W.getComputedStyle(node) : null;
        var oy = st ? st.overflowY : "";
        if (node.scrollHeight > node.clientHeight + 4 && (oy === "auto" || oy === "scroll" || oy === "overlay")) return node;
      } catch (e) {}
      node = node.parentElement;
    }
    return D.scrollingElement || D.documentElement || D.body;
  }

  function isNearBottom(cont) {
    if (!cont) return true;
    var dist = cont.scrollHeight - cont.clientHeight - cont.scrollTop;
    return dist <= NEAR_BOTTOM_PX;
  }

  // While locked and a position is being held, repeatedly RE-APPLY it —
  // unconditionally, regardless of how close cont.scrollTop currently reads
  // to "the bottom". This deliberately does NOT re-check isNearBottom() here:
  // Claude Code's own native pin-to-bottom write always lands EXACTLY at
  // scrollHeight - clientHeight, which is by definition always "near the
  // bottom" — so a near-bottom check at this point would immediately treat
  // every native write as "the user caught up" and release the hold on the
  // very next tick, defeating the whole feature. Whether to hold at all is
  // decided solely by onUserScroll() below, from a REAL user-driven scroll —
  // never from tick() re-reading a position tick() itself may have just been
  // overridden away from by a native write.
  function tick() {
    var cont = scrollContainer();
    if (!locked || !cont || heldTop == null) return;
    if (Math.abs(cont.scrollTop - heldTop) > 1) {
      try { cont.scrollTop = heldTop; } catch (e) {}
    }
  }

  // Whenever the user manually scrolls while locked, adopt the NEW position as
  // the one to hold (so locking doesn't freeze them at a stale spot — it just
  // stops Claude Code's own pin-to-bottom from overriding wherever they are).
  // This is the ONLY place heldTop is set or cleared based on "how close to
  // the bottom" a position is — a real scroll event genuinely reflects where
  // the user (not a native pin-to-bottom write) left the view.
  var scrollDebounce = null;
  function onUserScroll() {
    if (!locked) return;
    if (scrollDebounce) W.clearTimeout(scrollDebounce);
    scrollDebounce = W.setTimeout(function () {
      var cont = scrollContainer();
      if (!cont) return;
      // Ignore a scroll event that landed exactly where tick() itself just
      // placed the container (its own counter-scroll write) — that is our
      // OWN echo, not a fresh user gesture, and must not re-derive heldTop
      // from itself.
      if (heldTop != null && Math.abs(cont.scrollTop - heldTop) <= 1) return;
      heldTop = isNearBottom(cont) ? null : cont.scrollTop;
    }, 60);
  }

  var boundContainer = null;
  function bindScrollListener() {
    var cont = scrollContainer();
    if (cont === boundContainer) return;
    if (boundContainer) {
      try { boundContainer.removeEventListener("scroll", onUserScroll); } catch (e) {}
    }
    boundContainer = cont;
    if (cont) {
      try { cont.addEventListener("scroll", onUserScroll, { passive: true }); } catch (e) {}
    }
  }

  function updateButton() {
    if (!toggleBtn) return;
    toggleBtn.setAttribute("aria-pressed", locked ? "true" : "false");
    toggleBtn.setAttribute(
      "title",
      locked
        ? "Auto-scroll locked — streaming replies won't pull you back down (click to unlock)"
        : "Auto-scroll unlocked — replies stream normally (click to lock while reading)"
    );
    toggleBtn.textContent = locked ? "\\u23F8" : "\\u23F5"; // pause / play glyph
  }

  function setLocked(v) {
    locked = v;
    if (!locked) heldTop = null;
    persist();
    updateButton();
    try {
      console.info("[cc-autoscroll] " + (locked ? "locked" : "unlocked"));
    } catch (e) {}
  }

  function ensureUI() {
    if (toggleBtn && !D.body.contains(toggleBtn)) toggleBtn = null;
    if (!toggleBtn) toggleBtn = D.querySelector(".cc-autoscroll-toggle");
    var strays = D.querySelectorAll(".cc-autoscroll-toggle:not(.cc-toolbar-btn)");
    for (var i = 0; i < strays.length; i++) { try { strays[i].remove(); } catch (e) {} }
    if (toggleBtn && !toggleBtn.classList.contains("cc-toolbar-btn")) toggleBtn = null;
    if (!toggleBtn) toggleBtn = D.querySelector(".cc-autoscroll-toggle.cc-toolbar-btn");

    if (!toggleBtn) {
      var spec = {
        id: "autoscroll",
        icon: locked ? "\\u23F8" : "\\u23F5",
        label: "Lock scroll position while reading a streaming reply",
        order: 42,
        onClick: function () { setLocked(!locked); },
      };
      if (W.__ccToolbar && W.__ccToolbar.add) {
        toggleBtn = W.__ccToolbar.add(spec);
        if (toggleBtn && !toggleBtn.classList.contains("cc-autoscroll-toggle")) toggleBtn.classList.add("cc-autoscroll-toggle");
      } else {
        (W.__ccToolbarQueue = W.__ccToolbarQueue || []).push(spec);
      }
    }
    updateButton();
  }

  function init(doc, win) {
    D = doc;
    W = win || window;
    locked = readInitial();
    toggleBtn = null;
    boundContainer = null;
    heldTop = null;
    try { ensureUI(); bindScrollListener(); } catch (e) {}
    try {
      if (holdTimer) W.clearInterval(holdTimer);
      holdTimer = W.setInterval(function () {
        try { bindScrollListener(); tick(); } catch (e) {}
      }, HOLD_INTERVAL_MS);
    } catch (e) {}
    try {
      if (W.__ccObserve) {
        W.__ccObserve(D.body, function () { try { ensureUI(); bindScrollListener(); } catch (e) {} }, {
          ownClass: "cc-autoscroll-toggle",
          ownAttrPrefix: "data-cc-autoscroll",
        });
      }
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
/* AutoScroll toggle lives inside the shared toolbar (.cc-toolbar-btn). No extra
   rules are needed for the LOCKED state — the toolbar's own
   [aria-pressed="true"] rule (behaviorToolbar.ts's TOOLBAR_CSS) already turns
   the chip accent-colored the moment updateButton() sets aria-pressed. */
`.trim();

registerFeature({
  id: "autoscroll",
  label: "Auto-scroll lock (hold position while a reply streams)",
  js: JS,
  css: CSS,
});
