// Real-DOM regression test for behaviorFeatures.noarrowuphistory.ts.
//
// Claude Code's OWN native webview/index.js binds a keydown listener on the
// composer that recalls the user's last sent message when ArrowUp is pressed
// (`if(le.key==="ArrowUp"&&!R&&!Zi){if(Qs.cycleMessage(-1))...}`, confirmed
// live against the real installed bundle). This feature adds a CAPTURE-phase
// keydown listener on the same composer element that calls
// ev.stopImmediatePropagation() for ArrowUp, so the native bubble-phase
// listener (registered later, in React's own event delegation) never sees the
// key. This test does not have the real Claude Code bundle to load, so it
// proves the mechanism directly: register a stand-in bubble-phase listener on
// the SAME element (representing the native handler) and assert it never
// fires once this feature's real, extracted script is active.
//
// Runs the REAL `const JS` template literal straight out of the .ts source
// (never a hand-typed re-implementation), in a real jsdom window, against a
// synthetic composer element shaped like the real one
// ([role="textbox"][aria-label="Message input"]).

import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, "..", "src", "behaviorFeatures.noarrowuphistory.ts");

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

// A minimal window.__ccOnChatDoc stand-in matching the real bootstrap's
// contract (behaviorBootstrap.ts): call the registered init(doc, win)
// immediately, synchronously, since the DOM is already built.
function installBootstrapStub(win) {
  win.__ccOnChatDoc = function (fn) {
    fn(win.document, win);
  };
}

function dispatchArrowUp(win, el) {
  const ev = new win.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
}

test("capture-phase listener stops ArrowUp before a native bubble-phase handler sees it", () => {
  const win = buildWindow();
  try {
    const doc = win.document;
    const composer = doc.querySelector('[role="textbox"][aria-label="Message input"]');

    // Stand-in for Claude Code's own native handler — registered on the SAME
    // element, bubble phase (React's own delegation model), exactly like the
    // real bundle's composer keydown handler.
    let nativeHandlerFired = false;
    composer.addEventListener("keydown", function () {
      nativeHandlerFired = true;
    }, false);

    installBootstrapStub(win);
    win.eval(extractInjectedScript(readFileSync(SRC, "utf8")));

    dispatchArrowUp(win, composer);

    assert.equal(
      nativeHandlerFired, false,
      "the native bubble-phase ArrowUp handler must never fire once this feature's capture listener is bound"
    );
  } finally {
    win.close();
  }
});

test("feature toggled OFF (window.__ccFeature returns false) lets ArrowUp reach the native handler", () => {
  const win = buildWindow();
  try {
    const doc = win.document;
    const composer = doc.querySelector('[role="textbox"][aria-label="Message input"]');

    let nativeHandlerFired = false;
    composer.addEventListener("keydown", function () {
      nativeHandlerFired = true;
    }, false);

    win.__ccFeature = function () { return false; }; // simulate the panel checkbox unchecked

    win.eval(extractInjectedScript(readFileSync(SRC, "utf8")));
    installBootstrapStub(win);

    dispatchArrowUp(win, composer);

    assert.equal(
      nativeHandlerFired, true,
      "with the feature OFF, ArrowUp must reach the native handler unmodified"
    );
  } finally {
    win.close();
  }
});

test("a non-ArrowUp key is never intercepted", () => {
  const win = buildWindow();
  try {
    const doc = win.document;
    const composer = doc.querySelector('[role="textbox"][aria-label="Message input"]');

    let nativeHandlerFired = false;
    composer.addEventListener("keydown", function () {
      nativeHandlerFired = true;
    }, false);

    win.eval(extractInjectedScript(readFileSync(SRC, "utf8")));
    installBootstrapStub(win);

    const ev = new win.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    composer.dispatchEvent(ev);

    assert.equal(nativeHandlerFired, true, "ArrowDown must reach the native handler untouched");
  } finally {
    win.close();
  }
});
