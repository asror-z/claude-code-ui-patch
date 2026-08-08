import { registerFeature } from "./behaviorFeatures";

// Shows the running model's name/version as the composer's PLACEHOLDER text
// (before anything is typed) -- reusing the composer's own native placeholder
// mechanism (webview/index.js sets data-placeholder on the contenteditable
// messageInput_<hash> div; its stock CSS is
// `.messageInput_<hash>:empty:before{content:attr(data-placeholder);...}`,
// see patcher.ts's CHAT_COMPOSER_* comment). We do NOT overwrite Claude
// Code's own data-placeholder attribute (React re-renders it every keystroke/
// state change and would immediately stomp a direct write) -- instead we set
// a SEPARATE data-cc-modelinfo attribute on the same element and add a higher-
// priority CSS rule (later in the cascade, so it wins on equal specificity)
// that swaps :empty:before's content to ours whenever that attribute is
// present. The moment real text is typed the element stops matching :empty
// and BOTH the native and our own placeholder vanish automatically -- no JS
// needed for the show/hide transition, exactly the native placeholder's own
// behavior.
//
// Requires the modelInfoBridge TogglePoint (always on, see patcher.ts /
// modelInfoBridge.ts), which mirrors window.__ccModelInfo = {model, ...} from
// the webview's own currentMainLoopModel/claudeConfig signals.
const JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-modelinfo] Model Info Feature loaded");
  } catch (e) {}

  var ATTR = "data-cc-modelinfo";
  var D = document;
  var W = window;

  function findComposer() {
    return (
      D.querySelector('[role="textbox"][aria-label="Message input"]') ||
      D.querySelector('[role="textbox"][contenteditable]')
    );
  }

  function currentLabel() {
    var info = W.__ccModelInfo;
    return (info && info.model) || "";
  }

  function apply() {
    // Per-feature on/off is enforced centrally by FOOTPRINT in
    // behaviorBootstrap.ts (a CSS neutralize rule reverting :empty:before's
    // content to the native placeholder when this feature is toggled off) --
    // the same enforcement point every other feature in this codebase relies
    // on, so this always writes the attribute; the CSS decides whether it's
    // ever actually rendered.
    var input = findComposer();
    if (!input) return;
    var label = currentLabel();
    if (!label) {
      if (input.hasAttribute(ATTR)) input.removeAttribute(ATTR);
      return;
    }
    var text = "Model: " + label;
    if (input.getAttribute(ATTR) !== text) input.setAttribute(ATTR, text);
  }

  function onChanged() {
    try { apply(); } catch (e) {}
  }

  function init(doc, win) {
    D = doc; W = win || window;
    try { apply(); } catch (e) {}
    W.addEventListener("cc-modelinfo-changed", onChanged);
    // The composer element itself can be unmounted/remounted (e.g. on chat
    // switch) — a lightweight sweep on the shared self-churn-guarded observer
    // re-applies the attribute to whichever composer instance is current.
    if (W.__ccObserve) {
      W.__ccObserve(D.body, apply, { ownAttrPrefix: "data-cc-modelinfo" });
    }
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

// The [class*="messageInput"] guard mirrors DateTime's own composer-exclusion
// rule (never render on the invisible input layer's inherited pseudo-content
// from an unrelated feature) — here it's the OPPOSITE intent: we deliberately
// target ONLY the composer via the ATTR presence, so no extra exclusion is
// needed beyond the attribute selector itself. Placed AFTER the stock
// `:empty:before{content:attr(data-placeholder);...}` rule in the cascade (this
// whole block is appended, not prepended, to the assembled stylesheet — see
// behaviorInject.ts) so equal-specificity attribute selectors resolve in our
// favor without needing !important on content itself (kept anyway for
// resilience against a future stock specificity bump).
const CSS = `
[data-cc-modelinfo]:empty:before {
  content: attr(data-cc-modelinfo) !important;
}
`.trim();

registerFeature({ id: "modelinfo", label: "Model name in composer placeholder", js: JS, css: CSS });
