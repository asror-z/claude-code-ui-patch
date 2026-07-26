// Real-DOM regression test for behaviorFeatures.forkincopy.ts's fork button
// docked into CopyButtons' own .cc-copy-group row on assistant OUTPUT
// messages.
//
// Real incident this guards against: the fork button never appeared for a
// real 1-exchange chat. Root cause: precedingUserMessage() originally only
// searched for a SIBLING stamped USER entry earlier in stampedMessages() —
// but Claude Code's real chat DOM nests the user prompt bubble
// (userMessageContainer_…) INSIDE the same turn_… wrapper DateTime stamps as
// ONE unit (per copybuttons.ts's own contentRoots() comment documenting this
// exact nesting), so a 1-exchange chat produces stampedCount=1, not 2 — there
// is no separate sibling entry to find. Live Faro evidence confirmed this:
// "[cc-forkincopy] sweep stampedCount=1 outputCount=1 attachedCount=0". Fixed
// by searching INSIDE outputEl for a nested user bubble FIRST, falling back
// to the sibling search only for a DOM shape where they really are distinct
// stamped elements.
//
// This test runs BOTH the real CopyButtons injected script (which creates the
// .cc-copy-group row this feature docks into) AND the real ForkInCopy
// injected script — not hand-extracted copies of their logic — in a real
// jsdom window, and covers BOTH DOM shapes.

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

// Build a native "Message actions" trigger + popup on `bubble`, wired so
// clicking the popup's "Fork conversation from here" option stamps
// data-test-forked="1" on `bubble` — mirrors ForkConv's own real fixture.
function wireMessageActions(doc, bubble) {
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
  return trigger;
}

// THE REAL SHAPE: a single turn_… wrapper (the DateTime-stamped element) that
// NESTS the user prompt bubble BEFORE the assistant's own markdown content —
// exactly as copybuttons.ts's own contentRoots() comment documents. Only ONE
// element carries [data-cc-dt-time] for the whole exchange.
function buildNestedTurn(doc, timeStamp) {
  const turn = doc.createElement("div");
  turn.className = "turn_def456";
  turn.setAttribute("data-cc-dt-time", timeStamp);
  turn.setAttribute("data-cc-dt-stamped", "1");

  const userBubble = doc.createElement("div");
  userBubble.className = "userMessageContainer_abc";
  userBubble.innerHTML = "<div class=\"messageContent_x\">What is the capital of France?</div>";
  wireMessageActions(doc, userBubble);
  turn.appendChild(userBubble);

  const block = doc.createElement("div");
  block.className = "markdown_xyz1";
  block.innerHTML = "<p>Paris is the capital of France.</p>";
  turn.appendChild(block);

  return { turn, userBubble };
}

async function driveFeatures(doc, win, root) {
  const copyScript = extractInjectedScript(readFileSync(COPYBUTTONS_SRC, "utf8"));
  win.eval(copyScript);
  assert.ok(Array.isArray(win.__ccPending) && win.__ccPending.length === 1,
    "expected CopyButtons to queue exactly one init() via window.__ccPending");
  win.__ccPending.shift()(doc, win);

  const forkScript = extractInjectedScript(readFileSync(FORKINCOPY_SRC, "utf8"));
  win.eval(forkScript);
  assert.ok(Array.isArray(win.__ccPending) && win.__ccPending.length === 1,
    "expected ForkInCopy to queue exactly one init() via window.__ccPending");
  win.__ccPending.shift()(doc, win);
}

