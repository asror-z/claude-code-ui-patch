import { registerFeature } from "./behaviorFeatures";

const JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-askcol] Chat AskCollapse Feature.js loaded");
  } catch (e) {}

  var BTN_ATTR = "data-cc-askcol-btn";       // marks OUR toggle button
  var STATE_ATTR = "data-cc-askcol";         // "expanded" | "collapsed" on the card
  var BACKDROP_ATTR = "data-cc-askcol-backdrop"; // marks the neutralized backdrop
  var KEEP_ATTR = "data-cc-askcol-keep";     // marks the header strip to keep visible

  // D = the chat document (bound in init()).
  var D = document;
  var W = window;

  var COLLAPSE_ICON = "▁";  // collapse (minimize to a bar)
  var EXPAND_ICON = "⭱";    // expand (restore)

  function chatRoot() {
    return D.getElementById("root") || D.body;
  }

  // ---- diagnose: log the real modal DOM shape so selectors are confirmed ---------
  var _lastDiag = 0;
  function diagnose(closeBtns, cards) {
    try {
      var now = (W.performance && W.performance.now) ? W.performance.now() : 0;
      if (now && _lastDiag && now - _lastDiag < 4000) return; // throttle 1 / 4s
      _lastDiag = now || _lastDiag;
      var sample = function (el) {
        if (!el) return "";
        var cn = (el.getAttribute && el.getAttribute("class")) || "";
        return (el.tagName || "") + "|" + String(cn).slice(0, 80);
      };
      var payload = {
        kind: "cc.dom.diagnose",
        feature: "askcollapse",
        closeBtnCount: closeBtns ? closeBtns.length : 0,
        cardCount: cards ? cards.length : 0,
        closeBtnSample: closeBtns && closeBtns[0] ? sample(closeBtns[0]) : "",
        cardSample: cards && cards[0] ? sample(cards[0]) : "",
        cardParentChain: cards && cards[0] ? parentChain(cards[0]) : "",
        toggled: !!(D.querySelector("[" + BTN_ATTR + "]")),
      };
      try { console.debug("[cc-askcol] diagnose", payload); } catch (e) {}
    } catch (e) {}
  }

  /**
   * A compact "TAG.classPrefix > TAG.classPrefix > …" chain up to 6 ancestors, so a diagnose record reveals the modal/backdrop structure without logging any text.
   * @param {Element} el - Element to walk up from.
   * @returns {string} The compact ancestor chain.
   */
  function parentChain(el) {
    var out = [];
    var n = el, hops = 0;
    while (n && n.nodeType === 1 && hops < 6) {
      var cn = (n.getAttribute && n.getAttribute("class")) || "";
      var pos = "";
      try {
        var cs = W.getComputedStyle ? W.getComputedStyle(n) : null;
        if (cs) pos = cs.position;
      } catch (e) {}
      out.push((n.tagName || "") + (cn ? "." + String(cn).split(/\s+/)[0] : "") + (pos ? "(" + pos + ")" : ""));
      n = n.parentElement; hops++;
    }
    return out.join(" > ");
  }

  // ---- structural discovery (no brittle literal class) ---------------------------

  // Does this element look like the native CLOSE (✕) control of a dialog?
  var CLOSE_LABEL_RE = /\b(close|dismiss|cancel)\b/i;
  function isCloseControl(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.getAttribute(BTN_ATTR) === "1") return false; // never our own button
    var tag = el.tagName;
    if (tag !== "BUTTON" && el.getAttribute("role") !== "button" && tag !== "A") return false;
    var label = (el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
    if (label && CLOSE_LABEL_RE.test(label)) return true;
    // glyph-only close: a short "×"/"✕"/"╳" text, or an <svg> with no other text
    var txt = (el.textContent || "").trim();
    if (txt && txt.length <= 2 && /[×✕╳✖]/.test(txt)) return true;
    if (el.querySelector && el.querySelector("svg") && txt.length === 0) {
      // an icon button with no text sitting near the top of a dialog — candidate
      return true;
    }
    return false;
  }

  /**
   * Find candidate close controls that live inside an AskUserQuestion-looking dialog.
   * @returns {Element[]} Matching close-control elements.
   */
  function findCloseControls() {
    var root = chatRoot();
    var buttons = root.querySelectorAll(
      "button,[role='button'],a[href='#'],a:not([href])"
    );
    var hits = [];
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      if (isCloseControl(b) && insideDialog(b)) hits.push(b);
    }
    return hits;
  }

  /**
   * LENIENT dialog-ish test — used only to SCOPE which close controls live inside a modal / question area (insideDialog).
   * A header/footer/title sub-part matching here is fine, it only widens the "we are inside a dialog" check.
   * "permission" covers the inline layout's permissionsContainer (the AskUserQuestion host in current builds).
   * @param {Element} el - Candidate element.
   * @returns {boolean} True if the element looks dialog-ish.
   */
  function isDialogish(el) {
    if (!el || el.nodeType !== 1) return false;
    var role = el.getAttribute("role");
    if (role === "dialog" || role === "alertdialog") return true;
    var cn = (el.getAttribute("class") || "");
    return /dialog|modal|popover|question|askuser|permission/i.test(cn);
  }

  var SCOPE_RE = /dialog|modal|popover|askuser|question|permission/i;
  /**
   * Is this card (or a near ancestor) inside an AskUserQuestion / permission scope?
   * Filters out cards that only resolved via geometry (e.g. the composer's own inputContainer picked up as a panel fallback) — those never get a toggle.
   * @param {Element} card - Candidate card element.
   * @returns {boolean} True if the card is within a question scope.
   */
  function withinQuestionScope(card) {
    var n = card, hops = 0;
    while (n && n !== D.body && hops < 5) {
      var role = n.getAttribute && n.getAttribute("role");
      if (role === "dialog" || role === "alertdialog") return true;
      var cn = (n.getAttribute && n.getAttribute("class")) || "";
      if (SCOPE_RE.test(cn)) return true;
      n = n.parentElement; hops++;
    }
    return false;
  }

  var CARD_SUBPART_RE = /header|footer|title|titlebar|body|content|actions|toolbar|controls/i;
  /**
   * STRICT dialog-CARD test — the actual modal panel we collapse.
   * role=dialog is the strong signal.
   * A class match is accepted ONLY for container-ish words and NOT for a sub-part of a dialog (header/footer/title/body/content/actions), so "dialog_header" never masquerades as the card.
   * This is the fix for cardFor resolving the header instead of the panel.
   * @param {Element} el - Candidate element.
   * @returns {boolean} True if the element is the dialog card.
   */
  function isDialogCard(el) {
    if (!el || el.nodeType !== 1) return false;
    var role = el.getAttribute("role");
    if (role === "dialog" || role === "alertdialog") return true;
    var cn = (el.getAttribute("class") || "");
    if (CARD_SUBPART_RE.test(cn)) return false; // a sub-part, not the card
    return /dialog|modal|popover|askuser/i.test(cn);
  }

  /**
   * Is 'el' inside something dialog-ish OR a positioned overlay? (used to filter close controls to only those in a real modal, not e.g. a toolbar ✕).
   * @param {Element} el - Candidate element.
   * @returns {boolean} True if inside a dialog/overlay.
   */
  function insideDialog(el) {
    var n = el;
    var hops = 0;
    while (n && n !== D.body && hops < 12) {
      if (isDialogish(n)) return true;
      if (isBackdrop(n)) return true;
      n = n.parentElement; hops++;
    }
    return false;
  }

  function cardFor(closeBtn) {
    var child = closeBtn;
    var n = closeBtn.parentElement;
    var hops = 0;
    var fallback = null;
    while (n && n !== D.body && hops < 12) {
      // the STRICT card test — role=dialog or a container-class (not a sub-part), so we never stop at the header/footer that holds the ✕.
      if (isDialogCard(n)) return n;
      // SLIM-HEADER heuristic — the inline AskUserQuestion card has no dialog class and no backdrop: the card is the deepest sizeable ancestor whose direct child holding the ✕ is a slim header strip with bulky siblings to hide.
      if (isCardBySlimHeader(n, child)) return n;
      // remember a positioned, sizeable panel as a fallback card
      if (!fallback && isPanel(n)) fallback = n;
      // stop climbing at the backdrop — the card is the child just under it
      if (isBackdrop(n.parentElement)) return n;
      child = n;
      n = n.parentElement; hops++;
    }
    return fallback || (closeBtn.parentElement && closeBtn.parentElement.parentElement) || closeBtn.parentElement;
  }

  /**
   * Card test via the header shape: 'h' (the direct child of 'A' on the ✕'s path) must be a slim strip while 'A' is a sizeable card with other (bulky) children — and 'A' must NOT host the live composer (a card never contains a textarea).
   * With no layout (jsdom), falls back to structural cues instead of pixel sizes.
   * @param {Element} A - Candidate card ancestor.
   * @param {Element} h - The header child on the close button's path.
   * @returns {boolean} True if A qualifies as the card via the slim-header heuristic.
   */
  function isCardBySlimHeader(A, h) {
    if (!A || !h || h.parentElement !== A) return false;
    if (!A.children || A.children.length < 2) return false;
    try { if (A.querySelector("textarea,[contenteditable='true']")) return false; } catch (e) { return false; }
    var ar = null, hr = null;
    try {
      ar = A.getBoundingClientRect ? A.getBoundingClientRect() : null;
      hr = h.getBoundingClientRect ? h.getBoundingClientRect() : null;
    } catch (e) {}
    if (ar && hr && (ar.height || hr.height)) {
      // layout path (real webview)
      if (ar.width < 240 || ar.height < 120) return false;
      return hr.height > 0 && hr.height <= Math.max(64, ar.height * 0.35);
    }
    // structural path (no layout): the header holds no options/inputs, a sibling does
    if (h.querySelector && h.querySelector("input,select,textarea,[role='radio'],[role='option']")) return false;
    var kids = A.children;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k === h || !k.querySelector) continue;
      if (k.querySelector("button,input,select,textarea,[role='radio'],[role='option']") ||
          String(k.textContent || "").trim().length > 80) return true;
    }
    return false;
  }

  function isPanel(el) {
    try {
      var cs = W.getComputedStyle ? W.getComputedStyle(el) : null;
      if (!cs) return false;
      if (cs.position !== "relative" && cs.position !== "absolute" && cs.position !== "fixed" && cs.position !== "static") return false;
      var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      return !!(r && r.width >= 240 && r.height >= 80);
    } catch (e) { return false; }
  }

  /**
   * A backdrop/overlay = a fixed or absolute ancestor that spans (near) the whole viewport.
   * That is what dims the chat and blocks clicks.
   * @param {Element} el - Candidate element.
   * @returns {boolean} True if the element is a backdrop/overlay.
   */
  function isBackdrop(el) {
    if (!el || el.nodeType !== 1 || el === D.body) return false;
    try {
      var cs = W.getComputedStyle ? W.getComputedStyle(el) : null;
      if (!cs) return false;
      if (cs.position !== "fixed" && cs.position !== "absolute") return false;
      var r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      if (!r) return false;
      var vw = W.innerWidth || (D.documentElement && D.documentElement.clientWidth) || 0;
      var vh = W.innerHeight || (D.documentElement && D.documentElement.clientHeight) || 0;
      if (!vw || !vh) return false;
      return r.width >= vw * 0.85 && r.height >= vh * 0.6;
    } catch (e) { return false; }
  }

  function backdropFor(card) {
    var n = card.parentElement;
    var hops = 0;
    while (n && n !== D.body && hops < 8) {
      if (isBackdrop(n)) return n;
      n = n.parentElement; hops++;
    }
    // the card itself may be the backdrop (overlay === card)
    if (isBackdrop(card)) return card;
    return null;
  }

  /**
   * Only a TRUE modal backdrop may be neutralized: position:fixed always qualifies; an absolute overlay qualifies only when it hosts no live composer OUTSIDE the card — the inline layout's inputContainer (which holds the composer textarea) must never be made transparent + click-through.
   * @param {Element} card - The resolved dialog card.
   * @returns {Element|null} The safe backdrop element, or null.
   */
  function safeBackdropFor(card) {
    var bd = backdropFor(card);
    if (!bd) return null;
    try {
      var cs = W.getComputedStyle ? W.getComputedStyle(bd) : null;
      if (cs && cs.position === "fixed") return bd;
    } catch (e) {}
    try {
      var eds = bd.querySelectorAll("textarea,[contenteditable='true']");
      for (var i = 0; i < eds.length; i++) {
        if (!card.contains(eds[i])) return null;
      }
    } catch (e) { return null; }
    return bd;
  }

  /**
   * The header strip to keep visible when collapsed = the child of the card that CONTAINS the close button (so title + our toggle + ✕ stay on-screen).
   * @param {Element} card - The resolved dialog card.
   * @param {Element} closeBtn - The close-control element.
   * @returns {Element|null} The header strip element to keep visible.
   */
  function headerFor(card, closeBtn) {
    var n = closeBtn;
    while (n && n.parentElement && n.parentElement !== card) n = n.parentElement;
    // n is now the direct child of the card that holds the close control
    return (n && n.parentElement === card) ? n : (card.firstElementChild || null);
  }

  // ---- collapse / expand ---------------------------------------------------------

  function setCollapsed(card, closeBtn, collapsed) {
    if (!card) return;
    var header = headerFor(card, closeBtn);
    // mark the header to keep visible
    var kids = card.children;
    for (var i = 0; i < kids.length; i++) {
      if (header && kids[i] === header) kids[i].setAttribute(KEEP_ATTR, "1");
      else kids[i].removeAttribute(KEEP_ATTR);
    }
    card.setAttribute(STATE_ATTR, collapsed ? "collapsed" : "expanded");

    var backdrop = safeBackdropFor(card);
    if (backdrop) {
      if (collapsed) backdrop.setAttribute(BACKDROP_ATTR, "1");
      else backdrop.removeAttribute(BACKDROP_ATTR);
    }
    // update our button glyph + labels
    var btn = card.querySelector("[" + BTN_ATTR + "]");
    if (btn) {
      btn.textContent = collapsed ? EXPAND_ICON : COLLAPSE_ICON;
      var lbl = collapsed ? "Expand question" : "Collapse question";
      btn.setAttribute("aria-label", lbl);
      btn.setAttribute("title", lbl);
      btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }
  }

  function makeToggle(card, closeBtn) {
    var btn = D.createElement("button");
    btn.type = "button";
    btn.className = "cc-askcol-btn cc-btn";
    btn.setAttribute(BTN_ATTR, "1");
    btn.textContent = COLLAPSE_ICON;
    btn.setAttribute("aria-label", "Collapse question");
    btn.setAttribute("title", "Collapse question");
    btn.setAttribute("aria-expanded", "true");
    btn.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      var collapsed = card.getAttribute(STATE_ATTR) === "collapsed";
      setCollapsed(card, closeBtn, !collapsed); // toggle
    });
    return btn;
  }

  /**
   * Ensure OUR toggle sits immediately to the LEFT of the native ✕ (same parent).
   * @param {Element} card - The resolved dialog card.
   * @param {Element} closeBtn - The close-control element.
   * @returns {Element} The toggle button, existing or newly created.
   */
  function ensureToggle(card, closeBtn) {
    var parent = closeBtn.parentElement;
    if (!parent) return;
    var existing = card.querySelector("[" + BTN_ATTR + "]");
    if (existing && existing.parentElement === parent && existing.nextElementSibling === closeBtn) {
      return existing; // already correctly placed
    }
    if (existing && existing.parentElement) existing.parentElement.removeChild(existing);
    var btn = makeToggle(card, closeBtn);
    parent.insertBefore(btn, closeBtn); // to the LEFT of ✕
    return btn;
  }

  function processDialog(card, closeBtn) {
    if (!card) return false;
    // initialise state attr once (expanded) so CSS has something to key off
    if (!card.getAttribute(STATE_ATTR)) card.setAttribute(STATE_ATTR, "expanded");
    ensureToggle(card, closeBtn);
    // re-apply collapsed styling if React re-rendered the card while collapsed
    if (card.getAttribute(STATE_ATTR) === "collapsed") setCollapsed(card, closeBtn, true);
    return true;
  }

  /**
   * Among a card's close candidates pick the BEST: a labeled/glyph close control beats a bare svg icon button; ties go to the one nearest the card's top-right.
   * @param {Element} b - Candidate close-control element.
   * @returns {number} Score for the candidate (higher is better).
   */
  function closeScore(b) {
    var label = (b.getAttribute("aria-label") || b.getAttribute("title") || "").trim();
    if (label && CLOSE_LABEL_RE.test(label)) return 2;
    var txt = (b.textContent || "").trim();
    if (txt && txt.length <= 2 && /[×✕╳✖]/.test(txt)) return 2;
    return 1;
  }
  function bestCloseBtn(list, card) {
    var best = null, bestScore = -1, bestDist = Infinity;
    var cr = null;
    try { cr = card.getBoundingClientRect ? card.getBoundingClientRect() : null; } catch (e) {}
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      var s = closeScore(b);
      var d = 0;
      try {
        var br = cr && b.getBoundingClientRect ? b.getBoundingClientRect() : null;
        if (br) d = Math.abs(cr.right - br.right) + Math.abs(br.top - cr.top);
      } catch (e) {}
      if (s > bestScore || (s === bestScore && d < bestDist)) { best = b; bestScore = s; bestDist = d; }
    }
    return best;
  }

  var warned = false;
  function run() {
    var closeBtns = findCloseControls();
    var cards = [];   // unique, in-scope resolved cards
    var byCard = [];  // parallel: candidate close buttons per card
    for (var i = 0; i < closeBtns.length; i++) {
      var card = cardFor(closeBtns[i]);
      // geometry-only resolutions (e.g. the composer's inputContainer as a panel
      // fallback) are rejected — a toggle only ever docks into a question card.
      if (!card || !withinQuestionScope(card)) continue;
      var idx = cards.indexOf(card);
      if (idx < 0) { cards.push(card); byCard.push([closeBtns[i]]); }
      else byCard[idx].push(closeBtns[i]);
    }
    var attached = 0;
    for (var c = 0; c < cards.length; c++) {
      var btn = bestCloseBtn(byCard[c], cards[c]);
      if (btn && processDialog(cards[c], btn)) attached++;
    }
    // remove stray toggles left outside every resolved card (stale placements from an earlier sweep against a since-changed layout)
    var strays = D.querySelectorAll("[" + BTN_ATTR + "]");
    for (var s = 0; s < strays.length; s++) {
      var inCard = false;
      for (var c2 = 0; c2 < cards.length; c2++) {
        if (cards[c2].contains(strays[s])) { inCard = true; break; }
      }
      if (!inCard && strays[s].parentElement) strays[s].parentElement.removeChild(strays[s]);
    }
    diagnose(closeBtns, cards);

    // fail-loud-once: an AskUserQuestion-looking dialog exists but we resolved no card
    if (!warned && closeBtns.length === 0) {
      var probablyDialog = chatRoot().querySelector(
        "[role='dialog'],[role='alertdialog'],[class*='dialog'],[class*='modal'],[class*='question' i]"
      );
      if (probablyDialog) {
        warned = true;
        try { console.warn("[cc-askcol] a dialog-like element is present but no close (✕) control resolved — selector may have drifted"); } catch (e) {}
      }
    }
  }

  var pending = null;
  function schedule(mutations) {
    // ignore mutations confined to our own button (self-churn from glyph swaps)
    if (mutations && mutations.length) {
      var external = false;
      for (var i = 0; i < mutations.length; i++) {
        var t = mutations[i].target;
        if (!(t && t.closest && t.closest("[" + BTN_ATTR + "]"))) { external = true; break; }
      }
      if (!external) return;
    }
    if (pending) return;
    pending = W.setTimeout(function () {
      pending = null;
      try { run(); } catch (e) {}
    }, 120);
  }

  // ---- stale-on-tab-return sweep --------------------------------------------------
  /**
   * A VS Code editor tab's webview is throttled/suspended while hidden.
   * If an AskUserQuestion suggestion chip is mid-animation/reposition at the moment the tab loses visibility, it can freeze mid-frame and repaint stuck — floating over the composer/toolbar of whichever tab is active when the frame finally resumes (reported live: a suggestion chip from one tab visible over a DIFFERENT tab's composer, clearing only after switching away and back once more).
   * This is a rendering artifact of VS Code's own webview suspend/resume, not a DOM node our script created or owns — the fix is a forced reflow of any floating, question-scoped element the moment the tab becomes visible again, which is enough to make the browser repaint it at its correct position/visibility instead of the frozen stale one.
   * @param {Element} el - Candidate element.
   * @returns {boolean} True if the element is a floating, question-scoped element.
   */
  function isFloatingQuestionEl(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      var cs = W.getComputedStyle ? W.getComputedStyle(el) : null;
      if (!cs || (cs.position !== "fixed" && cs.position !== "absolute")) return false;
      if (cs.display === "none" || cs.visibility === "hidden") return false;
    } catch (e) { return false; }
    return withinQuestionScope(el) || isDialogish(el);
  }

  function resweepOnVisible() {
    try {
      var root = chatRoot();
      var candidates = root.querySelectorAll(
        "[role='dialog'],[role='alertdialog'],[class*='dialog'],[class*='modal'],[class*='question' i],[class*='askUser' i]"
      );
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        if (!isFloatingQuestionEl(el)) continue;
        /*
         * Force a reflow: toggling a no-op inline style property makes the engine recompute layout/paint for this element instead of reusing a stale frame left over from before the tab was suspended.
         * Reading offsetHeight forces the flush; the display toggle nudges a truly-orphaned overlay to actually disappear if its own logic already decided it should be gone.
         */
        var prevDisplay = el.style.display;
        el.style.display = "none";
        void el.offsetHeight; // force reflow
        el.style.display = prevDisplay;
      }
      run();
    } catch (e) {}
  }

  /**
   * init(doc, win) — called directly with (document, window) once real chat DOM is detected; bind + observe it.
   * @param {Document} doc - The real chat document.
   * @param {Window} win - The real chat window.
   * @returns {void}
   */
  function init(doc, win) {
    D = doc;
    W = win || window;
    try { run(); } catch (e) {}
    try {
      new W.MutationObserver(schedule).observe(D.body, {
        childList: true,
        subtree: true,
      });
    } catch (e) {}
    try {
      D.addEventListener("visibilitychange", function () {
        if (D.visibilityState === "visible") resweepOnVisible();
      });
    } catch (e) {}
  }

  register(init);

  /**
   * Order-independent registration: if the bootstrap is already installed, hand off now; otherwise queue onto window.__ccPending — the bootstrap drains it the moment it installs.
   * A last-resort timer covers the impossible case where no bootstrap ever appears, running once against the current document.
   * @param {Function} fn - The init function to hand off once the chat document is ready.
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
   AskCollapse — collapse/expand toggle for the AskUserQuestion modal dialog.
   Injected as part of the assembled inline <script>/<style> block.

   The JS tags:
     * OUR toggle button      -> button.cc-askcol-btn[data-cc-askcol-btn="1"]
     * the dialog CARD        -> [data-cc-askcol="expanded"|"collapsed"]
     * the header strip kept  -> [data-cc-askcol-keep="1"]  (direct child of the card)
     * the neutralized backdrop -> [data-cc-askcol-backdrop="1"]

   CSS does the visual work: hide the body when collapsed, keep only the header, and drop the backdrop dim + pointer-blocking so the chat behind is readable.
*/

