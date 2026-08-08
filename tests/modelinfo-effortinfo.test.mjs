// Real-DOM regression test for behaviorFeatures.modelinfo.ts and
// behaviorFeatures.effortinfo.ts -- both drive the composer's NATIVE
// data-placeholder mechanism (webview/index.css's
// .messageInput_<hash>:empty:before{content:attr(data-placeholder);...}) via a
// SEPARATE attribute + CSS override, so the composer's own :empty pseudo-class
// (which reacts automatically to typed content) governs visibility with no JS
// show/hide logic needed.
//
// Runs the REAL injected scripts (extracted straight from the .ts source, not
// hand-copied) in a real jsdom window, builds a synthetic composer element
// matching the real webview's shape ([role="textbox"][aria-label="Message
// input"], initially :empty), drives the real init()/apply() flow, and
// asserts: (1) the attribute is set with the expected text while the composer
// is empty and window.__ccModelInfo holds real values, (2) typing real text
// (removing :empty) is the ONLY thing needed for the native placeholder
// mechanism to take over -- our own attribute staying set is harmless since
// the CSS selector itself is scoped to :empty, (3) per-feature on/off is
// enforced by the REAL behaviorBootstrap.ts FOOTPRINT/__ccApplyToggles
// mechanism (the same single enforcement point every other feature in this
// codebase relies on), (4) BOTH features active at once each set their own
// attribute so the combined CSS selector in behaviorFeatures.effortinfo.ts's
// CSS can compose them.

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELINFO_SRC = path.join(__dirname, "..", "src", "behaviorFeatures.modelinfo.ts");
const EFFORTINFO_SRC = path.join(__dirname, "..", "src", "behaviorFeatures.effortinfo.ts");
const BOOTSTRAP_SRC = path.join(__dirname, "..", "src", "behaviorBootstrap.ts");

function extractInjectedScript(source) {
  const marker = "const JS = `";
  const start = source.indexOf(marker);
  assert.ok(start !== -1, "could not find `const JS = \\`` in source");
  const bodyStart = start + marker.length;
  const end = source.indexOf("`.trim();", bodyStart);
  assert.ok(end !== -1, "could not find closing `.trim();` for the JS template literal");
  let body = source.slice(bodyStart, end);
  body = body.replace(/\\\\/g, "\\");
  return body;
}

function extractExportedSource(source, exportName) {
  const marker = `export const ${exportName} = \``;
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `could not find \`${marker}\` in source`);
  const bodyStart = start + marker.length;
  let end = source.indexOf("`.trim();", bodyStart);
  if (end === -1) end = source.indexOf("\n`;", bodyStart);
  assert.ok(end !== -1, `could not find closing backtick for ${exportName}`);
  let body = source.slice(bodyStart, end);
  body = body.replace(/\\\\/g, "\\");
  return body;
}

// Parse the hide/neutralize CSS __ccApplyToggles actually wrote into
// #cc-toggle-style, mirroring tests/footprint.test.mjs's own hideSelectors().
function toggleStyleText(win) {
  const st = win.document.getElementById("cc-toggle-style");
  return st ? st.textContent : "";
}

function buildDom() {
  return new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
    url: "https://example.test/",
    pretendToBeVisual: true,
    runScripts: "dangerously",
  });
}

// Mirrors the real webview's composer shape closely enough for these
// features' own findComposer() selector -- a contenteditable role=textbox
// with the exact aria-label Claude Code's own composer carries.
function buildComposer(doc) {
  const el = doc.createElement("div");
  el.setAttribute("role", "textbox");
  el.setAttribute("aria-label", "Message input");
  el.setAttribute("contenteditable", "plaintext-only");
  el.setAttribute("data-placeholder", "Ask Claude to edit…");
  doc.getElementById("root").appendChild(el);
  return el;
}

// A minimal element matching behaviorBootstrap.ts's own CHAT_PROBE selector
// -- only needed when the REAL bootstrap is also loaded (the FOOTPRINT
// cases): its tick()/hasChat() gate must see a real chat-shaped element
// before it calls a queued feature's init() at all, exactly the same
// precondition the real chat webview satisfies once a conversation exists.
function buildChatProbe(doc) {
  const el = doc.createElement("div");
  el.className = "turn_probe1";
  doc.getElementById("root").appendChild(el);
  return el;
}

// Runs one test case's DOM setup/assertions and ALWAYS closes the jsdom
// window afterward, even on failure -- the real behaviorBootstrap.ts (used by
// the FOOTPRINT cases) runs setInterval(tick, 400); an unclosed window's live
// timer keeps the node:test process alive past its own timeout on a failing
// assertion instead of reporting the failure (the exact hazard
// tests/footprint.test.mjs's own header comment documents and guards against
// the same way).
function withDom(fn) {
  const dom = buildDom();
  try {
    fn(dom.window, dom.window.document);
  } finally {
    dom.window.close();
  }
}

