/* A real bridge from the chat webview's injected chat-enhancement scripts to
   two extension-host-only capabilities neither can reach directly:
     (a) opening a URL in the user's real default browser
         (behaviorFeatures.googlesearch.ts)
     (b) opening a LOCAL FILE PATH in a real editor tab
         (behaviorFeatures.filelinks.ts)
   The chat webview's iframe is sandboxed WITHOUT "allow-popups" -- neither
   window.open() nor a real <a target="_blank"> click can open a new browser
   window from webview JS (confirmed live: "Blocked opening '...' in a new
   window because the request was made in a sandboxed frame whose
   'allow-popups' permission is not set"), and there is no client-side API at
   all for opening a local file in the editor -- both need a postMessage to
   the extension host.
   Two ADDITIVE patches, applied together, make this possible without
   touching Claude Code's own dispatch logic or calling acquireVsCodeApi() a
   second time (documented elsewhere as a full chat-webview crash):

   (Question/reply notifications -- taskbar flash + audio -- are handled
   entirely OUTSIDE this webview bridge, via a Claude Code CLI hook
   (~/.claude/hooks/vscode-notify.mjs) reacting to real Notification/Stop
   hook events.
   See that hook's own header comment for why: the DOM-watching webview
   approach this bridge used to also carry -- a ccNotify message type -- was
   retired because it depended on guessing "a reply just finished" from
   transient DOM state (a Stop button disappearing, a dialog element
   appearing), which is fragile against any Claude Code bundle change.
   The CLI's own hook events are the authoritative, DOM-independent signal.)

   1. webview/index.js: the webview's OWN acquireVsCodeApi() call (Claude
      Code's chat React app calls it exactly once) is wrapped so its return
      value is ALSO stashed on window.__ccVsCodeApi -- the call itself still
      happens exactly once, used identically by Claude Code's own code; we
      just piggyback a side-effect via the comma operator.
      Our injected chat-enhancement scripts (which run in the SAME document)
      then reuse window.__ccVsCodeApi.postMessage(...) instead of ever
      calling acquireVsCodeApi() themselves.
   2. extension.js: setupPanel()'s existing
      e.webview.onDidReceiveMessage((u)=>{...c?.fromClient(u)},null,this.disposables)
      registration (the chat panel's real message handler) is followed by a
      SECOND, independent onDidReceiveMessage registration on the SAME
      e.webview -- vscode.Webview.onDidReceiveMessage is a plain event, so
      multiple listeners coexist safely.
      Ours recognizes two message shapes, {type:"ccOpenExternal", url} and
      {type:"ccOpenFile", path}, and dispatches to
      <local-vscode-alias>.env.openExternal(...) / a small ccup_openFile(p)
      helper (also injected) that resolves p against every open workspace
      folder (Uri.joinPath) plus as a bare absolute path (Uri.file), opening
      the FIRST candidate that actually exists via vscode.workspace.fs.stat,
      with vscode.window.showTextDocument(uri, {preview:false}) -- VS Code's
      own editor-group model already reveals/focuses an EXISTING non-preview
      tab for that same URI instead of opening a duplicate, so "reuse the tab
      if it's already open" falls out of {preview:false} for free, no extra
      bookkeeping needed.
      Everything else is ignored, and Claude Code's own listener/dispatch is
      never touched.

   Both patches use the SAME idempotent present/apply/remove shape as every
   other TOGGLE_POINT: marker comment, removeThenReapply, restorable
   byte-for-byte.
   The host-side removal regex spans from the marker to the literal
   ",null,this.disposables);" close (non-greedy, [\s\S]*?) rather than
   hardcoding the exact injected body -- this survives future edits to what's
   INSIDE the injected block (e.g. adding a third message type later) without
   needing the removal regex updated in lockstep.
   If the anchor text is ever gone (Claude Code refactors either call site),
   apply()/present() simply no-op and the feature falls back to being
   unavailable -- never a thrown error, never a corrupted file. */

export const BRIDGE_HOST_MARKER = "/*ccup-open-external-host*/";
export const BRIDGE_WEBVIEW_MARKER = "/*ccup-open-external-webview*/";

// --- extension.js: the extension-host listener ------------------------------
// Anchors on the literal onDidReceiveMessage registration inside setupPanel()
// (the real chat panel, viewType "claudeVSCodePanel") -- captured live so a
// re-minify that renames e/u/c/this.disposables still matches, since only the
// call SHAPE (not the identifier names) is fixed across Claude Code builds.
const HOST_ANCHOR_RE =
  /(\b(\w+)\.webview\.onDidReceiveMessage\(\((\w+)\)=>\{this\.output\.info\(`Received message from webview: \$\{JSON\.stringify\(\3\)\}`\),(\w+)\?\.fromClient\(\3\)\},null,this\.disposables\);)/;

/**
 * "Present" means patchable at all -- either the real, unpatched anchor is
 * there, or our marker is (already applied).
 * Mirrors chatEnhancementsPresent's own anchor-or-marker semantics: this is
 * what gates whether applyPatch()'s per-toggle loop even attempts this
 * TogglePoint for a given file/build.
 * @param {string} extensionJs - the extension.js source to inspect
 * @returns {boolean} true if the anchor or the applied marker is present
 */
export function hostBridgePresent(extensionJs: string): boolean {
  return extensionJs.includes(BRIDGE_HOST_MARKER) || HOST_ANCHOR_RE.test(extensionJs);
}

