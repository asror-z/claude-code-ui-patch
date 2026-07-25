// Real-DOM regression test for behaviorFeatures.copybuttons.ts's Copy as
// Markdown / Copy as HTML buttons.
//
// Real incident this guards against: contentRoot() used to `return` the FIRST
// markdown/prose container it found inside a stamped message, silently
// dropping every OTHER sibling markdown block in that same message. Claude
// Code's real webview can render one assistant reply as several separate
// markdown-classed sub-containers (prose interleaved with tool-call chips, or
// a long reply split across multiple blocks) — so "Copy as Markdown" ended up
// copying only one paragraph instead of the whole message. Fixed by
// contentRoots() (plural) returning every qualifying, non-nested candidate in
// document order, with markdownOf()/htmlOf() joining all of them.
//
// This test runs the ACTUAL injected script (the same `JS` template-literal
// string shipped inside extension.js) in a real jsdom window — not a
// hand-extracted copy of its functions — builds a synthetic message with
// THREE separate markdown blocks, invokes the real init()/run()/attach()
// flow, clicks the real "Copy as Markdown" button, and asserts the captured
// clipboard text contains all three blocks' content, in order.

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(__dirname, "..", "src", "behaviorFeatures.copybuttons.ts");

// Extract the `const JS = \`...\`;` template literal body straight out of the
// real .ts source — the exact string that gets injected into the webview —
// rather than re-typing/duplicating the logic here.
function extractInjectedScript(source) {
  const marker = "const JS = `";
  const start = source.indexOf(marker);
  assert.ok(start !== -1, "could not find `const JS = \\`` in behaviorFeatures.copybuttons.ts");
  const bodyStart = start + marker.length;
  const end = source.indexOf("`.trim();", bodyStart);
  assert.ok(end !== -1, "could not find closing `.trim();` for the JS template literal");
  let body = source.slice(bodyStart, end);
  // The .ts source escapes backslashes (\\n, \\`, \\/) because IT is itself a
  // template literal; unescape them so the extracted text is the real,
  // as-injected JS (mirrors escapeForTemplateLiteral()'s inverse).
  body = body.replace(/\\\\/g, "\\");
  return body;
}

function buildDom() {
  // runScripts: "dangerously" is required so window.eval() resolves `document`/
  // `window` as bare globals (jsdom's default eval sandbox does not expose
  // them as globals, unlike a real browser/webview) — safe here since we only
  // ever eval our OWN already-reviewed extension script, never third-party
  // content, against a synthetic fixture document.
  const dom = new JSDOM(
    `<!doctype html><html><body><div id="root"></div></body></html>`,
    { url: "https://example.test/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  return dom;
}

// A message with THREE separate markdown-classed sibling blocks, mimicking a
// long assistant reply split across multiple prose containers.
function buildThreeBlockMessage(doc) {
  const turn = doc.createElement("div");
  turn.className = "turn_abc123";
  turn.setAttribute("data-cc-dt-time", "10:00");
  turn.setAttribute("data-cc-dt-stamped", "1");

  const block1 = doc.createElement("div");
  block1.className = "markdown_xyz1";
  block1.innerHTML = "<p>First paragraph of the reply.</p>";

  const block2 = doc.createElement("div");
  block2.className = "markdown_xyz2";
  block2.innerHTML = "<p>Second paragraph, a separate markdown block.</p>";

  const block3 = doc.createElement("div");
  block3.className = "markdown_xyz3";
  block3.innerHTML = "<p>Third and final paragraph.</p>";

  turn.appendChild(block1);
  turn.appendChild(block2);
  turn.appendChild(block3);
  doc.body.querySelector("#root").appendChild(turn);
  return turn;
}

async function run() {
  const dom = buildDom();
  const { window } = dom;
  const doc = window.document;

  // Stub the two things the real webview provides that jsdom does not:
  // navigator.clipboard.writeText (capture what gets copied) and the shared
  // bootstrap hook __ccOnChatDoc (the feature registers against it; we drive
  // init(doc, win) ourselves, mirroring how the real bootstrap would).
  let copiedText = null;
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: (text) => { copiedText = text; return Promise.resolve(); } },
    configurable: true,
  });

  buildThreeBlockMessage(doc);

  const script = extractInjectedScript(readFileSync(SRC_PATH, "utf8"));

  // Evaluate the real injected script inside the jsdom window's own global
  // scope, then drive its exposed registration hook exactly like the real
  // bootstrap does (register(init) queues onto window.__ccPending since
  // __ccOnChatDoc isn't installed in this minimal harness — so we grab the
  // queued init function and call it ourselves with the real document/window).
  window.eval(script);
  assert.ok(Array.isArray(window.__ccPending) && window.__ccPending.length === 1,
    "expected the feature to queue exactly one init() via window.__ccPending");
  const init = window.__ccPending[0];
  init(doc, window);

  // The real button-attach flow runs on a 140ms debounce inside run(); init()
  // already calls run() synchronously once, so the group should exist now.
  const group = doc.querySelector(".cc-copy-group");
  assert.ok(group, "expected a .cc-copy-group to be attached to the stamped message");

  const mdBtn = group.querySelector("button[title='Copy as Markdown']");
  assert.ok(mdBtn, "expected a 'Copy as Markdown' button inside the group");

  mdBtn.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
  // navigator.clipboard.writeText resolves synchronously in this stub, but the
  // real code chains .then(done, ...) — flush one microtask turn.
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(copiedText, "expected Copy as Markdown to have written something to the clipboard");
  assert.match(copiedText, /First paragraph of the reply\./, "missing block 1 content — only later blocks copied");
  assert.match(copiedText, /Second paragraph, a separate markdown block\./, "missing block 2 content — contentRoots() regressed to first-match-only");
  assert.match(copiedText, /Third and final paragraph\./, "missing block 3 content — only earlier blocks copied");

  // Order must be preserved (document order), not just presence.
  const i1 = copiedText.indexOf("First paragraph");
  const i2 = copiedText.indexOf("Second paragraph");
  const i3 = copiedText.indexOf("Third and final");
  assert.ok(i1 >= 0 && i1 < i2 && i2 < i3, "expected blocks to be copied in document order");

  console.log("PASS: Copy as Markdown captures all sibling prose blocks, in order.");

  // --- Copy as HTML gets the same treatment ---------------------------------
  copiedText = null;
  const htmlBtn = group.querySelector("button[title='Copy as HTML']");
  assert.ok(htmlBtn, "expected a 'Copy as HTML' button inside the group");
  htmlBtn.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(copiedText, "expected Copy as HTML to have written something to the clipboard");
  assert.match(copiedText, /First paragraph of the reply\./);
  assert.match(copiedText, /Second paragraph, a separate markdown block\./);
  assert.match(copiedText, /Third and final paragraph\./);

  console.log("PASS: Copy as HTML captures all sibling prose blocks, in order.");
}

run().catch((err) => {
  console.error("FAILED:", err.message);
  process.exitCode = 1;
});
