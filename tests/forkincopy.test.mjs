// Real-DOM regression test for behaviorFeatures.forkincopy.ts's fork button
// docked into CopyButtons' own .cc-copy-group row on assistant OUTPUT
// messages.
//
// This test runs BOTH the real CopyButtons injected script (which creates the
// .cc-copy-group row this feature docks into) AND the real ForkInCopy
// injected script — not hand-extracted copies of their logic — in a real
// jsdom window, builds a synthetic user message followed by an assistant
// output message, drives the real init()/run() flow for both features,
// clicks the fork button, and asserts it proxies a click onto the PRECEDING
// user message's native "Message actions" trigger and its popup's "Fork
// conversation from here" option — never the output message's own (it has
// none, since CopyButtons never attaches to user messages).

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COPYBUTTONS_SRC = path.join(__dirname, "..", "src", "behaviorFeatures.copybuttons.ts");
const FORKINCOPY_SRC = path.join(__dirname, "..", "src", "behaviorFeatures.forkincopy.ts");

// Extract the `const JS = \`...\`;` template literal body straight out of the
// real .ts source — the exact string that gets injected into the webview —
// rather than re-typing/duplicating the logic here. Mirrors
// tests/copybuttons.test.mjs's own extractInjectedScript().
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

// A USER message bubble carrying the native "Message actions" trigger + a
// (not-yet-mounted) popup — mirrors the real webview's own structure, and
// ForkConv/UserCollapse's own test fixtures for the same native markup.
function buildUserMessage(doc, timeStamp) {
  const bubble = doc.createElement("div");
  bubble.className = "userMessageContainer_abc";
  bubble.setAttribute("data-cc-dt-time", timeStamp);
  bubble.setAttribute("data-cc-dt-stamped", "1");
  bubble.innerHTML = "<div class=\"messageContent_x\">What is the capital of France?</div>";

  const trigger = doc.createElement("button");
  trigger.setAttribute("title", "Message actions");
  trigger.className = "actionButton_x";
  let popupOpen = false;
  trigger.addEventListener("click", () => {
    popupOpen = !popupOpen;
    let popup = bubble.querySelector(".popup_x");
    if (popupOpen) {
      if (!popup) {
        popup = doc.createElement("div");
        popup.className = "popup_x";
        const forkOpt = doc.createElement("button");
        forkOpt.className = "popupOption_x";
        forkOpt.innerHTML = "<span class=\"optionText_x\">Fork conversation from here</span>";
        forkOpt.addEventListener("click", () => {
          bubble.setAttribute("data-test-forked", "1");
        });
        popup.appendChild(forkOpt);
        bubble.appendChild(popup);
      }
    } else if (popup) {
      popup.remove();
    }
  });
  bubble.appendChild(trigger);
  return bubble;
}

// An assistant OUTPUT message — a plain turn_ wrapper with one markdown block,
// no native "Message actions" trigger of its own is required for this test
// (ForkInCopy must never look for one here — it forks from the PRECEDING user
// message instead).
function buildOutputMessage(doc, timeStamp) {
  const turn = doc.createElement("div");
  turn.className = "turn_def456";
  turn.setAttribute("data-cc-dt-time", timeStamp);
  turn.setAttribute("data-cc-dt-stamped", "1");
  const block = doc.createElement("div");
  block.className = "markdown_xyz1";
  block.innerHTML = "<p>Paris is the capital of France.</p>";
  turn.appendChild(block);
  return turn;
}

async function run() {
  const dom = buildDom();
  const { window } = dom;
  const doc = window.document;
  const root = doc.querySelector("#root");

  const userMsg = buildUserMessage(doc, "10:00");
  const outputMsg = buildOutputMessage(doc, "10:01");
  root.appendChild(userMsg);
  root.appendChild(outputMsg);

  // Load and drive CopyButtons FIRST (real load order in patcher.ts: copybuttons
  // is imported before forkincopy) so its .cc-copy-group row exists on the
  // output message before ForkInCopy's own run() sweeps.
  const copyScript = extractInjectedScript(readFileSync(COPYBUTTONS_SRC, "utf8"));
  window.eval(copyScript);
  assert.ok(Array.isArray(window.__ccPending) && window.__ccPending.length === 1,
    "expected CopyButtons to queue exactly one init() via window.__ccPending");
  window.__ccPending.shift()(doc, window);

  const group = outputMsg.querySelector(".cc-copy-group");
  assert.ok(group, "expected CopyButtons to attach its .cc-copy-group to the OUTPUT message");
  assert.ok(!userMsg.querySelector(".cc-copy-group"), "CopyButtons must never attach to the USER message");

  // Now load and drive ForkInCopy.
  const forkScript = extractInjectedScript(readFileSync(FORKINCOPY_SRC, "utf8"));
  window.eval(forkScript);
  assert.ok(Array.isArray(window.__ccPending) && window.__ccPending.length === 1,
    "expected ForkInCopy to queue exactly one init() via window.__ccPending");
  window.__ccPending.shift()(doc, window);

  const forkBtn = group.querySelector("[data-cc-forkincopy-btn='1']");
  assert.ok(forkBtn, "expected a fork button docked inside CopyButtons' own .cc-copy-group");
  assert.strictEqual(forkBtn.parentElement, group, "fork button must be a direct child of .cc-copy-group");
  assert.strictEqual(group.lastElementChild, forkBtn, "fork button must be the LAST child (right end) of the group");
  assert.ok(!userMsg.querySelector("[data-cc-forkincopy-btn]"),
    "ForkInCopy must never attach its own button directly to the user message");

  console.log("PASS: ForkInCopy docks its button as the last child of CopyButtons' row on the output message.");

  // Click it — must proxy through the PRECEDING USER message's native trigger,
  // never anything on the output message itself.
  forkBtn.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));

  // The popup mount is polled every 20ms (bounded ~30 tries); give it a few ticks.
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.strictEqual(userMsg.getAttribute("data-test-forked"), "1",
    "expected the click to reach the PRECEDING user message's native 'Fork conversation from here' option");

  console.log("PASS: Clicking the docked fork button forks from the preceding user message's native popup option.");

  // --- No preceding user message => no button, and any stale one is removed ---
  const dom2 = buildDom();
  const win2 = dom2.window;
  const doc2 = win2.document;
  const root2 = doc2.querySelector("#root");
  const soloOutput = buildOutputMessage(doc2, "09:00"); // no user message before it at all
  root2.appendChild(soloOutput);

  win2.eval(extractInjectedScript(readFileSync(COPYBUTTONS_SRC, "utf8")));
  win2.__ccPending.shift()(doc2, win2);
  const group2 = soloOutput.querySelector(".cc-copy-group");
  assert.ok(group2, "expected CopyButtons to still attach its row even with no preceding user message");

  win2.eval(extractInjectedScript(readFileSync(FORKINCOPY_SRC, "utf8")));
  win2.__ccPending.shift()(doc2, win2);
  assert.ok(!group2.querySelector("[data-cc-forkincopy-btn]"),
    "expected NO fork button when the output has no preceding user message to fork from");

  console.log("PASS: No fork button is added when there is no preceding user message.");
}

run().catch((err) => {
  console.error("FAILED:", err.message);
  process.exitCode = 1;
});
