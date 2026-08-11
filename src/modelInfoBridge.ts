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
// Finding "the end of the enclosing <fn>(...) call" can NOT be done with a
// simple regex up to the first "})" -- the real bundle's effort-sync arrow
// body has MORE statements after the effort-sync if(...) (an ultracode-seed
// block), so the true close is wherever the OPENING call's own parenthesis
// balances out, not the first "})" textually following the if(...) (which
// would land INSIDE that later statement). We therefore locate the anchor's
// START (the literal (()=>{let n=...,o=...,r=... arrow-body prefix that is
// unique to this specific effect, shared by both the native/OFF and
// effortSync-ON forms) and then do a manual balanced-parenthesis scan forward
// from its own opening "(" to find the true matching close -- the only
// correct way to handle arbitrary/unknown-length content in between across
// Claude Code versions.
//
// The one-or-two-letter minifier-assigned wrapper function name that
// immediately precedes this arrow (Wn/Un/... -- effectively arbitrary, and
// confirmed to change build-to-build: Wn in one build, Un in Claude Code
// 2.1.227) is deliberately captured as a wildcard, NEVER hardcoded -- an
// earlier version hardcoded "Wn(" and silently stopped matching the moment a
// build renamed it to "Un(", permanently breaking window.__ccModelInfo (and
// therefore the whole Model/Effort composer-placeholder feature) with no
// error, degrading only to "leave native" per applyModelInfoBridge()'s own
// anchor-gone contract.

export const MODELINFO_MARKER = "/*ccup-modelinfo*/";

// The literal prefix of the effort-sync effect's arrow body, shared by BOTH
// the native (OFF) and already-patched (ON, effortSyncFix) forms -- captured
// live from the real bundle. Anything after "effortLevel;" differs between
// the two forms and beyond (an unrelated ultracode-seed block may follow in
// the SAME arrow body), which is exactly why a fixed-length/first-"})" regex
// can't be used to find the true end. The leading wrapper-call name is a
// wildcard ([a-zA-Z_$][\w$]*) capture (group 1), never a literal -- see note
// above; groups 2-4 are the arrow body's own local var names.
const EFFORT_SYNC_WN_START_RE =
  /([a-zA-Z_$][\w$]*)\(\(\)=>\{let ([a-zA-Z_$][\w$]*)=this\.connection\.value\?\.config\.value,([a-zA-Z_$][\w$]*)=\2\?\.claudeSettings\?\.applied,([a-zA-Z_$][\w$]*)=\3!==void 0\?\3\.effort\?\?void 0:\2\?\.settings\?\.effortLevel;/;

// True when the effort-sync anchor's characteristic PREFIX is present (native
// or already-patched form -- both share it) -- this is what gates whether
// applyModelInfoBridge() can find an insertion point at all. Returns the
// matched wrapper-call NAME alongside the insertion offset (just past that
// call's own matching close-paren) -- callers reuse the same wrapper name to
// build their own new call (bridgeEffectSource()) rather than guessing one.
function findAnchor(webviewJs: string): { insertAt: number; wrapperFn: string } | undefined {
  const m = webviewJs.match(EFFORT_SYNC_WN_START_RE);
  if (!m || m.index === undefined) return undefined;
  const wrapperFn = m[1];
  // m.index points at the wrapper call's own name -- walk to that call's
  // opening "(" (right after the matched name, whatever it is) and scan
  // forward, tracking parenthesis depth, until it balances back to 0. This is
  // the ONLY correct way to find "the end of this specific call" when the
  // content between the open and close parens is of unknown/variable shape.
  const openParenIdx = webviewJs.indexOf("(", m.index + wrapperFn.length);
  if (openParenIdx === -1) return undefined;
  let depth = 0;
  for (let i = openParenIdx; i < webviewJs.length; i++) {
    const ch = webviewJs[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return { insertAt: i + 1, wrapperFn }; // just past the matching close paren
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
// wrapperFn is the SAME minifier-assigned effect-wrapper name the anchor scan
// just matched (m[1] in findAnchorEnd/applyModelInfoBridge) -- never a
// hardcoded literal. Reusing the exact function this build's own effort-sync
// effect is wrapped in (rather than a guessed/fixed name) is what keeps this
// injected call working across a rename (Wn in one build, Un in another).
function bridgeEffectSource(wrapperFn: string): string {
  return (
    `,${wrapperFn}(()=>{${MODELINFO_MARKER}try{` +
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
  const anchor = findAnchor(stripped);
  if (!anchor) return { out: webviewJs, changed: false }; // anchor gone: leave native
  const { insertAt, wrapperFn } = anchor;
  const out = stripped.slice(0, insertAt) + bridgeEffectSource(wrapperFn) + stripped.slice(insertAt);
  return { out, changed: out !== webviewJs };
}

// Removes our own injected ",<wrapperFn>(()=>{/*ccup-modelinfo*/...})" block,
// found by locating the marker and then doing the SAME balanced-parenthesis
// scan (starting from the wrapper call's own "(" immediately preceding the
// marker) to find its true close -- never a regex up to the first "})", for
// the same reason applyModelInfoBridge()'s insertion point can't be found
// that way. The wrapper name is read back from whatever identifier actually
// precedes "(()=>{" + MODELINFO_MARKER in THIS file (never assumed to be
// "Wn") -- our own injected block always has this exact shape (see
// bridgeEffectSource() above), so scanning backward from the marker for the
// nearest "<ident>(()=>{" is enough to recover it without hardcoding.
export function removeModelInfoBridge(webviewJs: string): string {
  const markerIdx = webviewJs.indexOf(MODELINFO_MARKER);
  if (markerIdx === -1) return webviewJs;
  const bodyPrefix = "(()=>{" + MODELINFO_MARKER;
  const bodyStart = webviewJs.lastIndexOf(bodyPrefix, markerIdx);
  if (bodyStart === -1) return webviewJs; // marker present but shape unrecognized: leave alone
  // Walk backward from bodyStart over the wrapper function's own identifier
  // chars, then confirm a leading "," immediately precedes it (our own
  // injected call is always a comma-expression continuation).
  let nameStart = bodyStart;
  while (nameStart > 0 && /[\w$]/.test(webviewJs[nameStart - 1])) nameStart--;
  const blockStart = nameStart - 1;
  if (blockStart < 0 || webviewJs[blockStart] !== ",") return webviewJs; // shape unrecognized: leave alone
  const openParenIdx = webviewJs.indexOf("(", nameStart); // the "(" of "<wrapperFn>("
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
