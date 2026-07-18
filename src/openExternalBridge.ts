// A real "open this URL in the user's default browser" bridge for the chat
// webview's injected chat-enhancement scripts (currently only
// behaviorFeatures.googlesearch.ts). The chat webview's iframe is sandboxed
// WITHOUT "allow-popups" -- neither window.open() nor a real <a
// target="_blank"> click can open a new browser window from webview JS
// (confirmed live: "Blocked opening '...' in a new window because the
// request was made in a sandboxed frame whose 'allow-popups' permission is
// not set"). The only way out is a postMessage to the extension host, which
// alone can call vscode.env.openExternal(). Two ADDITIVE patches, applied
// together, make this possible without touching Claude Code's own dispatch
// logic or calling acquireVsCodeApi() a second time (documented elsewhere as
// a full chat-webview crash):
//
// 1. webview/index.js: the webview's OWN acquireVsCodeApi() call (Claude
//    Code's chat React app calls it exactly once) is wrapped so its return
//    value is ALSO stashed on window.__ccVsCodeApi -- the call itself still
//    happens exactly once, used identically by Claude Code's own code; we
//    just piggyback a side-effect via the comma operator. Our injected
//    chat-enhancement script (which runs in the SAME document) then reuses
//    window.__ccVsCodeApi.postMessage(...) instead of ever calling
//    acquireVsCodeApi() itself.
// 2. extension.js: setupPanel()'s existing
//    e.webview.onDidReceiveMessage((u)=>{...c?.fromClient(u)},null,this.disposables)
//    registration (the chat panel's real message handler) is followed by a
//    SECOND, independent onDidReceiveMessage registration on the SAME
//    e.webview -- vscode.Webview.onDidReceiveMessage is a plain event, so
//    multiple listeners coexist safely. Ours only recognizes our own
//    {type:"ccOpenExternal", url} message and calls
//    <local-vscode-alias>.env.openExternal(...); everything else is ignored,
//    and Claude Code's own listener/dispatch is never touched.
//
// Both patches use the SAME idempotent present/apply/remove shape as every
// other TOGGLE_POINT: marker comment, removeThenReapply, restorable
// byte-for-byte. If the anchor text is ever gone (Claude Code refactors
// either call site), apply()/present() simply no-op and the feature falls
// back to being unavailable -- never a thrown error, never a corrupted file.

export const BRIDGE_HOST_MARKER = "/*ccup-open-external-host*/";
export const BRIDGE_WEBVIEW_MARKER = "/*ccup-open-external-webview*/";

// --- extension.js: the extension-host listener ------------------------------
// Anchors on the literal onDidReceiveMessage registration inside setupPanel()
// (the real chat panel, viewType "claudeVSCodePanel") -- captured live so a
// re-minify that renames e/u/c/this.disposables still matches, since only the
// call SHAPE (not the identifier names) is fixed across Claude Code builds.
const HOST_ANCHOR_RE =
  /(\b(\w+)\.webview\.onDidReceiveMessage\(\((\w+)\)=>\{this\.output\.info\(`Received message from webview: \$\{JSON\.stringify\(\3\)\}`\),(\w+)\?\.fromClient\(\3\)\},null,this\.disposables\);)/;

// "Present" means patchable at all -- either the real, unpatched anchor is
// there, or our marker is (already applied). Mirrors chatEnhancementsPresent's
// own anchor-or-marker semantics: this is what gates whether applyPatch()'s
// per-toggle loop even attempts this TogglePoint for a given file/build.
export function hostBridgePresent(extensionJs: string): boolean {
  return extensionJs.includes(BRIDGE_HOST_MARKER) || HOST_ANCHOR_RE.test(extensionJs);
}

export function applyHostBridge(extensionJs: string): { out: string; changed: boolean } {
  const stripped = removeHostBridge(extensionJs);
  const m = stripped.match(HOST_ANCHOR_RE);
  if (!m) return { out: extensionJs, changed: false }; // anchor gone: leave native
  const [full, , webviewVar] = m;
  // Resolve the vscode module alias from the SAME scope as the anchor: the
  // anchor line itself doesn't reference it, but setupPanel() always creates
  // its panel via `<alias>.window.createWebviewPanel("claudeVSCodePanel",...)`
  // a little earlier in the same function -- capture that alias live rather
  // than assuming a fixed name (e.g. "Tt"), since it can differ per build/
  // per closure.
  const aliasMatch = stripped
    .slice(Math.max(0, (m.index ?? 0) - 4000), m.index)
    .match(/(\w+)\.window\.createWebviewPanel\("claudeVSCodePanel"/);
  if (!aliasMatch) return { out: extensionJs, changed: false }; // no alias found: leave native
  const alias = aliasMatch[1];
  const injected =
    `${webviewVar}.webview.onDidReceiveMessage((u)=>{${BRIDGE_HOST_MARKER}try{if(u&&u.type==="ccOpenExternal"&&typeof u.url==="string")${alias}.env.openExternal(${alias}.Uri.parse(u.url))}catch(e){}},null,this.disposables);`;
  const out = stripped.slice(0, (m.index ?? 0) + full.length) + injected + stripped.slice((m.index ?? 0) + full.length);
  return { out, changed: out !== extensionJs };
}

export function removeHostBridge(extensionJs: string): string {
  const re =
    /\w+\.webview\.onDidReceiveMessage\(\(u\)=>\{\/\*ccup-open-external-host\*\/try\{if\(u&&u\.type==="ccOpenExternal"&&typeof u\.url==="string"\)\w+\.env\.openExternal\(\w+\.Uri\.parse\(u\.url\)\)\}catch\(e\)\{\}\},null,this\.disposables\);/;
  return extensionJs.replace(re, "");
}

// --- webview/index.js: capture the webview's own acquireVsCodeApi() result --
// Anchors on the literal, single acquireVsCodeApi() call (verified to occur
// exactly once in the chat webview bundle). Wraps it so the SAME single call
// also stashes its result on window.__ccVsCodeApi -- never a second call.
const WEBVIEW_ANCHOR_RE = /\bacquireVsCodeApi\(\)/;

// Same anchor-or-marker semantics as hostBridgePresent above.
export function webviewBridgePresent(webviewJs: string): boolean {
  return webviewJs.includes(BRIDGE_WEBVIEW_MARKER) || WEBVIEW_ANCHOR_RE.test(webviewJs);
}

export function applyWebviewBridge(webviewJs: string): { out: string; changed: boolean } {
  const stripped = removeWebviewBridge(webviewJs);
  if (!WEBVIEW_ANCHOR_RE.test(stripped)) return { out: webviewJs, changed: false }; // anchor gone: leave native
  const out = stripped.replace(
    WEBVIEW_ANCHOR_RE,
    `(window.__ccVsCodeApi=acquireVsCodeApi()${BRIDGE_WEBVIEW_MARKER})`,
  );
  return { out, changed: out !== webviewJs };
}

export function removeWebviewBridge(webviewJs: string): string {
  const re = /\(window\.__ccVsCodeApi=acquireVsCodeApi\(\)\/\*ccup-open-external-webview\*\/\)/;
  return webviewJs.replace(re, "acquireVsCodeApi()");
}
