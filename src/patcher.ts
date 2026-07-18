import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  applyBehaviorScript,
  removeBehaviorScript,
  behaviorPresent,
  currentBehaviorScript,
  wantedBehaviorScript,
  behaviorCssMarkedLine,
  featureIds,
  BEHAVIOR_CSS_MARKER,
} from "./behaviorInject";
import {
  hostBridgePresent,
  applyHostBridge,
  removeHostBridge,
  webviewBridgePresent,
  applyWebviewBridge,
  removeWebviewBridge,
} from "./openExternalBridge";
// faro is FIRST: it exposes window.__ccFaroLog, which every other feature below
// may call from its own init() — later features assume the sink already exists.
import "./behaviorFeatures.faro";
import "./behaviorFeatures.reply";
import "./behaviorFeatures.googlesearch";
import "./behaviorFeatures.search";
import "./behaviorFeatures.datetime";
import "./behaviorFeatures.askquestion";
import "./behaviorFeatures.userstyle";
import "./behaviorFeatures.blockquote";
import "./behaviorFeatures.copybuttons";
import "./behaviorFeatures.codeblock";
import "./behaviorFeatures.askcollapse";
import "./behaviorFeatures.usercollapse";
import "./behaviorFeatures.autocontinue";
import "./behaviorFeatures.draftsave";
import "./behaviorFeatures.usernav";
import "./behaviorFeatures.toc-export-scroll";
import "./behaviorFeatures.filelinks";

// The installed Claude Code extension is laid down as one directory per
// version/platform, e.g. anthropic.claude-code-2.1.200-darwin-arm64. We patch
// three bundled files inside it: extension.js (the plan-mode preview webview
// template), webview/index.css (the chat code-block font, which no setting
// reaches), and webview/index.js (the chat Edit-diff card: a Monaco diff editor
// with a hardcoded font size, line-numbers off, and a forced dark theme).
const EXT_PREFIX = "anthropic.claude-code-";
const MARKER_FILE = "extension.js"; // must exist for a dir to count as an install

const CONFIG_NS = "smartsClaudeManager";

// Stock-value capture: the real native font-size values are read from the
// fresh (unpatched) bundle and persisted in globalState, keyed by Claude Code
// version. Restore uses these captured values instead of the hardcoded
// originalPx/originalValue constants, so it always matches the actual native
// behavior even if a future bundle changes its stock sizes.
const STOCK_VERSION_KEY = "smartsClaudeManager.stockVersion";
const STOCK_VALUES_KEY = "smartsClaudeManager.stockValues";
export type StockCapture = Record<string, string>;

// The settings values in effect right before "Fully Disable Patch" ran, so
// "Enable Patch" can restore them instead of leaving every knob at its stock
// default (restore() itself resets all settings to stock as part of reverting
// the bundle — this snapshot is taken BEFORE that reset).
const PRE_DISABLE_SETTINGS_KEY = "smartsClaudeManager.preDisableSettings";
type PreDisableSettings = Record<string, number | boolean | string>;

export const MIN_PX = 6;
export const MAX_PX = 48;
export const STEP = 0.25;

export type Section = "Chat Panel" | "Plan Preview";
export const SECTION_ORDER: Section[] = [
  "Chat Panel",
  "Plan Preview",
];

// Display order of knobs within a section (panel and popup), by point id. Ids
// not listed keep their natural order after the listed ones.
const KNOB_ORDER: string[] = [
  "chatEnhancements", // master switch for Reply/Search/DateTime/... (see behaviorFeatures.ts)
  "hideUsageWarning", // the "You've used X% of your weekly limit" banner
  "chatHistorySize", // agent response
  "chatCodeInline", // inline code
  "chatCode", // code block
  "chatComposer", // message input box
  "diffCard",
  "diffLineNumbers",
  "diffThemeSync",
  "permCode",
  "effortSyncFix",
  "text", // plan agent response
  "planCodeInline", // plan inline code
  "code", // plan code block
  "preview", // plan comment quote
  "input", // plan comment composer
  "badge", // plan comment badge
];
function knobOrder(id: string): number {
  const i = KNOB_ORDER.indexOf(id);
  return i < 0 ? KNOB_ORDER.length : i;
}

// ---------------------------------------------------------------------------
// Native chat text size. NOT patched: Claude Code reads chat.fontSize and
// injects it live (it sizes the chat message text, the input box, and the token
// IN/OUT box). The panel exposes it with the same ▼/▲ controls as patch knobs;
// adjusting writes the native setting directly (applied live, no reload needed).
// External changes to chat.fontSize are reflected via onDidChangeConfiguration.
// (chat.editor.fontSize sizes only the chat input editor; the chat's rendered
// code block has no such lever, so it is a patch point below.)
// ---------------------------------------------------------------------------
interface NativeKnob {
  id: "chatText";
  label: string;
  vscodeKey: string;
  fallback: number;
}

const NATIVE_KNOBS: NativeKnob[] = [
  { id: "chatText", label: "Text", vscodeKey: "chat.fontSize", fallback: 13 },
];

function nativePx(k: NativeKnob): number {
  const raw = vscode.workspace.getConfiguration().get<number>(k.vscodeKey);
  return typeof raw === "number" && raw > 0 ? raw : k.fallback;
}

// The native chat.fontSize, shown by the chatHistoryFontSize knob while it is
// inheriting (setting at 0), so the knob still reflects the effective size and a
// first ▲/▼ takes control from that value.
function nativeChatFontSizePx(): number {
  const raw = vscode.workspace.getConfiguration().get<number>("chat.fontSize");
  return typeof raw === "number" && raw > 0 ? raw : 13;
}

// ---------------------------------------------------------------------------
// Patch points (edits inside bundled files).
//   style "number": swap a bare px number in place (pinned value / hardcoded).
//   style "value":  swap a whole value that is either a stock var(...) or an
//     absolute Npx we substituted (decouples from a live var).
//   custom (fn*):   a self-contained transform for a spot the value-slot model
//     can't express (the chat code block, scoped via appended CSS).
// ---------------------------------------------------------------------------
interface PatchPoint {
  id: string;
  section: Section;
  label: string;
  key: string; // settings sub-key under the smartsClaudeManager namespace
  defaultPx: number;
  maxPx: number; // clamp for ▲/▼ adjust
  file: string; // path relative to the install dir
  originalPx: number; // stock px (for messaging / number-style restore)
  style?: "number" | "value";
  originalValue?: string; // value-style restore target
  res?: RegExp[]; // value-slot regexes, each capturing (prefix)(value)(suffix)
  // Custom transform (used when fnApply is present):
  fnPresent?: (c: string) => boolean;
  fnCurrentPx?: (c: string) => string | undefined; // undefined => stock/native
  fnApply?: (c: string, px: string) => string;
  fnRestore?: (c: string) => string;
}

