import { registerFeature } from "./behaviorFeatures";

const JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-usernav] Chat UserNav Feature.js loaded");
  } catch (e) {}

  var NAV_FLASH_CLASS = "cc-nav-flash"; // transient highlight on a navigated-to user msg

  /*
   * The user-bubble selector (the REAL prompt bubbles) and the exclusions.
   * Exclusions: the composer/scroll containers, and the sticky-header DUPLICATE of a bubble.
   */
  var USER_SELECTOR = "[class*='userMessageContainer'],[class*='userMessage']";
  var EXCLUDE_RE = /messageInput|messagesContainer|messageGradient|fullEditor|stickyHeader/i;

  // D/W = the chat Document/Window (set by init()).
  var D = document;
  var W = window;

  /*
   * --- icons: single GLYPHS, not SVG strings ---
   * The shared toolbar renders an action's \`icon\` via textContent, so an SVG markup string would show as raw text.
   * Use plain arrow glyphs, exactly like Scroll's arrows.
   */
  var ICON_UP = "↑";   // Up arrow  Previous user message
  var ICON_DOWN = "↓"; // Down arrow  Next user message

  // --- collection ------------------------------------------------------------
  /**
   * True if this element is an excluded non-message container or a sticky-header duplicate.
   * @param {Element} el - the element to test.
   * @returns {boolean} true if el should be excluded.
   */
  function isExcluded(el) {
    var cn = (el.getAttribute && el.getAttribute("class")) || "";
    return EXCLUDE_RE.test(cn);
  }

  /**
   * Collect, in document order, the OUTERMOST real USER bubbles.
   * Read-only: this NEVER mutates the DOM, so it can never trigger an observer / freeze loop.
   * @returns {Element[]} the outermost user bubbles, in document order.
   */
  function userBubbles() {
    var nodes = D.querySelectorAll ? D.querySelectorAll(USER_SELECTOR) : [];
    var all = [];
    for (var i = 0; i < nodes.length; i++) {
      if (isExcluded(nodes[i])) continue;
      all.push(nodes[i]);
    }
    // outermost-only within the kept set
    var out = [];
    for (var k = 0; k < all.length; k++) {
      var p = all[k].parentElement, nested = false;
      while (p) { if (all.indexOf(p) !== -1) { nested = true; break; } p = p.parentElement; }
      if (!nested) out.push(all[k]);
    }
    // document order
    out.sort(function (a, b) {
      var pos = a.compareDocumentPosition(b);
      if (pos & 4) return -1; if (pos & 2) return 1; return 0;
    });
    return out;
  }

  /**
   * Add a transient highlight class, removed after ~1s (CSS animates it).
   * @param {Element} el - the element to flash.
   * @returns {void}
   */
  function flashEl(el) {
    try {
      el.classList.add(NAV_FLASH_CLASS);
      W.setTimeout(function () {
        try { el.classList.remove(NAV_FLASH_CLASS); } catch (e) {}
      }, 1100);
    } catch (e) {}
  }

  /**
   * Sequential nav: from the user bubble we are currently "on" (the one whose top is nearest the viewport top), step exactly ONE message — dir=-1 previous, dir=+1 next — and land at its TOP (block:"start"), so its first paragraph sits at the viewport top.
   * Detection and landing share the SAME edge (the viewport top): after scrolling bubble N to the top, nearest-to-top is N, so the next step is exactly N±1 — reliable one-at-a-time navigation (the earlier top-vs-center mismatch failed to advance).
   * @param {number} dir - -1 for previous, +1 for next.
   * @returns {void}
   */
  function gotoUser(dir) {
    var bubbles = userBubbles();
    if (!bubbles.length) return;
    // the bubble nearest the viewport top = the one we are on now
    var here = 0, bestD = Infinity;
    for (var i = 0; i < bubbles.length; i++) {
      var top;
      try { top = bubbles[i].getBoundingClientRect().top; } catch (e) { continue; }
      var d = Math.abs(top);
      if (d < bestD) { bestD = d; here = i; }
    }
    var idx = here + dir;
    if (idx < 0 || idx >= bubbles.length) return; // already at the first/last — no-op
    var target = bubbles[idx];
    try {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      try { target.scrollIntoView(); } catch (x) {}
    }
    flashEl(target);
  }

  // --- toolbar registration (mirrors the Scroll feature) ---------------------
  /**
   * A fixed floating fallback button used only when the shared toolbar is absent.
   * @param {string} cls - the button's own CSS class.
   * @param {string} glyph - the button's text glyph.
   * @param {string} label - the aria-label/title text.
   * @param {Function} onClick - the click handler.
   * @param {string} bottom - the CSS bottom offset.
   * @returns {Element} the created button.
   */
  function fallbackButton(cls, glyph, label, onClick, bottom) {
    var b = D.createElement("button");
    b.type = "button";
    b.className = cls + " cc-btn";
    b.textContent = glyph;
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

  function ensureUI() {
    if (W.__ccToolbar && W.__ccToolbar.add) {
      /*
       * Toolbar owns these actions.
       * Remove any stray standalone fallback buttons (created before the toolbar loaded) so they never double.
       */
      var strays = D.querySelectorAll(".cc-usernav-up:not(.cc-toolbar-btn),.cc-usernav-down:not(.cc-toolbar-btn)");
      for (var sI = 0; sI < strays.length; sI++) { try { strays[sI].remove(); } catch (e) {} }
      // order 10/11 → LEFT end of the toolbar, before Toc (20) / Export (30) / Scroll (40).
      W.__ccToolbar.add({ id: "usernav-up", icon: ICON_UP, label: "Previous user message", order: 10, onClick: function () { gotoUser(-1); } });
      W.__ccToolbar.add({ id: "usernav-down", icon: ICON_DOWN, label: "Next user message", order: 11, onClick: function () { gotoUser(+1); } });
      var up = W.__ccToolbar.get && W.__ccToolbar.get("usernav-up");
      if (up) up.classList.add("cc-usernav-up");
      var dn = W.__ccToolbar.get && W.__ccToolbar.get("usernav-down");
      if (dn) dn.classList.add("cc-usernav-down");
    } else if (!D.querySelector(".cc-usernav-up")) {
      fallbackButton("cc-usernav-up", ICON_UP, "Previous user message", function () { gotoUser(-1); }, "172px");
      fallbackButton("cc-usernav-down", ICON_DOWN, "Next user message", function () { gotoUser(+1); }, "210px");
    }
  }

  /**
   * Called with the chat document/window directly.
   * No observer: the toolbar owns re-docking when the composer re-renders, exactly like Scroll/Toc.
   * @param {Document} doc - the chat document.
   * @param {Window} [win] - the chat window, defaults to window.
   * @returns {void}
   */
  function init(doc, win) {
    D = doc;
    W = win || window;
    try { ensureUI(); } catch (e) {}
  }

  register(init);

  /**
   * Order-independent registration.
   * If the bootstrap is already installed, hand off now; otherwise queue onto window.__ccPending — the bootstrap drains it once it installs.
   * A last-resort timer covers the impossible case where no bootstrap ever appears.
   * @param {Function} fn - the init(doc, win) callback to register.
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
 * Chat UserNav feature — styles for the two prev/next USER-message actions.
 * UserNav is TOOLBAR-BASED: its up/down buttons live inside the shared composer toolbar (registered via window.__ccToolbar), so their chip styling comes from the toolbar's own .cc-toolbar-btn rules — this stylesheet only needs the fallback floating-button look (used when the toolbar is absent) and the shared navigate-to flash pulse.
 * There is NO per-message element and NO positioning host, so the old .cc-usernav-group / host rules are gone (that per-bubble design self-churned into a freeze loop).
 */

/*
 * Fallback floating buttons — only used when the shared toolbar is absent.
 * When the toolbar is present these render inside it and inherit .cc-toolbar-btn styling.
 */
.cc-usernav-up,
.cc-usernav-down {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-charts-purple, #b083f0);
  box-shadow: var(--cc-shadow-sm, 0 2px 8px rgba(0, 0, 0, 0.35));
  opacity: 0.82;
}
.cc-usernav-up:hover,
.cc-usernav-down:hover { opacity: 1; }

.cc-usernav-up svg,
.cc-usernav-down svg {
  display: block;
  pointer-events: none;
}

/*
 * Transient highlight on a user message we navigated to (Previous/Next).
 * A soft pulse that fades; removed by the JS after ~1s.
 * This mirrors CopyButtons' .cc-nav-flash so the effect is present even when UserNav is injected WITHOUT CopyButtons (a features= subset); when both are injected the identical rules are harmlessly deduplicated.
 */
.cc-nav-flash {
  animation: cc-nav-pulse 1s ease-out 1;
  border-radius: 8px;
}

@keyframes cc-nav-pulse {
  0% {
    box-shadow: 0 0 0 3px var(--vscode-focusBorder, #4ea1ff);
    background-color: var(--vscode-editor-selectionHighlightBackground, rgba(78, 161, 255, 0.25));
  }
  100% {
    box-shadow: 0 0 0 3px transparent;
    background-color: transparent;
  }
}
`.trim();

registerFeature({ id: "usernav", label: "User-message nav (up/down)", js: JS, css: CSS });
