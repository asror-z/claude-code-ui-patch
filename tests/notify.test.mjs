// Real-DOM regression test for behaviorFeatures.notify.ts: it must post a
// {type:"ccNotify"} message through window.__ccVsCodeApi (the shared
// openExternalBridge -- see openExternalBridge.ts) the moment (a) an
// AskUserQuestion-looking dialog appears, and (b) a reply finishes streaming
// (the composer's "Stop" control disappearing again). Also verifies the
// per-trigger localStorage settings (seeded by behaviorInject.ts's
// seedScript()/NOTIFY_KEYS) actually gate each trigger, and that a
// WebAudio-based beep is attempted when the sound setting is on.
//
// Runs the REAL injected script (not a hand-extracted copy) in a real jsdom
// window, drives real DOM mutations Claude Code's own bundle would produce,
// and asserts the real postMessage calls.

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOTIFY_SRC = path.join(__dirname, "..", "src", "behaviorFeatures.notify.ts");

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
    { url: "https://example.test/", pretendToBeVisual: true, runScripts: "dangerously" },
  );
}

// Minimal WebAudio stub -- jsdom has no real AudioContext, so a beep() call
// is proven by asserting the stubbed constructor was actually invoked and
// start()/stop() were called on an oscillator, not by asserting any real
// audio output (which doesn't exist in this environment).
function installAudioStub(win) {
  const calls = { contexts: 0, started: 0, stopped: 0 };
  function FakeOsc() {
    this.frequency = { setValueAtTime() {} };
    this.connect = () => {};
    this.start = () => { calls.started++; };
    this.stop = () => { calls.stopped++; };
  }
  function FakeGain() {
    this.gain = {
      setValueAtTime() {},
      exponentialRampToValueAtTime() {},
    };
    this.connect = () => {};
  }
  function FakeAudioContext() {
    calls.contexts++;
    this.state = "running";
    this.currentTime = 0;
    this.destination = {};
    this.createOscillator = () => new FakeOsc();
    this.createGain = () => new FakeGain();
  }
  win.AudioContext = FakeAudioContext;
  return calls;
}

function setLocal(win, key, value) {
  win.localStorage.setItem(key, value);
}

async function run() {
  const dom = buildDom();
  const { window } = dom;
  const doc = window.document;
  const audioCalls = installAudioStub(window);

  // The bridge notify.ts posts through -- capture every postMessage call.
  const posted = [];
  window.__ccVsCodeApi = { postMessage: (m) => posted.push(m) };

  const script = extractInjectedScript(readFileSync(NOTIFY_SRC, "utf8"));
  window.eval(script);
  assert.ok(
    Array.isArray(window.__ccPending) && window.__ccPending.length === 1,
    "expected Notify to queue exactly one init() via window.__ccPending",
  );
  const init = window.__ccPending.shift();
  init(doc, window);

  // --- Trigger 1: an AskUserQuestion-looking dialog appears ----------------
  const dialog = doc.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.className = "askUserQuestion_x1";
  const inner = doc.createElement("div");
  inner.textContent = "Which option?";
  dialog.appendChild(inner);
  doc.getElementById("root").appendChild(dialog);

  await new Promise((resolve) => setTimeout(resolve, 300)); // let the debounced sweep run

  const flashAsk = posted.filter((m) => m.type === "ccNotify" && m.flash);
  assert.ok(flashAsk.length >= 1, "expected a ccNotify flash message when an AskUserQuestion dialog appears");

  console.log("PASS: An AskUserQuestion-looking dialog triggers a ccNotify flash message.");

  // A second sweep with the SAME dialog still present must NOT re-notify.
  const countAfterFirst = posted.length;
  dialog.setAttribute("data-noop", "1"); // trivial mutation to trigger the observer
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(posted.length, countAfterFirst, "the same dialog must not re-trigger a second notification");

  console.log("PASS: The same AskUserQuestion dialog does not re-notify on a later sweep.");

  // --- Respect notifyFlashOnAsk = false -------------------------------------
  posted.length = 0;
  setLocal(window, "cc-notify-flash-on-ask", "false");
  const dialog2 = doc.createElement("div");
  dialog2.setAttribute("role", "alertdialog");
  dialog2.className = "askUserQuestion_x2";
  const inner2 = doc.createElement("div");
  inner2.textContent = "Pick one";
  dialog2.appendChild(inner2);
  doc.getElementById("root").appendChild(dialog2);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(posted.length, 0, "notifyFlashOnAsk=false must suppress the ask-trigger flash");

  console.log("PASS: notifyFlashOnAsk=false suppresses the AskUserQuestion flash.");

  // --- Trigger 2: a reply finishes streaming (Stop button appears then goes away) ---
  setLocal(window, "cc-notify-flash-on-ask", "true"); // reset for cleanliness
  posted.length = 0;

  const stopBtn = doc.createElement("button");
  stopBtn.setAttribute("aria-label", "Stop generating");
  doc.body.appendChild(stopBtn);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(posted.length, 0, "a Stop button appearing (streaming START) must not itself notify");

  doc.body.removeChild(stopBtn); // streaming ends
  await new Promise((resolve) => setTimeout(resolve, 300));

  const flashComplete = posted.filter((m) => m.type === "ccNotify" && m.flash);
  assert.ok(flashComplete.length >= 1, "expected a ccNotify flash message when the Stop button disappears (reply finished)");

  console.log("PASS: The Stop button disappearing (reply finished streaming) triggers a ccNotify flash message.");

  // --- Respect notifyFlashOnComplete = false --------------------------------
  posted.length = 0;
  setLocal(window, "cc-notify-flash-on-complete", "false");
  const stopBtn2 = doc.createElement("button");
  stopBtn2.setAttribute("title", "Stop response");
  doc.body.appendChild(stopBtn2);
  await new Promise((resolve) => setTimeout(resolve, 300));
  doc.body.removeChild(stopBtn2);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.strictEqual(posted.length, 0, "notifyFlashOnComplete=false must suppress the completion-trigger flash");

  console.log("PASS: notifyFlashOnComplete=false suppresses the completion flash.");

  // --- Sound: notifySoundOnComplete = true triggers a beep ------------------
  setLocal(window, "cc-notify-flash-on-complete", "true");
  setLocal(window, "cc-notify-sound-on-complete", "true");
  const before = audioCalls.started;
  const stopBtn3 = doc.createElement("button");
  stopBtn3.setAttribute("aria-label", "stop");
  doc.body.appendChild(stopBtn3);
  await new Promise((resolve) => setTimeout(resolve, 300));
  doc.body.removeChild(stopBtn3);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(audioCalls.started > before, "notifySoundOnComplete=true must play a beep (oscillator.start() called) on completion");

  console.log("PASS: notifySoundOnComplete=true plays a WebAudio beep on completion.");

  window.close();
}

run()
  .catch((err) => {
    console.error("FAILED:", err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => process.exit(process.exitCode || 0), 50);
  });
