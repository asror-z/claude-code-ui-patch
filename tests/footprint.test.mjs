// Real-DOM regression test for behaviorBootstrap.ts's FOOTPRINT map: every
// feature that registers a toolbar button (via the shared behaviorToolbar.ts)
// must have its REAL rendered button matched by at least one FOOTPRINT hide
// selector when that feature is toggled OFF.
//
// This class of bug shipped THREE separate times before this test existed:
//   1. forkincopy — no FOOTPRINT entry at all (fixed in 14b5bc6).
//   2. multiselect — FOOTPRINT hid only .cc-multiselect-chk (the per-message
//      checkbox), never the toolbar button ([data-cc-tool='multiselect']),
//      so unchecking the feature left its toolbar chip visible in the chat.
//   3. scroll — only scroll-top ever got its .cc-scroll-top class added;
//      scroll-bottom stayed classless, so FOOTPRINT hid ⤒ but left ⤓ visible.
//
// Runs the REAL BOOTSTRAP_SOURCE and REAL TOOLBAR_SOURCE (extracted straight
// out of their .ts sources, never re-typed) in a real jsdom window, renders
// real toolbar buttons through the real __ccToolbar.add()/renderButton()
// path, toggles each owning feature OFF via the real __ccSetFeature(), runs
// the real __ccApplyToggles(), and asserts the generated hide-CSS selectors
// actually MATCH each real button element (el.matches — the exact check that
// silently failed in bugs 2 and 3, where a selector existed but matched
// nothing the toolbar actually rendered).

import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = (f) => path.join(__dirname, "..", "src", f);

// Extract an `export const X_SOURCE = \`...\`;` template-literal body straight
// out of the real .ts source — the exact string that gets injected into the
// webview — mirroring tests/multiselect.test.mjs's extractInjectedScript().
function extractExportedSource(file, exportName) {
  const source = readFileSync(SRC(file), "utf8");
  const marker = `export const ${exportName} = \``;
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `could not find \`${marker}\` in ${file}`);
  const bodyStart = start + marker.length;
  let end = source.indexOf("`.trim();", bodyStart);
  if (end === -1) end = source.indexOf("\n`;", bodyStart);
  assert.ok(end !== -1, `could not find closing backtick for ${exportName} in ${file}`);
  let body = source.slice(bodyStart, end);
  body = body.replace(/\\\\/g, "\\");
  return body;
}

// Feature id -> the toolbar button ids its own real source registers, plus any
// class its real source adds onto the rendered button after add(). Each entry
// is verified against the REAL owning source below (assertSourceContains), so
// a renamed id/class breaks this test loudly instead of silently drifting.
const TOOLBAR_FEATURES = [
  { feature: "multiselect", file: "behaviorFeatures.multiselect.ts", buttons: [{ id: "multiselect" }] },
  { feature: "toc", file: "behaviorFeatures.toc-export-scroll.ts", buttons: [{ id: "toc", addClass: "cc-toc-toggle" }] },
  { feature: "export", file: "behaviorFeatures.toc-export-scroll.ts", buttons: [{ id: "export", addClass: "cc-export-toggle" }] },
  {
    feature: "scroll",
    file: "behaviorFeatures.toc-export-scroll.ts",
    buttons: [{ id: "scroll-top", addClass: "cc-scroll-top" }, { id: "scroll-bottom", addClass: "cc-scroll-bottom" }],
  },
  {
    feature: "usernav",
    file: "behaviorFeatures.usernav.ts",
    buttons: [{ id: "usernav-up", addClass: "cc-usernav-up" }, { id: "usernav-down", addClass: "cc-usernav-down" }],
  },
];

function assertSourceContains(file, needle, why) {
  const source = readFileSync(SRC(file), "utf8");
  assert.ok(source.includes(needle), `${file} no longer contains ${JSON.stringify(needle)} — ${why}`);
}

function buildWindow() {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div id="root">
        <div class="inputFooter_ab12"><div class="container_cd34"></div></div>
      </div>
    </body></html>`,
    { url: "https://example.test/", pretendToBeVisual: true, runScripts: "dangerously" }
  );
  const win = dom.window;
  win.eval(extractExportedSource("behaviorBootstrap.ts", "BOOTSTRAP_SOURCE"));
  win.eval(extractExportedSource("behaviorToolbar.ts", "TOOLBAR_SOURCE"));
  return win;
}

// Parse the hide-selector list out of the CSS __ccApplyToggles actually wrote:
// "sel1,sel2,...{display:none !important;}" — everything before the first "{".
function hideSelectors(win) {
  const st = win.document.getElementById("cc-toggle-style");
  if (!st || !st.textContent.includes("{")) return [];
  const css = st.textContent;
  const head = css.slice(0, css.indexOf("{"));
  return head.split(",").map((s) => s.trim()).filter(Boolean);
}

test("every toolbar-registering feature's OFF state hides its real toolbar button(s)", () => {
  for (const entry of TOOLBAR_FEATURES) {
    for (const btnSpec of entry.buttons) {
      assertSourceContains(
        entry.file,
        `id: "${btnSpec.id}"`,
        "toolbar button id this test renders must match what the real feature registers"
      );
      if (btnSpec.addClass) {
        assertSourceContains(
          entry.file,
          `"${btnSpec.addClass}"`,
          "the class this test adds must be one the real feature genuinely adds after __ccToolbar.add()"
        );
      }
    }
  }

  for (const entry of TOOLBAR_FEATURES) {
    const win = buildWindow();
    const doc = win.document;
    // The real bootstrap runs setInterval(tick, 400) — ALWAYS close the jsdom
    // window (even when an assertion below throws) so a FAILING run's timers
    // cannot keep the node:test process alive past its timeout (observed live:
    // the pre-fix regression run "hung" instead of reporting its failure).
    try {

    // Render this feature's real toolbar button(s) through the REAL add() path.
    const buttons = entry.buttons.map((btnSpec) => {
      const el = win.__ccToolbar.add({ id: btnSpec.id, icon: "x", label: btnSpec.id, order: 1 });
      assert.ok(el, `real __ccToolbar.add() must render a button for ${btnSpec.id}`);
      // Replicate exactly what the owning feature's own verified source does
      // right after add() (classList.add of its FOOTPRINT class), no more.
      if (btnSpec.addClass) el.classList.add(btnSpec.addClass);
      return el;
    });

    // Feature ON: no hide selector may match the button.
    win.__ccSetFeature(entry.feature, true);
    win.__ccApplyToggles(doc);
    for (const el of buttons) {
      const matchedOn = hideSelectors(win).filter((sel) => {
        try { return el.matches(sel); } catch { return false; }
      });
      assert.deepEqual(
        matchedOn, [],
        `feature "${entry.feature}" ON must not hide its toolbar button ${el.getAttribute("data-cc-tool")}`
      );
    }

    // Feature OFF: at least one generated hide selector must MATCH each real button.
    win.__ccSetFeature(entry.feature, false);
    win.__ccApplyToggles(doc);
    const sels = hideSelectors(win);
    for (const el of buttons) {
      const matched = sels.some((sel) => {
        try { return el.matches(sel); } catch { return false; }
      });
      assert.ok(
        matched,
        `feature "${entry.feature}" OFF: no FOOTPRINT hide selector matches its real toolbar button ` +
        `[data-cc-tool="${el.getAttribute("data-cc-tool")}"] — selectors were: ${sels.join(" , ")}`
      );
    }

    } finally {
      win.close();
    }
  }
});
