// A read-only bridge from the chat webview's own session state (the running
// model, effort level, and extended-thinking level) to the injected
// chat-enhancement scripts (behaviorFeatures.modelinfo.ts /
// behaviorFeatures.effortinfo.ts), which cannot reach it any other way.
//
// The values live as Preact signals/computeds on the webview's session-state
// class instance (this.currentModelInfo / this.currentMainLoopModel /
// this.modelSelection / this.effortLevel / the this.thinkingLevel getter) --
// module-scoped to that class, not reachable from a separately-injected
// <script> in the same document (no shared JS realm/closure). So, exactly
// like openExternalBridge.ts's
// acquireVsCodeApi() piggyback, we ADD a new autorun effect right after the
// existing effortSync one (see EFFORT_SYNC_*_RE in patcher.ts, which already
// anchors this exact spot) that mirrors the current values onto
// window.__ccModelInfo = {model, effort, thinking} and fires a
// "cc-modelinfo-changed" DOM event so listeners can react without polling.
// Claude Code's own effortSync logic (untouched) still runs first in the same
// comma-expression chain; our effect is a pure ADDITIVE read, no interference.
//
// Finding "the end of the enclosing Wn(...) call" can NOT be done with a
// simple regex up to the first "})" -- the real bundle's effort-sync arrow
// body has MORE statements after the effort-sync if(...) (an ultracode-seed
// block), so the true close is wherever the OPENING Wn('s own parenthesis
// balances out, not the first "})" textually following the if(...) (which
// would land INSIDE that later statement). We therefore locate the anchor's
// START (the literal Wn(()=>{let n=...,o=...,r=... prefix that is unique to
// this specific effect, shared by both the native/OFF and effortSync-ON
// forms) and then do a manual balanced-parenthesis scan forward from its
// opening "(" to find the true matching close -- the only correct way to
// handle arbitrary/unknown-length content in between across Claude Code
// versions.

export const MODELINFO_MARKER = "/*ccup-modelinfo*/";