/**
 * @param {string} extensionJs - the extension.js source to patch
 * @returns {{out: string, changed: boolean}} patched source and whether it changed
 */
export function applyHostBridge(extensionJs: string): { out: string; changed: boolean } {
  const stripped = removeHostBridge(extensionJs);
  const m = stripped.match(HOST_ANCHOR_RE);
  if (!m) return { out: extensionJs, changed: false }; // anchor gone: leave native
  const [full, , webviewVar] = m;
  /* Resolve the vscode module alias from the SAME scope as the anchor: the
     anchor line itself doesn't reference it, but setupPanel() always creates
     its panel via `<alias>.window.createWebviewPanel("claudeVSCodePanel",...)`
     a little earlier in the same function -- capture that alias live rather
     than assuming a fixed name (e.g. "Tt"), since it can differ per build/
     per closure. */
  const aliasMatch = stripped
    .slice(Math.max(0, (m.index ?? 0) - 4000), m.index)
    .match(/(\w+)\.window\.createWebviewPanel\("claudeVSCodePanel"/);
  if (!aliasMatch) return { out: extensionJs, changed: false }; // no alias found: leave native
  const alias = aliasMatch[1];
  /* ccOpenFile handling is an inline IIFE inside the SAME try block (not a
     separate top-level function declaration) so the overall injected shape
     -- <webviewVar>.webview.onDidReceiveMessage((u)=>{[marker]try{...}
     catch(e){}},null,this.disposables); -- is UNCHANGED from the original
     ccOpenExternal-only version; only the content between try{ and }catch
     grows.
     This keeps removeHostBridge's regex correct for BOTH an already-applied
     OLD-shape file (upgrading from a version that only handled
     ccOpenExternal) and this NEW shape, without needing two different
     removal patterns.
     Resolves p (relative OR absolute) against every open workspace folder
     (Uri.joinPath) plus as a bare absolute path (Uri.file), opening the
     FIRST candidate that actually exists (vscode.workspace.fs.stat, works
     for local and remote filesystems) via showTextDocument(uri,
     {preview:false}) -- a non-preview tab, so VS Code's own editor-group
     model reveals/focuses an EXISTING tab for that URI instead of opening a
     duplicate.
     Silently no-ops if nothing resolves (matches this codebase's established
     "never throw on a miss" convention). */
  const injected =
    `${webviewVar}.webview.onDidReceiveMessage((u)=>{${BRIDGE_HOST_MARKER}try{` +
    `if(u&&u.type==="ccOpenExternal"&&typeof u.url==="string")${alias}.env.openExternal(${alias}.Uri.parse(u.url));` +
    `else if(u&&u.type==="ccOpenFile"&&typeof u.path==="string")(function(p){` +
    `var f=${alias}.workspace.workspaceFolders||[];` +
    `var c=f.map(function(w){return ${alias}.Uri.joinPath(w.uri,p)});` +
    `c.push(${alias}.Uri.file(p));` +
    `var chain=Promise.reject();` +
    `c.forEach(function(u2){chain=chain.catch(function(){return ${alias}.workspace.fs.stat(u2).then(function(){return ${alias}.window.showTextDocument(u2,{preview:false})})})});` +
    `chain.catch(function(){})` +
    `})(u.path);` +
    `}catch(e){}},null,this.disposables);`;
  const out = stripped.slice(0, (m.index ?? 0) + full.length) + injected + stripped.slice((m.index ?? 0) + full.length);
  return { out, changed: out !== extensionJs };
}

/**
 * @param {string} extensionJs - the extension.js source to strip
 * @returns {string} the source with the host bridge listener removed
 */
export function removeHostBridge(extensionJs: string): string {
  /* Non-greedy [\s\S]*? between the marker and the fixed try/catch close
     matches BOTH the original ccOpenExternal-only body and the expanded
     ccOpenExternal+ccOpenFile body above -- only the STRUCTURAL prefix/suffix
     (the exact literal text around the marker and the closing
     "}catch(e){}},null,this.disposables);") needs to stay fixed; the content
     in between is free to grow across versions without this regex ever
     needing an update in lockstep. */
  const re =
    /\w+\.webview\.onDidReceiveMessage\(\(u\)=>\{\/\*ccup-open-external-host\*\/try\{[\s\S]*?\}catch\(e\)\{\}\},null,this\.disposables\);/;
  return extensionJs.replace(re, "");
}

/* --- webview/index.js: capture the webview's own acquireVsCodeApi() result --
   Anchors on the literal, single acquireVsCodeApi() call (verified to occur
   exactly once in the chat webview bundle).
   Wraps it so the SAME single call also stashes its result on
   window.__ccVsCodeApi -- never a second call. */
const WEBVIEW_ANCHOR_RE = /\bacquireVsCodeApi\(\)/;

/**
 * Same anchor-or-marker semantics as hostBridgePresent above.
 * @param {string} webviewJs - the webview/index.js source to inspect
 * @returns {boolean} true if the anchor or the applied marker is present
 */
export function webviewBridgePresent(webviewJs: string): boolean {
  return webviewJs.includes(BRIDGE_WEBVIEW_MARKER) || WEBVIEW_ANCHOR_RE.test(webviewJs);
}

/**
 * @param {string} webviewJs - the webview/index.js source to patch
 * @returns {{out: string, changed: boolean}} patched source and whether it changed
 */
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
