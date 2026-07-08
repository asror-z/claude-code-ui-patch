// Shared runtime injected once into the chat webview (extension.js) to host every
// chat-enhancement feature (Reply, Search, DateTime, ... — see behaviorFeatures.ts).
// Unlike claude-code-ui-patch's PATCH_POINTS/TOGGLE_POINTS/INJECT_POINTS (which all
// swap an EXISTING hardcoded value already present in the bundle), these features add
// NEW behavior that doesn't exist in the stock bundle at all, so they ride as one
// marker-tagged <script>/<style> block (see behaviorInject.ts) rather than a value-slot
// patch.
//
// Unlike the Antigravity IDE build this design was ported from, this webview panel has
// NO nested `active-frame` iframe: `getHtmlForWebview()`'s own template renders
// `<div id="root">` directly under `<body>` in the SAME document our injected
// <script> runs in. So the bootstrap needs no frame-hunting/frame-swap polling — the
// chat DOM to observe is just `document`. window.__ccOnChatDoc(fn) still exists (so
// every feature keeps the same registration call), but it resolves synchronously
// against `document`/`window` and re-fires once chat content appears.
export const BOOTSTRAP_SOURCE = `
(function () {
  "use strict";
  if (window.__ccOnChatDoc) return; // already installed

  var callbacks = [];
  var inited = false;

  var CHAT_PROBE =
    "[class*='userMessage'],[class*='messageContainer'],[class*='message-container']," +
    "[data-message-id],[class*='chatMessage'],[class*='bubble'],[class*='turn_']";

  function hasChat(doc) {
    try { return !!(doc && doc.querySelector && doc.querySelector(CHAT_PROBE)); }
    catch (e) { return false; }
  }

  function runCallbacks() {
    try {
      if (window.__ccApplyToggles) {
        window.__ccApplyToggles(document);
        if (!document.__ccToggleBound) {
          document.__ccToggleBound = true;
          window.addEventListener("cc-features-changed", function () {
            try { window.__ccApplyToggles(document); } catch (e) {}
          });
        }
      }
    } catch (e) {}
    for (var i = 0; i < callbacks.length; i++) {
      if (callbacks[i].done) continue;
      try {
        callbacks[i].fn(document, window);
        callbacks[i].done = true;
      } catch (e) {
        try { console.error("[cc-bootstrap] feature init failed:", e); } catch (e2) {}
      }
    }
  }

  function tick() {
    if (inited || !hasChat(document)) return;
    inited = true;
    runCallbacks();
  }

  window.__ccOnChatDoc = function (initFn) {
    if (typeof initFn !== "function") return;
    callbacks.push({ fn: initFn, done: false });
    if (inited) {
      try { initFn(document, window); } catch (e) {}
    } else {
      try { tick(); } catch (e) {}
    }
  };

  // ===================================================================
  // SHARED SELF-CHURN-GUARDED OBSERVER — window.__ccObserve
  // ===================================================================
  // The ONE observer helper every DOM feature must use instead of hand-rolling
  // \`new MutationObserver\`. Debounced (~150ms) and drops any mutation batch that is
  // ENTIRELY the feature's own churn (its own tagged elements/attrs/text), so a
  // feature that idempotently re-marks its own nodes every sweep can never
  // self-feed into a runaway observer loop.
  window.__ccObserve = function (root, onSweep, opts) {
    if (!root || typeof onSweep !== "function") return null;
    opts = opts || {};
    var cls = opts.ownClass;
    var attrPrefix = opts.ownAttrPrefix;
    var debounceMs = typeof opts.debounceMs === "number" ? opts.debounceMs : 150;

    function isOwnNode(n) {
      if (!n || n.nodeType !== 1) return false;
      try {
        if (cls && n.classList && n.classList.contains(cls)) return true;
        if (cls && n.closest && n.closest("." + cls)) return true;
      } catch (e) {}
      return false;
    }
    function isSelfChurn(records) {
      if (!records || !records.length) return false;
      for (var i = 0; i < records.length; i++) {
        var m = records[i];
        if (m.type === "attributes") {
          var an = m.attributeName || "";
          if (attrPrefix && an.indexOf(attrPrefix) === 0) continue;
          if (an.indexOf("data-cc") === 0 && isOwnNode(m.target)) continue;
          return false;
        }
        if (m.type === "characterData") {
          var pt = m.target && m.target.parentNode;
          if (pt && (isOwnNode(pt) || (pt.parentNode && isOwnNode(pt.parentNode)))) continue;
          return false;
        }
        if (m.type === "childList") {
          if (!m.addedNodes.length && !m.removedNodes.length) continue;
          var mine = true, j, n;
          for (j = 0; j < m.addedNodes.length && mine; j++) {
            n = m.addedNodes[j];
            if (isOwnNode(n)) continue;
            if (n && n.nodeType === 3 && n.parentNode && isOwnNode(n.parentNode)) continue;
            if (isOwnNode(m.target)) continue;
            mine = false;
          }
          for (j = 0; j < m.removedNodes.length && mine; j++) {
            n = m.removedNodes[j];
            if (isOwnNode(n)) continue;
            if (n && n.nodeType === 3 && isOwnNode(m.target)) continue;
            if (isOwnNode(m.target)) continue;
            mine = false;
          }
          if (mine) continue;
          return false;
        }
        return false;
      }
      return true;
    }

    var pending = null;
    var wdTimes = [];
    function watchdogTrip() {
      var now = (window.performance && window.performance.now) ? window.performance.now() : 0;
      if (!now) return false;
      wdTimes.push(now);
      while (wdTimes.length && now - wdTimes[0] > 2000) wdTimes.shift();
      return wdTimes.length > 40; // >20 sweeps/sec sustained => runaway
    }

    var obs = null;
    function schedule(records) {
      if (isSelfChurn(records)) return;
      if (watchdogTrip()) { try { obs && obs.disconnect(); } catch (e) {} return; }
      if (pending) return;
      pending = window.setTimeout(function () {
        pending = null;
        try { onSweep(); } catch (e) {}
      }, debounceMs);
    }

    try {
      obs = new MutationObserver(schedule);
      var init = { childList: true, subtree: true, characterData: true };
      if (attrPrefix) init.attributes = true;
      obs.observe(root, init);
    } catch (e) { obs = null; }
    try { onSweep(); } catch (e) {}
    return obs;
  };

  // ===================================================================
  // SHARED FEATURE TOGGLE — window.__ccFeature(id) / __ccSetFeature(id, on)
  // ===================================================================
  // Runtime on/off per feature, persisted in localStorage (a JSON id->bool map; a
  // feature with no entry defaults to ON). Central enforcement (FOOTPRINT below)
  // means most features never call __ccFeature themselves — a disabled feature's
  // DOM footprint is CSS-hidden/neutralized by a single rebuilt <style> node.
  var TOGGLE_KEY = "cc-feature-toggles";
  function readToggleMap() {
    try {
      var raw = localStorage.getItem(TOGGLE_KEY) || "";
      return raw ? (JSON.parse(raw) || {}) : {};
    } catch (e) { return {}; }
  }
  window.__ccFeature = function (id) {
    if (!id) return true;
    return readToggleMap()[id] !== false;
  };
  window.__ccFeatureMap = readToggleMap;
  window.__ccSetFeature = function (id, on) {
    try {
      var m = readToggleMap();
      m[id] = !!on;
      localStorage.setItem(TOGGLE_KEY, JSON.stringify(m));
      window.dispatchEvent(new Event("cc-features-changed"));
    } catch (e) {}
  };

  var FOOTPRINT = {
    reply:        { hide: [".cc-reply-button"] },
    search:       { hide: [".cc-search-bar"] },
    datetime:     { hide: [".cc-dt-date-sep"], neutralize: "span.cc-dt-time{display:none !important;} [data-cc-dt-time]::after{content:none !important;}" },
    askquestion:  { neutralize: "[data-cc-md='1']{white-space:normal !important;}" },
    userstyle:    { neutralize: "[data-cc-user='1']{background:none !important;border:none !important;border-radius:0 !important;padding:0 !important;margin:0 !important;width:auto !important;max-width:none !important;font-weight:normal !important;} [data-cc-user='1'] p,[data-cc-user='1'] span,[data-cc-user='1'] li,[data-cc-user='1'] div{font-weight:normal !important;}" },
    blockquote:   { neutralize: "[data-cc-blockquote='1'],[data-cc-interrupt='1']{all:revert;}" },
    copybuttons:  { hide: [".cc-copy-group"] },
    codeblock:    { hide: [".cc-code-bar", ".cc-code-copy"] },
    toc:          { hide: [".cc-toc-toggle", ".cc-toc", ".cc-toc-panel"] },
    export:       { hide: [".cc-export-toggle", ".cc-export-menu"] },
    scroll:       { hide: [".cc-scroll-top", ".cc-scroll-bottom"] },
    askcollapse:  { hide: [".cc-askcol-btn"] },
    autocontinue: {},
    draftsave:    {},
    usernav:      { hide: [".cc-usernav-up", ".cc-usernav-down"] },
  };

  window.__ccApplyToggles = function (doc) {
    try {
      if (!doc || (!doc.head && !doc.body)) return;
      var m = readToggleMap();
      var hideSel = [], rules = [];
      for (var id in FOOTPRINT) {
        if (m[id] === false) {
          var fp = FOOTPRINT[id];
          if (fp.hide) for (var i = 0; i < fp.hide.length; i++) hideSel.push(fp.hide[i]);
          if (fp.neutralize) rules.push(fp.neutralize);
        }
      }
      var css = "";
      if (hideSel.length) css += hideSel.join(",") + "{display:none !important;}\\n";
      css += rules.join("\\n");
      var st = doc.getElementById("cc-toggle-style");
      if (!st) {
        st = doc.createElement("style");
        st.id = "cc-toggle-style";
        (doc.head || doc.documentElement).appendChild(st);
      }
      if (st.textContent !== css) st.textContent = css;
    } catch (e) {}
  };

  setInterval(tick, 400);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tick);
  } else {
    tick();
  }
})();
`.trim();

