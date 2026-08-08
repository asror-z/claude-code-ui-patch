import { registerFeature } from "./behaviorFeatures";

// Shows the running effort level + extended-thinking status as the
// composer's PLACEHOLDER text (before anything is typed) -- same native
// placeholder mechanism as ModelInfo (behaviorFeatures.modelinfo.ts): a
// data-cc-effortinfo attribute + a higher-priority :empty:before CSS rule, so
// it appears/disappears automatically with the composer's own empty state,
// no JS-driven show/hide needed. When BOTH modelinfo and effortinfo are on,
// they compose into one combined placeholder line (see the CSS's combined
// selector below) rather than one silently overwriting the other's attribute.
//
// Requires the modelInfoBridge TogglePoint (always on, see patcher.ts /
// modelInfoBridge.ts), which mirrors window.__ccModelInfo = {effort, thinking}
// from the webview's own effortLevel/thinkingLevel signals.
const JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-effortinfo] Effort Info Feature loaded");
  } catch (e) {}

  var ATTR = "data-cc-effortinfo";
  var MODEL_ATTR = "data-cc-modelinfo";
  var D = document;
  var W = window;

  // Mirrors the stock Q6t label map in webview/index.js (low/medium/high/
  // xhigh/max -> Low/Medium/High/"Extra high"/Max) -- duplicated rather than
  // read live since it's a small, stable, documented id set (see CLAUDE.md's
  // effort-level references) and reading it live would need reaching into
  // the same module-scoped closure this whole bridge exists to avoid.
  var EFFORT_LABELS = {
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Max",
  };

  function findComposer() {
    return (
      D.querySelector('[role="textbox"][aria-label="Message input"]') ||
      D.querySelector('[role="textbox"][contenteditable]')
    );
  }

  function effortText() {
    var info = W.__ccModelInfo;
    var effort = info && info.effort;
    if (!effort) return "";
    return "Effort: " + (EFFORT_LABELS[effort] || effort);
  }

  function thinkingText() {
    var info = W.__ccModelInfo;
    var thinking = info && info.thinking;
    if (!thinking || thinking === "off") return "Thinking: off";
    return "Thinking: " + thinking;
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
    var eff = effortText();
    var think = thinkingText();
    var parts = [];
    if (eff) parts.push(eff);
    if (think) parts.push(think);
    if (!parts.length) {
      if (input.hasAttribute(ATTR)) input.removeAttribute(ATTR);
      return;
    }
    // Two spaces, a bullet (U+2022), two spaces -- the one universal
    // separator used everywhere two placeholder fragments are joined (here,
    // and again in the combined-selector CSS content below).
    var text = parts.join("  \\u2022  ");
    if (input.getAttribute(ATTR) !== text) input.setAttribute(ATTR, text);
  }

  function onChanged() {
    try { apply(); } catch (e) {}
  }

  function init(doc, win) {
    D = doc; W = win || window;
    try { apply(); } catch (e) {}
    W.addEventListener("cc-modelinfo-changed", onChanged);
    if (W.__ccObserve) {
      W.__ccObserve(D.body, apply, { ownAttrPrefix: "data-cc-effortinfo" });
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

// Composes with ModelInfo's own [data-cc-modelinfo]:empty:before rule: when
// BOTH attributes are present on the same element, this rule (appended after
// ModelInfo's in the assembled stylesheet -- behaviorFeatures.ts import order
// below decides that) wins the equal-specificity tie and shows the combined
// selector's content instead of either alone.
const CSS = `
[data-cc-effortinfo]:empty:before {
  content: attr(data-cc-effortinfo) !important;
}
[data-cc-modelinfo][data-cc-effortinfo]:empty:before {
  content: attr(data-cc-modelinfo) "  \\2022  " attr(data-cc-effortinfo) !important;
}
`.trim();

registerFeature({ id: "effortinfo", label: "Effort / thinking status in composer placeholder", js: JS, css: CSS });
