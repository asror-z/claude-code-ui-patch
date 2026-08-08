// Regression/behavior test for modelInfoBridge.ts. Verifies applyModelInfoBridge()
// anchors on the SAME effortSync Wn(...) call patcher.ts's EFFORT_SYNC_*_RE already
// recognizes (both the native OFF form and the already-patched ON form), that the
// injected output stays syntactically valid JavaScript, and that a second apply is
// idempotent. Also runs end-to-end against the REAL installed extension's scratch
// copy (never the user's live install) to prove the anchor still matches the real
// bundle, not just a hand-built fixture.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_JS = path.join(ROOT, "out", "modelInfoBridge.js");

async function run() {
  execFileSync("npx", ["tsc", "-p", "./"], { cwd: ROOT, stdio: "inherit", shell: true });

  const {
    applyModelInfoBridge,
    removeModelInfoBridge,
    modelInfoBridgePresent,
    modelInfoBridgeCurrentOn,
  } = await import(pathToFileURL(OUT_JS).href);

  // The exact literal shape effortSync's OWN native (OFF) anchor matches,
  // embedded in a plausible surrounding Wn(...) comma chain -- mirrors the
  // real bundle shape captured live (see patcher.ts's EFFORT_SYNC_OFF_RE).
  const fakeWebviewJsOff =
    "class Session{constructor(){Wn(()=>{let n=this.connection.value?.config.value?.thinkingLevel;" +
    "if(n&&!this.thinkingLevelOverride.value)this.thinkingLevelOverride.value=n}),Wn(()=>{" +
    "let n=this.connection.value?.config.value,o=n?.claudeSettings?.applied,r=o!==void 0?o.effort??void 0:n?.settings?.effortLevel;" +
    "if(r&&!this.effortLevel.value)this.effortLevel.value=r;" +
    "}),Wn(()=>{let n=this.connection.value?.config.value;});}}";

  assert.ok(
    modelInfoBridgePresent(fakeWebviewJsOff),
    "sanity: the OFF-form fixture must be recognized as patchable (anchor present)",
  );
  assert.strictEqual(
    modelInfoBridgeCurrentOn(fakeWebviewJsOff),
    false,
    "OFF-form fixture reports currentOn=false (native, not yet patched)",
  );

  const { out, changed } = applyModelInfoBridge(fakeWebviewJsOff);
  assert.ok(changed, "applyModelInfoBridge reports a real change against the OFF fixture");
  assert.ok(out.includes("/*ccup-modelinfo*/"), "marker is present after apply");
  assert.ok(out.includes("window.__ccModelInfo"), "window.__ccModelInfo write is present");
  assert.ok(out.includes("cc-modelinfo-changed"), "the change event dispatch is present");
  console.log("PASS: applyModelInfoBridge() injects the mirror effect after the OFF-form anchor.");

  // THE ACTUAL REGRESSION CHECK: syntactic validity of the injected output on
  // its own (wrapped in a class body the same shape as the fixture).
  try {
    new Function(out);
  } catch (e) {
    assert.fail(`applyModelInfoBridge() produced a SYNTAX ERROR in its own output: ${e.message}\n\nOutput:\n${out}`);
  }
  console.log("PASS: applyModelInfoBridge()'s injected output is syntactically valid JavaScript.");

  assert.ok(
    modelInfoBridgeCurrentOn(out) === true,
    "after apply, modelInfoBridgeCurrentOn reports true",
  );

  // Idempotent re-apply must stay syntactically valid and report no further change.
  const second = applyModelInfoBridge(out);
  assert.strictEqual(second.changed, false, "a second apply with nothing new to add is a no-op");
  try {
    new Function(second.out);
  } catch (e) {
    assert.fail(`A second (idempotent) applyModelInfoBridge() call produced a SYNTAX ERROR: ${e.message}`);
  }
  console.log("PASS: re-applying is idempotent and stays syntactically valid.");

  // Restore must strip the marker and the injected effect cleanly.
  const restored = removeModelInfoBridge(out);
  assert.ok(!restored.includes("/*ccup-modelinfo*/"), "restore removes the marker");
  assert.ok(!restored.includes("window.__ccModelInfo"), "restore removes the injected mirror effect");
  assert.strictEqual(
    restored,
    fakeWebviewJsOff,
    "restore round-trips byte-for-byte back to the original OFF-form fixture",
  );
  console.log("PASS: removeModelInfoBridge() round-trips byte-for-byte back to native.");

  // Also anchor against the ALREADY-effortSync-PATCHED (ON) form, so this
  // bridge composes correctly whether effortSyncFix is itself on or off.
  const fakeWebviewJsEffortSyncOn =
    "class Session{constructor(){Wn(()=>{" +
    "let n=this.connection.value?.config.value,o=n?.claudeSettings?.applied,r=o!==void 0?o.effort??void 0:n?.settings?.effortLevel;" +
    "if(r&&!this.effortLevel.value){this.effortLevel.value=r;/*ccup-effortSync*/this.queueSettingsApply(()=>this.applySettings({effortLevel:r},{flagsOnly:!0}).catch(()=>{}));}" +
    "}),Wn(()=>{let n=this.connection.value?.config.value;});}}";

  assert.ok(
    modelInfoBridgePresent(fakeWebviewJsEffortSyncOn),
    "the effortSync-ON-form fixture is also recognized as patchable",
  );
  const onResult = applyModelInfoBridge(fakeWebviewJsEffortSyncOn);
  assert.ok(onResult.changed, "applies cleanly against the effortSync-ON-form fixture too");
  try {
    new Function(onResult.out);
  } catch (e) {
    assert.fail(`Patching the effortSync-ON fixture produced a SYNTAX ERROR: ${e.message}`);
  }
  console.log("PASS: composes correctly with an already-ON effortSyncFix toggle.");

  // --- End-to-end against the REAL installed extension's scratch copy -------
  const scratchWebviewJs = path.join(
    ROOT,
    ".claude",
    "Model Effort Info Composer",
    "Tests",
    "scratch-ext",
    "anthropic.claude-code-2.1.226-win32-x64",
    "webview",
    "index.js",
  );
  if (existsSync(scratchWebviewJs)) {
    const real = readFileSync(scratchWebviewJs, "utf8");
    assert.ok(
      modelInfoBridgePresent(real),
      "the REAL installed bundle's webview/index.js is recognized as patchable (anchor matches real code, not just the hand-built fixture)",
    );
    const realResult = applyModelInfoBridge(real);
    assert.ok(realResult.changed, "applies cleanly against the REAL bundle");
    try {
      // The real file is enormous (minified React app) -- new Function() on
      // the WHOLE file (not just our slice) is the strongest possible
      // syntax-validity proof, since it exercises our insertion point in situ
      // among everything else in the bundle.
      new Function(realResult.out);
    } catch (e) {
      assert.fail(`Patching the REAL scratch bundle produced a SYNTAX ERROR: ${e.message}`);
    }
    assert.ok(realResult.out.includes("window.__ccModelInfo"), "real-bundle patch includes the mirror write");
    console.log("PASS: applies cleanly and stays syntactically valid against the REAL installed extension's scratch copy.");

    const realRestored = removeModelInfoBridge(realResult.out);
    assert.strictEqual(
      realRestored,
      real,
      "restore round-trips the REAL bundle byte-for-byte back to native",
    );
    console.log("PASS: restore round-trips the REAL bundle byte-for-byte.");
  } else {
    console.log("SKIP: no scratch-ext copy found at " + scratchWebviewJs + " -- real-bundle checks skipped.");
  }
}

run()
  .then(() => {
    console.log("\nALL CHECKS PASSED");
  })
  .catch((err) => {
    console.error("FAILED:", err.message);
    process.exitCode = 1;
  });
