import { infrastructureSources, allFeatures } from "./behaviorFeatures";

// Chat-enhancement features (Reply, Search, DateTime, ... — see behaviorFeatures.ts)
// ride as ONE marker-tagged inline <script>/<style> block, distinct from
// PATCH_POINTS/TOGGLE_POINTS/INJECT_POINTS in patcher.ts: those all swap an EXISTING
// hardcoded value already present in the bundle, whereas these add NEW behavior that
// doesn't exist in the stock bundle at all. The chat webview's CSP is
// script-src 'nonce-${u}' only (no unsafe-inline, no external src without that exact
// nonce), so the whole feature set is injected as a single nonce'd inline <script> tag
// (spliced right after the existing index.js <script src> chain, before </body>) rather
// than as separate asset files with their own <script src> tags.
export const BEHAVIOR_MARKER = "/*ccup-behavior*/";
export const BEHAVIOR_CSS_MARKER = "/*ccup-behavior-css*/";

// Anchor: the chat webview's index.js <script type="module"> tag, optionally
// followed by any number of already-injected nonce'd <script> tags (tolerating a
// prior smarts-claude-patch asset-file apply on the same bundle), then </body>. The
// nonce variable name (captured group 2, e.g. "u") is read live so this survives
// re-minification renaming it.
const BODY_ANCHOR_RE =
  /(<script nonce="\$\{(\w+)\}" src="\$\{(\w+)\}" type="module"><\/script>\n)((?:\s*<script nonce="\$\{\2\}"[^>]*><\/script>\n)*)(\s*<\/body>)/;

function escapeForTemplateLiteral(src: string): string {
  return src.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}
function unescapeFromTemplateLiteral(src: string): string {
  return src.replace(/\\\$\{/g, "${").replace(/\\`/g, "`").replace(/\\\\/g, "\\");
}

// Per-feature enable/disable is a RUNTIME toggle (localStorage 'cc-feature-toggles',
// read by window.__ccFeature(id) in the injected bootstrap), not a patch-time value —
// so it is not a TOGGLE_POINTS entry. The panel's Chat Enhancement Features checkboxes
// (see panel.ts / Patcher.setFeature) are the ONE control surface for it: each
// claudeCodeUiPatch.feature.<id> setting is written into the localStorage map on
// EVERY webview load, unconditionally, so a checkbox flip takes effect the next
// window reload (the same "reload to apply" contract as every other patch setting) —
// there is no separate live in-chat control to defer to.
function seedScript(defaults: Record<string, boolean>): string {
  const entries = Object.entries(defaults);
  if (!entries.length) return "";
  return (
    "(function(){try{" +
    `localStorage.setItem('cc-feature-toggles',JSON.stringify(${JSON.stringify(defaults)}));` +
    "}catch(e){}})();"
  );
}

// The full assembled script: infrastructure (bootstrap, toolbar) first, then the
// one-time feature-default seed (from VS Code settings), then every registered
// feature, in registration order (a dependent, e.g. CopyButtons on DateTime, must be
// registered after its dependency in behaviorFeatures.ts imports).
function assembledScript(featureDefaults?: Record<string, boolean>): string {
  const parts: string[] = [];
  for (const s of infrastructureSources()) parts.push(s.js);
  if (featureDefaults) parts.push(seedScript(featureDefaults));
  for (const f of allFeatures()) parts.push(f.js);
  return parts.join("\n");
}

function assembledCss(): string {
  const parts: string[] = [];
  for (const s of infrastructureSources()) parts.push(s.css);
  for (const f of allFeatures()) parts.push(f.css);
  return parts.join("\n");
}

export function behaviorPresent(extensionJs: string): boolean {
  return BODY_ANCHOR_RE.test(extensionJs) || extensionJs.includes(BEHAVIOR_MARKER);
}

// Apply (or refresh) the behavior script block. Idempotent: an existing block is
// removed first, so re-applying (e.g. after a feature is added/changed) never
// double-injects and always reflects the CURRENT assembled source. featureDefaults
// (from the claudeCodeUiPatch.feature.<id> settings) seeds the runtime toggle map on
// the webview's first load only — see seedScript() above.
export function applyBehaviorScript(
  extensionJs: string,
  featureDefaults?: Record<string, boolean>,
): {
  out: string;
  changed: boolean;
} {
  const stripped = removeBehaviorScript(extensionJs);
  const m = stripped.match(BODY_ANCHOR_RE);
  if (!m) return { out: extensionJs, changed: false }; // anchor gone: leave native
  const [full, moduleScriptLine, nonceVar, , existingExtra, bodyClose] = m;
  const script = assembledScript(featureDefaults);
  const block =
    `        <script nonce="\${${nonceVar}}">${BEHAVIOR_MARKER}\n` +
    escapeForTemplateLiteral(script) +
    `\n</script>\n`;
  const replacement = moduleScriptLine + existingExtra + block + bodyClose;
  const out =
    stripped.slice(0, m.index) + replacement + stripped.slice((m.index ?? 0) + full.length);
  return { out, changed: out !== extensionJs };
}

export function removeBehaviorScript(extensionJs: string): string {
  const re = /\s*<script nonce="\$\{\w+\}">\/\*ccup-behavior\*\/\n[\s\S]*?\n<\/script>\n/;
  return extensionJs.replace(re, "\n");
}

// Extract the currently-injected script body (unescaped), or undefined if absent —
// used by analyze() to detect drift (bundle content differs from what the CURRENT
// feature registry would assemble, e.g. after this extension is updated with new/
// changed features).
export function currentBehaviorScript(extensionJs: string): string | undefined {
  const m = extensionJs.match(
    /<script nonce="\$\{\w+\}">\/\*ccup-behavior\*\/\n([\s\S]*?)\n<\/script>/,
  );
  return m ? unescapeFromTemplateLiteral(m[1]) : undefined;
}

export function wantedBehaviorScript(featureDefaults?: Record<string, boolean>): string {
  return assembledScript(featureDefaults);
}

// The declared feature ids, for building both the settings schema
// (claudeCodeUiPatch.feature.<id>) and the panel — sourced from the SAME registry the
// injected script is built from, so it can never drift out of sync with what's
// actually injected.
export function featureIds(): { id: string; label: string }[] {
  return allFeatures().map((f) => ({ id: f.id, label: f.label }));
}

// --- CSS side: appended to webview/index.css as ONE marker-tagged LINE, matching
// patcher.ts's cssApplyLine/cssRemoveLine/cssMarkedLine convention (marker-through-
// next-newline). CSS is whitespace-insensitive, so the whole assembled stylesheet is
// flattened to a single line (newlines stripped) rather than introducing a second,
// multi-line marker convention alongside the existing single-line one. ---

function flattenCss(css: string): string {
  return css.replace(/\s*\n\s*/g, "").trim();
}

// The full marked line patcher.ts's cssBuild contract expects: the marker followed
// by the (flattened) assembled CSS, or undefined if there is nothing to inject
// (kept as a function, not a constant, so it always reflects the CURRENT feature
// registry — mirrors diffLinesCssBuild's shape).
export function behaviorCssMarkedLine(): string {
  return `${BEHAVIOR_CSS_MARKER}${flattenCss(assembledCss())}`;
}

export function behaviorCssPresent(css: string): boolean {
  return css.includes(BEHAVIOR_CSS_MARKER);
}