async function run() {
  // --- Case 1: THE REAL, NESTED shape (the actual bug scenario) ------------
  {
    const dom = buildDom();
    const { window } = dom;
    const doc = window.document;
    const root = doc.querySelector("#root");

    const { turn, userBubble } = buildNestedTurn(doc, "10:00");
    root.appendChild(turn);

    await driveFeatures(doc, window, root);

    const group = turn.querySelector(":scope > .cc-copy-group");
    assert.ok(group, "expected CopyButtons to attach its .cc-copy-group to the turn_ wrapper");

    const forkBtn = group.querySelector("[data-cc-forkincopy-btn='1']");
    assert.ok(forkBtn, "expected a fork button in a 1-exchange chat where the user bubble is NESTED inside the stamped turn_ wrapper (the real bug scenario)");
    assert.strictEqual(group.lastElementChild, forkBtn, "fork button must be the LAST child (right end) of the group");

    forkBtn.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.strictEqual(userBubble.getAttribute("data-test-forked"), "1",
      "expected the click to reach the NESTED user bubble's native 'Fork conversation from here' option");

    console.log("PASS: Fork button appears and works for the real NESTED user-bubble-inside-turn_ DOM shape.");
  }

  // --- Case 2: the SIBLING fallback shape (a distinct earlier stamped user entry) ---
  {
    const dom = buildDom();
    const { window } = dom;
    const doc = window.document;
    const root = doc.querySelector("#root");

    const userMsg = doc.createElement("div");
    userMsg.className = "userMessageContainer_abc";
    userMsg.setAttribute("data-cc-dt-time", "10:00");
    userMsg.setAttribute("data-cc-dt-stamped", "1");
    userMsg.innerHTML = "<div class=\"messageContent_x\">What is the capital of France?</div>";
    wireMessageActions(doc, userMsg);

    const outputMsg = doc.createElement("div");
    outputMsg.className = "turn_ghi789";
    outputMsg.setAttribute("data-cc-dt-time", "10:01");
    outputMsg.setAttribute("data-cc-dt-stamped", "1");
    outputMsg.innerHTML = "<div class=\"markdown_xyz1\"><p>Paris is the capital of France.</p></div>";

    root.appendChild(userMsg);
    root.appendChild(outputMsg);

    await driveFeatures(doc, window, root);

    const group = outputMsg.querySelector(":scope > .cc-copy-group");
    assert.ok(group, "expected CopyButtons to attach its .cc-copy-group to the OUTPUT message");
    assert.ok(!userMsg.querySelector(".cc-copy-group"), "CopyButtons must never attach to the USER message");

    const forkBtn = group.querySelector("[data-cc-forkincopy-btn='1']");
    assert.ok(forkBtn, "expected a fork button docked inside CopyButtons' own .cc-copy-group (sibling shape)");
    assert.ok(!userMsg.querySelector("[data-cc-forkincopy-btn]"),
      "ForkInCopy must never attach its own button directly to the user message");

    forkBtn.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.strictEqual(userMsg.getAttribute("data-test-forked"), "1",
      "expected the click to reach the preceding SIBLING user message's native popup option");

    console.log("PASS: Fork button also works for the sibling (non-nested) DOM shape fallback.");
  }

  // --- Case 3: no preceding/nested user message => no button ---------------
  {
    const dom = buildDom();
    const { window } = dom;
    const doc = window.document;
    const root = doc.querySelector("#root");

    const soloOutput = doc.createElement("div");
    soloOutput.className = "turn_solo";
    soloOutput.setAttribute("data-cc-dt-time", "09:00");
    soloOutput.setAttribute("data-cc-dt-stamped", "1");
    soloOutput.innerHTML = "<div class=\"markdown_xyz1\"><p>Hello.</p></div>";
    root.appendChild(soloOutput);

    await driveFeatures(doc, window, root);

    const group = soloOutput.querySelector(":scope > .cc-copy-group");
    assert.ok(group, "expected CopyButtons to still attach its row even with no preceding user message");
    assert.ok(!group.querySelector("[data-cc-forkincopy-btn]"),
      "expected NO fork button when the output has no preceding/nested user message to fork from");

    console.log("PASS: No fork button is added when there is no preceding/nested user message.");
  }
}

run().catch((err) => {
  console.error("FAILED:", err.message);
  process.exitCode = 1;
});