// The literal prefix of the effort-sync effect's arrow body, shared by BOTH
// the native (OFF) and already-patched (ON, effortSyncFix) forms -- captured
// live from the real bundle. Anything after "effortLevel;" differs between
// the two forms and beyond (an unrelated ultracode-seed block may follow in
// the SAME arrow body), which is exactly why a fixed-length/first-"})" regex
// can't be used to find the true end.
const EFFORT_SYNC_WN_START_RE =
  /Wn\(\(\)=>\{let ([a-zA-Z_$][\w$]*)=this\.connection\.value\?\.config\.value,([a-zA-Z_$][\w$]*)=\1\?\.claudeSettings\?\.applied,([a-zA-Z_$][\w$]*)=\2!==void 0\?\2\.effort\?\?void 0:\1\?\.settings\?\.effortLevel;/;

// True when the effort-sync anchor's characteristic PREFIX is present (native
// or already-patched form -- both share it) -- this is what gates whether
// applyModelInfoBridge() can find an insertion point at all.
function findAnchorEnd(webviewJs: string): number | undefined {
  const m = webviewJs.match(EFFORT_SYNC_WN_START_RE);
  if (!m || m.index === undefined) return undefined;
  // m.index points at "Wn(" -- walk to that call's own opening "(" and scan
  // forward, tracking parenthesis depth, until it balances back to 0. This is
  // the ONLY correct way to find "the end of this specific call" when the
  // content between the open and close parens is of unknown/variable shape.
  const openParenIdx = webviewJs.indexOf("(", m.index + "Wn".length);
  if (openParenIdx === -1) return undefined;
  let depth = 0;
  for (let i = openParenIdx; i < webviewJs.length; i++) {
    const ch = webviewJs[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1; // just past the matching close paren
    }
  }
  return undefined; // unbalanced (shouldn't happen on valid JS): anchor unusable
}

export function modelInfoBridgePresent(webviewJs: string): boolean {
  return webviewJs.includes(MODELINFO_MARKER) || EFFORT_SYNC_WN_START_RE.test(webviewJs);
}

export function modelInfoBridgeCurrentOn(webviewJs: string): boolean | undefined {
  if (webviewJs.includes(MODELINFO_MARKER)) return true;
  if (EFFORT_SYNC_WN_START_RE.test(webviewJs)) return false;
  return undefined; // anchor gone
}

// The injected effect body. Reads the human-readable model label off
// this.currentModelInfo.value -- a computed already defined on the SAME
// session class (this.currentModelInfo=kn(()=>{let e=Q_(...claudeConfig),
// t=!this.modelSelection.value||this.modelSelection.value==="default"?
// "default":this.modelSelection.value,...;return e.find(n=>n.value===t)??
// ...??e.find(n=>n.resolvedModel===t...)})) that ALREADY resolves the
// "default" selection down to the real underlying model entry the same way
// the stock composer/model-popup UI does -- reusing it here means we never
// need to re-derive that resolution ourselves (an earlier version looked up
// currentMainLoopModel.value directly against claudeConfig.value.models,
// which shows the literal string "default" whenever the user is on the
// default model and no message has set currentMainLoopModel yet, since
// "default" never appears as a real value in that models list -- fixed by
// reading the already-correctly-resolved computed instead). Also reads the
// effort level's raw id (low/medium/high/xhigh -- behaviorFeatures.
// effortinfo.ts humanizes it) and the resolved thinking level ("off" | a
// truthy level string). Writes only on an actual change (a plain
// object-equality guard) so the dispatched event never fires on every
// unrelated signal read inside the same effect pass. Ends on a distinct
// marker comment (not just the effect's own natural "})", which recurs
// inside the body's own try/catch and CustomEvent dispatch) purely as a
// readable removal anchor for removeModelInfoBridge() below -- the actual
// removal boundary is ALSO found via balanced-paren scanning, matching how
// insertion finds its own boundary, so this stays correct regardless of what
// this body's own content looks like.
function bridgeEffectSource(): string {
  return (
    `,Wn(()=>{${MODELINFO_MARKER}try{` +
    `var info=this.currentModelInfo&&this.currentModelInfo.value;` +
    `var mid=(info&&info.value)||this.currentMainLoopModel.value||(typeof this.modelSelection!=="undefined"?this.modelSelection.value:void 0);` +
    `var label=(info&&info.label)?info.label:(mid||"");` +
    `var effort=this.effortLevel.value||"";` +
    `var thinking=this.thinkingLevel||"off";` +
    `var next={model:label,modelId:mid||"",effort:effort,thinking:thinking};` +
    `var prev=window.__ccModelInfo;` +
    `if(!prev||prev.model!==next.model||prev.effort!==next.effort||prev.thinking!==next.thinking){` +
    `window.__ccModelInfo=next;` +
    `try{window.dispatchEvent(new CustomEvent("cc-modelinfo-changed",{detail:next}));}catch(e2){}` +
    `}` +
    `}catch(e){}})`
  );
}

export function applyModelInfoBridge(webviewJs: string): { out: string; changed: boolean } {
  const stripped = removeModelInfoBridge(webviewJs);
  const insertAt = findAnchorEnd(stripped);
  if (insertAt === undefined) return { out: webviewJs, changed: false }; // anchor gone: leave native
  const out = stripped.slice(0, insertAt) + bridgeEffectSource() + stripped.slice(insertAt);
  return { out, changed: out !== webviewJs };
}

// Removes our own injected ",Wn(()=>{/*ccup-modelinfo*/...})" block, found by
// locating the marker and then doing the SAME balanced-parenthesis scan
// (starting from the "Wn(" immediately preceding the marker) to find its true
// close -- never a regex up to the first "})", for the same reason
// applyModelInfoBridge()'s insertion point can't be found that way.
export function removeModelInfoBridge(webviewJs: string): string {
  const markerIdx = webviewJs.indexOf(MODELINFO_MARKER);
  if (markerIdx === -1) return webviewJs;
  // Our own block always starts with the literal ",Wn(()=>{" immediately
  // before the marker (see bridgeEffectSource() above) -- locate that exact
  // prefix's leading comma so the whole ",Wn(...)" is removed, not just the
  // marker's own text.
  const prefix = ",Wn(()=>{" + MODELINFO_MARKER;
  const blockStart = webviewJs.lastIndexOf(prefix, markerIdx);
  if (blockStart === -1) return webviewJs; // marker present but shape unrecognized: leave alone
  const openParenIdx = webviewJs.indexOf("(", blockStart + 1); // the "(" of "Wn("
  if (openParenIdx === -1) return webviewJs;
  let depth = 0;
  for (let i = openParenIdx; i < webviewJs.length; i++) {
    const ch = webviewJs[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        return webviewJs.slice(0, blockStart) + webviewJs.slice(i + 1);
      }
    }
  }
  return webviewJs; // unbalanced (shouldn't happen): leave alone rather than corrupt
}
