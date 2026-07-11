// Chat Faro Logging feature — ships structured diagnostics from every OTHER
// chat-enhancement feature (and, monkey-patched, the raw console) to Grafana Cloud
// Frontend Observability via the official @grafana/faro-web-sdk, loaded from the
// unpkg CDN as a classic IIFE bundle (Grafana's own documented browser snippet) —
// a plain <script src> + onload, no bundler, no dynamic import().
//
// WHY FARO (not a direct Loki push): Grafana Cloud's Loki push endpoint does not
// answer the browser's CORS preflight, so a webview fetch() can never reach it
// directly. The Faro Collector is purpose-built to receive telemetry straight
// from a browser/webview and answers CORS for the configured app/domain.
//
// SECRETS: none. The Faro "app key" (the collector URL's path segment) is a
// public write-only ingest identifier — safe to embed in client-side code,
// unlike a Loki Basic-auth token. Stamped here from the smarts-logging-grafana
// skill's central config (its .env FARO_* values), via that skill's own
// `action=apply arch=skill` — re-run that skill (never hand-edit the two
// constants below) if the collector URL/app name ever needs to change.
//
// PER-FEATURE GATING (this is the whole point of this feature existing as its
// own toggleable row, not a silent always-on infra script): every OTHER feature
// that wants to log calls window.__ccFaroLog(channel, fields, level, callerModule).
// __ccFaroLog checks BOTH:
//   1. THIS feature's own on/off switch — window.__ccFeature("faro"). Unchecking
//      "Logging (console + Grafana Loki)" in the panel makes ALL logging (from
//      every feature, and the wrapped console.*) truly silent everywhere — no
//      console line, no Faro push — with no reload.
//   2. The CALLING feature's own on/off switch — window.__ccFeature(callerModule).
//      A caller passes its own module id (e.g. draftsave, autocontinue) as the
//      4th arg; if THAT feature is toggled off, its records are dropped even
//      while Faro itself stays on. This is the literal requirement: "qaysi
//      feature yoqilgan bo'lsa - o'sha feature log yozadi, o'chirilgan bo'lsa
//      yozmaydi" (whichever feature is ON logs; OFF ones don't) — checked
//      per-record here so no caller has to re-implement the same test itself.
// A caller with NO module id (raw console.* calls, wrapped below) is gated by
// switch 1 only — there is no "which feature" to check for a bare console.log.
import { registerFeature } from "./behaviorFeatures";

const JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-faro] Chat Faro Logging Feature loaded");
  } catch (e) {}

  // ----- configuration (stamped by smarts-logging-grafana action=apply arch=skill) --
  var FARO_COLLECTOR_URL = "https://faro-collector-prod-ap-south-1.grafana.net/collect/a972a81cd8816fb6d2d28b7ff8e773f6";
  var FARO_APP_NAME = "cc-patch";

  var D = document;
  var faroReady = false;

  // ----- master switch: THIS feature's own panel checkbox ----------------------
  function faroFeatureOn() {
    try { return window.__ccFeature ? window.__ccFeature("faro") !== false : true; } catch (e) { return true; }
  }

  // ----- per-caller gate: the CALLING feature's own panel checkbox -------------
  // No module id supplied (bare console.* wrap) -> gated by faroFeatureOn() alone.
  function callerOn(mod) {
    if (!mod) return true;
    try { return window.__ccFeature ? window.__ccFeature(mod) !== false : true; } catch (e) { return true; }
  }

  var status = {
    state: "init", // init | disabled | no-url | loading | ready | error
    pushed: 0,
    queued: 0,
    lastError: "",
    app: FARO_APP_NAME,
    url: (FARO_COLLECTOR_URL || "").replace(/\\/collect\\/.*/, "/collect/…"),
  };
  function setStatus(patch) {
    try { for (var k in patch) status[k] = patch[k]; window.__ccFaroStatus = status; } catch (e) {}
  }
  window.__ccFaroStatus = status;

  // The chat webview's CSP is script-src nonce-only (no unsafe-inline, no host
  // allowlist), so a dynamically-created script tag pointing at the unpkg CDN
  // is BLOCKED unless it carries the page's live nonce — a real incident: the
  // Faro SDK CDN load failed every time with a CSP violation, so Loki never got
  // any data. The nonce is read at runtime from an existing nonced script tag
  // (our own injected block, or Claude Code's index.js module script — both
  // carry the same live nonce). Setting BOTH the nonce property and the nonce
  // attribute is required: Chromium clears the reflected attribute after parse,
  // so the property is the reliable carrier for a script the CSP checks.
  function pageNonce() {
    try {
      if (D.currentScript && D.currentScript.nonce) return D.currentScript.nonce;
    } catch (e) {}
    try {
      var nodes = D.querySelectorAll("script[nonce]");
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i].nonce || nodes[i].getAttribute("nonce");
        if (n) return n;
      }
    } catch (e) {}
    return "";
  }
  function loadScript(src, onload) {
    var s = D.createElement("script");
    var nonce = pageNonce();
    if (nonce) { try { s.nonce = nonce; } catch (e) {} try { s.setAttribute("nonce", nonce); } catch (e) {} }
    s.src = src;
    s.onload = onload;
    s.onerror = function () {
      setStatus({ state: "error", lastError: "failed to load " + src });
      // original console only — this runs before wrapConsole in the failure path,
      // but keep it a single warn so a genuine CDN outage is visible without spam.
      try { console.warn("[cc-faro] failed to load script (CSP or network): " + src); } catch (e) {}
    };
    D.head.appendChild(s);
  }

  // The Faro collector requires \`context\` to be a FLAT STRING MAP — a nested
  // object/array value is rejected. Coerce every value to a string.
  function flattenContext(payload) {
    var out = {};
    if (!payload || typeof payload !== "object") return out;
    for (var k in payload) {
      if (!Object.prototype.hasOwnProperty.call(payload, k)) continue;
      var v = payload[k];
      if (v == null) { out[k] = ""; continue; }
      if (typeof v === "string") { out[k] = v; }
      else if (typeof v === "number" || typeof v === "boolean") { out[k] = String(v); }
      else { try { out[k] = JSON.stringify(v); } catch (e) { out[k] = String(v); } }
    }
    return out;
  }

  var VALID_LEVELS = { trace: 1, debug: 1, info: 1, log: 1, warn: 1, error: 1 };
  function normalizeLevel(level) {
    var v = String(level || "").toLowerCase();
    return VALID_LEVELS[v] ? v : "log";
  }

  function _push(channel, payload, level) {
    try {
      var opts = { context: flattenContext(payload) };
      var lvl = normalizeLevel(level);
      opts.level = (window.GrafanaFaroWebSdk.LogLevel && window.GrafanaFaroWebSdk.LogLevel[lvl.toUpperCase()]) || lvl;
      window.GrafanaFaroWebSdk.faro.api.pushLog([channel], opts);
      status.pushed = (status.pushed || 0) + 1; status.lastChannel = channel; status.lastLevel = lvl;
      try { window.__ccFaroStatus = status; } catch (e) {}
      return true;
    } catch (e) { return false; }
  }

  var _preReady = [];
  var _MAX_QUEUE = 200;

  // window.__ccFaroLog(channel, fields, level, module) — the shared sink every
  // OTHER feature calls to log. Exposed BEFORE any early return so a caller
  // always has a working (if console-only/no-op) sink to call.
  function logRecord(channel, fields, level, mod) {
    var payload = fields || {};
    var lvl = level || (channel === "window.onerror" ? "error" : "log");
    if (!faroFeatureOn()) return; // Logging feature itself is OFF -> truly silent
    if (!callerOn(mod)) return;   // the CALLING feature is OFF -> its own records stay silent
    try {
      var logFn = (lvl === "error" && console.error) || (lvl === "warn" && console.warn) || console.info;
      logFn.call(console, "[cc-faro] " + channel, payload);
    } catch (e) {}
    if (!FARO_COLLECTOR_URL) return; // console-only build (no collector configured)
    if (faroReady && window.GrafanaFaroWebSdk && window.GrafanaFaroWebSdk.faro) {
      _push(channel, payload, lvl);
    } else if (_preReady.length < _MAX_QUEUE) {
      _preReady.push({ channel: channel, payload: payload, level: lvl });
      status.queued = _preReady.length;
      try { window.__ccFaroStatus = status; } catch (e) {}
    }
  }
  window.__ccFaroLog = logRecord;

  // ----- console.* monkey-patch (bare console calls; gated by switch 1 only) ---
  var _consoleWrapped = false;
  function wrapConsole() {
    if (_consoleWrapped) return;
    _consoleWrapped = true;
    ["log", "info", "warn", "error", "debug"].forEach(function (level) {
      var orig = console[level] ? console[level].bind(console) : function () {};
      console[level] = function () {
        var args = Array.prototype.slice.call(arguments);
        try { orig.apply(null, args); } catch (e) {}
        if (!faroFeatureOn()) return;
        try {
          var msg = args.map(function (a) {
            try { return typeof a === "string" ? a : JSON.stringify(a); } catch (e) { return String(a); }
          }).join(" ");
          if (!FARO_COLLECTOR_URL) return;
          if (faroReady && window.GrafanaFaroWebSdk && window.GrafanaFaroWebSdk.faro) {
            _push("console." + level, { level: level, message: msg }, level === "error" ? "error" : level === "warn" ? "warn" : "log");
          }
        } catch (e) {}
      };
    });
  }

  function flushPreReady() {
    if (!(window.GrafanaFaroWebSdk && window.GrafanaFaroWebSdk.faro)) return;
    var q = _preReady; _preReady = [];
    for (var i = 0; i < q.length; i++) _push(q[i].channel, q[i].payload, q[i].level);
  }

  function bootFaro() {
    if (!FARO_COLLECTOR_URL) {
      setStatus({ state: "no-url" });
      try { console.warn("[cc-faro] FARO_COLLECTOR_URL not set — console-only (no Faro push)."); } catch (e) {}
      return;
    }
    setStatus({ state: "loading" });

    var _existingFaro = null;
    if (window.GrafanaFaroWebSdk) {
      if (window.GrafanaFaroWebSdk.faro) {
        _existingFaro = window.GrafanaFaroWebSdk.faro;
      } else if (
        typeof window.GrafanaFaroWebSdk.isInternalFaroOnGlobalObject === "function" &&
        window.GrafanaFaroWebSdk.isInternalFaroOnGlobalObject() &&
        typeof window.GrafanaFaroWebSdk.getInternalFaroFromGlobalObject === "function"
      ) {
        _existingFaro = window.GrafanaFaroWebSdk.getInternalFaroFromGlobalObject();
        if (_existingFaro) { window.GrafanaFaroWebSdk.faro = _existingFaro; }
      }
    }
    if (_existingFaro) {
      faroReady = true;
      setStatus({ state: "ready" });
      wrapConsole();
      try { flushPreReady(); } catch (e) {}
      return;
    }

    loadScript("https://unpkg.com/@grafana/faro-web-sdk@2/dist/bundle/faro-web-sdk.iife.js", function () {
      try {
        var cfg = {
          url: FARO_COLLECTOR_URL,
          app: { name: FARO_APP_NAME, version: "1.0.0", environment: "production" },
        };
        if (typeof window.GrafanaFaroWebSdk.getWebInstrumentations === "function") {
          cfg.instrumentations = window.GrafanaFaroWebSdk.getWebInstrumentations();
        }
        window.GrafanaFaroWebSdk.initializeFaro(cfg);
        if (!window.GrafanaFaroWebSdk.faro) {
          setStatus({ state: "error", lastError: "initializeFaro returned without setting .faro (already registered elsewhere on this page)" });
          try { console.warn("[cc-faro] initializeFaro did not set .faro — skipping tracing instrumentation."); } catch (e2) {}
          return;
        }
        faroReady = true;
        setStatus({ state: "ready" });
        wrapConsole();
        try { console.info("[cc-faro] Faro initialized -> " + FARO_APP_NAME); } catch (e) {}
        try { flushPreReady(); } catch (e) {}
      } catch (e) {
        setStatus({ state: "error", lastError: (e && e.message) || "initializeFaro failed" });
        try { console.warn("[cc-faro] initializeFaro failed:", e); } catch (e2) {}
        return;
      }

      loadScript("https://unpkg.com/@grafana/faro-web-tracing@2/dist/bundle/faro-web-tracing.iife.js", function () {
        if (!(window.GrafanaFaroWebSdk && window.GrafanaFaroWebSdk.faro && window.GrafanaFaroWebSdk.faro.instrumentations)) {
          try { console.warn("[cc-faro] tracing instrumentation skipped: faro.instrumentations unavailable."); } catch (e2) {}
          return;
        }
        try {
          window.GrafanaFaroWebSdk.faro.instrumentations.add(
            new window.GrafanaFaroWebTracing.TracingInstrumentation()
          );
        } catch (e) {
          logRecord("cc.faro.tracing-failed", { kind: "cc.faro.tracing-failed", message: (e && e.message) || String(e) }, "warn", "faro");
        }
      });
    });
  }

  // React live to the panel checkbox: switching "Logging" ON after this script
  // already ran (no reload) should boot Faro immediately instead of requiring a
  // reload; switching it OFF stops nothing already loaded (Faro's own SDK has no
  // "unload" hook) but logRecord()/wrapConsole()'s per-call faroFeatureOn() check
  // makes every FUTURE record silent immediately, which is the observable effect
  // that matters.
  function onFeaturesChanged() {
    if (faroFeatureOn() && status.state !== "ready" && status.state !== "loading") {
      bootFaro();
    } else if (!faroFeatureOn()) {
      setStatus({ state: "disabled" });
    }
  }

  function init(doc, win) {
    D = doc;
    try {
      win.addEventListener("cc-features-changed", onFeaturesChanged);
    } catch (e) {}
    if (!faroFeatureOn()) {
      setStatus({ state: "disabled" });
      try { console.info("[cc-faro] Logging feature DISABLED (panel checkbox) — silent everywhere."); } catch (e) {}
      return;
    }
    bootFaro();
    logRecord("frame.init", { kind: "frame.init" }, null, "faro");
    try {
      // Global-error capture, hardened against a self-amplifying flood. A real
      // incident: Claude Code's OWN bundle (webview/index.js) throws a repeating
      // "Cannot read properties of undefined (reading 'toUrl')" from its Monaco
      // web-worker setup (getWorkerUrl/$loadForeignModule) — dozens of times a
      // second. The prior handler re-logged every one through logRecord ->
      // console.error, and since console.error is monkey-patched (wrapConsole),
      // that re-entered the wrapper and spammed the DevTools console into an
      // unreadable wall, making the (working) features look dead. Three guards:
      //   1. NEVER route a captured error through logRecord/console.* — push it
      //      straight to Faro (raw), so it can't re-enter the wrapped console.
      //   2. De-dupe + rate-limit: drop an identical message seen in the last
      //      2s, and cap total captured errors to _MAX_ERR so a runaway upstream
      //      crash can never flood the collector or the console either.
      //   3. It still records the FIRST occurrence of each distinct error, so a
      //      genuine one-off is never lost — only the repeat-spam is suppressed.
      var _errSeen = {}, _errCount = 0, _MAX_ERR = 50;
      win.addEventListener(
        "error",
        function (e) {
          try {
            var msg = (e && e.message) || "";
            var key = msg.slice(0, 120);
            var now = (win.performance && win.performance.now) ? win.performance.now() : 0;
            if (_errSeen[key] && now && now - _errSeen[key] < 2000) return; // repeat within 2s: drop
            _errSeen[key] = now;
            if (_errCount >= _MAX_ERR) return; // hard cap: stop after _MAX_ERR distinct captures
            _errCount++;
            // Raw push only — do NOT call logRecord()/console.* (they are wrapped
            // and would re-enter this handler / the console flood).
            if (faroFeatureOn() && faroReady && window.GrafanaFaroWebSdk && window.GrafanaFaroWebSdk.faro) {
              _push("window.onerror", { kind: "window.onerror", message: msg, source: (e && e.filename) || "" }, "error");
            }
          } catch (e2) {}
        },
        true
      );
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
/* Faro logging has no visible UI — this file exists only so the feature follows
   the same .js + .css asset-pair convention as every other feature. */
[data-cc-faro] {
  /* marker only — no visual change */
}
`.trim();

registerFeature({ id: "faro", label: "Logging (console + Grafana Loki)", js: JS, css: CSS });
