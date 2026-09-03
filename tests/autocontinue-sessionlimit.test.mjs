// Real-DOM regression test for the session-limit branch of
// behaviorFeatures.autocontinue.ts — the part that detects Claude's own
// session/usage-limit banner ("You've hit your session limit · resets 7:50pm"
// and known variants), parses the reset time out of the banner's own text
// (several tolerated shapes), and arms a wait to auto-submit "continue" once
// that reset time (+ a buffer) arrives. A banner with NO parseable time falls
// back to a fixed wait instead of being silently ignored.
//
// Runs the REAL `const JS` template literal straight out of the .ts source
// (never a hand-typed re-implementation), in a real jsdom window, driving the
// real MutationObserver-based sweep against a synthetic banner element.
// window.setTimeout/clearTimeout are stubbed to CAPTURE the scheduled delay
// rather than actually waiting real time, so the test can assert "armed for
// ~N ms from now" without a real multi-hour sleep.

import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "src", "behaviorFeatures.autocontinue.ts");

// Mirrors tests/multiselect.test.mjs's extractInjectedScript().
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

function buildWindow() {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div id="root">
        <div role="textbox" aria-label="Message input" contenteditable="true"></div>
      </div>
    </body></html>`,
    { url: "https://example.test/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  return dom.window;
}

function installBootstrapStub(win) {
  win.__ccOnChatDoc = function (fn) {
    fn(win.document, win);
  };
}

// Captures every real setTimeout call the injected script makes (delay + fn),
// without actually scheduling anything on the real event loop — lets the test
// inspect "how long did it arm for" without sleeping real (possibly hours of)
// time. Returns the captured calls array; win.setTimeout/clearTimeout are
// replaced but every OTHER window API (querySelector, localStorage, Date,
// execCommand, etc.) stays real jsdom behavior.
function stubTimers(win) {
  const calls = [];
  let nextId = 1;
  win.setTimeout = function (fn, delay) {
    const id = nextId++;
    calls.push({ id, fn, delay });
    return id;
  };
  win.clearTimeout = function (id) {
    const idx = calls.findIndex((c) => c.id === id);
    if (idx !== -1) calls.splice(idx, 1);
  };
  return calls;
}

function addLimitBanner(doc, text) {
  const el = doc.createElement("div");
  el.setAttribute("role", "alert");
  el.className = "limitBanner_abc123";
  el.textContent = text;
  doc.getElementById("root").appendChild(el);
  return el;
}

// Reads the persisted { fireAt, matched } record the session-limit arm path writes to
// localStorage — the authoritative final fire moment, independent of slSchedule()'s
// internal MAX_CHUNK re-scheduling (a long wait is armed via several chained
// setTimeout calls capped at 30min each, so the LONGEST captured setTimeout delay is
// often just the first chunk, not the true total wait).
function readArmedRecord(win) {
  const raw = win.localStorage.getItem("cc-autocontinue-sessionlimit-armed");
  return raw ? JSON.parse(raw) : null;
}

test("session-limit banner with a clock-time reset ('resets 7:50pm') arms a wait ~1min past that clock time", () => {
  const win = buildWindow();
  try {
    const doc = win.document;
    installBootstrapStub(win);
    stubTimers(win);

    addLimitBanner(doc, "You've hit your session limit · resets 7:50pm");

    win.eval(extractInjectedScript(readFileSync(SRC, "utf8")));

    const armed = readArmedRecord(win);
    assert.ok(armed, "expected a persisted armed record from the session-limit arm path");
    const delay = armed.fireAt - Date.now();
    // A clock-time reset (+ 1min default buffer) must land somewhere between now and
    // ~24h+1min out (next occurrence of that clock time, worst case tomorrow).
    assert.ok(delay > 0, "armed fireAt must be in the future");
    assert.ok(delay <= 24 * 60 * 60000 + 60000, "armed fireAt must be within ~24h + buffer");
  } finally {
    win.close();
  }
});

test("session-limit banner with a bare-hour+am/pm reset and trailing timezone ('resets 11am (Asia/Karachi)') arms a real wait, not the fallback", () => {
  const win = buildWindow();
  try {
    const doc = win.document;
    installBootstrapStub(win);
    stubTimers(win);

    addLimitBanner(doc, "You've hit your session limit · resets 11am (Asia/Karachi)");

    win.eval(extractInjectedScript(readFileSync(SRC, "utf8")));

    const armed = readArmedRecord(win);
    assert.ok(armed, "expected a persisted armed record from the session-limit arm path");
    const delay = armed.fireAt - Date.now();
    assert.ok(delay > 0, "armed fireAt must be in the future");
    assert.ok(delay <= 24 * 60 * 60000 + 60000, "armed fireAt must be within ~24h + buffer");
    const fireAtDate = new Date(armed.fireAt);
    assert.equal(fireAtDate.getHours(), 11, "must resolve to 11:00, not fall back to the generic 30min wait");
    assert.equal(fireAtDate.getMinutes(), 1, "must include the 1min default buffer past the parsed clock time");
  } finally {
    win.close();
  }
});

test("session-limit banner with a relative duration ('resets in 45 minutes') arms a wait close to 45min + buffer", () => {
  const win = buildWindow();
  try {
    const doc = win.document;
    installBootstrapStub(win);
    stubTimers(win);

    addLimitBanner(doc, "Usage limit reached. Resets in 45 minutes");

    win.eval(extractInjectedScript(readFileSync(SRC, "utf8")));

    const armed = readArmedRecord(win);
    assert.ok(armed, "expected a persisted armed record");
    const delay = armed.fireAt - Date.now();
    // ~45 minutes (2,700,000ms) + 60,000ms default buffer = ~2,760,000ms, allow
    // slack for wall-clock jitter during the test run.
    const expected = 45 * 60000 + 60000;
    assert.ok(
      Math.abs(delay - expected) < 5000,
      `expected delay near ${expected}ms, got ${delay}ms`
    );
  } finally {
    win.close();
  }
});

test("session-limit banner with a duration+hours shape ('resets in 2h 30m') arms a wait close to 2h30m + buffer", () => {
  const win = buildWindow();
  try {
    const doc = win.document;
    installBootstrapStub(win);
    stubTimers(win);

    addLimitBanner(doc, "5-hour limit reached · resets in 2h 30m");

    win.eval(extractInjectedScript(readFileSync(SRC, "utf8")));

    const armed = readArmedRecord(win);
    assert.ok(armed, "expected a persisted armed record");
    const delay = armed.fireAt - Date.now();
    const expected = (2 * 60 + 30) * 60000 + 60000;
    assert.ok(
      Math.abs(delay - expected) < 5000,
      `expected delay near ${expected}ms, got ${delay}ms`
    );
  } finally {
    win.close();
  }
});

test("session-limit banner with NO parseable time falls back to the fixed fallback wait", () => {
  const win = buildWindow();
  try {
    const doc = win.document;
    installBootstrapStub(win);
    stubTimers(win);

    addLimitBanner(doc, "Weekly limit reached. It will reset soon.");

    win.eval(extractInjectedScript(readFileSync(SRC, "utf8")));

    const armed = readArmedRecord(win);
    assert.ok(armed, "expected a persisted armed record for the fallback wait");
    const delay = armed.fireAt - Date.now();
    // Default fallback is 30 minutes (1,800,000ms), NO buffer added on top of
    // the fallback (the fallback itself already IS the whole wait).
    const expected = 30 * 60000;
    assert.ok(
      Math.abs(delay - expected) < 5000,
      `expected fallback delay near ${expected}ms, got ${delay}ms`
    );
  } finally {
    win.close();
  }
});

test("ordinary chat prose merely mentioning 'session limit' never arms a session-limit wait", () => {
  const win = buildWindow();
  try {
    const doc = win.document;
    installBootstrapStub(win);
    stubTimers(win);

    // A user message DISCUSSING the topic — inside a message container, not a banner,
    // and the limit phrase does not LEAD the text (it's buried past the 40-char window
    // limitPhraseLeads() checks, unlike a real banner which leads with it immediately).
    const msg = doc.createElement("div");
    msg.className = "userMessageContainer_xyz";
    msg.textContent = "I was reading the docs earlier and wondered — how does the session limit reset actually work in Claude?";
    doc.getElementById("root").appendChild(msg);

    win.eval(extractInjectedScript(readFileSync(SRC, "utf8")));

    assert.equal(readArmedRecord(win), null, "chat prose merely mentioning the phrase must never arm a wait");
  } finally {
    win.close();
  }
});

test("off override (localStorage 'cc-autocontinue'='off') never arms a session-limit wait", () => {
  const win = buildWindow();
  try {
    const doc = win.document;
    installBootstrapStub(win);
    win.localStorage.setItem("cc-autocontinue", "off");
    stubTimers(win);

    addLimitBanner(doc, "You've hit your session limit · resets 7:50pm");

    win.eval(extractInjectedScript(readFileSync(SRC, "utf8")));

    assert.equal(readArmedRecord(win), null, "off override must prevent arming a session-limit wait");
  } finally {
    win.close();
  }
});

test("a NEWEST chat message that leads with a real limit+reset phrase arms a wait (Claude can surface this as an ordinary message, not a styled banner)", () => {
  const win = buildWindow();
  try {
    const doc = win.document;
    installBootstrapStub(win);
    stubTimers(win);

    const msg = doc.createElement("div");
    msg.className = "turn_xyz";
    msg.textContent = "Usage limit reached, resets in 10 minutes";
    doc.getElementById("root").appendChild(msg);

    win.eval(extractInjectedScript(readFileSync(SRC, "utf8")));

    const armed = readArmedRecord(win);
    assert.ok(armed, "a newest message leading with a real limit+reset phrase must arm a wait");
  } finally {
    win.close();
  }
});