async function run() {
  // --- modelinfo alone: attribute set from window.__ccModelInfo.model ------
  withDom((window, doc) => {
    const composer = buildComposer(doc);
    window.__ccModelInfo = { model: "Sonnet 5", modelId: "claude-sonnet-5", effort: "xhigh", thinking: "off" };

    const script = extractInjectedScript(readFileSync(MODELINFO_SRC, "utf8"));
    window.eval(script);
    assert.ok(Array.isArray(window.__ccPending) && window.__ccPending.length === 1,
      "expected ModelInfo to queue exactly one init() via window.__ccPending");
    window.__ccPending.shift()(doc, window);

    assert.strictEqual(composer.getAttribute("data-cc-modelinfo"), "Model: Sonnet 5",
      "the composer's data-cc-modelinfo attribute must carry the human-readable model label");
    // The composer is still empty (no text typed) -- native :empty applies.
    assert.strictEqual(composer.matches(":empty"), true,
      "composer with only attributes (no text) must still match :empty");
    // Claude Code's OWN data-placeholder attribute is left untouched -- we
    // never overwrite it (React would stomp a direct write anyway).
    assert.strictEqual(composer.getAttribute("data-placeholder"), "Ask Claude to edit…",
      "the native data-placeholder attribute must be left untouched");

    console.log("PASS: ModelInfo sets data-cc-modelinfo from window.__ccModelInfo while leaving the native placeholder attribute untouched.");

    // Typing real text: the composer stops matching :empty (native behavior,
    // no code of ours involved) -- proving the "automatically disappears"
    // contract is satisfied purely by CSS reacting to :empty, not JS.
    composer.textContent = "hello world";
    assert.strictEqual(composer.matches(":empty"), false,
      "a composer with real text content must NOT match :empty (native placeholder mechanism takes over)");

    console.log("PASS: typing real text removes :empty — the CSS-driven placeholder (native and ours) stops applying with no JS show/hide logic.");
  });

  // --- reacts live to a "cc-modelinfo-changed" event (model switched) ------
  withDom((window, doc) => {
    const composer = buildComposer(doc);
    window.__ccModelInfo = { model: "Sonnet 5", modelId: "claude-sonnet-5", effort: "high", thinking: "off" };

    const script = extractInjectedScript(readFileSync(MODELINFO_SRC, "utf8"));
    window.eval(script);
    window.__ccPending.shift()(doc, window);
    assert.strictEqual(composer.getAttribute("data-cc-modelinfo"), "Model: Sonnet 5");

    window.__ccModelInfo = { model: "Opus 5", modelId: "claude-opus-5", effort: "high", thinking: "off" };
    window.dispatchEvent(new window.CustomEvent("cc-modelinfo-changed", { detail: window.__ccModelInfo }));

    assert.strictEqual(composer.getAttribute("data-cc-modelinfo"), "Model: Opus 5",
      "a cc-modelinfo-changed event must re-apply the attribute with the new model label");

    console.log("PASS: ModelInfo reacts live to a cc-modelinfo-changed event (model switch).");
  });

  // --- effortinfo alone: effort + thinking text, EFFORT_LABELS humanized ---
  withDom((window, doc) => {
    const composer = buildComposer(doc);
    window.__ccModelInfo = { model: "Sonnet 5", modelId: "claude-sonnet-5", effort: "xhigh", thinking: "off" };

    const script = extractInjectedScript(readFileSync(EFFORTINFO_SRC, "utf8"));
    window.eval(script);
    assert.ok(Array.isArray(window.__ccPending) && window.__ccPending.length === 1,
      "expected EffortInfo to queue exactly one init() via window.__ccPending");
    window.__ccPending.shift()(doc, window);

    assert.strictEqual(composer.getAttribute("data-cc-effortinfo"), "Effort: Extra high · Thinking: off",
      "expected the humanized effort label (xhigh -> \"Extra high\") plus the thinking status, joined by a middle-dot");

    console.log("PASS: EffortInfo sets data-cc-effortinfo with the humanized effort label and thinking status.");
  });

  // --- effortinfo: thinking ON shows the raw level, not "off" ---------------
  withDom((window, doc) => {
    const composer = buildComposer(doc);
    window.__ccModelInfo = { model: "Sonnet 5", modelId: "claude-sonnet-5", effort: "medium", thinking: "high" };

    const script = extractInjectedScript(readFileSync(EFFORTINFO_SRC, "utf8"));
    window.eval(script);
    window.__ccPending.shift()(doc, window);

    assert.strictEqual(composer.getAttribute("data-cc-effortinfo"), "Effort: Medium · Thinking: high",
      "expected the raw thinking level shown when it is not \"off\"");

    console.log("PASS: EffortInfo shows the raw thinking level when extended thinking is enabled.");
  });

  // --- both features active at once: each sets its OWN attribute -----------
  withDom((window, doc) => {
    const composer = buildComposer(doc);
    window.__ccModelInfo = { model: "Sonnet 5", modelId: "claude-sonnet-5", effort: "low", thinking: "off" };

    window.eval(extractInjectedScript(readFileSync(MODELINFO_SRC, "utf8")));
    window.__ccPending.shift()(doc, window);
    window.eval(extractInjectedScript(readFileSync(EFFORTINFO_SRC, "utf8")));
    window.__ccPending.shift()(doc, window);

    assert.strictEqual(composer.getAttribute("data-cc-modelinfo"), "Model: Sonnet 5");
    assert.strictEqual(composer.getAttribute("data-cc-effortinfo"), "Effort: Low · Thinking: off");

    console.log("PASS: both ModelInfo and EffortInfo can be active at once, each owning its own attribute (CSS composes them).");
  });

  // --- feature OFF: FOOTPRINT's neutralize rule reverts the placeholder ----
  // Per-feature on/off is enforced centrally by behaviorBootstrap.ts's
  // FOOTPRINT map (the same single enforcement point every other feature in
  // this codebase relies on -- see multiselect/toc/export/scroll/etc.), NOT
  // by this feature's own JS. So: the JS keeps writing the attribute exactly
  // as when ON, and a SEPARATE CSS rule -- generated by the REAL
  // __ccApplyToggles() from FOOTPRINT.modelinfo.neutralize -- reverts
  // :empty:before's content back to the native placeholder when OFF. This
  // mirrors tests/footprint.test.mjs's own real-bootstrap-driven pattern.
  withDom((window, doc) => {
    buildChatProbe(doc); // satisfies the real bootstrap's hasChat() gate
    const composer = buildComposer(doc);
    window.__ccModelInfo = { model: "Sonnet 5", modelId: "claude-sonnet-5", effort: "xhigh", thinking: "off" };

    // Order matters: the bootstrap defines window.__ccOnChatDoc BEFORE the
    // feature script evals, so register(init) hands off to it directly
    // (synchronously, since a chat-probe element is already present) rather
    // than queuing into window.__ccPending -- the real load order in
    // patcher.ts (bootstrap injected first, every feature after).
    window.eval(extractExportedSource(readFileSync(BOOTSTRAP_SRC, "utf8"), "BOOTSTRAP_SOURCE"));
    window.eval(extractInjectedScript(readFileSync(MODELINFO_SRC, "utf8")));

    assert.strictEqual(composer.getAttribute("data-cc-modelinfo"), "Model: Sonnet 5",
      "sanity: apply() must have really run and set the attribute before this test checks the OFF-state neutralize rule");

    window.__ccSetFeature("modelinfo", false);
    window.__ccApplyToggles(doc);

    const css = toggleStyleText(window);
    assert.ok(css.includes("[data-cc-modelinfo]:empty:before"),
      "FOOTPRINT.modelinfo.neutralize must target the same selector the feature's own CSS uses");
    assert.ok(css.includes("content:attr(data-placeholder)"),
      "FOOTPRINT.modelinfo.neutralize must revert :empty:before's content back to the NATIVE data-placeholder attribute when OFF");

    console.log("PASS: FOOTPRINT.modelinfo neutralizes the placeholder override (reverts to native) when the feature is toggled OFF.");
  });

  withDom((window, doc) => {
    buildChatProbe(doc); // satisfies the real bootstrap's hasChat() gate
    const composer = buildComposer(doc);
    window.__ccModelInfo = { model: "Sonnet 5", modelId: "claude-sonnet-5", effort: "xhigh", thinking: "off" };

    window.eval(extractExportedSource(readFileSync(BOOTSTRAP_SRC, "utf8"), "BOOTSTRAP_SOURCE"));
    window.eval(extractInjectedScript(readFileSync(EFFORTINFO_SRC, "utf8")));

    assert.strictEqual(composer.getAttribute("data-cc-effortinfo"), "Effort: Extra high · Thinking: off",
      "sanity: apply() must have really run and set the attribute before this test checks the OFF-state neutralize rule");

    window.__ccSetFeature("effortinfo", false);
    window.__ccApplyToggles(doc);

    const css = toggleStyleText(window);
    assert.ok(css.includes("[data-cc-effortinfo]:empty:before"),
      "FOOTPRINT.effortinfo.neutralize must target the same selector the feature's own CSS uses");
    assert.ok(css.includes("[data-cc-modelinfo][data-cc-effortinfo]:empty:before"),
      "FOOTPRINT.effortinfo.neutralize must also revert the COMBINED (both-features-on) selector");

    console.log("PASS: FOOTPRINT.effortinfo neutralizes both its own and the combined placeholder override when toggled OFF.");
  });

  // --- no window.__ccModelInfo yet (bridge hasn't fired): no attribute -----
  withDom((window, doc) => {
    const composer = buildComposer(doc);
    // window.__ccModelInfo intentionally left undefined.

    window.eval(extractInjectedScript(readFileSync(MODELINFO_SRC, "utf8")));
    window.__ccPending.shift()(doc, window);

    assert.strictEqual(composer.hasAttribute("data-cc-modelinfo"), false,
      "before the modelInfoBridge has ever fired (window.__ccModelInfo undefined), no attribute is written");

    console.log("PASS: ModelInfo is a safe no-op before window.__ccModelInfo exists (bridge not yet fired).");
  });
}

run()
  .then(() => {
    console.log("\nALL CHECKS PASSED");
  })
  .catch((err) => {
    console.error("FAILED:", err.message);
    process.exitCode = 1;
  });
