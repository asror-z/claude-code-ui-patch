import { registerFeature } from "./behaviorFeatures";

const JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-blockquote] Chat Blockquote Feature.js loaded");
  } catch (e) {}

  var TAG = "data-cc-blockquote";
  var INTERRUPT_TAG = "data-cc-interrupt"; // a "Tool interrupted"/aborted system block

  // D = the chat document (set by the bootstrap in init()).
  var D = document;
  var W = window;

  /* Minified webviews sometimes render a quote as a <div>/<p> with a
     blockquote-ish class instead of a real <blockquote>.
     Catch those too. */
  var QUOTE_SELECTORS = [
    "blockquote",
    "[class*='blockquote']",
    "[class*='Blockquote']",
    "[class*='callout']",
    "[class*='Callout']",
  ];

  function run() {
    var set = new Set();
    for (var i = 0; i < QUOTE_SELECTORS.length; i++) {
      var nodes = D.querySelectorAll(QUOTE_SELECTORS[i]);
      for (var j = 0; j < nodes.length; j++) set.add(nodes[j]);
    }
    set.forEach(function (el) {
      if (el.getAttribute(TAG) !== "1") el.setAttribute(TAG, "1");
    });
    tagInterrupts();
  }

  /* Tag "Tool interrupted" / aborted / cancelled SYSTEM notice blocks with
     data-cc-interrupt="1" so the CSS can paint them light-red — distinct from a
     user message (UserStyle blue) and a normal blockquote.
     We match either a class cue (/interrupt|aborted|cancelled|canceled/i) or a
     text cue ("Tool interrupted"), and tag the OUTERMOST such block (skip if an
     ancestor already carries the tag) so the whole notice is painted once, not
     per child. */
  var INTERRUPT_CLASS_RE = /interrupt|aborted|cancelled|canceled/i;
  var INTERRUPT_TEXT_RE = /^(tool interrupted|interrupted by user|request interrupted)/i;

  function isInterruptEl(el) {
    var cn = (el.getAttribute && el.getAttribute("class")) || "";
    if (INTERRUPT_CLASS_RE.test(cn)) return true;
    var txt = (el.textContent || "").trim();
    /* Text cue: the block's trimmed text must START with the interrupt phrase
       (anchored), so a parent/conversation container that merely CONTAINS the
       phrase deeper down is NOT matched.
       Only the notice block itself is. */
    if (txt.length <= 400 && INTERRUPT_TEXT_RE.test(txt)) return true;
    return false;
  }

  function tagInterrupts() {
    /* candidates: small blocks by class, plus any element whose own short text
       starts the interrupt phrase.
       Scan a bounded set of block-ish elements. */
    var candidates = D.querySelectorAll(
      "div,p,span,section,blockquote,[class*='message'],[class*='callout'],[class*='notice']"
    );
    var hits = [];
    for (var i = 0; i < candidates.length; i++) {
      if (isInterruptEl(candidates[i])) hits.push(candidates[i]);
    }
    for (var k = 0; k < hits.length; k++) {
      var el = hits[k];
      // outermost-only: skip if an ancestor is also a hit
      var nested = false, p = el.parentElement;
      while (p) { if (isInterruptEl(p)) { nested = true; break; } p = p.parentElement; }
      if (nested) continue;
      if (el.getAttribute(INTERRUPT_TAG) !== "1") el.setAttribute(INTERRUPT_TAG, "1");
    }
  }

  var pending = null;
  function schedule() {
    if (pending) return;
    pending = W.setTimeout(function () {
      pending = null;
      try {
        run();
      } catch (e) {}
    }, 100);
  }

  /**
   * bootstrap hands us the chat document; bind + observe it.
   * @param {Document} doc - the chat document
   * @param {Window} win - the chat window
   */
  function init(doc, win) {
    D = doc;
    W = win || window;
    try {
      run();
    } catch (e) {}
    try {
      /* PLAIN debounced observer (NOT __ccObserve).
         Blockquote's ONLY writes are guarded idempotent setAttribute tags
         (data-cc-blockquote / data-cc-interrupt), so it is ALREADY freeze-safe: a
         re-run tags nothing new → emits no mutation → the observer goes quiet on
         its own.
         Routing it through __ccObserve with ownAttrPrefix was a mistake — the
         shared filter treats the tag write as self-churn and, in a mixed
         streaming batch, suppresses the sweep so NEW quote/interrupt lines never
         get tagged (the same regression that broke UserStyle: userTagged=0).
         __ccObserve is only for element-APPENDING features.
         schedule() debounces run() ~100ms. */
      new W.MutationObserver(schedule).observe(D.body, {
        childList: true,
        subtree: true,
      });
    } catch (e) {}
  }

  register(init);

  /* Order-independent registration: if the bootstrap is already installed, hand
     off now; otherwise queue onto window.__ccPending — the bootstrap drains it
     the moment it installs (it is injected too, so it WILL load).
     A last-resort timer covers the impossible case where no bootstrap ever
     appears, running once against the current document (the chat DOM lives in
     THIS document). */
  function register(fn) {
    if (window.__ccOnChatDoc) { window.__ccOnChatDoc(fn); return; }
    (window.__ccPending = window.__ccPending || []).push(fn);
    var tries = 0;
    var t = setInterval(function () {
      if (window.__ccOnChatDoc) { clearInterval(t); return; } // bootstrap drained us
      if (++tries >= 25) { // ~5s with no bootstrap — run standalone, once
        clearInterval(t);
        try { fn(document, window); } catch (e) {}
      }
    }, 200);
  }
})();
`.trim();

const CSS = `
/* Blockquote / callout styling for chat messages (e.g. the "> ℹ️ …" info
   notices).

   Goal: a clean filled card — a subtle background, 10px padding on EVERY edge,
   and NO "> " quote bar (the default left border/accent is removed). */

blockquote,
[data-cc-blockquote="1"] {
  background: var(
    --vscode-textBlockQuote-background,
    var(--vscode-editorWidget-background, rgba(120, 120, 120, 0.14))
  );
  /* remove the "> " quote bar on every edge */
  border: none !important;
  border-left: none !important;
  padding: 10px !important;
  margin: 8px 0;
  border-radius: 8px;
  color: inherit;
}

/* Some webviews draw the quote bar with a ::before pseudo-element — hide it. */
blockquote::before,
[data-cc-blockquote="1"]::before {
  content: none !important;
  display: none !important;
}

/* Keep inner paragraphs tight so the 10px padding is the only spacing. */
blockquote > :first-child,
[data-cc-blockquote="1"] > :first-child {
  margin-top: 0;
}
blockquote > :last-child,
[data-cc-blockquote="1"] > :last-child {
  margin-bottom: 0;
}

/* "Tool interrupted" / aborted / cancelled SYSTEM notice — a distinct LIGHT-RED
   card so it reads as an interrupted/error state, NOT a user message (UserStyle
   blue) or a normal blockquote.
   Tagged data-cc-interrupt="1" by the JS.
   The doubled attribute selector + !important raise specificity so it wins
   over [data-cc-user="1"] and [data-cc-blockquote="1"] on the same element. */
[data-cc-interrupt="1"][data-cc-interrupt="1"] {
  background: var(
    --vscode-inputValidation-errorBackground,
    rgba(255, 80, 80, 0.14)
  ) !important;
  border: none !important;
  border-inline-start: 3px solid
    var(--vscode-errorForeground, rgba(255, 80, 80, 0.7)) !important;
  border-radius: 8px !important;
  padding: 10px !important;
  color: inherit !important;
}
`.trim();

registerFeature({ id: "blockquote", label: "Blockquote callouts", js: JS, css: CSS });
