// Regression test for a REAL bug that shipped: applyHostBridge()'s injected
// if/else-if chain (ccOpenExternal / ccOpenFile) had a missing
// semicolon between the ccOpenFile branch's IIFE call and the following
// "else if" -- `})(u.path)else if(...)` is a syntax error
// ("Unexpected token 'else'"), which broke Claude Code's OWN extension
// activation entirely the moment this patch was applied to a real install
// (confirmed live via the VS Code error toast "Activating extension
// 'Anthropic.claude-code' failed: Unexpected token 'else'.").
//
// This test compiles src/openExternalBridge.ts, calls the REAL
// applyHostBridge() against a synthetic-but-structurally-real anchor (the
// exact literal shape HOST_ANCHOR_RE matches), and asserts the injected
// output is syntactically valid JavaScript on its own -- not just that
// certain substrings are present, which is what let this bug ship
// undetected before.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_JS = path.join(ROOT, "out", "openExternalBridge.js");

async function run() {
  // Make sure `out/` reflects the CURRENT source before testing it (a stale
  // out/ would silently hide a real regression in src/).
  execFileSync("npx", ["tsc", "-p", "./"], { cwd: ROOT, stdio: "inherit", shell: true });

  const { applyHostBridge, hostBridgePresent } = await import(pathToFileURL(OUT_JS).href);

  // The exact literal shape applyHostBridge()'s own internal anchor regex
  // matches (mirrored from its definition in openExternalBridge.ts) plus the
  // createWebviewPanel alias capture it also needs, embedded in a plausible
  // surrounding function -- structurally real, not a hand-wavy stand-in.
  const fakeExtensionJs =
    'function setupPanel(){var e=Tt.window.createWebviewPanel("claudeVSCodePanel",title,col,opts);' +
    "e.webview.onDidReceiveMessage((u)=>{this.output.info(`Received message from webview: ${JSON.stringify(u)}`),c?.fromClient(u)},null,this.disposables);" +
    "}";

  assert.ok(hostBridgePresent(fakeExtensionJs), "sanity: the fake fixture must be recognized as patchable (anchor present)");

  const { out, changed } = applyHostBridge(fakeExtensionJs);
  assert.ok(changed, "applyHostBridge reports a real change against the fixture");
  assert.ok(out.includes('"ccOpenExternal"'), "ccOpenExternal handling is present");
  assert.ok(out.includes('"ccOpenFile"'), "ccOpenFile handling is present");

  console.log("PASS: applyHostBridge() injects both message-type branches.");

  // THE ACTUAL REGRESSION CHECK: the injected output, on its own, must be
  // syntactically valid JavaScript. This is what the missing-semicolon bug
  // violated -- new Function() throws "Unexpected token 'else'" on the
  // broken shape, and would have caught this before it ever reached a real
  // install.
  try {
    new Function(out);
  } catch (e) {
    assert.fail(`applyHostBridge() produced a SYNTAX ERROR in its own output: ${e.message}\n\nOutput:\n${out}`);
  }

  console.log("PASS: applyHostBridge()'s injected output is syntactically valid JavaScript (no missing semicolons in the if/else-if chain).");

  // Idempotent re-apply must ALSO stay syntactically valid.
  const second = applyHostBridge(out);
  try {
    new Function(second.out);
  } catch (e) {
    assert.fail(`A second (idempotent) applyHostBridge() call produced a SYNTAX ERROR: ${e.message}`);
  }
  assert.strictEqual(second.changed, false, "a second apply with nothing new to add is a no-op");

  console.log("PASS: re-applying is idempotent and stays syntactically valid.");
}

run()
  .then(() => {
    console.log("\nALL CHECKS PASSED");
  })
  .catch((err) => {
    console.error("FAILED:", err.message);
    process.exitCode = 1;
  });