// Design tokens + shared control base, mirrored from the CSS the bootstrap's JS
// counterpart above assumes exists (\`.cc-btn\`, \`--cc-*\` custom properties, the
// focus ring for every \`cc-*\` control). Every feature stylesheet block is appended
// after this one so it can consume these tokens.
export const BOOTSTRAP_CSS = `
:root {
  --cc-accent: var(--vscode-button-background, #0e639c);
  --cc-accent-fg: var(--vscode-button-foreground, #ffffff);
  --cc-accent-2: var(--vscode-textLink-foreground, #4daafc);
  --cc-ok: var(--vscode-testing-iconPassed, #2ea043);
  --cc-surface: var(--vscode-editorWidget-background, var(--vscode-editor-background, #252526));
  --cc-surface-2: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.18));
  --cc-border: var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
  --cc-fg: var(--vscode-foreground, #dddddd);
  --cc-fg-dim: var(--vscode-descriptionForeground, rgba(200, 200, 200, 0.7));
  --cc-hover: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.18));
  --cc-focus: var(--vscode-focusBorder, #0e639c);
  --cc-radius: 6px;
  --cc-radius-lg: 10px;
  --cc-chip: 20px;
  --cc-fab: 34px;
  --cc-gap: 8px;
  --cc-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
  --cc-shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.35);
  --cc-z: 2147483000;
  --cc-motion: 0.12s ease;
}
.cc-btn {
  font-family: inherit;
  cursor: pointer;
  border: 1px solid var(--cc-border);
  background: var(--cc-surface-2);
  color: var(--cc-fg);
  border-radius: var(--cc-radius);
  transition: background var(--cc-motion), color var(--cc-motion), opacity var(--cc-motion);
}
.cc-btn:hover { background: var(--cc-accent); color: var(--cc-accent-fg); }
.cc-btn:focus-visible, [class^="cc-"]:focus-visible, [class*=" cc-"]:focus-visible {
  outline: 2px solid var(--cc-focus);
  outline-offset: 1px;
}
@media (prefers-reduced-motion: reduce) { .cc-btn { transition: none; } }
`.trim();
