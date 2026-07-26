// Real-DOM regression test for behaviorFeatures.autoscroll.ts's scroll-lock
// toggle: while LOCKED and the user is scrolled away from the bottom, the
// feature repeatedly re-applies the held scroll position (counter-acting
// Claude Code's own native pin-to-bottom writes); while UNLOCKED (the
// default), it does nothing and leaves scrollTop untouched.
//
// Runs the REAL injected script (not a hand-extracted copy) in a real jsdom
// window, builds a synthetic scrollable message container, simulates the
// native webview repeatedly pinning scrollTop to the bottom (as Claude Code's
// own bundle does while streaming), and asserts: unlocked => the pin wins;
// locked => the held position is restored.

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTOSCROLL_SRC = path.join(__dirname, "..", "src", "behaviorFeatures.autoscroll.ts");

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
  return new JSDOM(
    `<!doctype html><html><body><div id="root"></div></body></html>`,
    { url: "https://example.test/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
}

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

// A synthetic scrollable "messagesContainer" — jsdom does not lay out real
// scrollHeight/clientHeight from CSS, so these are stubbed directly as
// writable numeric properties (the same technique any jsdom scroll test uses
// since jsdom has no real layout engine). scrollHeight is mutable via
// growScrollHeight() so a test can simulate new streamed content actually
// growing the container, exactly like the real webview does while a reply
// streams in.
function buildScrollContainer(doc) {
  const cont = doc.createElement("div");
  cont.className = "messagesContainer_zz";
  let _scrollHeight = 2000;
  Object.defineProperty(cont, "scrollHeight", {
    get() { return _scrollHeight; },
    configurable: true,
  });
  Object.defineProperty(cont, "clientHeight", { value: 500, configurable: true });
  let _top = 0;
  Object.defineProperty(cont, "scrollTop", {
    get() { return _top; },
    set(v) { _top = v; },
    configurable: true,
  });
  cont.growScrollHeight = (by) => { _scrollHeight += by; };
  const msg = doc.createElement("div");
  msg.className = "userMessageContainer_a";
  cont.appendChild(msg);
  doc.querySelector("#root").appendChild(cont);
  return cont;
}

async function run() {
  const dom = buildDom();
  const { window } = dom;
  const doc = window.document;
  installToolbarStub(window);
  const cont = buildScrollContainer(doc);

  const script = extractInjectedScript(readFileSync(AUTOSCROLL_SRC, "utf8"));
  window.eval(script);
  assert.ok(Array.isArray(window.__ccPending) && window.__ccPending.length === 1,
    "expected AutoScroll to queue exactly one init() via window.__ccPending");
  window.__ccPending.shift()(doc, window);

  const toggleBtn = window.__ccToolbar.get("autoscroll");
  assert.ok(toggleBtn, "expected AutoScroll to register a toolbar action");
  assert.strictEqual(toggleBtn.getAttribute("aria-pressed"), "false", "expected the default state to be unlocked");

  console.log("PASS: AutoScroll registers a toolbar toggle, unlocked by default.");

  // --- UNLOCKED: user scrolls up, a native "pin to bottom" write wins ---
  cont.scrollTop = 900; // user scrolled up, away from the bottom
  cont.dispatchEvent(new window.Event("scroll"));
  await new Promise((resolve) => setTimeout(resolve, 200)); // let the hold-interval tick run

  cont.scrollTop = 1500; // simulate Claude Code's own native pin-to-bottom write
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.strictEqual(cont.scrollTop, 1500, "unlocked: a native pin-to-bottom write must NOT be counter-acted");

  console.log("PASS: While unlocked, a native scroll write is left untouched.");

  // --- LOCK, scroll away from the bottom, then a native write is fought back ---
  toggleBtn.__spec.onClick();
  assert.strictEqual(toggleBtn.getAttribute("aria-pressed"), "true", "expected the toggle to report locked after clicking");

  cont.scrollTop = 900; // user scrolls up while locked
  cont.dispatchEvent(new window.Event("scroll"));
  await new Promise((resolve) => setTimeout(resolve, 200)); // let onUserScroll's debounce + a hold tick run

  // Simulate the reply continuing to STREAM while the user reads at 900: new
  // content grows scrollHeight (2000 -> 3000, mirroring the real webview),
  // and the native code pins scrollTop to the new bottom
  // (scrollHeight - clientHeight = 2500) — now genuinely far from the held
  // 900, so the hold must fight it back rather than release.
  cont.growScrollHeight(1000);
  cont.scrollTop = 2500;
  await new Promise((resolve) => setTimeout(resolve, 250)); // give the hold-interval time to re-apply

  assert.strictEqual(cont.scrollTop, 900, "locked: the held scroll position must be re-applied over a native pin-to-bottom write");

  console.log("PASS: While locked, a native pin-to-bottom write is counter-acted back to the held position.");

  // --- Unlocking again releases the hold ---
  toggleBtn.__spec.onClick();
  assert.strictEqual(toggleBtn.getAttribute("aria-pressed"), "false", "expected the toggle to report unlocked after a second click");

  cont.scrollTop = 1999;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.strictEqual(cont.scrollTop, 1999, "unlocked again: scroll writes must no longer be counter-acted");

  console.log("PASS: Unlocking releases the held position and native scroll writes pass through again.");

  // The feature installs a real setInterval hold-timer that otherwise keeps
  // the Node process (and node --test) alive forever — close the jsdom window
  // to tear down every timer/listener it owns before this test exits.
  window.close();
}

run()
  .catch((err) => {
    console.error("FAILED:", err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    // Belt-and-suspenders: force-exit even if something else in jsdom kept a
    // handle open, so this test can never hang the suite.
    setTimeout(() => process.exit(process.exitCode || 0), 50);
  });
