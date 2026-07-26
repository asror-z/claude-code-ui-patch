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
// so it is not a TOGGLE_POINTS entry. The panel's Chat Features checkboxes
// (see panel.ts / Patcher.setFeature) are the ONE control surface for it: each
// smartsClaudeManager.feature.<id> setting is written into the localStorage map on
// EVERY webview load, unconditionally, so a checkbox flip takes effect the next
// window reload (the same "reload to apply" contract as every other patch setting) —
// there is no separate live in-chat control to defer to.
//
// Numeric per-feature tunables (AutoContinue's timing/cap values, DraftSave's
// staleness/debounce delays) ride the SAME seed mechanism, under their own
// dedicated localStorage keys — see NUMERIC_KEYS below. This keeps every VS
// Code-settings-sourced runtime value on one seed script rather than inventing a
// second injection path per new tunable; adding a future one is a single entry
// in NUMERIC_KEYS plus the matching field in NumericConfig.
export interface NumericConfig {
  autoContinueQuietMs: number;
  autoContinueCooldownMs: number;
  autoContinueDefaultCap: number;
  draftSaveStaleMs: number;
  draftSaveDebounceMs: number;
}

const NUMERIC_KEYS: { field: keyof NumericConfig; storageKey: string }[] = [
  { field: "autoContinueQuietMs", storageKey: "cc-autocontinue-quietms" },
  { field: "autoContinueCooldownMs", storageKey: "cc-autocontinue-cooldownms" },
  { field: "autoContinueDefaultCap", storageKey: "cc-autocontinue-defaultcap" },
  { field: "draftSaveStaleMs", storageKey: "cc-draftsave-stalems" },
  { field: "draftSaveDebounceMs", storageKey: "cc-draftsave-debouncems" },
];

// Notify feature's own boolean tunables (smartsClaudeManager.notifyFlashOnAsk /
// notifyFlashOnComplete / notifySoundOnComplete) — a separate namespace from the
// per-feature-id toggles above (this isn't a smartsClaudeManager.feature.<id>
// checkbox, it's the "Notifications" panel section), so it rides its own
// localStorage keys via the same seed mechanism rather than overloading
// 'cc-feature-toggles' with unrelated keys.
export interface NotifyConfig {
  notifyFlashOnAsk: boolean;
  notifyFlashOnComplete: boolean;
  notifySoundOnComplete: boolean;
}

const NOTIFY_KEYS: { field: keyof NotifyConfig; storageKey: string }[] = [
  { field: "notifyFlashOnAsk", storageKey: "cc-notify-flash-on-ask" },
  { field: "notifyFlashOnComplete", storageKey: "cc-notify-flash-on-complete" },
  { field: "notifySoundOnComplete", storageKey: "cc-notify-sound-on-complete" },
];

function seedScript(
  defaults: Record<string, boolean>,
  numeric?: NumericConfig,
  notify?: NotifyConfig,
): string {
  const entries = Object.entries(defaults);
  const parts: string[] = [];
  if (entries.length) {
    parts.push(
      `localStorage.setItem('cc-feature-toggles',JSON.stringify(${JSON.stringify(defaults)}));`,
    );
  }
  if (numeric) {
    for (const { field, storageKey } of NUMERIC_KEYS) {
      parts.push(
        `localStorage.setItem('${storageKey}',${JSON.stringify(String(numeric[field]))});`,
      );
    }
  }
  if (notify) {
    for (const { field, storageKey } of NOTIFY_KEYS) {
      parts.push(
        `localStorage.setItem('${storageKey}',${JSON.stringify(String(!!notify[field]))});`,
      );
    }
  }
  if (!parts.length) return "";
  return "(function(){try{" + parts.join("") + "}catch(e){}})();";
}

// The full assembled script: infrastructure (bootstrap, toolbar) first, then the
// one-time feature-default + numeric-tunable + notify-tunable seed (from VS Code
// settings), then every registered feature, in registration order (a dependent,
// e.g. CopyButtons on DateTime, must be registered after its dependency in
// behaviorFeatures.ts imports).
function assembledScript(
  featureDefaults?: Record<string, boolean>,
  numeric?: NumericConfig,
  notify?: NotifyConfig,
): string {
  const parts: string[] = [];
  for (const s of infrastructureSources()) parts.push(s.js);
  if (featureDefaults || numeric || notify)
    parts.push(seedScript(featureDefaults ?? {}, numeric, notify));
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
// (from the smartsClaudeManager.feature.<id> settings) and numeric (from the
// smartsClaudeManager.autoContinueQuietMs-style settings) seed their respective
// runtime values on the webview's first load only — see seedScript() above.
export function applyBehaviorScript(
  extensionJs: string,
  featureDefaults?: Record<string, boolean>,
  numeric?: NumericConfig,
  notify?: NotifyConfig,
): {
  out: string;
  changed: boolean;
} {
  const stripped = removeBehaviorScript(extensionJs);
  const m = stripped.match(BODY_ANCHOR_RE);
  if (!m) return { out: extensionJs, changed: false }; // anchor gone: leave native
  const [full, moduleScriptLine, nonceVar, , existingExtra, bodyClose] = m;
  const script = assembledScript(featureDefaults, numeric, notify);
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

export function wantedBehaviorScript(
  featureDefaults?: Record<string, boolean>,
  numeric?: NumericConfig,
  notify?: NotifyConfig,
): string {
  return assembledScript(featureDefaults, numeric, notify);
}

// The declared feature ids, for building both the settings schema
// (smartsClaudeManager.feature.<id>) and the panel's Chat Features grid —
// sourced from the SAME registry the injected script is built from, so it can
// never drift out of sync with what's actually injected. A feature marked
// noMasterToggle (e.g. "notify", whose own Notifications-section settings
// already gate it) is excluded — its js/css still assemble via allFeatures()
// below, only the redundant Chat Features checkbox is skipped.
export function featureIds(): { id: string; label: string }[] {
  return allFeatures()
    .filter((f) => !f.noMasterToggle)
    .map((f) => ({ id: f.id, label: f.label }));
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
