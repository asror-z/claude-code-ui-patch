// NoArrowUpHistory — suppresses Claude Code's OWN native composer behavior: pressing
// ArrowUp in an empty composer calls the bundle's own cycleMessage(-1), replacing the
// composer's content with your last sent message (confirmed live in
// webview/index.js's minified source: `if(le.key==="ArrowUp"&&!R&&!Zi){if(Qs.cycleMessage(-1))...`).
// This is deliberate upstream behavior, not a bug in this extension — it just isn't
// wanted by everyone, since an accidental ArrowUp (e.g. reaching for Up to scroll)
// silently overwrites whatever the user was about to type.
//
// The native handler is bound on a React synthetic-event listener attached at
// bootstrap; a capture-phase listener on the SAME element, registered by us, always
// runs first (capture fires outer-to-inner, and both listeners sit on the same
// contenteditable element) — so ev.stopImmediatePropagation() here reliably stops
// React's own handler from ever seeing the key event, without patching the bundle
// itself. No CSS footprint — this feature is pure keydown interception, same
// footprint shape as AutoContinue/DraftSave.
import { registerFeature } from "./behaviorFeatures";

const JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-noarrowup] Chat NoArrowUpHistory Feature loaded");
  } catch (e) {}

  var D = document;
  var W = window;
  var _bound = null; // the composer we've wired the capture listener onto

  function findComposer() {
    return (
      D.querySelector('[role="textbox"][aria-label="Message input"]') ||
      D.querySelector('[role="textbox"][contenteditable]') ||
      D.querySelector('[contenteditable="plaintext-only"]') ||
      D.querySelector('[contenteditable="true"]')
    );
  }

  function onKeyDownCapture(ev) {
    if (ev.key !== "ArrowUp") return;
    if (typeof W.__ccFeature === "function" && !W.__ccFeature("noarrowuphistory")) return;
    ev.stopImmediatePropagation();
  }

  function bindComposer() {
    var input = findComposer();
    if (!input || input === _bound) return;
    _bound = input;
    input.addEventListener("keydown", onKeyDownCapture, true);
  }

  var pending = null;
  function schedule() {
    if (pending) return;
    pending = W.setTimeout(function () {
      pending = null;
      try { bindComposer(); } catch (e) {}
    }, 150);
  }

  function init(doc, win) {
    D = doc;
    W = win || window;
    _bound = null;
    try { bindComposer(); } catch (e) {}
    try {
      if (W.__ccObserve) {
        W.__ccObserve(D.body, function () { try { bindComposer(); } catch (e) {} });
      } else {
        new W.MutationObserver(schedule).observe(D.body, { childList: true, subtree: true });
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
/* NoArrowUpHistory has no visible UI — pure keydown interception on the composer.
   This stylesheet is an intentional (near-)empty placeholder so the feature stays a
   normal copy-and-inject asset PAIR (js + css), matching every other feature. */
[data-cc-noarrowuphistory] {
  /* marker only — no visual change */
}
`.trim();

registerFeature({ id: "noarrowuphistory", label: "Disable ArrowUp last-message recall", js: JS, css: CSS });
