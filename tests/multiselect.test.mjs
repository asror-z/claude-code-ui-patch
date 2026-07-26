// Real-DOM regression test for behaviorFeatures.multiselect.ts's checkbox
// docked into CopyButtons' own .cc-copy-group row, plus its batch-copy action.
//
// Runs BOTH the real CopyButtons injected script (which creates the
// .cc-copy-group row this feature docks into, and exposes
// window.__ccCopyButtons for reuse) AND the real MultiSelect injected script
// — not hand-extracted copies of their logic — in a real jsdom window, builds
// two synthetic assistant OUTPUT messages, drives the real init()/run() flow
// for both features, checks both checkboxes, invokes the toolbar's
// copySelected(), and asserts the clipboard receives the COMBINED content of
// both selected replies, in document order.

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COPYBUTTONS_SRC = path.join(__dirname, "..", "src", "behaviorFeatures.copybuttons.ts");
const MULTISELECT_SRC = path.join(__dirname, "..", "src", "behaviorFeatures.multiselect.ts");

// Extract the `const JS = \`...\`;` template literal body straight out of the
// real .ts source — the exact string that gets injected into the webview —
// rather than re-typing/duplicating the logic here. Mirrors
// tests/forkincopy.test.mjs's own extractInjectedScript().
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

function buildDom() {
  const dom = new JSDOM(
    `<!doctype html><html><body><div id="root"></div></body></html>`,
    { url: "https://example.test/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  return dom;
}

// A minimal window.__ccToolbar stand-in — MultiSelect only needs .add()/.get(),
// not the real docked-toolbar DOM mechanics (behaviorToolbar.ts is a separate
// injected script this test does not need to also load).
function installToolbarStub(win) {
  const buttons = new Map();
  win.__ccToolbar = {
    add(spec) {
      let btn = buttons.get(spec.id);
      if (!btn) {
        btn = win.document.createElement("button");
        btn.setAttribute("data-cc-tool", spec.id);
        win.document.body.appendChild(btn);
        buttons.set(spec.id, btn);
      }
      btn.__spec = spec;
      return btn;
    },
    get(id) {
      return buttons.get(id) || null;
    },
  };
}

function buildOutputMessage(doc, timeStamp, text) {
  const turn = doc.createElement("div");
  turn.className = "turn_abc123";
  turn.setAttribute("data-cc-dt-time", timeStamp);
  turn.setAttribute("data-cc-dt-stamped", "1");
  const block = doc.createElement("div");
  block.className = "markdown_xyz1";
  block.innerHTML = "<p>" + text + "</p>";
  turn.appendChild(block);
  return turn;
}

async function run() {
  const dom = buildDom();
  const { window } = dom;
  const doc = window.document;
  const root = doc.querySelector("#root");
  installToolbarStub(window);

  const msg1 = buildOutputMessage(doc, "10:00", "First reply content.");
  const msg2 = buildOutputMessage(doc, "10:05", "Second reply content.");
  root.appendChild(msg1);
  root.appendChild(msg2);

  // Load and drive CopyButtons FIRST (real load order in patcher.ts: copybuttons
  // is imported before multiselect) so its .cc-copy-group rows + window.__ccCopyButtons
  // exist before MultiSelect's own run() sweeps.
  const copyScript = extractInjectedScript(readFileSync(COPYBUTTONS_SRC, "utf8"));
  window.eval(copyScript);
  assert.ok(Array.isArray(window.__ccPending) && window.__ccPending.length === 1,
    "expected CopyButtons to queue exactly one init() via window.__ccPending");
  window.__ccPending.shift()(doc, window);

  const group1 = msg1.querySelector(".cc-copy-group");
  const group2 = msg2.querySelector(".cc-copy-group");
  assert.ok(group1 && group2, "expected CopyButtons to attach its row to both output messages");
  assert.ok(typeof window.__ccCopyButtons === "object" && typeof window.__ccCopyButtons.markdownOf === "function",
    "expected CopyButtons to expose window.__ccCopyButtons.markdownOf()");

  // Now load and drive MultiSelect.
  const msScript = extractInjectedScript(readFileSync(MULTISELECT_SRC, "utf8"));
  window.eval(msScript);
  assert.ok(Array.isArray(window.__ccPending) && window.__ccPending.length === 1,
    "expected MultiSelect to queue exactly one init() via window.__ccPending");
  window.__ccPending.shift()(doc, window);

  const chk1 = group1.querySelector("[data-cc-multiselect-chk]");
  const chk2 = group2.querySelector("[data-cc-multiselect-chk]");
  assert.ok(chk1 && chk2, "expected a checkbox docked into each output message's .cc-copy-group");
  assert.strictEqual(group1.firstElementChild, chk1, "the checkbox must be the FIRST child (left end) of the group");

  console.log("PASS: MultiSelect docks a checkbox as the first child of each output message's CopyButtons row.");

  // --- Nothing selected yet: the toolbar action must no-op / warn, not throw ---
  const toolbarBtn = window.__ccToolbar.get("multiselect");
  assert.ok(toolbarBtn, "expected MultiSelect to register a toolbar action");
  assert.doesNotThrow(() => toolbarBtn.__spec.onClick({}), "clicking with nothing selected must not throw");

  // --- Check both boxes, then batch-copy as Markdown ---
  chk1.checked = true;
  chk1.dispatchEvent(new window.Event("change", { bubbles: true }));
  chk2.checked = true;
  chk2.dispatchEvent(new window.Event("change", { bubbles: true }));

  assert.strictEqual(window.__ccMultiSelect.selectedCount(), 2, "expected both messages to be selected");

  // jsdom exposes no real navigator.clipboard — the feature falls back to the
  // hidden-textarea + execCommand("copy") path; capture what gets copied by
  // stubbing execCommand to record the textarea's value at call time.
  let copiedText = null;
  doc.execCommand = function (cmd) {
    if (cmd === "copy") {
      const active = doc.activeElement;
      if (active && "value" in active) copiedText = active.value;
    }
    return true;
  };

  toolbarBtn.__spec.onClick({}); // plain click => Markdown

  assert.ok(copiedText, "expected copySelected() to write something to the clipboard fallback");
  assert.ok(copiedText.includes("First reply content."), "combined copy must include the first selected reply");
  assert.ok(copiedText.includes("Second reply content."), "combined copy must include the second selected reply");
  // document order: first reply's text must appear before the second's.
  assert.ok(copiedText.indexOf("First reply content.") < copiedText.indexOf("Second reply content."),
    "combined copy must preserve document order");

  console.log("PASS: Batch-copying two selected replies combines both, in document order.");

  // --- Shift-click copies HTML instead of Markdown ---
  copiedText = null;
  toolbarBtn.__spec.onClick({ shiftKey: true });
  assert.ok(copiedText && copiedText.indexOf("<html>") !== -1, "shift-click must copy an HTML document, not Markdown");

  console.log("PASS: Shift-clicking the toolbar action copies HTML instead of Markdown.");

  // --- Unchecking a box removes it from the selection ---
  chk1.checked = false;
  chk1.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.strictEqual(window.__ccMultiSelect.selectedCount(), 1, "expected unchecking a box to shrink the selection");

  console.log("PASS: Unchecking a box removes that message from the selection.");
}

run().catch((err) => {
  console.error("FAILED:", err.message);
  process.exitCode = 1;
});