// Chat code block. Scoped to the chat message DOM (hovers/tooltips untouched)
// by appending a CSS rule to webview/index.css that overrides the font ONLY
// inside chat code-block wrappers (.codeBlockWrapper_<hash>) AND inline code
// (.root_<hash> code, the markdown renderer's code spans). The stock wrapper
// rule sets no font-size and inline code is 0.9em of chat.fontSize, so pinning
// both to the same px keeps inline and fenced code matched. The markdown module
// exposes both classes under one CSS-module hash, so `.root_<hash>` reuses the
// hash read from the wrapper rule. A scoped !important rule wins by specificity.
// The hash changes per build, so we read it at patch time; originalPx is
// approximate (em-relative; ~11px at the default chat.fontSize of 13) and unused
// by the css-style logic.
const CHAT_CODE_MARKER = "/*cc-ui-patch:chatCode*/";
const CHAT_CODE_WRAP_RE = /\.codeBlockWrapper_[-\w]+ pre\s*\{/;
const CHAT_CODE_HASH_RE = /\.codeBlockWrapper_([-\w]+) pre\s*\{/;
const CHAT_CODE_LINE_RE = /\n?\/\*cc-ui-patch:chatCode\*\/[^\n]*/;

function applyChatCodeCss(css: string, px: string): string {
  const hash = css.match(CHAT_CODE_HASH_RE)?.[1];
  if (!hash) return css; // wrapper rule gone (version changed): nothing to anchor
  const line = `\n${CHAT_CODE_MARKER}.codeBlockWrapper_${hash} pre,.codeBlockWrapper_${hash} pre code,.root_${hash} code{font-size:${px}px !important}`;
  return css.includes(CHAT_CODE_MARKER)
    ? css.replace(CHAT_CODE_LINE_RE, line)
    : css + line;
}

// Chat message-input box (composer). The composer is actually TWO stacked
// elements sharing one CSS-module hash: the real contenteditable div (role=
// "textbox", aria-label="Message input", className messageInput_<hash>) is
// painted INVISIBLE (color:#0000 — it exists only to hold the caret/selection),
// while className mentionMirror_<hash> (aria-hidden, positioned absolutely on
// top) is what actually renders the visible text, incl. @-mention highlighting.
// Patching messageInput_<hash> alone changes the invisible layer's metrics but
// not what the user sees — both classes must be sized together. Claude Code's
// own CSS sets no font-size on either, so it inherits the webview's base
// font-size (~13px, VS Code's own editor font). There is no existing value to
// swap, so — same approach as chatCode above — we append a marker-tagged
// !important rule targeting both hashed classes, re-reading the hash from the
// stock messageInputContainer_<hash> rule at patch time so this survives a
// re-minify that changes the hash.
const CHAT_COMPOSER_MARKER = "/*cc-ui-patch:chatComposer*/";
const CHAT_COMPOSER_HASH_RE = /\.messageInputContainer_([-\w]+)\{/;
const CHAT_COMPOSER_LINE_RE = /\n?\/\*cc-ui-patch:chatComposer\*\/[^\n]*/;

function applyChatComposerCss(css: string, px: string): string {
  const hash = css.match(CHAT_COMPOSER_HASH_RE)?.[1];
  if (!hash) return css; // container rule gone (version changed): nothing to anchor
  const line = `\n${CHAT_COMPOSER_MARKER}.messageInput_${hash},.mentionMirror_${hash}{font-size:${px}px !important}`;
  return css.includes(CHAT_COMPOSER_MARKER)
    ? css.replace(CHAT_COMPOSER_LINE_RE, line)
    : css + line;
}

// Chat Edit-diff card font. The Edit/MultiEdit tool body renders a read-only
// Monaco diff editor whose options hardcode fontSize:12 (no setting reaches it).
// We rewrite the number in both createDiffEditor option blocks (the inline card
// and the expand modal) in webview/index.js. The anchor keys off the stable
// `,lineNumbers:"` that follows the size, so it composes with the line-number
// and theme toggles below (whichever of them is on, this still matches). The /g
// flag patches both sites in one pass; the size is a bare JS number, not px.
const DIFF_FONT_STOCK = 12;
const DIFF_FONT_RE = /(fontSize:)(\d+(?:\.\d+)?)(,lineNumbers:")/g;

function diffFontPresent(c: string): boolean {
  DIFF_FONT_RE.lastIndex = 0;
  return DIFF_FONT_RE.test(c);
}
// The fixed size in the bundle, or undefined when at the native stock (12).
function diffFontCurrent(c: string): string | undefined {
  DIFF_FONT_RE.lastIndex = 0;
  const v = DIFF_FONT_RE.exec(c)?.[2];
  return v === undefined || Number(v) === DIFF_FONT_STOCK ? undefined : v;
}
function diffFontSet(c: string, px: string): string {
  return c.replace(DIFF_FONT_RE, (_w, p, _v, s) => `${p}${px}${s}`);
}
function diffFontRestore(c: string): string {
  return c.replace(
    DIFF_FONT_RE,
    (_w, p, _v, s) => `${p}${DIFF_FONT_STOCK}${s}`,
  );
}

const PATCH_POINTS: PatchPoint[] = [
  {
    id: "chatCode",
    section: "Chat Panel",
    label: "Code block",
    key: "chatCodeblockFontSize",
    defaultPx: 14,
    maxPx: 24,
    file: "webview/index.css",
    originalPx: 11,
    fnPresent: (c) => c.includes(CHAT_CODE_MARKER) || CHAT_CODE_WRAP_RE.test(c),
    // A pre-inline-code patch line lacks `.root_`; report it as not-current so the
    // reconcile upgrades it in place to the selector list that also covers inline
    // code (rather than leaving inline code at the stock 0.9em).
    fnCurrentPx: (c) => {
      const line = c.match(CHAT_CODE_LINE_RE)?.[0];
      if (!line || !line.includes(".root_")) return undefined;
      return line.match(/font-size:(\d+(?:\.\d+)?)px/)?.[1];
    },
    fnApply: (c, px) => applyChatCodeCss(c, px),
    fnRestore: (c) => c.replace(CHAT_CODE_LINE_RE, ""),
  },
  {
    id: "chatComposer",
    section: "Chat Panel",
    label: "Message input box",
    key: "chatComposerFontSize",
    defaultPx: 14,
    maxPx: 24,
    file: "webview/index.css",
    originalPx: 13,
    fnPresent: (c) =>
      c.includes(CHAT_COMPOSER_MARKER) || CHAT_COMPOSER_HASH_RE.test(c),
    fnCurrentPx: (c) => {
      const line = c.match(CHAT_COMPOSER_LINE_RE)?.[0];
      return line?.match(/font-size:(\d+(?:\.\d+)?)px/)?.[1];
    },
    fnApply: (c, px) => applyChatComposerCss(c, px),
    fnRestore: (c) => c.replace(CHAT_COMPOSER_LINE_RE, ""),
  },
  {
    id: "diffCard",
    section: "Chat Panel",
    label: "Diff card",
    key: "chatDiffCardFontSize",
    defaultPx: 14,
    maxPx: 24,
    file: "webview/index.js",
    originalPx: 12,
    fnPresent: diffFontPresent,
    fnCurrentPx: diffFontCurrent,
    fnApply: diffFontSet,
    fnRestore: diffFontRestore,
  },
  {
    id: "text",
    section: "Plan Preview",
    label: "Agent response",
    key: "planPreviewFontSize",
    defaultPx: 14,
    maxPx: 24,
    file: "extension.js",
    originalPx: 14,
    style: "value",
    originalValue: "var(--vscode-markdown-font-size, 14px)",
    // Anchor on the plan-preview `body` rule's font-size, tolerating any
    // font-family value before it, so this composes with the planPreviewFontFamily
    // injection (which rewrites that same rule's font-family). extension.js has a
    // single `body {` rule, so this stays unambiguous.
    res: [
      /(body \{\s*font-family:[^;]+;\s*font-size:\s*)(var\(--vscode-markdown-font-size, \d+(?:\.\d+)?px\)|\d+(?:\.\d+)?px)(;)/,
    ],
  },
  {
    id: "code",
    section: "Plan Preview",
    label: "Code block",
    key: "planPreviewCodeblockFontSize",
    defaultPx: 13,
    maxPx: 24,
    file: "extension.js",
    originalPx: 13,
    style: "value",
    originalValue: "var(--vscode-editor-font-size, 13px)",
    res: [
      /(font-family: var\(--vscode-editor-font-family\);\s*font-size:\s*)(var\(--vscode-editor-font-size, \d+(?:\.\d+)?px\)|\d+(?:\.\d+)?px)(;)/,
    ],
  },
  {
    id: "preview",
    section: "Plan Preview",
    label: "Comment quote",
    key: "planPreviewCommentQuoteFontSize",
    defaultPx: 12,
    maxPx: 24,
    file: "extension.js",
    originalPx: 12,
    style: "number",
    res: [
      /(\.selected-text-preview\s*\{[^}]*?font-size:\s*)(\d+(?:\.\d+)?)(px)/,
    ],
  },
  {
    id: "input",
    section: "Plan Preview",
    label: "Comment input box",
    key: "planPreviewCommentInputFontSize",
    defaultPx: 13,
    maxPx: 24,
    file: "extension.js",
    originalPx: 13,
    style: "number",
    res: [
      /(#comment-input textarea\s*\{[^}]*?font-size:\s*)(\d+(?:\.\d+)?)(px)/,
    ],
  },
  {
    id: "badge",
    section: "Plan Preview",
    label: "Comment badge",
    key: "planPreviewCommentBadgeFontSize",
    defaultPx: 10,
    maxPx: 12,
    file: "extension.js",
    originalPx: 10,
    style: "number",
    res: [/(\.comment-indicator\s*\{[^}]*?font-size:\s*)(\d+(?:\.\d+)?)(px)/],
  },
];

// ---------------------------------------------------------------------------
// Toggle points: boolean on/off patches (as opposed to px sizes). They ride the
// same atomic-write / stock-drift / pending-reload machinery, but the value is
// a switch, so they get a small model of their own and a switch control in the
// panel. Both live in the Edit-diff card's createDiffEditor options; each anchor
// is global (patches the inline card and the expand modal) and keys off a stable
// neighbor so it composes with the font knob and the other toggle.
// ---------------------------------------------------------------------------

// Theme sync (ON): replace the hardcoded theme:"vs-dark" with an IIFE that (1)
// returns the Monaco theme matching the webview's current VS Code theme kind, and
// (2) once per window installs a MutationObserver on <body>'s class so a later
// light/dark switch live-updates every diff editor via monaco's global setTheme
// (Cd is monaco.editor at the injection site). Everything is wrapped in try/catch
// so a failure can never break card creation; the /*ccup-theme*/ marker makes the
// ON state detectable and survives minification.
const THEME_SYNC_ON =
  '/*ccup-theme*/(function(){function p(){var l=document.body.classList;return l.contains("vscode-high-contrast")?(l.contains("vscode-high-contrast-light")?"hc-light":"hc-black"):(l.contains("vscode-light")?"vs":"vs-dark")}try{if(!window.__ccupThemeObs){window.__ccupThemeObs=1;new MutationObserver(function(){try{Cd.setTheme(p())}catch(e){}}).observe(document.body,{attributes:true,attributeFilter:["class"]})}}catch(e){}return p()}())';

// Gutter cleanup appended to webview/index.css when line numbers are ON. The diff
// card marks changed lines with codicon glyphs (codicon-diff-insert = the "+"
// icon, codicon-diff-remove = the "-" icon), but this bundle's codicon subset
// can't draw them, so they fall back to empty notdef boxes next to each line. We
// re-point those glyphs at a text font and render literal "+"/"-", turning the
// boxes into the real diff signs; and we flatten line 1's always-bright active
// line number to the normal color. Scoped to every diff container found in the
// stylesheet (the inline card and the expand modal use different CSS-module
// hashes, e.g. _s6OFow and _oXZawA), so both render the signs.
const DIFF_LINES_CSS_MARKER = "/*ccup:diffLines*/";
const DIFF_CONTAINER_HASH_RE = /\.diffEditorContainer_([-\w]+)\{/g;

// Effort reload-sync (ON): close the settings.json -> actual-call gap. Claude
// Code persists `effortLevel` to ~/.claude/settings.json and the chat UI seeds
// its effort button from that raw value, but a freshly spawned CLI session does
// NOT re-read `effortLevel` from settings — effort is driven live only via the
// apply_settings / applyFlagSettings RPC, which fires when the button is
// toggled. So after a window reload the button shows "max" while the next
// message silently runs at the CLI default ("high") until you flip the button.
// The patch mirrors the toggle's proven path: in the webview init effect that
// seeds `effortLevel` from settings, also push that value to the running CLI
// via applySettings({effortLevel:r},{flagsOnly:!0}) (flagsOnly = push only, no
// settings.json rewrite, since the value already came from there). The
// /*ccup-effortSync*/ marker makes the ON state detectable; the local seed
// variable is captured so the patch survives re-minification across versions.
// The seed branch's own `!this.effortLevel.value` guard makes the push fire
// once per webview load, and .catch swallows any rejection (e.g. an effort
// level the current model doesn't support) so it can never break the effect.
const EFFORT_SYNC_MARKER = "/*ccup-effortSync*/";
// Native (OFF) form: if(VAR&&!this.effortLevel.value)this.effortLevel.value=VAR;
const EFFORT_SYNC_OFF_RE =
  /if\(([a-zA-Z_$][\w$]*)&&!this\.effortLevel\.value\)this\.effortLevel\.value=\1;/;
// Patched (ON) form: the marker plus the live push to the running CLI session.
const EFFORT_SYNC_ON_RE =
  /if\(([a-zA-Z_$][\w$]*)&&!this\.effortLevel\.value\)\{this\.effortLevel\.value=\1;\/\*ccup-effortSync\*\/this\.queueSettingsApply\(\(\)=>this\.applySettings\(\{effortLevel:\1\},\{flagsOnly:!0\}\)\.catch\(\(\)=>\{\}\)\);\}/;

function effortSyncPresent(c: string): boolean {
  return EFFORT_SYNC_OFF_RE.test(c) || EFFORT_SYNC_ON_RE.test(c);
}
// true = ON (patched), false = OFF (native), undefined = anchor gone.
function effortSyncCurrentOn(c: string): boolean | undefined {
  if (EFFORT_SYNC_ON_RE.test(c)) return true;
  if (EFFORT_SYNC_OFF_RE.test(c)) return false;
  return undefined;
}
function effortSyncSet(c: string, on: boolean): string {
  if (on) {
    return c.replace(
      EFFORT_SYNC_OFF_RE,
      (_w, v: string) =>
        `if(${v}&&!this.effortLevel.value){this.effortLevel.value=${v};${EFFORT_SYNC_MARKER}this.queueSettingsApply(()=>this.applySettings({effortLevel:${v}},{flagsOnly:!0}).catch(()=>{}));}`,
    );
  }
  return c.replace(
    EFFORT_SYNC_ON_RE,
    (_w, v: string) =>
      `if(${v}&&!this.effortLevel.value)this.effortLevel.value=${v};`,
  );
}

// Hide usage-limit warning (ON): the composer footer shows a dismissable "You've
// used X% of your weekly limit" banner (color:"warning", the same RC notice
// component used for the settings-error banner elsewhere, so this anchor is scoped
// tightly to the ONE instance whose onClose calls dismissRateLimitWarning() — a
// string unique in the bundle). Its own X only clears rateLimitWarning.value for the
// current rate-limit key (dismissRateLimitWarning() in the webview's session-state
// class), so it reappears on the next usage update; ON here instead short-circuits
// the whole render condition permanently by swapping its leading
// `t.rateLimitWarning.value` for `false`, so the banner (and its "View usage" link)
// never renders regardless of usage state. The middle guard clauses
// (!h&&!fe&&un===void 0&&!ie&&!R&&!n.showReviewUpsellBanner.value) are matched
// tolerantly (a bounded &&-separated run) since their exact count/order is
// build-specific and not the actual anchor — the unique tail
// (color:"warning",onClose:()=>{t.dismissRateLimitWarning()},closeTooltip:"Dismiss
// warning") is what pins this to the correct banner instance.
const USAGE_WARNING_RE =
  /(t\.rateLimitWarning\.value|false)((?:&&[^&{}]*)*?&&(?:E|b)\(RC,\{color:"warning",onClose:\(\)=>\{t\.dismissRateLimitWarning\(\)\},closeTooltip:"Dismiss warning")/;

function usageWarningPresent(c: string): boolean {
  return USAGE_WARNING_RE.test(c);
}
function usageWarningCurrentOn(c: string): boolean | undefined {
  const m = c.match(USAGE_WARNING_RE);
  if (!m) return undefined;
  return m[1] === "false";
}
function usageWarningSet(c: string, on: boolean): string {
  return c.replace(
    USAGE_WARNING_RE,
    (_w, _lead: string, rest: string) => `${on ? "false" : "t.rateLimitWarning.value"}${rest}`,
  );
}

// Permission-code size match (ON): the permission "Allow this command?" dialog
// renders the command in .bashCommand_<hash> at 0.9em, larger than the tool
// input (IN) block (0.85em). When ON we append a scoped rule pinning the
// permission block to 0.85em so it matches the IN block (both remain em-relative
// to the chat font size). The hash is read from the stylesheet; if the anchor is
// gone we skip (native). The /*cc-ui-patch:permCode*/ marker makes it detectable.
// This is a pure-CSS toggle (no JS anchor): its "file" is the stylesheet and the
// fn* transforms append/remove the marked line, so it rides the toggle machinery
// without a JS side.
const PERM_CODE_MARKER = "/*cc-ui-patch:permCode*/";
const BASH_CMD_HASH_RE = /\.bashCommand_([-\w]+)\{/;

function permCodePresent(c: string): boolean {
  return c.includes(PERM_CODE_MARKER) || BASH_CMD_HASH_RE.test(c);
}
function permCodeCurrentOn(c: string): boolean | undefined {
  if (c.includes(PERM_CODE_MARKER)) return true;
  if (BASH_CMD_HASH_RE.test(c)) return false;
  return undefined; // anchor gone
}
function permCodeSet(c: string, on: boolean): string {
  if (!on) return cssRemoveLine(c, PERM_CODE_MARKER);
  const hash = c.match(BASH_CMD_HASH_RE)?.[1];
  if (!hash) return c; // anchor gone: leave native
  return cssApplyLine(
    c,
    PERM_CODE_MARKER,
    `${PERM_CODE_MARKER}.bashCommand_${hash}{font-size:.85em !important}`,
  );
}

// Faro logging CSP allowance (ON): the chat webview's stock CSP is
// `default-src 'none'; ${p}; ${f}; ${m}; script-src 'nonce-${u}'; ${v};`
// (style/font/img/worker via cspSource, script nonce-only). It permits NEITHER
// the unpkg CDN (to load the Faro Web SDK) NOR the Faro collector origin (to
// POST telemetry) — so the chatEnhancements Faro feature can never reach
// Grafana Loki with the stock CSP (verified live: the SDK <script> is
// CSP-blocked, and even nonce'd, the collector POST would be blocked by the
// absent connect-src). This toggle rewrites that one CSP <meta> so Faro works:
// it injects `https://unpkg.com` into the existing script-src and appends a
// `connect-src` for the Faro collector origin, right before the closing `;">`.
// Scoped tightly to the chat webview CSP (anchored on the `script-src
// 'nonce-${u}'` template literal, which is unique to that one template — the
// plan-preview webview uses a literal `nonce-{{NONCE}}` instead, so it is never
// touched). The /*ccup-csp*/ marker (kept OUTSIDE the meta content, in a
// trailing HTML comment) makes the ON state detectable and reversible.
//
// The two allowed origins are derived from the Faro feature's own stamped
// collector URL; keep them in sync if smarts-logging-grafana ever restamps a
// different collector region.
// Mirrors the proven-working CSP patch from the sibling smarts-claude-patch
// project (scripts/Apply Patch.mjs step 3d): two idempotent edits to the ONE
// chat-webview CSP meta —
//   (1) connect-src <collector> inserted right after `default-src 'none';`
//       (or an existing connect-src replaced) so Faro's push fetch is allowed,
//   (2) unpkg.com added to the existing `script-src 'nonce-${n}';` so the SDK
//       <script> can load.
// The nonce var name (${u} here, but captured fresh so it survives re-minify)
// is never hardcoded. Detection: the presence of `unpkg.com` in the script-src
// is the ON marker (no separate comment marker needed — the CSP change IS the
// state). Scoped to the chat webview CSP alone: it anchors on the nonce
// TEMPLATE-LITERAL form `nonce-${u}`, which is unique to that template — the
// plan-preview webview uses a literal `nonce-{{NONCE}}` and is never matched.
const FARO_CDN_ORIGIN = "https://unpkg.com";
const FARO_COLLECTOR_ORIGIN = "https://faro-collector-prod-ap-south-1.grafana.net";
// The ONE chat-webview CSP <meta> — matched as a whole so both edits stay scoped
// to it and never touch the SEPARATE plan-preview CSP, which shares the same
// `default-src 'none';` prefix but uses a literal `nonce-{{NONCE}}` (not the
// template-literal `nonce-${u}`) and img-src data:. Anchoring the whole tag on
// the template-literal nonce form is what keeps the plan-preview meta untouched
// (a naive split on `default-src 'none';` would hit BOTH — a real bug caught in
// testing). The nonce var name (${u}) is captured, never hardcoded, so this
// survives a re-minify that renames it.
const CSP_CHAT_META_RE =
  /<meta http-equiv="Content-Security-Policy" content="(default-src 'none';[^"]*?script-src 'nonce-\$\{\w+\}'[^"]*?)">/;
const CSP_SCRIPT_SRC_RE = /script-src\s+'nonce-\$\{(\w+)\}'\s*;/;

function cspChatMetaPresent(c: string): boolean {
  return CSP_CHAT_META_RE.test(c);
}
function cspPresent(c: string): boolean {
  return cspChatMetaPresent(c);
}
// true = ON (unpkg in the chat script-src), false = OFF (stock), undefined = anchor gone.
function cspCurrentOn(c: string): boolean | undefined {
  const m = c.match(CSP_CHAT_META_RE);
  if (!m) return undefined;
  return m[1].includes(`${FARO_CDN_ORIGIN};`) && m[1].includes(`connect-src ${FARO_COLLECTOR_ORIGIN}`)
    ? true
    : false;
}
// Transform ONLY the chat CSP meta's content, splicing the result back so the
// plan-preview meta (and everything else) is byte-for-byte untouched.
function cspSet(c: string, on: boolean): string {
  const m = c.match(CSP_CHAT_META_RE);
  if (!m) return c; // anchor gone: leave native
  const content = m[1];
  const next = on ? cspContentOn(content) : cspContentOff(content);
  if (next === content) return c; // no-op
  return c.replace(m[0], `<meta http-equiv="Content-Security-Policy" content="${next}">`);
}
// ON: add connect-src <collector> right after default-src 'none'; (or replace an
// existing connect-src), and add unpkg.com to the nonce script-src. Idempotent.
function cspContentOn(content: string): string {
  let out = content;
  const connectDirective = `connect-src ${FARO_COLLECTOR_ORIGIN}`;
  if (!out.includes(connectDirective)) {
    if (/connect-src [^;]*;/.test(out)) {
      out = out.replace(/connect-src [^;]*;/, `${connectDirective};`);
    } else {
      out = out.replace("default-src 'none';", `default-src 'none'; ${connectDirective};`);
    }
  }
  const s = CSP_SCRIPT_SRC_RE.exec(out);
  if (s && !out.includes(`'nonce-\${${s[1]}}' ${FARO_CDN_ORIGIN}`)) {
    out = out.replace(s[0], `script-src 'nonce-\${${s[1]}}' ${FARO_CDN_ORIGIN};`);
  }
  return out;
}
// OFF: exact inverse of cspContentOn — strip our connect-src and the unpkg token.
function cspContentOff(content: string): string {
  let out = content;
  out = out.replace(
    new RegExp(
      ` connect-src ${FARO_COLLECTOR_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")};`,
    ),
    "",
  );
  out = out.replace(/(script-src\s+'nonce-\$\{\w+\}') https:\/\/unpkg\.com;/, "$1;");
  return out;
}

// Open-external bridge (see openExternalBridge.ts for the full rationale):
// two ALWAYS-ON TogglePoints, one per file, that together let the injected
// chat-enhancement scripts open a URL in the user's real browser despite the
// chat webview's no-"allow-popups" sandbox. Neither has a user-facing
// setting -- both ride with chatEnhancements the same way faroCsp does.
function openExternalHostPresent(c: string): boolean {
  return hostBridgePresent(c);
}
function openExternalHostCurrentOn(c: string): boolean | undefined {
  return hostBridgePresent(c) ? true : false;
}
function openExternalHostSet(c: string, on: boolean): string {
  return on ? applyHostBridge(c).out : removeHostBridge(c);
}
function openExternalWebviewPresent(c: string): boolean {
  return webviewBridgePresent(c);
}
function openExternalWebviewCurrentOn(c: string): boolean | undefined {
  return webviewBridgePresent(c) ? true : false;
}
function openExternalWebviewSet(c: string, on: boolean): string {
  return on ? applyWebviewBridge(c).out : removeWebviewBridge(c);
}

// The chat message "Show more" (.expandButton_<hash>) and "Show less"
// (.collapseButton_<hash>) buttons live in the expandable-content module. "Show
// more" is position:absolute (bottom:0;right:0) anchored to the fit-content
// .expandableContainer and only renders on hover, so it overlays the content
// instead of taking a flow slot; its horizontal spot tracks the content width
// and drifts between messages. "Show less" is an in-flow flex item defaulting
// to the container's right edge. The chatShowMoreAndLessAlign inject point
// (below) pins each to the chosen side: "Show more" stays absolute (still
// overlaid, so it never adds height) with only its left/right anchor flipped;
// "Show less" keeps its flow slot, pushed with an auto margin. An earlier build
// forced "Show more" into normal flow (position:static), which grew the box
// taller whenever it appeared on hover, a vertical jitter. "" = leave native.
// Anchor on the buttonContainer rule to recover the hash.
const SHOW_MORE_MARKER = "/*cc-ui-patch:showMoreRight*/";
const SHOW_MORE_HASH_RE =
  /\.buttonContainer_([-\w]+)\{display:flex;opacity:\.9;justify-content:flex-end/;

interface TogglePoint {
  id: string;
  section: Section;
  label: string;
  key: string; // settings sub-key under the smartsClaudeManager namespace (boolean)
  defaultOn: boolean; // native default (the "off"/stock state)
  file: string; // path relative to the install dir
  // Value-swap model (re captures (prefix)(value)(suffix); onValue/offValue
  // replace the captured value). Used by the diff-card toggles.
  re?: RegExp; // global; captures (prefix)(value)(suffix)
  onValue?: string; // literal written for ON
  offValue?: string; // literal written for OFF (native)
  isOn?: (value: string) => boolean; // detect ON from the captured value (default: === onValue)
  // Custom transform for an on/off change the value-swap model can't express
  // (e.g. injecting a statement). When present, these override re/onValue/offValue/isOn.
  fnPresent?: (c: string) => boolean;
  fnCurrentOn?: (c: string) => boolean | undefined; // undefined => anchor gone
  fnSet?: (c: string, on: boolean) => string;
  // Optional content digest beyond a plain on/off boolean — for a toggle whose ON
  // state can itself carry different CONTENT (e.g. chatEnhancements: the injected
  // script's per-feature seed values), so toggleStateStr()'s equality check (used by
  // both analyzeToggles' status and reconcilePendingReload's "needs reload" flag)
  // notices a content-only change, not just an on/off flip. Returns a short string
  // that changes whenever the meaningful content differs; undefined defers to the
  // plain jsOn boolean (the default for every other toggle).
  fnContentDigest?: (c: string) => string | undefined;
  // The digest toggleWantStr() should compare against when ON — computed from
  // CURRENT settings alone (no file content available yet), so it must mirror
  // fnContentDigest's derivation exactly. Only meaningful when fnContentDigest is
  // also set.
  fnWantDigest?: () => string;
  // Optional secondary CSS side-effect (a different file) applied when ON.
  cssFile?: string;
  cssMarker?: string; // comment tagging the appended rule
  cssBuild?: (css: string) => string | undefined; // full marked rule, or undefined if anchor gone
}

// Chat enhancements (ON): injects the shared bootstrap + toolbar + every
// registered behavior feature (Reply, Search, DateTime, ... — see
// behaviorFeatures.ts) as one marker-tagged nonce'd <script> in extension.js, plus
// their combined CSS as one marker-tagged block in webview/index.css. Both files
// ride the toggle machinery via a custom fn* transform (extension.js) + a cssFile
// side-effect (webview/index.css), exactly like diffLineNumbers' gutter CSS above,
// because this is a whole-block inject/remove rather than a single value swap.
// smartsClaudeManager.feature.<id> (one boolean per feature — see package.json, and the
// panel's Chat Features checkboxes) is written into the runtime toggle's
// localStorage map on EVERY webview load — the panel is the one control surface for
// per-feature on/off (a checkbox flip takes effect on the next window reload, exactly
// like every other patch setting). Read fresh on every apply so a settings change is
// picked up by the next re-patch.
export function readFeatureDefaults(): Record<string, boolean> {
  const c = vscode.workspace.getConfiguration(CONFIG_NS);
  const m: Record<string, boolean> = {};
  for (const f of featureIds()) m[f.id] = c.get<boolean>(`feature.${f.id}`, true);
  return m;
}

function chatEnhancementsPresent(c: string): boolean {
  return behaviorPresent(c);
}
function chatEnhancementsCurrentOn(c: string): boolean | undefined {
  const cur = currentBehaviorScript(c);
  if (cur === undefined) return false; // anchor present, no block: OFF
  return true; // block present (content drift, if any, is reconciled by re-apply)
}
// A plain on/off boolean can't tell "the injected script is present" apart from
// "the injected script is present WITH THE CURRENTLY-WANTED per-feature seed
// values" — a smartsClaudeManager.feature.<id> flip changes only the latter. These
// two functions give toggleStateStr()/toggleWantStr() a real content comparison
// (a fast, cheap length+char-sum digest — the actual scripts run tens of KB, so
// hashing the full string on every analyze/reconcile pass is unnecessary), so a
// feature-only change is correctly flagged as "needs reload" instead of silently
// looking identical to the already-applied state.
function cheapDigest(s: string): string {
  let sum = 0;
  for (let i = 0; i < s.length; i += 7) sum = (sum + s.charCodeAt(i) * (i + 1)) % 0xfffffff;
  return `${s.length}-${sum.toString(36)}`;
}
function chatEnhancementsContentDigest(c: string): string | undefined {
  const cur = currentBehaviorScript(c);
  return cur === undefined ? undefined : cheapDigest(cur);
}
function chatEnhancementsWantDigest(): string {
  return cheapDigest(wantedBehaviorScript(readFeatureDefaults()));
}
function chatEnhancementsSet(c: string, on: boolean): string {
  if (!on) return removeBehaviorScript(c);
  const defaults = readFeatureDefaults();
  const cur = currentBehaviorScript(c);
  const want = wantedBehaviorScript(defaults);
  if (cur === want) return c; // already in sync: no-op write
  return applyBehaviorScript(c, defaults).out;
}
// The full marker-tagged line to write when ON — always re-derived from the
// CURRENT feature registry (mirrors diffLinesCssBuild's shape above), so an
// extension update that adds/changes a feature is picked up on the next apply.
function chatEnhancementsCssBuild(_css: string): string | undefined {
  return behaviorCssMarkedLine();
}

const TOGGLE_POINTS: TogglePoint[] = [
  {
    id: "chatEnhancements",
    section: "Chat Panel",
    label: "Chat enhancements",
    key: "chatEnhancements",
    defaultOn: false,
    file: "extension.js",
    fnPresent: chatEnhancementsPresent,
    fnCurrentOn: chatEnhancementsCurrentOn,
    fnSet: chatEnhancementsSet,
    fnContentDigest: chatEnhancementsContentDigest,
    fnWantDigest: chatEnhancementsWantDigest,
    cssFile: "webview/index.css",
    cssMarker: BEHAVIOR_CSS_MARKER,
    cssBuild: chatEnhancementsCssBuild,
  },
  {
    id: "hideUsageWarning",
    section: "Chat Panel",
    label: "Usage-limit warning banner",
    key: "chatHideUsageWarning",
    defaultOn: false,
    file: "webview/index.js",
    fnPresent: usageWarningPresent,
    fnCurrentOn: usageWarningCurrentOn,
    fnSet: usageWarningSet,
  },
  {
    id: "diffLineNumbers",
    section: "Chat Panel",
    label: "Diff card line numbers",
    key: "chatDiffCardLineNumbers",
    defaultOn: true,
    file: "webview/index.js",
    // Swap the whole lineNumbers value; ON also sets lineNumbersMinChars:2 to keep
    // the gutter narrow (Monaco's default minimum is 5 chars, which widens the
    // margin noticeably). The optional min-chars group in the match also accepts a
    // prior build's bare lineNumbers:"on", so re-applying upgrades it in place.
    re: /(fontSize:\d+(?:\.\d+)?,)(lineNumbers:"(?:off|on)"(?:,lineNumbersMinChars:\d+)?)(,)/g,
    onValue: 'lineNumbers:"on",lineNumbersMinChars:2',
    offValue: 'lineNumbers:"off"',
    isOn: (v) => v.includes('"on"'),
    cssFile: "webview/index.css",
    cssMarker: DIFF_LINES_CSS_MARKER,
    cssBuild: diffLinesCssBuild,
  },
  {
    id: "diffThemeSync",
    section: "Chat Panel",
    label: "Diff card theme sync",
    key: "chatDiffCardThemeSync",
    defaultOn: true,
    file: "webview/index.js",
    re: /(automaticLayout:!0,theme:)([\s\S]*?)(,fontSize:)/g,
    onValue: THEME_SYNC_ON,
    offValue: '"vs-dark"',
    isOn: (v) => v.includes("ccup-theme"),
  },
  {
    id: "effortSyncFix",
    section: "Chat Panel",
    label: "Effort-level indicator sync",
    key: "effortSyncFix",
    defaultOn: false,
    file: "webview/index.js",
    fnPresent: effortSyncPresent,
    fnCurrentOn: effortSyncCurrentOn,
    fnSet: effortSyncSet,
  },
  {
    id: "permCode",
    section: "Chat Panel",
    label: "Permission code fontsize sync",
    key: "chatPermissionCodeMatchChatCodeblock",
    defaultOn: false,
    file: "webview/index.css",
    fnPresent: permCodePresent,
    fnCurrentOn: permCodeCurrentOn,
    fnSet: permCodeSet,
  },
  {
    // Faro logging CSP allowance — extends the chat webview's CSP so the Faro
    // Web SDK (unpkg script-src) and its collector fetch (connect-src) are
    // permitted; without it the chatEnhancements Faro feature is CSP-blocked and
    // Grafana Loki gets nothing (verified live). ALWAYS ON (see ALWAYS_ON_TOGGLES):
    // it has no user-facing setting — it exists solely to make the always-on
    // chat-enhancements pack's own Faro logging able to reach Grafana, so it
    // rides with chatEnhancements rather than being independently toggleable.
    id: "faroCsp",
    section: "Chat Panel",
    label: "Faro logging CSP allowance",
    key: "faroCsp",
    defaultOn: false,
    file: "extension.js",
    fnPresent: cspPresent,
    fnCurrentOn: cspCurrentOn,
    fnSet: cspSet,
  },
  {
    // Extension-host half of the open-external bridge — see
    // openExternalBridge.ts. ALWAYS ON: no user-facing setting, rides with
    // chatEnhancements (googlesearch depends on it to open a real browser
    // window despite the chat webview's sandbox).
    id: "openExternalHost",
    section: "Chat Panel",
    label: "Open-external bridge (host)",
    key: "openExternalHost",
    defaultOn: false,
    file: "extension.js",
    fnPresent: openExternalHostPresent,
    fnCurrentOn: openExternalHostCurrentOn,
    fnSet: openExternalHostSet,
  },
  {
    // Webview half of the open-external bridge — see openExternalBridge.ts.
    // ALWAYS ON, same rationale as openExternalHost above.
    id: "openExternalWebview",
    section: "Chat Panel",
    label: "Open-external bridge (webview)",
    key: "openExternalWebview",
    defaultOn: false,
    file: "webview/index.js",
    fnPresent: openExternalWebviewPresent,
    fnCurrentOn: openExternalWebviewCurrentOn,
    fnSet: openExternalWebviewSet,
  },
];

export type ToggleMap = Record<string, boolean>;

// Toggle ids with no user-facing setting: always forced to this value regardless of
// smartsClaudeManager.* config. chatEnhancements is one of these — the individual
// smartsClaudeManager.feature.<id> checkboxes are the only per-feature control; there
// is no separate master on/off (removed per user feedback: "doim on bo'ladi").
const ALWAYS_ON_TOGGLES = new Set([
  "chatEnhancements",
  "faroCsp",
  "openExternalHost",
  "openExternalWebview",
]);

export function readToggles(): ToggleMap {
  const c = vscode.workspace.getConfiguration(CONFIG_NS);
  const m: ToggleMap = {};
  for (const t of TOGGLE_POINTS) {
    m[t.id] = ALWAYS_ON_TOGGLES.has(t.id) ? true : c.get<boolean>(t.key, t.defaultOn);
  }
  return m;
}

// One-time migration: the diff-card settings were renamed chatDiff* → chatDiffCard*.
// Copy any user-set legacy value to the new key (when the new key is unset) and
// clear the legacy key. Safe to run every activation: a no-op once nothing legacy
// remains, and it must run before the Patcher reads settings so nothing reverts.
const LEGACY_KEY_RENAMES: [string, string][] = [
  ["chatDiffFontSize", "chatDiffCardFontSize"],
  ["chatDiffLineNumbers", "chatDiffCardLineNumbers"],
  ["chatDiffThemeSync", "chatDiffCardThemeSync"],
  ["chatCodeFontSize", "chatCodeblockFontSize"],
];

export async function migrateLegacyKeys(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
  for (const [oldKey, newKey] of LEGACY_KEY_RENAMES) {
    const legacy = cfg.inspect(oldKey)?.globalValue;
    if (legacy === undefined) continue;
    try {
      if (cfg.inspect(newKey)?.globalValue === undefined) {
        await cfg.update(newKey, legacy, vscode.ConfigurationTarget.Global);
      }
      await cfg.update(oldKey, undefined, vscode.ConfigurationTarget.Global);
    } catch {
      // best effort: the value is copied; clearing an unregistered legacy key can
      // throw on some VS Code versions, which is harmless (it just lingers).
    }
  }
}

// The whole extension was renamed claudeCodeUiPatch -> smartsClaudeManager (v2.0.0),
// which moves EVERY setting to a new namespace, not just a handful of keys. Every
// sub-key that has ever existed under the old namespace is copied over verbatim
// (both Global and Workspace scope — a workspace-level override must migrate too,
// not just a user-level one) the first time this runs after the upgrade, then the
// old key is cleared so a stale claudeCodeUiPatch.* value never lingers or masks a
// future old-namespace read (there is none, but this mirrors migrateLegacyKeys's own
// discipline). Safe to run every activation: a no-op once nothing under the old
// namespace remains. Must run before the Patcher reads settings, same as
// migrateLegacyKeys, so a migrated value takes effect immediately.
const OLD_CONFIG_NS = "claudeCodeUiPatch";
const NAMESPACE_MIGRATION_KEYS: string[] = [
  "chatHistoryFontSize",
  "chatHistoryFontFamily",
  "chatCodeblockFontSize",
  "chatCodeInlineFontSize",
  "chatDiffCardFontSize",
  "chatDiffCardLineNumbers",
  "chatDiffCardThemeSync",
  "chatPermissionCodeMatchChatCodeblock",
  "chatShowMoreAndLessAlign",
  "effortSyncFix",
  "planPreviewFontSize",
  "planPreviewFontFamily",
  "planPreviewCodeblockFontSize",
  "planPreviewCodeInlineFontSize",
  "planPreviewCommentInputFontSize",
  "planPreviewCommentInputRows",
  "planPreviewCommentQuoteFontSize",
  "planPreviewCommentBadgeFontSize",
  "chatHideUsageWarning",
  "feature.reply",
  "feature.search",
  "feature.datetime",
  "feature.askquestion",
  "feature.userstyle",
  "feature.blockquote",
  "feature.copybuttons",
  "feature.codeblock",
  "feature.toc",
  "feature.export",
  "feature.scroll",
  "feature.askcollapse",
  "feature.autocontinue",
  "feature.draftsave",
  "feature.usernav",
  // Pre-2.0.0 legacy keys, in case a user upgrades straight from a version that
  // predates the chatDiff*->chatDiffCard*/chatCodeFontSize->chatCodeblockFontSize
  // rename without ever having run migrateLegacyKeys() under the old namespace.
  "chatDiffFontSize",
  "chatDiffLineNumbers",
  "chatDiffThemeSync",
  "chatCodeFontSize",
];

export async function migrateNamespaceRename(): Promise<void> {
  const oldCfg = vscode.workspace.getConfiguration(OLD_CONFIG_NS);
  const newCfg = vscode.workspace.getConfiguration(CONFIG_NS);
  const scopes: [vscode.ConfigurationTarget, "globalValue" | "workspaceValue"][] = [
    [vscode.ConfigurationTarget.Global, "globalValue"],
    [vscode.ConfigurationTarget.Workspace, "workspaceValue"],
  ];
  for (const key of NAMESPACE_MIGRATION_KEYS) {
    const inspected = oldCfg.inspect(key);
    if (!inspected) continue;
    for (const [target, prop] of scopes) {
      const legacy = inspected[prop];
      if (legacy === undefined) continue;
      try {
        const newInspected = newCfg.inspect(key);
        const newProp = target === vscode.ConfigurationTarget.Global ? "globalValue" : "workspaceValue";
        if (newInspected?.[newProp] === undefined) {
          await newCfg.update(key, legacy, target);
        }
        await oldCfg.update(key, undefined, target);
      } catch {
        // best effort: the value is copied; clearing an unregistered legacy
        // namespace key can throw on some VS Code versions, harmless (it lingers).
      }
    }
  }
}

function togglePresent(content: string, t: TogglePoint): boolean {
  if (t.fnPresent) return t.fnPresent(content);
  t.re!.lastIndex = 0;
  return t.re!.test(content);
}
// on/off in the bundle (reads the first match; all sites are kept in sync), or
// undefined when the anchor is absent.
function toggleCurrentOn(content: string, t: TogglePoint): boolean | undefined {
  if (t.fnCurrentOn) return t.fnCurrentOn(content);
  t.re!.lastIndex = 0;
  const m = t.re!.exec(content);
  if (!m) return undefined;
  return t.isOn ? t.isOn(m[2]) : m[2] === t.onValue;
}
// Canonical string of a toggle's FULL on-disk state: the JS anchor plus any CSS
// side-effect. Used for status, drift detection, and pending-reload. undefined if
// the JS anchor is gone. A mixed state (e.g. JS "on" from a prior build but the
// CSS rule not yet appended) yields its own string, so it never looks "current"
// and therefore gets reconciled — the fix for the CSS half being skipped.
function toggleStateStr(
  read: (rel: string) => string | undefined,
  t: TogglePoint,
): string | undefined {
  const js = read(t.file);
  if (js === undefined || !togglePresent(js, t)) return undefined;
  const digest = t.fnContentDigest?.(js);
  const jsOn = digest !== undefined ? `on:${digest}` : toggleCurrentOn(js, t) ? "on" : "off";
  if (!t.cssFile || !t.cssMarker) return jsOn;
  const css = read(t.cssFile);
  // "css" only when the EXACT current rule matches what we'd build now. A missing
  // rule is "nocss"; a rule that differs from the current build (e.g. a newer
  // patch version) is "stale" — both differ from "css" so they get re-applied.
  let cssState = "nocss";
  if (css !== undefined && css.includes(t.cssMarker)) {
    const want = t.cssBuild ? t.cssBuild(css) : undefined;
    cssState =
      want !== undefined && cssMarkedLine(css, t.cssMarker) === want
        ? "css"
        : "stale";
  }
  return `${jsOn}+${cssState}`;
}

// The full-state string a toggle should have for a given on/off setting.
function toggleWantStr(t: TogglePoint, on: boolean): string {
  const js = on ? (t.fnWantDigest ? `on:${t.fnWantDigest()}` : "on") : "off";
  if (!t.cssFile || !t.cssMarker) return js;
  return `${js}+${on ? "css" : "nocss"}`;
}
function toggleSet(content: string, t: TogglePoint, on: boolean): string {
  if (t.fnSet) return t.fnSet(content, on);
  const value = on ? t.onValue : t.offValue;
  return content.replace(t.re!, (_w, p, _v, s) => `${p}${value}${s}`);
}

function toggleByFile(): Map<string, TogglePoint[]> {
  const m = new Map<string, TogglePoint[]>();
  for (const t of TOGGLE_POINTS) {
    (m.get(t.file) ?? m.set(t.file, []).get(t.file)!).push(t);
  }
  return m;
}

// Build the diff-card gutter-cleanup rule, scoped to the diff container whose
// CSS-module hash is read from the stylesheet (undefined if the anchor is gone,
// so a future build fails gracefully: line numbers still show, just not cleaned).
function diffLinesCssBuild(css: string): string | undefined {
  DIFF_CONTAINER_HASH_RE.lastIndex = 0;
  const hashes = [
    ...new Set([...css.matchAll(DIFF_CONTAINER_HASH_RE)].map((m) => m[1])),
  ];
  if (!hashes.length) return undefined;
  const asText =
    "font-family:var(--vscode-editor-font-family),monospace !important";
  const perContainer = (hash: string): string => {
    const c = `.diffEditorContainer_${hash}`;
    const ins = `${c} .codicon-diff-insert`;
    const rem = `${c} .codicon-diff-remove`;
    return (
      // undo the codicon shrink so the sign fills the gutter, and force a text
      // font on both the element and the ::before (the box is a notdef glyph).
      `${ins},${rem}{${asText};transform:none !important;font-size:12px !important;line-height:1 !important}` +
      `${ins}::before{content:"+" !important;${asText}}` +
      `${rem}::before{content:"-" !important;${asText}}` +
      `${c} .line-numbers.active-line-number{color:var(--vscode-editorLineNumber-foreground) !important}`
    );
  };
  return DIFF_LINES_CSS_MARKER + hashes.map(perContainer).join("");
}

// Append (or replace) a single marker-tagged line in a CSS file, and its inverse.
// String-based (not regex) so a marker containing /* */ needs no escaping.
function cssApplyLine(css: string, marker: string, line: string): string {
  const stripped = cssRemoveLine(css, marker);
  return `${stripped}\n${line}`;
}
function cssRemoveLine(css: string, marker: string): string {
  const i = css.indexOf(marker);
  if (i < 0) return css;
  const start = i > 0 && css[i - 1] === "\n" ? i - 1 : i;
  const end = css.indexOf("\n", i);
  return css.slice(0, start) + (end < 0 ? "" : css.slice(end));
}
// The marker-tagged line's current contents (marker through end of line), for
// comparing the on-disk rule against the freshly built one.
function cssMarkedLine(css: string, marker: string): string | undefined {
  const i = css.indexOf(marker);
  if (i < 0) return undefined;
  const end = css.indexOf("\n", i);
  return css.slice(i, end < 0 ? undefined : end);
}

// ---------------------------------------------------------------------------
// Injection points: settings that are neither a px slot nor a boolean toggle
// (a font-family string, a decoupled chat size, a textarea row count). Each maps
// its setting to a self-contained CSS/JS injection with an "off" state
// (undefined) meaning "leave the bundle native". They ride the same file-write /
// drift / pending-reload machinery, but carry their own value type and
// transforms so the px and toggle models are untouched.
//
//   read()    -> the EFFECTIVE value, or undefined for "off" (size 0 = inherit
//                chat.fontSize; family "" = native; rows 0 = native).
//   current() -> the value currently written into the bundle, or undefined when
//                native. So (current === read) means in sync.
// ---------------------------------------------------------------------------
type InjectValue = string | number;

interface InjectPoint {
  id: string;
  section: Section;
  label: string;
  key: string; // settings sub-key under the smartsClaudeManager namespace
  kind: "size" | "family" | "rows" | "align";
  file: string;
  showInPanel: boolean; // size shows as a knob; strings/rows are settings-only
  max: number; // upper clamp for a size knob (unused otherwise)
  defaultRaw: InjectValue; // config default
  effective: (raw: InjectValue) => InjectValue | undefined; // undefined = off
  inheritFrom?: string; // PATCH_POINT id whose size this follows when off (panel display)
  present: (c: string) => boolean; // anchor patchable in this file?
  current: (c: string) => InjectValue | undefined; // value in bundle, or undefined
  apply: (c: string, v: InjectValue) => string;
  remove: (c: string) => string;
}

// chatHistoryFontSize: size the agent message body only (.root_<hash>), NOT the
// whole webview. Everything else (user messages, input box, interface
// chrome, other extensions' chats) stays on the shared native chat.fontSize, so
// the agent transcript can be enlarged (e.g. to compensate for a proportional
// reading font) without inflating the textarea or Codex. 0 = inherit (no rule).
const CHAT_SIZE_MARKER = "/*cc-ui-patch:chatSize*/";
const CHAT_SIZE_PX_RE =
  /\/\*cc-ui-patch:chatSize\*\/\.root_[-\w]+[^{\n]*\{font-size:(\d+(?:\.\d+)?)px/;

// chatHistoryFontFamily: apply a font to the agent message body only
// (.root_<hash>). Reset the whole webview's chat family to the native UI font
// (so the interface, input box, user messages, attachments, and diff-card chrome
// stay native, which also fixes caret drift under a proportional font), then
// apply the chosen family to the agent markdown, re-asserting a monospace family
// so code blocks and inline code stay monospace. User messages are left native
// on purpose: the file-name attachment chip renders INSIDE .userMessage_, so
// scoping there would drag the reading font onto that chrome.
const CHAT_FAMILY_MARKER = "/*cc-ui-patch:chatFamily*/";
const CHAT_FAMILY_VAL_RE =
  /\/\*cc-ui-patch:chatFamily\*\/[^\n]*?\.root_[-\w]+[^{\n]*\{font-family:(.+?) !important\}/;
// The agent message body is the rich markdown module: the only .root_ with
// element rules, anchored via its inline-code rule.
const CHAT_MD_HASH_RE = /\.root_([-\w]+) code\{font-family/;

// Selector the family/size scope to: the agent markdown body only. undefined if
// the markdown module is gone (leave native).
function chatContentSelector(c: string): string | undefined {
  const md = c.match(CHAT_MD_HASH_RE)?.[1];
  return md ? `.root_${md}` : undefined;
}

// planPreviewFontFamily: the plan preview is its own webview; swap its <body>
// font-family (stock is the markdown var). Composes with the planPreviewFontSize
// point, which anchors on the same rule's font-size independent of the family.
const PLAN_FAMILY_STOCK =
  "var(--vscode-markdown-font-family, var(--vscode-font-family))";
const PLAN_FAMILY_RE =
  /(body \{\s*font-family:\s*)(var\(--vscode-markdown-font-family, var\(--vscode-font-family\)\)|[^;]+?)(;\s*font-size:)/;

// planPreviewCommentInputRows: the select-and-comment textarea has no rows
// attribute (defaults to ~3 lines via min-height); inject one so it opens taller.
const PLAN_ROWS_RE =
  /(<textarea id="comment-textarea")(?: rows="\d+")?( placeholder=)/;
const PLAN_ROWS_READ_RE = /<textarea id="comment-textarea" rows="(\d+)"/;

function clampSizePx(n: number): number {
  return Math.min(MAX_PX, Math.max(MIN_PX, Math.round(n * 100) / 100));
}

// chatCodeInlineFontSize / planPreviewCodeInlineFontSize: add-on overrides that
// size ONLY inline code (a <code> whose parent is not <pre>), so blocks and
// inline can be tuned separately. 0 = off, inline then follows the block/code
// knob (chatCodeblockFontSize / planPreviewCodeblockFontSize), which is left
// unchanged. `:not(pre) > code` wins over the base code rule by specificity and
// never matches block code (parent <pre>), so block sizing is untouched.
const CHAT_CODE_INLINE_MARKER = "/*cc-ui-patch:chatCodeInline*/";
const CHAT_CODE_INLINE_PX_RE =
  /\/\*cc-ui-patch:chatCodeInline\*\/[^\n]*?font-size:(\d+(?:\.\d+)?)px/;

// Plan preview: the inline override is spliced in right after the general
// `code {}` rule (anchored on its editor-font-family declaration).
const PLAN_CODE_INLINE_MARKER = "/*cc-ui-patch:planCodeInline*/";
const PLAN_CODE_INLINE_PX_RE =
  /\/\*cc-ui-patch:planCodeInline\*\/:not\(pre\) > code\{font-size:(\d+(?:\.\d+)?)px/;
const PLAN_CODE_RULE_RE =
  /code \{\s*font-family: var\(--vscode-editor-font-family\);[^}]*\}/;

function planRemoveCodeInline(c: string): string {
  const i = c.indexOf(PLAN_CODE_INLINE_MARKER);
  if (i < 0) return c;
  const end = c.indexOf("}", i);
  return end < 0 ? c : c.slice(0, i) + c.slice(end + 1);
}

function planInjectCodeInline(c: string, v: InjectValue): string {
  const cleaned = planRemoveCodeInline(c);
  const m = cleaned.match(PLAN_CODE_RULE_RE);
  if (!m) return c; // general code rule gone: leave native
  const idx = (m.index ?? 0) + m[0].length;
  const rule = `${PLAN_CODE_INLINE_MARKER}:not(pre) > code{font-size:${v}px !important}`;
  return cleaned.slice(0, idx) + rule + cleaned.slice(idx);
}

const INJECT_POINTS: InjectPoint[] = [
  {
    id: "chatHistorySize",
    section: "Chat Panel",
    label: "Agent response",
    key: "chatHistoryFontSize",
    kind: "size",
    file: "webview/index.css",
    showInPanel: true,
    max: 48,
    defaultRaw: 0,
    effective: (raw) =>
      typeof raw === "number" && raw > 0 ? clampSizePx(raw) : undefined,
    present: (c) => CHAT_MD_HASH_RE.test(c),
    current: (c) => {
      const m = c.match(CHAT_SIZE_PX_RE);
      return m ? Number(m[1]) : undefined;
    },
    apply: (c, v) => {
      const sel = chatContentSelector(c);
      if (!sel) return c; // markdown anchor gone: leave native
      return cssApplyLine(
        c,
        CHAT_SIZE_MARKER,
        `${CHAT_SIZE_MARKER}${sel}{font-size:${v}px !important}`,
      );
    },
    remove: (c) => cssRemoveLine(c, CHAT_SIZE_MARKER),
  },
  {
    id: "chatHistoryFamily",
    section: "Chat Panel",
    label: "Font family",
    key: "chatHistoryFontFamily",
    kind: "family",
    file: "webview/index.css",
    showInPanel: false,
    max: 0,
    defaultRaw: "",
    effective: (raw) =>
      typeof raw === "string" && raw.trim() ? raw.trim() : undefined,
    present: (c) => CHAT_MD_HASH_RE.test(c),
    current: (c) => c.match(CHAT_FAMILY_VAL_RE)?.[1],
    apply: (c, v) => {
      const sel = chatContentSelector(c);
      const md = c.match(CHAT_MD_HASH_RE)?.[1];
      if (!sel || !md) return c; // markdown anchor gone: leave native
      return cssApplyLine(
        c,
        CHAT_FAMILY_MARKER,
        `${CHAT_FAMILY_MARKER}:root{--vscode-chat-font-family:var(--vscode-font-family) !important}` +
          `${sel}{font-family:${v} !important}` +
          `.root_${md} code,.root_${md} pre{font-family:var(--app-monospace-font-family) !important}`,
      );
    },
    remove: (c) => cssRemoveLine(c, CHAT_FAMILY_MARKER),
  },
  {
    id: "planFamily",
    section: "Plan Preview",
    label: "Font family",
    key: "planPreviewFontFamily",
    kind: "family",
    file: "extension.js",
    showInPanel: false,
    max: 0,
    defaultRaw: "",
    effective: (raw) =>
      typeof raw === "string" && raw.trim() ? raw.trim() : undefined,
    present: (c) => PLAN_FAMILY_RE.test(c),
    current: (c) => {
      const m = c.match(PLAN_FAMILY_RE);
      if (!m) return undefined;
      return m[2] === PLAN_FAMILY_STOCK ? undefined : m[2];
    },
    apply: (c, v) =>
      c.replace(PLAN_FAMILY_RE, (_w, p, _v, s) => `${p}${v}${s}`),
    remove: (c) =>
      c.replace(
        PLAN_FAMILY_RE,
        (_w, p, _v, s) => `${p}${PLAN_FAMILY_STOCK}${s}`,
      ),
  },
  {
    id: "planCommentRows",
    section: "Plan Preview",
    label: "Comment rows",
    key: "planPreviewCommentInputRows",
    kind: "rows",
    file: "extension.js",
    showInPanel: false,
    max: 0,
    defaultRaw: 0,
    effective: (raw) =>
      typeof raw === "number" && raw >= 1
        ? Math.min(40, Math.round(raw))
        : undefined,
    present: (c) => PLAN_ROWS_RE.test(c),
    current: (c) => {
      const m = c.match(PLAN_ROWS_READ_RE);
      return m ? Number(m[1]) : undefined;
    },
    apply: (c, v) =>
      c.replace(PLAN_ROWS_RE, (_w, p, s) => `${p} rows="${v}"${s}`),
    remove: (c) => c.replace(PLAN_ROWS_RE, (_w, p, s) => `${p}${s}`),
  },
  {
    id: "chatCodeInline",
    section: "Chat Panel",
    label: "Inline code",
    key: "chatCodeInlineFontSize",
    kind: "size",
    file: "webview/index.css",
    showInPanel: true,
    max: 24,
    defaultRaw: 0,
    effective: (raw) =>
      typeof raw === "number" && raw > 0 ? clampSizePx(raw) : undefined,
    inheritFrom: "chatCode",
    present: (c) => CHAT_MD_HASH_RE.test(c),
    current: (c) => {
      const m = c.match(CHAT_CODE_INLINE_PX_RE);
      return m ? Number(m[1]) : undefined;
    },
    apply: (c, v) => {
      const hash = c.match(CHAT_MD_HASH_RE)?.[1];
      if (!hash) return c; // markdown anchor gone: leave native
      return cssApplyLine(
        c,
        CHAT_CODE_INLINE_MARKER,
        `${CHAT_CODE_INLINE_MARKER}.root_${hash} :not(pre) > code{font-size:${v}px !important}`,
      );
    },
    remove: (c) => cssRemoveLine(c, CHAT_CODE_INLINE_MARKER),
  },
  {
    id: "planCodeInline",
    section: "Plan Preview",
    label: "Inline code",
    key: "planPreviewCodeInlineFontSize",
    kind: "size",
    file: "extension.js",
    showInPanel: true,
    max: 24,
    defaultRaw: 0,
    effective: (raw) =>
      typeof raw === "number" && raw > 0 ? clampSizePx(raw) : undefined,
    inheritFrom: "code",
    present: (c) => PLAN_CODE_RULE_RE.test(c),
    current: (c) => {
      const m = c.match(PLAN_CODE_INLINE_PX_RE);
      return m ? Number(m[1]) : undefined;
    },
    apply: (c, v) => planInjectCodeInline(c, v),
    remove: (c) => planRemoveCodeInline(c),
  },
  {
    id: "showMoreAlign",
    section: "Chat Panel",
    label: "Show more/less align",
    key: "chatShowMoreAndLessAlign",
    kind: "align",
    file: "webview/index.css",
    showInPanel: false,
    max: 0,
    defaultRaw: "",
    effective: (raw) => (raw === "left" || raw === "right" ? raw : undefined),
    present: (c) => SHOW_MORE_HASH_RE.test(c),
    current: (c) => {
      const line = cssMarkedLine(c, SHOW_MORE_MARKER);
      if (line === undefined) return undefined; // native (no rule)
      // A pre-fix rule (no absolute "Show more" block) reads as native so the
      // drift gate re-applies the current form on upgrade.
      if (!line.includes("position:absolute")) return undefined;
      return line.includes("margin-left:auto") ? "right" : "left";
    },
    apply: (c, v) => {
      const hash = c.match(SHOW_MORE_HASH_RE)?.[1];
      if (!hash) return c; // anchor gone: leave native
      // "Show more" stays position:absolute so it keeps overlaying the content
      // and never adds height (the source of the old hover jitter); only its
      // horizontal anchor flips. "Show less" is already in flow, so an auto
      // margin on the opposite side pins it without changing its slot.
      const expand =
        v === "right"
          ? "position:absolute !important;left:auto !important;right:0 !important"
          : "position:absolute !important;right:auto !important;left:0 !important";
      const collapse =
        v === "right"
          ? "position:static !important;margin-left:auto !important"
          : "position:static !important;margin-right:auto !important";
      return cssApplyLine(
        c,
        SHOW_MORE_MARKER,
        `${SHOW_MORE_MARKER}.expandButton_${hash}{${expand}}.collapseButton_${hash}{${collapse}}`,
      );
    },
    remove: (c) => cssRemoveLine(c, SHOW_MORE_MARKER),
  },
];

function readInject(ip: InjectPoint): InjectValue | undefined {
  const raw = vscode.workspace
    .getConfiguration(CONFIG_NS)
    .get<InjectValue>(ip.key, ip.defaultRaw);
  return ip.effective(raw);
}

function injectByFile(): Map<string, InjectPoint[]> {
  const m = new Map<string, InjectPoint[]>();
  for (const ip of INJECT_POINTS) {
    (m.get(ip.file) ?? m.set(ip.file, []).get(ip.file)!).push(ip);
  }
  return m;
}

function injectEq(
  a: InjectValue | undefined,
  b: InjectValue | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return String(a) === String(b);
}

// The value a point currently has on disk ("off" when native), for pending-reload
// and activation-floor tracking. undefined when the anchor is absent.
function injectStateStr(
  content: string | undefined,
  ip: InjectPoint,
): string | undefined {
  if (content === undefined || !ip.present(content)) return undefined;
  const cur = ip.current(content);
  return cur === undefined ? "off" : String(cur);
}

// Map an activation-floor string (from injectStateStr) back to a config value.
function injectFloorToRaw(
  ip: InjectPoint,
  floor: string | undefined,
): InjectValue {
  if (floor === undefined || floor === "off") return ip.defaultRaw;
  return ip.kind === "family" || ip.kind === "align" ? floor : Number(floor);
}

export type SizeMap = Record<string, number>;

export function readSizes(): SizeMap {
  const c = vscode.workspace.getConfiguration(CONFIG_NS);
  const m: SizeMap = {};
  for (const p of PATCH_POINTS)
    m[p.id] = Number(formatPx(c.get<number>(p.key, p.defaultPx)));
  return m;
}

export function formatPx(n: number): string {
  const clamped = Math.min(
    MAX_PX,
    Math.max(MIN_PX, Number.isFinite(n) ? n : 14),
  );
  return String(Math.round(clamped * 100) / 100);
}

// Native (chat.fontSize) is the user's own VS Code setting, so it is not bound
// by the patch clamp (MAX_PX). Round to 2dp and clamp to [MIN_PX, 100].
export function formatNativePx(n: number): string {
  const clamped = Math.min(100, Math.max(MIN_PX, Number.isFinite(n) ? n : 13));
  return String(Math.round(clamped * 100) / 100);
}

// --- per-point primitives (dispatch to custom fns or the value-slot model) ---

function pointPresent(content: string, p: PatchPoint): boolean {
  return p.fnPresent
    ? p.fnPresent(content)
    : p.res!.some((re) => re.test(content));
}

// px string if a fixed size is in place, or undefined for the stock/native form.
function pointCurrentPx(content: string, p: PatchPoint): string | undefined {
  if (p.fnCurrentPx) return p.fnCurrentPx(content);
  for (const re of p.res!) {
    const m = content.match(re);
    if (!m) continue;
    if (p.style === "number") return m[2];
    return /^\d/.test(m[2]) ? m[2].replace("px", "") : undefined; // value style
  }
  return undefined;
}

function pointSet(content: string, p: PatchPoint, px: string): string {
  if (p.fnApply) return p.fnApply(content, px);
  const value = p.style === "number" ? px : `${px}px`;
  let out = content;
  for (const re of p.res!) {
    out = out.replace(re, (_w, prefix, _v, suffix) => prefix + value + suffix);
  }
  return out;
}

function pointRestore(
  content: string,
  p: PatchPoint,
  stockValue: string,
): string {
  if (p.fnRestore) return p.fnRestore(content);
  let out = content;
  for (const re of p.res!) {
    out = out.replace(
      re,
      (_w, prefix, _v, suffix) => prefix + stockValue + suffix,
    );
  }
  return out;
}

// --- stock-capture helpers ---

// The effective stock px for a point: parsed from the captured value if
// available, else the hardcoded originalPx fallback.
function stockNumberFor(p: PatchPoint, capture: StockCapture): number {
  const c = capture[p.id];
  if (!c) return p.originalPx;
  if (p.style === "number") return parseFloat(c);
  const m = c.match(/(\d+(?:\.\d+)?)px/);
  return m ? parseFloat(m[1]) : p.originalPx;
}

// The effective stock value string for restore: the captured value if
// available, else the hardcoded fallback (bare number or originalValue var).
function stockValueFor(p: PatchPoint, capture: StockCapture): string {
  const c = capture[p.id];
  if (c) return c;
  return p.style === "number" ? `${p.originalPx}` : p.originalValue!;
}

// Read the real native stock values from the bundle. Value-style points are
// captured whenever they are at stock (var() present — reliably detected).
// Number-style points are captured only when force=true (fresh bundle after a
// version change), because a bare number can't be distinguished from a
// previously patched value.
function captureStockValues(ext: ClaudeExt, force: boolean): StockCapture {
  const captured: StockCapture = {};
  const cache = new Map<string, string | undefined>();
  const read = (rel: string) => {
    if (!cache.has(rel)) cache.set(rel, readFileSafe(ext, rel));
    return cache.get(rel);
  };
  for (const p of PATCH_POINTS) {
    if (!p.style || !p.res) continue;
    const content = read(p.file);
    if (!content || !pointPresent(content, p)) continue;

    if (p.style === "value") {
      if (pointCurrentPx(content, p) === undefined) {
        for (const re of p.res) {
          const m = content.match(re);
          if (m) {
            captured[p.id] = m[2];
            break;
          }
        }
      }
    } else if (force) {
      for (const re of p.res) {
        const m = content.match(re);
        if (m) {
          captured[p.id] = m[2];
          break;
        }
      }
    }
  }
  return captured;
}

export interface ClaudeExt {
  dir: string;
  version: string;
}

function filePath(ext: ClaudeExt, rel: string): string {
  return path.join(ext.dir, rel);
}

// Universal across every VS Code-based IDE host: this extension's OWN install
// directory (context.extensionUri) is ALWAYS inside that host's real, currently
// active extensions folder — whichever IDE is running it (VS Code, Antigravity
// IDE, Cursor, Windsurf, Trae, VSCodium, ...) — so its parent directory is
// always the correct, live extensions root for THIS session, with zero
// hardcoding. This is listed first and is the one that matters in practice.
//
// A real incident proved why the hardcoded fallback list alone is NOT
// sufficient on its own, and why it must stay in sync with what host is
// actually running: diagnosing a "patch not applying" report kept checking
// plain VS Code's `~/.vscode/extensions` (and `%APPDATA%/Code/User/
// settings.json`) while the user was running Antigravity IDE the whole time —
// a completely different, unrelated install whose real extensions folder is
// `~/.antigravity-ide/extensions` (Windows) and whose settings live under
// `%APPDATA%/Antigravity IDE/User/`. `context.extensionUri` alone already
// resolves correctly regardless of host; the fallbacks below exist ONLY for a
// defensive secondary scan (e.g. Claude Code installed under a DIFFERENT
// IDE-family folder than the one this extension itself is running under) and
// are kept as a best-effort list of every known VS Code-family fork's
// extensions folder name — never assume the list is exhaustive; a genuinely
// new fork adds its own folder name here when discovered.
function extensionsDirs(context: vscode.ExtensionContext): string[] {
  const dirs = new Set<string>();
  dirs.add(path.dirname(context.extensionUri.fsPath));
  const home = os.homedir();
  const KNOWN_FORK_DIRS = [
    ".vscode",
    ".vscode-insiders",
    ".vscode-oss",
    ".antigravity-ide", // Antigravity IDE (Google) — confirmed real folder name
    ".antigravity", // an older/alternate Antigravity IDE profile also seen in the wild
    ".cursor", // Cursor
    ".windsurf", // Windsurf (Codeium)
    ".trae", // Trae
    ".vscodium", // VSCodium
  ];
  for (const name of KNOWN_FORK_DIRS) {
    dirs.add(path.join(home, name, "extensions"));
  }
  return [...dirs].filter((d) => fs.existsSync(d));
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function findLatestClaudeExt(
  context: vscode.ExtensionContext,
): ClaudeExt | undefined {
  const verRe = /^anthropic\.claude-code-(\d+(?:\.\d+)*)/;
  let best: ClaudeExt | undefined;
  for (const base of extensionsDirs(context)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith(EXT_PREFIX)) continue;
      const m = name.match(verRe);
      if (!m) continue;
      const dir = path.join(base, name);
      if (!fs.existsSync(path.join(dir, MARKER_FILE))) continue;
      if (!best || compareVersions(m[1], best.version) > 0) {
        best = { dir, version: m[1] };
      }
    }
  }
  return best;
}

export type PointState =
  | {
      id: string;
      label: string;
      section: Section;
      status: "current";
      px: string;
    }
  | {
      id: string;
      label: string;
      section: Section;
      status: "stock" | "custom";
      px: string;
      want: string;
    }
  | { id: string; label: string; section: Section; status: "missing" };

function readFileSafe(ext: ClaudeExt, rel: string): string | undefined {
  try {
    return fs.readFileSync(filePath(ext, rel), "utf8");
  } catch {
    return undefined;
  }
}

export function analyze(
  ext: ClaudeExt,
  sizes: SizeMap,
  capture: StockCapture,
): PointState[] {
  const cache = new Map<string, string | undefined>();
  const read = (rel: string) => {
    if (!cache.has(rel)) cache.set(rel, readFileSafe(ext, rel));
    return cache.get(rel);
  };
  return PATCH_POINTS.map((p): PointState => {
    const base = { id: p.id, label: p.label, section: p.section };
    const content = read(p.file);
    if (content === undefined || !pointPresent(content, p)) {
      return { ...base, status: "missing" };
    }
    const stockNum = stockNumberFor(p, capture);
    const want = formatPx(sizes[p.id]);
    const stockWant = want === formatPx(stockNum);
    const cur = pointCurrentPx(content, p);
    const isStock =
      p.style === "number" ? cur === formatPx(stockNum) : cur === undefined;

    if (stockWant && isStock)
      return { ...base, status: "current", px: `${stockNum}` };
    if (!stockWant && cur === want)
      return { ...base, status: "current", px: cur };
    if (isStock) return { ...base, status: "stock", px: `${stockNum}`, want };
    return { ...base, status: "custom", px: cur ?? `${stockNum}`, want };
  });
}

export type ToggleStatus = "current" | "stock" | "custom" | "missing";
export interface ToggleState {
  id: string;
  label: string;
  section: Section;
  status: ToggleStatus;
  wantOn: boolean; // the setting value (what the panel shows and apply targets)
}

// Same shape as analyze() but for on/off points: "stock" = bundle at native and
// the setting wants it flipped; "custom" = bundle flipped the other way from the
// setting (e.g. a leftover patch the setting no longer wants).
export function analyzeToggles(
  ext: ClaudeExt,
  toggles: ToggleMap,
): ToggleState[] {
  const cache = new Map<string, string | undefined>();
  const read = (rel: string) => {
    if (!cache.has(rel)) cache.set(rel, readFileSafe(ext, rel));
    return cache.get(rel);
  };
  return TOGGLE_POINTS.map((t): ToggleState => {
    const base = { id: t.id, label: t.label, section: t.section };
    const wantOn = toggles[t.id];
    const cur = toggleStateStr(read, t);
    if (cur === undefined) return { ...base, status: "missing", wantOn };
    if (cur === toggleWantStr(t, wantOn))
      return { ...base, status: "current", wantOn };
    if (cur === toggleWantStr(t, t.defaultOn))
      return { ...base, status: "stock", wantOn };
    return { ...base, status: "custom", wantOn };
  });
}

export type InjectStatus = "current" | "stock" | "custom" | "missing";
export interface InjectState {
  id: string;
  label: string;
  section: Section;
  status: InjectStatus;
  value: InjectValue | undefined; // the setting value (undefined = off)
}

// Same shape as analyze()/analyzeToggles() for the string/size/rows injections:
// "stock" = bundle native and the setting wants an injection; "custom" = the
// bundle carries an injection differing from the setting (leftover or drifted).
export function analyzeInjects(ext: ClaudeExt): InjectState[] {
  const cache = new Map<string, string | undefined>();
  const read = (rel: string) => {
    if (!cache.has(rel)) cache.set(rel, readFileSafe(ext, rel));
    return cache.get(rel);
  };
  return INJECT_POINTS.map((ip): InjectState => {
    const base = { id: ip.id, label: ip.label, section: ip.section };
    const want = readInject(ip);
    const content = read(ip.file);
    if (content === undefined || !ip.present(content)) {
      return { ...base, status: "missing", value: want };
    }
    const cur = ip.current(content);
    if (injectEq(cur, want)) return { ...base, status: "current", value: want };
    if (cur === undefined) return { ...base, status: "stock", value: want };
    return { ...base, status: "custom", value: want };
  });
}

export interface PatchReport {
  version: string;
  changed: string[]; // human-readable summaries of the edits actually written
  // Files whose computed changes could NOT be written (e.g. writeFileAtomic
  // exhausted its retries on a persistent lock) — every OTHER file in this
  // same applyPatch() call still gets its own write attempt regardless (see
  // the per-file try/catch in the main loop below), so a lock on one file
  // never blocks the rest of the batch. Empty on a fully successful apply.
  failed: { file: string; error: string }[];
}

function byFile(): Map<string, PatchPoint[]> {
  const m = new Map<string, PatchPoint[]>();
  for (const p of PATCH_POINTS) {
    (m.get(p.file) ?? m.set(p.file, []).get(p.file)!).push(p);
  }
  return m;
}

// Write atomically: stage to a unique temp file in the same directory, then
// rename over the target. rename(2) is atomic on POSIX, and on Windows Node
// maps it to MoveFileEx with replace, so a concurrent reader (another window's
// apply, or Claude Code loading the bundle) never observes a half-written file.
// The temp name is per-process + counter so parallel writers never collide.
//
// RETRY ON TRANSIENT WINDOWS LOCK ERRORS: a real incident — `rename()` failed
// with `EPERM: operation not permitted` right after Claude Code updated to a
// fresh version, because something briefly held extension.js open (Windows
// Defender scanning a newly-extracted extension, VS Code's own extension host
// still finishing its read, an indexer, etc.). This is almost always transient
// (gone within milliseconds), so a bare single-attempt throw turned a
// millisecond-scale lock into a hard failure that aborted the WHOLE applyPatch
// loop (see below) — a genuinely PARTIAL apply where files processed before the
// failing one stayed patched but everything after it silently never was.
// EPERM/EBUSY/EACCES on the rename step are retried with a short backoff before
// giving up; any other error (e.g. a genuine permissions problem, disk full)
// still throws immediately, unretried.
const RETRYABLE_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
function sleepSync(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}
function writeFileAtomic(abs: string, data: string): void {
  const tmp = `${abs}.${process.pid}.${atomicWriteCounter++}.tmp`;
  const MAX_ATTEMPTS = 5;
  try {
    fs.writeFileSync(tmp, data, "utf8");
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        fs.renameSync(tmp, abs);
        return; // success
      } catch (err) {
        lastErr = err;
        const code = (err as NodeJS.ErrnoException).code;
        if (!code || !RETRYABLE_CODES.has(code) || attempt === MAX_ATTEMPTS) {
          throw err;
        }
        sleepSync(Math.min(50 * attempt, 250)); // 50, 100, 150, 200ms backoff
      }
    }
    throw lastErr;
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // best effort: nothing to clean up if the temp was never created
    }
    throw err;
  }
}
let atomicWriteCounter = 0;

// Reconcile each patch point to its wanted size: a non-stock want is written as
// a fixed px; a stock want restores the point to its native form. A point is
// only reported (and its file only rewritten) when the transform actually
// changes the content, so a no-op (already at target, or an anchor whose form
// changed so the transform can't apply) never produces a spurious "changed".
export function applyPatch(
  ext: ClaudeExt,
  sizes: SizeMap,
  toggles: ToggleMap,
  capture: StockCapture,
): PatchReport {
  const changed: string[] = [];
  const failed: { file: string; error: string }[] = [];
  const pointsByFile = byFile();
  const togglesByFile = toggleByFile();
  const injectsByFile = injectByFile();
  const files = allPatchedFiles();
  for (const file of files) {
    const abs = filePath(ext, file);
    let content: string;
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    let out = content;
    for (const p of pointsByFile.get(file) ?? []) {
      if (!pointPresent(out, p)) continue;
      const want = formatPx(sizes[p.id]);
      const stockWant = want === formatPx(stockNumberFor(p, capture));
      const cur = pointCurrentPx(out, p);
      const next = stockWant
        ? pointRestore(out, p, stockValueFor(p, capture))
        : pointSet(out, p, want);
      if (next !== out) {
        out = next;
        changed.push(
          stockWant
            ? `${p.label} ${cur}px→stock`
            : `${p.label} ${cur ?? "stock"}→${want}px`,
        );
      }
    }
    for (const ip of injectsByFile.get(file) ?? []) {
      if (!ip.present(out)) continue;
      const want = readInject(ip);
      const cur = ip.current(out);
      const next = want === undefined ? ip.remove(out) : ip.apply(out, want);
      if (next !== out) {
        out = next;
        changed.push(
          want === undefined
            ? `${ip.label} ${cur}→native`
            : `${ip.label} ${cur ?? "native"}→${want}`,
        );
      }
    }
    for (const t of togglesByFile.get(file) ?? []) {
      if (!togglePresent(out, t)) continue;
      const wantOn = toggles[t.id];
      const cur = toggleCurrentOn(out, t);
      const next = toggleSet(out, t, wantOn);
      if (next !== out) {
        out = next;
        changed.push(
          `${t.label} ${cur ? "on" : "off"}→${wantOn ? "on" : "off"}`,
        );
      }
    }
    for (const t of TOGGLE_POINTS) {
      if (t.cssFile !== file || !t.cssMarker || !t.cssBuild) continue;
      const wantOn = toggles[t.id];
      const rule = wantOn ? t.cssBuild(out) : undefined;
      const next = rule
        ? cssApplyLine(out, t.cssMarker, rule)
        : cssRemoveLine(out, t.cssMarker);
      if (next !== out) {
        out = next;
        changed.push(`${t.label} gutter ${wantOn ? "clean" : "native"}`);
      }
    }
    if (out !== content) {
      // A per-file try/catch so a write failure on ONE file (e.g. a persistent
      // Windows lock that outlasts writeFileAtomic's own retries) never aborts
      // the loop and skips every OTHER file's already-computed changes — the
      // exact mechanism behind a real "chala apply" (partial-apply) incident,
      // where extension.js's EPERM aborted the whole batch and left
      // webview/index.css and webview/index.js unpatched even though their
      // content changes had already been computed and were ready to write.
      try {
        writeFileAtomic(abs, out);
      } catch (err) {
        failed.push({ file, error: (err as Error).message });
      }
    }
  }
  return { version: ext.version, changed, failed };
}

// Every file any point, toggle (including a toggle's CSS side-effect), or
// injection touches.
function allPatchedFiles(): Set<string> {
  const files = new Set<string>();
  for (const p of PATCH_POINTS) files.add(p.file);
  for (const t of TOGGLE_POINTS) {
    files.add(t.file);
    if (t.cssFile) files.add(t.cssFile);
  }
  for (const ip of INJECT_POINTS) files.add(ip.file);
  return files;
}

export function restorePatch(
  ext: ClaudeExt,
  capture: StockCapture,
): PatchReport {
  const changed: string[] = [];
  const failed: { file: string; error: string }[] = [];
  const pointsByFile = byFile();
  const togglesByFile = toggleByFile();
  const injectsByFile = injectByFile();
  const files = allPatchedFiles();
  for (const file of files) {
    const abs = filePath(ext, file);
    let content: string;
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    let out = content;
    for (const p of pointsByFile.get(file) ?? []) {
      if (!pointPresent(out, p)) continue;
      const next = pointRestore(out, p, stockValueFor(p, capture));
      if (next !== out) {
        out = next;
        changed.push(`${p.label} restored`);
      }
    }
    for (const ip of injectsByFile.get(file) ?? []) {
      if (!ip.present(out)) continue;
      const next = ip.remove(out);
      if (next !== out) {
        out = next;
        changed.push(`${ip.label} restored`);
      }
    }
    for (const t of togglesByFile.get(file) ?? []) {
      if (!togglePresent(out, t)) continue;
      const next = toggleSet(out, t, t.defaultOn);
      if (next !== out) {
        out = next;
        changed.push(`${t.label} restored`);
      }
    }
    for (const t of TOGGLE_POINTS) {
      if (t.cssFile !== file || !t.cssMarker) continue;
      const next = cssRemoveLine(out, t.cssMarker);
      if (next !== out) {
        out = next;
        changed.push(`${t.label} gutter restored`);
      }
    }
    if (out !== content) {
      try {
        writeFileAtomic(abs, out);
      } catch (err) {
        failed.push({ file, error: (err as Error).message });
      }
    }
  }
  return { version: ext.version, changed, failed };
}

// Cheap, cached view for the hover popup.
export interface Knob {
  id: string;
  section: Section;
  label: string;
  kind: "size" | "toggle";
  px: string; // size knobs: current px; toggle knobs: unused ("")
  on: boolean; // toggle knobs: current on/off; size knobs: unused (false)
  max: number; // upper clamp for the panel's ▲/▼ controls (size knobs)
  native: boolean;
  state: "current" | "stock" | "custom" | "missing";
  pendingReload: boolean; // this row's bundle was written but window not reloaded
  nativeKey?: string;
}

export interface FeatureState {
  id: string;
  label: string;
  on: boolean; // current smartsClaudeManager.feature.<id> setting value
}

export interface Snapshot {
  available: boolean;
  supported: boolean; // at least one patch anchor present
  version: string; // installed Claude Code extension's version
  extVersion: string; // this extension's OWN version (context.extension.packageJSON.version — never hardcoded)
  knobs: Knob[]; // native chat + present patch knobs, in section order
  features: FeatureState[]; // the 16 chat-enhancement feature seed settings
  applied: boolean;
  actionable: boolean;
  needsReload: boolean; // bundle written this session but window not reloaded
  patchEnabled: boolean; // smartsClaudeManager.patchEnabled — false after "Fully Disable Patch"
}

export class Patcher {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  private ext: ClaudeExt | undefined;
  private states: PointState[] = [];
  private toggleStates: ToggleState[] = [];
  private injectStates: InjectState[] = [];
  private stockCapture: StockCapture = {};
  private pendingReload = new Set<string>(); // point IDs written but not reloaded
  private activationPx = new Map<string, string | undefined>(); // on-disk px at activation
  // Set while restore()/enable() itself is writing patchEnabled, so the
  // onDidChangeConfiguration listener (which mirrors an EXTERNAL Settings UI/
  // JSON edit of patchEnabled by calling restore()/enable() in turn) doesn't
  // recurse into a second restore()/enable() for our own write.
  private writingPatchEnabled = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.refresh();
    // Re-apply the saved sizes when the on-disk bundle has drifted from the
    // settings (e.g. a fresh install of this extension whose settings.json
    // already carries non-default smartsClaudeManager.* values — synced from
    // another machine, restored from a profile, or hand-edited before the
    // extension ever ran — or a Claude Code update reverting a previously
    // applied patch). This is a no-op on a genuinely fresh install: every
    // setting defaults to Claude Code's native value, so nothing is "drifted"
    // and the bundle is left untouched. Gated on patchEnabled so a bundle the
    // user explicitly reverted via the panel's Enable/Disable toggle (which
    // flips patchEnabled to false) is never silently re-patched on the next
    // activation. deactivate() is a pure no-op (see extension.ts) — it never
    // reverts the patch itself, so this constructor's own drift-check is the
    // ONLY place a patch is ever (re-)applied, keeping activation the single
    // source of truth for "is the bundle currently correct."
    const enabled = vscode.workspace
      .getConfiguration(CONFIG_NS)
      .get<boolean>("patchEnabled", true);
    const drifted = (s: { status: string }) =>
      s.status === "stock" || s.status === "custom";
    if (
      enabled &&
      this.ext &&
      (this.states.some(drifted) ||
        this.toggleStates.some(drifted) ||
        this.injectStates.some(drifted))
    ) {
      // Apply now AND auto-reload the window if real edits were written, so a
      // fresh install (or a Claude-Code-update-reverted patch) takes effect on
      // first load without a manual Disable/Enable or manual reload.
      void this.applyOnActivation();
    }
  }

  register(): vscode.Disposable[] {
    const patchKeys = [
      ...PATCH_POINTS.map((p) => p.key),
      ...TOGGLE_POINTS.map((t) => t.key),
      ...INJECT_POINTS.map((ip) => ip.key),
      ...featureIds().map((f) => `feature.${f.id}`),
    ].map((k) => `${CONFIG_NS}.${k}`);
    const patchEnabledKey = `${CONFIG_NS}.patchEnabled`;
    // chat.fontSize is no longer a knob, but the chatHistoryFontSize knob shows it
    // while inheriting, so a native change should refresh (not re-patch) the view.
    const nativeKeys = NATIVE_KNOBS.map((k) => k.vscodeKey);
    return [
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(patchEnabledKey)) {
          if (this.writingPatchEnabled) return; // our own restore()/enable() write
          // Someone flipped smartsClaudeManager.patchEnabled directly in
          // Settings UI/JSON rather than via the panel button — mirror the
          // panel's own enable()/restore() so the two entry points agree.
          const enabled = vscode.workspace
            .getConfiguration(CONFIG_NS)
            .get<boolean>("patchEnabled", true);
          if (enabled) void this.enable();
          else void this.restore();
        } else if (patchKeys.some((k) => e.affectsConfiguration(k))) {
          this.autoApply();
        } else if (nativeKeys.some((k) => e.affectsConfiguration(k))) {
          this.refresh();
        }
      }),
      this.emitter,
    ];
  }

  snapshot(): Snapshot | undefined {
    if (!this.ext) return undefined;
    const sizes = readSizes();
    const toggles = readToggles();
    const statusById = new Map(this.states.map((s) => [s.id, s.status]));
    const toggleStatusById = new Map(
      this.toggleStates.map((s) => [s.id, s.status]),
    );
    const injectStatusById = new Map(
      this.injectStates.map((s) => [s.id, s.status]),
    );
    // The chat text size knob (formerly the native chat.fontSize knob) is now the
    // chatHistoryFontSize injection: it shows the effective size (its own value, or
    // the inherited chat.fontSize when unset) and adjusting it takes control.
    const chat: Knob[] = INJECT_POINTS.filter(
      (ip) => ip.showInPanel && injectStatusById.get(ip.id) !== "missing",
    ).map((ip) => {
      const eff = readInject(ip);
      return {
        id: ip.id,
        section: ip.section,
        label: ip.label,
        kind: "size" as const,
        px: formatNativePx(
          typeof eff === "number"
            ? eff
            : ip.inheritFrom
              ? sizes[ip.inheritFrom]
              : nativeChatFontSizePx(),
        ),
        on: false,
        max: ip.max,
        native: false,
        state:
          (injectStatusById.get(ip.id) as "current" | "stock" | "custom") ??
          "stock",
        pendingReload: this.pendingReload.has(ip.id),
      };
    });
    const patch: Knob[] = PATCH_POINTS.filter(
      (p) => statusById.get(p.id) !== "missing",
    ).map((p) => ({
      id: p.id,
      section: p.section,
      label: p.label,
      kind: "size" as const,
      px: formatPx(sizes[p.id]),
      on: false,
      max: p.maxPx,
      native: false,
      state:
        (statusById.get(p.id) as "current" | "stock" | "custom") ?? "stock",
      pendingReload: this.pendingReload.has(p.id),
    }));
    const toggleKnobs: Knob[] = TOGGLE_POINTS.filter(
      (t) => toggleStatusById.get(t.id) !== "missing" && !ALWAYS_ON_TOGGLES.has(t.id),
    ).map((t) => ({
      id: t.id,
      section: t.section,
      label: t.label,
      kind: "toggle" as const,
      px: "",
      on: toggles[t.id],
      max: 0,
      native: false,
      state:
        (toggleStatusById.get(t.id) as "current" | "stock" | "custom") ??
        "stock",
      pendingReload: this.pendingReload.has(t.id),
    }));
    const presentSizes = this.states.filter((s) => s.status !== "missing");
    const presentToggles = this.toggleStates.filter(
      (s) => s.status !== "missing",
    );
    const presentInjects = this.injectStates.filter(
      (s) => s.status !== "missing",
    );
    const anyPresent =
      presentSizes.length + presentToggles.length + presentInjects.length > 0;
    const allCurrent =
      presentSizes.every((s) => s.status === "current") &&
      presentToggles.every((s) => s.status === "current") &&
      presentInjects.every((s) => s.status === "current");
    const featureCfg = vscode.workspace.getConfiguration(CONFIG_NS);
    const features: FeatureState[] = featureIds().map((f) => ({
      id: f.id,
      label: f.label,
      on: featureCfg.get<boolean>(`feature.${f.id}`, true),
    }));
    return {
      available: true,
      supported: anyPresent,
      version: this.ext.version,
      extVersion: this.context.extension.packageJSON.version as string,
      knobs: [...chat, ...patch, ...toggleKnobs].sort(
        (a, b) => knobOrder(a.id) - knobOrder(b.id),
      ),
      features,
      applied: anyPresent && allCurrent,
      actionable: !allCurrent,
      needsReload: this.pendingReload.size > 0,
      patchEnabled: featureCfg.get<boolean>("patchEnabled", true),
    };
  }

  private refresh(): void {
    this.ext = findLatestClaudeExt(this.context);
    if (this.ext) {
      this.refreshStockCapture(this.ext);
      this.states = analyze(this.ext, readSizes(), this.stockCapture);
      this.toggleStates = analyzeToggles(this.ext, readToggles());
      this.injectStates = analyzeInjects(this.ext);
      if (this.activationPx.size === 0) this.captureActivationPx();
    } else {
      this.states = [];
      this.toggleStates = [];
      this.injectStates = [];
    }
    this.emitter.fire();
  }

  private captureActivationPx(): void {
    if (!this.ext) return;
    const cache = new Map<string, string | undefined>();
    const read = (rel: string) => {
      if (!cache.has(rel)) cache.set(rel, readFileSafe(this.ext!, rel));
      return cache.get(rel);
    };
    for (const p of PATCH_POINTS) {
      const content = read(p.file);
      this.activationPx.set(
        p.id,
        content ? pointCurrentPx(content, p) : undefined,
      );
    }
    for (const t of TOGGLE_POINTS) {
      this.activationPx.set(t.id, toggleStateStr(read, t));
    }
    for (const ip of INJECT_POINTS) {
      this.activationPx.set(ip.id, injectStateStr(read(ip.file), ip));
    }
  }

  // Auto-apply: any patch setting change writes to the bundle immediately.
  // After writing, reconcile pendingReload in a single pass, then refresh once.
  // Skipped entirely while patchEnabled is false (set by "Fully Disable Patch"
  // or by deactivate()'s uninstall/disable teardown — see writeDisabledFlag()):
  // without this guard a setting change (or the constructor's own drift-check
  // on the NEXT activation) would silently re-patch a bundle the user, or the
  // uninstall path, explicitly reverted and marked disabled.
  //
  // Returns the number of bundle edits actually written (0 = already in sync,
  // nothing changed), so the ACTIVATION-time caller (the constructor) can decide
  // whether an automatic window reload is warranted — see applyOnActivation().
  private async autoApply(): Promise<number> {
    const enabled = vscode.workspace
      .getConfiguration(CONFIG_NS)
      .get<boolean>("patchEnabled", true);
    if (!enabled) return 0;
    // Re-resolve the install in case Claude Code updated in place since the last
    // refresh (its versioned directory changes on update, so a cached ext could
    // point at a directory that no longer exists).
    this.ext = findLatestClaudeExt(this.context);
    if (!this.ext) {
      this.refresh();
      return 0;
    }
    let changedCount = 0;
    try {
      const report = applyPatch(this.ext, readSizes(), readToggles(), this.stockCapture);
      changedCount = report.changed.length;
      if (report.failed.length) {
        // A per-file write failure (e.g. a persistent Windows lock outlasting
        // writeFileAtomic's own retries) no longer aborts the whole batch —
        // every OTHER file still got its own write attempt. Surface exactly
        // which file(s) failed rather than silently leaving a partial apply,
        // so the user knows to retry (a toggle flip / reload) instead of
        // wondering why only some of the patch took effect.
        void vscode.window.showErrorMessage(
          `Smarts Claude Manager: failed to patch ${report.failed.map((f) => f.file).join(", ")}: ${report.failed[0].error}`,
        );
      }
      this.reconcilePendingReload();
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Smarts Claude Manager: failed to patch Claude Code: ${(err as Error).message}`,
      );
    }
    this.refresh();
    return changedCount;
  }

  // Called ONCE from the constructor when patchEnabled is on and the on-disk
  // bundle has drifted from the settings (a fresh install, a Claude Code update
  // that reverted the patch, or a partial/older patch). It applies the patch
  // and, IF real edits were written (the bundle was NOT already fully applied),
  // AUTOMATICALLY reloads the window so every already-open chat webview picks up
  // the freshly-patched bundle — implementing "if patchEnabled is on, the patch
  // applies the moment the extension loads, including the very first load,
  // without a manual Disable/Enable or a manual reload".
  //
  // No reload loop: applyPatch() is idempotent (writes only on a real change),
  // so after the reload the bundle is fully applied → the next activation's
  // drift-check finds nothing drifted → applyOnActivation() is never called
  // again → no second reload. A per-window-session guard
  // (context.globalState "activationReloadedFor") is a belt-and-suspenders stop
  // against an edge case where an anchor reports drifted yet applyPatch can't
  // reach a stable fixed point (a broken/renamed anchor): it records the exact
  // (extVersion, claudeVersion, changed-summary hash) it last auto-reloaded for
  // and refuses to reload again for that identical state, so a genuinely-stuck
  // point degrades to "applied on disk, panel shows the reload button" instead
  // of a reload loop. A DIFFERENT state (a Claude Code update reverting the
  // patch → a new claudeVersion or a new drift) is a new stamp and reloads
  // correctly.
  private async applyOnActivation(): Promise<void> {
    const changed = await this.autoApply();
    if (changed <= 0 || !this.ext) return; // already in sync: nothing to reload for
    const guardKey = "smartsClaudeManager.activationReloadedFor";
    const stamp = `${this.context.extension.packageJSON.version}|${this.ext.version}|${changed}`;
    if (this.context.globalState.get<string>(guardKey) === stamp) return; // identical stuck state: don't loop
    await this.context.globalState.update(guardKey, stamp);
    void vscode.commands.executeCommand("workbench.action.reloadWindow");
  }

  private reconcilePendingReload(): void {
    if (!this.ext) return;
    const cache = new Map<string, string | undefined>();
    const read = (rel: string) => {
      if (!cache.has(rel)) cache.set(rel, readFileSafe(this.ext!, rel));
      return cache.get(rel);
    };
    const reconcile = (id: string, now: string | undefined) => {
      if (now === this.activationPx.get(id)) this.pendingReload.delete(id);
      else this.pendingReload.add(id);
    };
    for (const p of PATCH_POINTS) {
      const content = read(p.file);
      reconcile(p.id, content ? pointCurrentPx(content, p) : undefined);
    }
    for (const t of TOGGLE_POINTS) {
      reconcile(t.id, toggleStateStr(read, t));
    }
    for (const ip of INJECT_POINTS) {
      reconcile(ip.id, injectStateStr(read(ip.file), ip));
    }
  }

  // Capture the real native stock values from the bundle. Only force-capture
  // (including number-style points) when a saved version exists and genuinely
  // differs — that means a real Claude Code update laid down a fresh unpatched
  // bundle. When savedVersion is undefined (first install or reinstall after
  // globalState was cleared), the bundle may already be patched, so we only
  // capture value-style points (reliably detected as stock via var()) and fall
  // back to hardcoded originalPx for number-style points.
  private refreshStockCapture(ext: ClaudeExt): void {
    const savedVersion =
      this.context.globalState.get<string>(STOCK_VERSION_KEY);
    const savedValues = this.context.globalState.get<StockCapture>(
      STOCK_VALUES_KEY,
      {},
    );
    const realVersionChange =
      savedVersion !== undefined && savedVersion !== ext.version;

    let capture: StockCapture;
    if (realVersionChange) {
      capture = captureStockValues(ext, true);
    } else {
      capture = { ...savedValues, ...captureStockValues(ext, false) };
    }

    this.stockCapture = capture;
    void this.context.globalState.update(STOCK_VERSION_KEY, ext.version);
    void this.context.globalState.update(STOCK_VALUES_KEY, capture);
  }

  // Set an absolute size for a patch knob. The panel computes the target value
  // (accumulating rapid clicks on its own optimistic display) and sends it here,
  // so quick successive clicks can't lose increments to a read-modify-write
  // race. The setting update triggers onDidChangeConfiguration → autoApply,
  // which writes the bundle and refreshes.
  async setSize(target: string, value: number): Promise<void> {
    // The chat text size knob is an injection (chatHistoryFontSize): adjusting it
    // from the inherited display writes an absolute px, taking control from the
    // native chat.fontSize.
    const ip = INJECT_POINTS.find((x) => x.id === target && x.kind === "size");
    if (ip) {
      const next = Math.min(
        ip.max,
        Math.max(MIN_PX, Math.round(value * 100) / 100),
      );
      const cur = readInject(ip);
      if (typeof cur === "number" && cur === next) return;
      await vscode.workspace
        .getConfiguration(CONFIG_NS)
        .update(ip.key, next, vscode.ConfigurationTarget.Global);
      return;
    }
    const p = PATCH_POINTS.find((x) => x.id === target);
    if (!p) return;
    const next = Math.min(p.maxPx, Math.max(MIN_PX, Number(formatPx(value))));
    if (next === readSizes()[target]) return;
    await vscode.workspace
      .getConfiguration(CONFIG_NS)
      .update(p.key, next, vscode.ConfigurationTarget.Global);
  }

  // Set an absolute size for the native chat.fontSize knob. The config listener
  // reacts with a refresh, so no explicit refresh is needed here.
  async setNative(target: string, value: number): Promise<void> {
    const k = NATIVE_KNOBS.find((x) => x.id === target);
    if (!k) return;
    const next = Number(formatNativePx(value));
    if (next === nativePx(k)) return;
    await vscode.workspace
      .getConfiguration()
      .update(k.vscodeKey, next, vscode.ConfigurationTarget.Global);
  }

  // Flip a toggle knob. Writing the boolean setting triggers
  // onDidChangeConfiguration → autoApply, which rewrites the bundle and refreshes.
  async setToggle(target: string, on: boolean): Promise<void> {
    const t = TOGGLE_POINTS.find((x) => x.id === target);
    if (!t) return;
    if (on === readToggles()[target]) return;
    await vscode.workspace
      .getConfiguration(CONFIG_NS)
      .update(t.key, on, vscode.ConfigurationTarget.Global);
  }

  // Flip one chat-enhancement feature's smartsClaudeManager.feature.<id> setting. This
  // is a SEED value (see readFeatureDefaults()), not a patch point: writing it
  // reaches onDidChangeConfiguration -> autoApply -> chatEnhancementsSet(), which
  // re-derives the injected script with the new default map (only takes effect for
  // a webview that has not loaded yet / has no localStorage override; an
  // already-open chat's live state is instead changed via its own ⚙ gear).
  async setFeature(id: string, on: boolean): Promise<void> {
    if (!featureIds().some((f) => f.id === id)) return;
    const key = `feature.${id}`;
    const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
    if (on === cfg.get<boolean>(key, true)) return;
    await cfg.update(key, on, vscode.ConfigurationTarget.Global);
  }

  // Discard modifications made since the last window reload: reset every knob to
  // the value that was on disk at activation (the "floor" a reload establishes),
  // i.e. what the live UI currently shows. Unlike restore (which always goes to
  // native), this reverts only the not-yet-reloaded changes, so it needs no
  // reload. The config changes trigger autoApply, which rewrites the bundle to
  // the floor.
  async discard(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
    await Promise.all([
      ...PATCH_POINTS.map((p) => {
        const floor = this.activationPx.get(p.id);
        const value =
          floor !== undefined
            ? Number(floor)
            : stockNumberFor(p, this.stockCapture);
        return cfg.update(p.key, value, vscode.ConfigurationTarget.Global);
      }),
      ...TOGGLE_POINTS.filter((t) => !ALWAYS_ON_TOGGLES.has(t.id)).map((t) => {
        // floor is the full state string (e.g. "on+css" / "off+nocss"); its on/off
        // is the leading token.
        const floor = this.activationPx.get(t.id);
        const value =
          floor !== undefined ? floor.startsWith("on") : t.defaultOn;
        return cfg.update(t.key, value, vscode.ConfigurationTarget.Global);
      }),
      ...INJECT_POINTS.map((ip) =>
        cfg.update(
          ip.key,
          injectFloorToRaw(ip, this.activationPx.get(ip.id)),
          vscode.ConfigurationTarget.Global,
        ),
      ),
    ]);
    this.refresh();
  }

  // Synchronous, side-effect-free file restore for extension TEARDOWN
  // (deactivate()/uninstall/disable), where there is no time budget for the
  // async settings-reset work restore() below also does and no guarantee any
  // awaited Promise completes before the host tears the extension host down.
  // Unlike restore(), this never touches vscode.workspace configuration or
  // globalState — it only reverts the on-disk extension.js/index.css bytes via
  // the same restorePatch() the panel button calls, so Claude Code loads its
  // native, unpatched bundle the next time it starts, even if the user simply
  // uninstalled/disabled this extension instead of clicking "Fully Disable
  // Patch" first. A missing/undetected Claude Code install is a silent no-op
  // here (deactivate() has no UI to report an error through).
  //
  // Deliberately does NOT also write smartsClaudeManager.patchEnabled: false —
  // VS Code's deactivate() fires identically for an ordinary "Reload Window"
  // and for a genuine disable/uninstall, with no API to tell them apart
  // (confirmed against microsoft/vscode#110034, unresolved as of this writing).
  // Writing patchEnabled: false unconditionally here would incorrectly disable
  // the patch on every routine reload too, breaking the normal day-to-day
  // workflow. The on-disk file revert above is sufficient on its own: an
  // extension that stays uninstalled never runs autoApply()/the constructor
  // again, so Claude Code simply stays on its native, unpatched bundle
  // forever — the original bug (the patch surviving removal) either way.
  restoreFilesOnly(): void {
    if (!this.ext) return;
    try {
      restorePatch(this.ext, this.stockCapture);
    } catch {
      // best-effort during teardown — nothing more can be done here
    }
  }

  // Factory reset (the panel's red button): revert every knob to Claude Code's
  // native value. Writes the native bundle and resets the settings; the panel's
  // "Reload Window" link lights up to apply it, so no separate prompt is needed.
  // Also snapshots the current settings (so "Enable Patch" can restore them
  // instead of leaving every knob at stock) and flips patchEnabled to false, so
  // the panel's button switches to "Enable Patch".
  async restore(): Promise<void> {
    if (!this.ext) {
      void vscode.window.showErrorMessage(
        "Smarts Claude Manager: couldn't find an installed Claude Code extension.",
      );
      return;
    }
    const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
    const preDisable: PreDisableSettings = {};
    for (const p of PATCH_POINTS) preDisable[p.key] = cfg.get<number>(p.key)!;
    for (const t of TOGGLE_POINTS.filter((t) => !ALWAYS_ON_TOGGLES.has(t.id)))
      preDisable[t.key] = cfg.get<boolean>(t.key)!;
    for (const ip of INJECT_POINTS)
      preDisable[ip.key] = cfg.get(ip.key) as number | boolean | string;
    void this.context.globalState.update(PRE_DISABLE_SETTINGS_KEY, preDisable);

    try {
      restorePatch(this.ext, this.stockCapture);
      this.reconcilePendingReload();
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Smarts Claude Manager: failed to restore Claude Code v${this.ext.version}: ${(err as Error).message}`,
      );
      return;
    }
    // Reset all patch settings to their stock values so the panel/settings
    // reflect the restored native state, not the enlarged values.
    await Promise.all([
      ...PATCH_POINTS.map((p) =>
        cfg.update(p.key, p.originalPx, vscode.ConfigurationTarget.Global),
      ),
      ...TOGGLE_POINTS.filter((t) => !ALWAYS_ON_TOGGLES.has(t.id)).map((t) =>
        cfg.update(t.key, t.defaultOn, vscode.ConfigurationTarget.Global),
      ),
      ...INJECT_POINTS.map((ip) =>
        cfg.update(ip.key, ip.defaultRaw, vscode.ConfigurationTarget.Global),
      ),
      this.setPatchEnabled(false),
    ]);
    this.refresh();
  }

  // Writes patchEnabled while suppressing the onDidChangeConfiguration mirror
  // (see writingPatchEnabled) — every internal write goes through here so the
  // listener never recurses into a second restore()/enable() for our own change.
  private async setPatchEnabled(value: boolean): Promise<void> {
    this.writingPatchEnabled = true;
    try {
      await vscode.workspace
        .getConfiguration(CONFIG_NS)
        .update("patchEnabled", value, vscode.ConfigurationTarget.Global);
    } finally {
      this.writingPatchEnabled = false;
    }
  }

  // The panel's "Enable Patch" button (shown in place of "Fully Disable Patch"
  // once patchEnabled is false): restores the settings captured right before
  // the disable, flips patchEnabled back to true, and re-applies the patch —
  // autoApply() fires from the config-change listener as each restored patch
  // setting is written, so the explicit autoApply() call below covers the case
  // where none of the restored values actually differ from current (no
  // onDidChangeConfiguration event would otherwise fire to trigger a re-apply).
  async enable(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
    const preDisable = this.context.globalState.get<PreDisableSettings>(
      PRE_DISABLE_SETTINGS_KEY,
      {},
    );
    await Promise.all([
      ...Object.entries(preDisable).map(([key, value]) =>
        cfg.update(key, value, vscode.ConfigurationTarget.Global),
      ),
      this.setPatchEnabled(true),
    ]);
    await this.autoApply();
  }
}

function cmdLink(label: string, command: string, args?: unknown[]): string {
  const query = args ? "?" + encodeURIComponent(JSON.stringify(args)) : "";
  return `[${label}](command:${command}${query})`;
}

// Read-only font-size summary for the status-bar hover. Requires a trusted,
// theme-icon MarkdownString. Click the status-bar item to open the webview
// panel for interactive controls; click the gear to jump to settings.
export function tooltipLines(snap: Snapshot | undefined): string[] {
  if (!snap || !snap.available) return [];

  // Title (heading) with the version on its own plain line below it.
  const out: string[] = [
    `### Smarts Claude Manager`,
    `Claude Code v${snap.version}`,
  ];

  // Right-align the px in a monospace column. A status-bar tooltip is a
  // MarkdownString, whose text size VS Code controls (extensions can't set it);
  // the only lever is heading level, so section titles are rendered as headings
  // and the rows as a fenced (monospace) block that keeps the numbers aligned.
  // `gap` widens the label→value spacing so the popup has more horizontal room.
  const valueStr = (k: Knob) =>
    k.kind === "toggle" ? (k.on ? "on" : "off") : `${k.px}px`;
  const rows = snap.knobs;
  const labelW = rows.length ? Math.max(...rows.map((k) => k.label.length)) : 0;
  const pxW = rows.length
    ? Math.max(...rows.map((k) => valueStr(k).length))
    : 0;
  const gap = "        "; // 8 spaces

  for (const section of SECTION_ORDER) {
    const ks = snap.knobs.filter((k) => k.section === section);
    if (!ks.length) continue;
    out.push("", "---", "", `### ${section}`, "```text");
    for (const k of ks) {
      out.push(`${k.label.padEnd(labelW)}${gap}${valueStr(k).padStart(pxW)}`);
    }
    out.push("```");
  }

  out.push(
    "",
    "---",
    "",
    `${cmdLink("$(gear) Open VS Code Settings", "workbench.action.openSettings", ["smartsClaudeManager"])}  ·  ${cmdLink("$(refresh) Reload Window", "workbench.action.reloadWindow")}`,
  );

  if (!snap.supported) {
    out.push(
      "",
      `$(circle-slash) patch not supported on Claude Code v${snap.version}`,
    );
  }

  return out;
}