/* Our toggle button — sits immediately LEFT of the native ✕, styled like the ✕. */
button.cc-askcol-btn[data-cc-askcol-btn="1"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.6em;
  height: 1.6em;
  padding: 0 0.3em;
  margin: 0 0.25em 0 0;
  font-size: 1em;
  line-height: 1;
  cursor: pointer;
  border: none;
  border-radius: var(--cc-radius, 6px);
  background: transparent;
  color: inherit;
  opacity: 0.75;
}
button.cc-askcol-btn[data-cc-askcol-btn="1"]:hover {
  opacity: 1;
  background: var(--cc-chip-bg, var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.18)));
}

/* ---- COLLAPSED state ------------------------------------------------------- */

/*
   When the card is collapsed, hide every DIRECT child except the kept header strip.
   (Direct-child scope keeps the header's own contents — title + our toggle + ✕ — fully visible.)
*/
[data-cc-askcol="collapsed"] > :not([data-cc-askcol-keep="1"]) {
  display: none !important;
}

/* Shrink the collapsed card to just the slim header bar. */
[data-cc-askcol="collapsed"] {
  min-height: 0 !important;
  height: auto !important;
  max-height: none !important;
}

/*
   Neutralized backdrop — transparent + click-through so the chat behind is BOTH visible and scrollable.
   The card sits ON the backdrop, so re-enable pointer events on the card itself (and our controls) even though the backdrop ignores them.
*/
[data-cc-askcol-backdrop="1"] {
  background: transparent !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  pointer-events: none !important;
}
/* the collapsed dialog card (and its kept header + our button) stay interactive */
[data-cc-askcol-backdrop="1"] [data-cc-askcol="collapsed"],
[data-cc-askcol="collapsed"],
[data-cc-askcol="collapsed"] [data-cc-askcol-keep="1"],
[data-cc-askcol="collapsed"] button.cc-askcol-btn[data-cc-askcol-btn="1"] {
  pointer-events: auto !important;
}
`.trim();

registerFeature({ id: "askcollapse", label: "Collapse the question card", js: JS, css: CSS });
