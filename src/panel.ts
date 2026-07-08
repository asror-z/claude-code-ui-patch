import * as vscode from "vscode";
import { Patcher, Snapshot, Knob, FeatureState, SECTION_ORDER, STEP, MIN_PX } from "./patcher";

// Shared rendering + message-handling logic for the control surface, hosted by
// EITHER a floating editor-tab WebviewPanel (PatchPanel, opened via the Command
// Palette / status-bar click) OR an Activity Bar-docked WebviewView
// (PatchSidebarView, opened via its own icon in the Activity Bar) — VS Code's
// vscode.Webview interface (.html, .postMessage, .onDidReceiveMessage,
// .cspSource) is identical for both host types, so one base class drives both;
// only how each host is created/revealed differs.
//
// Snappiness: clicking an arrow updates the px display in the webview
// immediately (optimistically) and posts the absolute target value. The full
// HTML is rebuilt only when the structure changes (version, which knobs exist);
// ordinary value/dot/status updates are pushed as lightweight "sync" messages
// that patch the DOM in place, so nothing reloads on each click.
abstract class PatchWebviewHost {
  protected shape = ""; // signature of the last full render's structure

  protected constructor(protected readonly patcher: Patcher) {}

  protected abstract get webview(): vscode.Webview | undefined;

  // Full re-render on a structural change; otherwise patch the DOM in place.
  protected update(): void {
    const webview = this.webview;
    if (!webview) return; // view not yet resolved (sidebar view before first reveal)
    const snap = this.patcher.snapshot();
    const shape = shapeOf(snap);
    if (shape !== this.shape) {
      this.shape = shape;
      webview.html = this.html(webview, snap);
    } else if (snap) {
      void webview.postMessage({ type: "sync", ...syncPayload(snap) });
    }
  }

  protected async onMessage(msg: {
    command: string;
    target?: string;
    value?: number;
    on?: boolean;
    key?: string;
  }): Promise<void> {
    switch (msg.command) {
      case "set":
        if (msg.target !== undefined && msg.value !== undefined)
          await this.patcher.setSize(msg.target, msg.value);
        break;
      case "nativeSet":
        if (msg.target !== undefined && msg.value !== undefined)
          await this.patcher.setNative(msg.target, msg.value);
        break;
      case "toggleSet":
        if (msg.target !== undefined && msg.on !== undefined)
          await this.patcher.setToggle(msg.target, msg.on);
        break;
      case "featureSet":
        if (msg.target !== undefined && msg.on !== undefined)
          await this.patcher.setFeature(msg.target, msg.on);
        break;
      case "discard":
        await this.patcher.discard();
        break;
      case "restore":
        await this.patcher.restore();
        break;
      case "reload":
        void vscode.commands.executeCommand("workbench.action.reloadWindow");
        break;
      case "openSettings":
        void vscode.commands.executeCommand(
          "workbench.action.openSettings",
          msg.key ?? "claudeCodeUiPatch"
        );
        break;
    }
  }

  // --- HTML generation ---

  private knobHtml(k: Knob): string {
    const dotOk = k.native ? true : !k.pendingReload;
    const dotTitle = dotTitleFor(k.native, dotOk);
    const dot = `<span class="dot-slot"><span class="dot ${dotOk ? "dot-ok" : "dot-warn"}" title="${dotTitle}">●</span></span>`;
    if (k.kind === "toggle") {
      return `      <div class="knob" data-id="${k.id}" data-kind="toggle">
        ${dot}
        <span class="label">${k.label}</span>
        <span class="controls"><button class="btn-toggle ${k.on ? "on" : "off"}" data-cmd="toggle" role="switch" aria-checked="${k.on}">${k.on ? "On" : "Off"}</button></span>
      </div>`;
    }
    const cmd = k.native ? "nativeAdjust" : "adjust";
    return `      <div class="knob" data-id="${k.id}" data-min="${MIN_PX}" data-max="${k.max}">
        ${dot}
        <span class="label">${k.label}</span>
        <span class="controls">
          <button class="btn-sm" data-cmd="${cmd}" data-delta="${-STEP}"><b>&#9660;</b></button>
          <span class="px">${k.px}px</span>
          <button class="btn-sm" data-cmd="${cmd}" data-delta="${STEP}"><b>&#9650;</b></button>
        </span>
      </div>`;
  }

  private featureHtml(f: FeatureState): string {
    return `      <label class="feature-row" data-feature-id="${f.id}">
        <input type="checkbox" class="feature-cb"${f.on ? " checked" : ""}>
        <span class="feature-label">${f.label}</span>
      </label>`;
  }

  private html(webview: vscode.Webview, snap: Snapshot | undefined): string {
    const nonce = getNonce();
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">`;
    if (!snap || !snap.available) {
      return `<!DOCTYPE html><html><head><meta charset="UTF-8">
${csp}
<style>${baseCss}</style></head><body>
<p>Claude Code extension not detected.</p></body></html>`;
    }

    const groups = SECTION_ORDER.map((sec) => ({
      sec,
      knobs: snap.knobs.filter((k) => k.section === sec),
    })).filter((g) => g.knobs.length);

    // Chat Enhancement Features: one real checkbox per feature. Checking/unchecking
    // writes straight to claudeCodeUiPatch.feature.<id> (see Patcher.setFeature) —
    // this is the ONE control surface for per-feature on/off (no in-webview gear).
    // The pack is always injected now (no master switch — see CLAUDE.md). It is a
    // self-contained, single-column list (unlike the ▼/▲ knob rows, which need
    // horizontal room for their controls), so it gets its OWN column rather than
    // being crammed above a knob section.
    const featuresCol = `    <div class="section-col">
      <h2>Chat Enhancement Features</h2>
      <div class="feature-grid feature-grid-1col">
${snap.features.map((f) => this.featureHtml(f)).join("\n")}
      </div>
    </div>`;

    // The 3 columns: the feature checkboxes, then each real Section (Chat Panel or
    // Tab, Plan Mode Markdown Preview) with its own ▼/▲ knob rows — this fills the
    // panel's full width with three coherent blocks instead of one long vertical
    // flow. Columns wrap to fewer/stacked automatically in a narrow window (see
    // .section-grid below).
    const sectionCols = groups
      .map((g) => {
        const rows = g.knobs.map((k) => this.knobHtml(k)).join("\n");
        return `    <div class="section-col">\n      <h2>${g.sec}</h2>\n${rows}\n    </div>`;
      })
      .join("\n");
    const sections = `${featuresCol}\n${sectionCols}`;

    return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8">
${csp}
<style>${baseCss}</style>
</head>
<body>
  <h1>Claude Code UI Patch</h1>
  <div class="spacer"></div>
  <div class="version-line">Patching: <span class="version-value">Claude Code v${snap.version}</span></div>
  <div class="header-status">${statusInner(snap)}</div>
  <hr class="divider">
  <div class="section-grid">
${sections}
  </div>
  <hr class="divider">
  <div class="actions">
    <button class="btn btn-green${snap.needsReload ? "" : " quiet"}" data-cmd="discard" title="Revert to the values on disk at the last window reload">Restore Last Applied</button>
    <span class="actions-right">
      <a class="link" data-cmd="openSettings">&#9881; Open VS Code Settings</a>
      <a class="link link-reload${snap.needsReload ? " link-reload-pending" : ""}" data-cmd="reload">&#8635; Reload Window</a>
      <button class="btn btn-red" data-cmd="restore" title="Reset every setting to Claude Code's native values">Factory Reset</button>
    </span>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const pending = {}; // knob id -> last optimistic value we sent (ignore stale echoes until it matches)
    const pendingToggle = {}; // toggle id -> last optimistic on/off we sent
    const pendingFeature = {}; // feature id -> last optimistic on/off we sent
    function fmt(n) { return String(Math.round(n * 100) / 100); }
    function setToggleBtn(btn, on) {
      btn.classList.toggle('on', on);
      btn.classList.toggle('off', !on);
      btn.textContent = on ? 'On' : 'Off';
      btn.setAttribute('aria-checked', String(on));
    }

    document.addEventListener('click', function (e) {
      const el = e.target.closest('[data-cmd]');
      if (!el) return;
      e.preventDefault();
      const cmd = el.dataset.cmd;
      if (cmd === 'toggle') {
        const knob = el.closest('.knob');
        if (!knob) return;
        const id = knob.dataset.id;
        const next = !el.classList.contains('on');
        setToggleBtn(el, next); // optimistic: flip instantly
        pendingToggle[id] = next;
        vscode.postMessage({ command: 'toggleSet', target: id, on: next });
        return;
      }
      if (cmd === 'adjust' || cmd === 'nativeAdjust') {
        const knob = el.closest('.knob');
        if (!knob) return;
        const pxEl = knob.querySelector('.px');
        const id = knob.dataset.id;
        const min = parseFloat(knob.dataset.min);
        const max = parseFloat(knob.dataset.max);
        const cur = parseFloat(pxEl.textContent);
        let next = Math.min(max, Math.max(min, cur + parseFloat(el.dataset.delta)));
        next = Math.round(next * 100) / 100;
        if (next === cur) return;
        pxEl.textContent = fmt(next) + 'px'; // optimistic: show it instantly
        pending[id] = fmt(next);
        vscode.postMessage({ command: cmd === 'nativeAdjust' ? 'nativeSet' : 'set', target: id, value: next });
        return;
      }
      vscode.postMessage({ command: cmd, key: el.dataset.key });
    });

    document.addEventListener('change', function (e) {
      const cb = e.target.closest('.feature-cb');
      if (!cb) return;
      const row = cb.closest('.feature-row');
      if (!row) return;
      const id = row.dataset.featureId;
      pendingFeature[id] = cb.checked; // optimistic: the checkbox already shows the new state
      vscode.postMessage({ command: 'featureSet', target: id, on: cb.checked });
    });

    window.addEventListener('message', function (e) {
      const m = e.data;
      if (!m || m.type !== 'sync') return;
      (m.knobs || []).forEach(function (k) {
        const knob = document.querySelector('.knob[data-id="' + k.id + '"]');
        if (!knob) return;
        const dot = knob.querySelector('.dot');
        if (dot) { dot.className = 'dot ' + (k.dotOk ? 'dot-ok' : 'dot-warn'); dot.title = k.dotTitle; }
        const pxEl = knob.querySelector('.px');
        if (pxEl) {
          if (pending[k.id] === undefined) { pxEl.textContent = k.px + 'px'; }
          else if (pending[k.id] === k.px) { pxEl.textContent = k.px + 'px'; delete pending[k.id]; }
        }
        const tg = knob.querySelector('.btn-toggle');
        if (tg && typeof k.on === 'boolean') {
          if (pendingToggle[k.id] === undefined) { setToggleBtn(tg, k.on); }
          else if (pendingToggle[k.id] === k.on) { setToggleBtn(tg, k.on); delete pendingToggle[k.id]; }
        }
      });
      (m.features || []).forEach(function (f) {
        const row = document.querySelector('.feature-row[data-feature-id="' + f.id + '"]');
        if (!row) return;
        const cb = row.querySelector('.feature-cb');
        if (!cb) return;
        if (pendingFeature[f.id] === undefined) { cb.checked = f.on; }
        else if (pendingFeature[f.id] === f.on) { cb.checked = f.on; delete pendingFeature[f.id]; }
      });
      if (typeof m.status === 'string') {
        const st = document.querySelector('.header-status');
        if (st) st.innerHTML = m.status;
      }
      const rl = document.querySelector('a[data-cmd="reload"]');
      if (rl) rl.classList.toggle('link-reload-pending', !!m.reloadPending);
      const disc = document.querySelector('button[data-cmd="discard"]');
      if (disc) disc.classList.toggle('quiet', !m.reloadPending);
    });
  </script>
</body>
</html>`;
  }
}

// Floating editor-tab host (opened via the Command Palette or status-bar click).
export class PatchPanel extends PatchWebviewHost {
  private static current: PatchPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly sub: vscode.Disposable;

  private constructor(patcher: Patcher) {
    super(patcher);
    this.panel = vscode.window.createWebviewPanel(
      "claudeCodeUiPatch.panel",
      "Claude Code UI Patch",
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true }
    );
    this.sub = vscode.Disposable.from(
      patcher.onDidChange(() => this.update()),
      this.panel.onDidDispose(() => {
        PatchPanel.current = undefined;
        this.sub.dispose();
      }),
      this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m))
    );
    this.update();
  }

  protected get webview(): vscode.Webview {
    return this.panel.webview;
  }

  static show(patcher: Patcher): void {
    if (PatchPanel.current) {
      PatchPanel.current.panel.reveal();
      return;
    }
    PatchPanel.current = new PatchPanel(patcher);
  }
}

// Activity Bar sidebar host — the SAME control surface, docked in the sidebar
// under its own Activity Bar icon (media/activitybar-icon.svg) instead of a
// floating editor tab. VS Code resolves the WebviewView lazily, the first time
// the user opens the view (clicks the icon or expands it), not at activation.
export class PatchSidebarView extends PatchWebviewHost implements vscode.WebviewViewProvider {
  static readonly viewId = "claudeCodeUiPatch.sidebarView";
  private view: vscode.WebviewView | undefined;

  constructor(patcher: Patcher) {
    super(patcher);
    patcher.onDidChange(() => this.update());
  }

  protected get webview(): vscode.Webview | undefined {
    return this.view?.webview;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [] };
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined;
    });
    webviewView.webview.onDidReceiveMessage((m) => this.onMessage(m));
    this.shape = ""; // force a full render for the newly-resolved webview
    this.update();
  }
}

// Structure signature: a full re-render happens only when this changes.
function shapeOf(snap: Snapshot | undefined): string {
  if (!snap || !snap.available) return "none";
  return [snap.supported, snap.version, snap.knobs.map((k) => k.id).join(",")].join(
    "|",
  );
}

function dotTitleFor(native: boolean, ok: boolean): string {
  if (native) return "live";
  return ok ? "in effect" : "reload window to take effect";
}

function statusInner(snap: Snapshot): string {
  if (!snap.supported)
    return `<span class="status-banner warn">Patch not supported on Claude Code v${snap.version}</span>`;
  if (snap.needsReload)
    return `<span class="status-banner warn">Reload window to apply changes</span>`;
  return `<span class="status-banner ok">All settings applied</span>`;
}

// Lightweight per-knob state + header status for in-place DOM updates.
function syncPayload(snap: Snapshot): {
  knobs: Array<{ id: string; px: string; on: boolean; dotOk: boolean; dotTitle: string }>;
  features: Array<{ id: string; on: boolean }>;
  status: string;
  reloadPending: boolean;
} {
  const knobs = snap.knobs.map((k) => {
    const dotOk = k.native ? true : !k.pendingReload;
    return { id: k.id, px: k.px, on: k.on, dotOk, dotTitle: dotTitleFor(k.native, dotOk) };
  });
  const features = snap.features.map((f) => ({ id: f.id, on: f.on }));
  return { knobs, features, status: statusInner(snap), reloadPending: snap.needsReload };
}

const baseCss = `
  body {
    font-family: var(--vscode-font-family);
    font-size: calc(var(--vscode-font-size) * 1.2);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    max-width: 1400px;
    padding: 16px 28px;
  }
  h1 { font-size: 1.7em; font-weight: 700; margin: 0; }
  .spacer { height: 2px; }
  .version-line { font-size: 1.1em; font-weight: 400; margin-bottom: 2px; }
  .version-value { color: #d97757; }
  .header-status { margin-top: 4px; margin-bottom: 1px; font-size: 1.1em; font-weight: 500; }
  h2 { font-size: 1.1em; margin: 6px 0 3px; }
  .knob { display: flex; align-items: center; padding: 4px 0; line-height: 1.6; }
  .knob .dot-slot { width: 14px; flex-shrink: 0; text-align: center; margin-right: 14px; }
  .knob .label { flex: 1 1 auto; min-width: 160px; }
  /* Two columns whenever there's room (>= ~340px per column), one column in a
     narrow panel — auto-fit avoids a forced 2-up layout that would overflow or
     leave an awkward gap in a resized/narrow window. */
  .feature-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); column-gap: 20px; row-gap: 0; padding-left: 28px; }
  /* Inside its OWN section-col (narrower than the whole panel), the feature list
     stays a single column — a nested 2-up auto-fit would cramp each label. */
  .feature-grid-1col { grid-template-columns: 1fr; padding-left: 0; }
  /* 3 columns whenever there's room (feature checkboxes, Chat Panel or Tab knobs,
     Plan Mode Markdown Preview knobs); wraps down to 2, then 1, in a narrower
     window rather than ever overflowing or leaving an awkward gap. */
  .section-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); column-gap: 32px; align-items: start; }
  .section-col { min-width: 0; }
  .section-col + .section-col { border-left: 1px solid var(--vscode-panel-border); padding-left: 32px; }
  /* Below ~500px (the Activity Bar sidebar's typical width, far narrower than the
     editor-tab panel this layout was originally designed for) a knob row's fixed
     168px control group + 160px label simply cannot fit side-by-side. Stack each
     row's label above its controls instead of letting it clip or forcing a
     horizontal scrollbar — a real responsive layout, not a scroll-escape hatch. */
  @media (max-width: 500px) {
    .feature-grid, .section-grid { grid-template-columns: 1fr; }
    .section-col + .section-col { border-left: none; padding-left: 0; border-top: 1px solid var(--vscode-panel-border); padding-top: 10px; margin-top: 6px; }
    .knob { flex-direction: column; align-items: flex-start; gap: 2px; padding: 6px 0; }
    .knob .dot-slot { position: absolute; margin-right: 0; }
    .knob .label { padding-left: 20px; min-width: 0; }
    .knob .controls { width: 100%; justify-content: flex-start; margin-left: 20px; }
    .knob { position: relative; }
    .actions { flex-direction: column; align-items: stretch; gap: 8px; }
    .actions-right { flex-wrap: wrap; justify-content: flex-start; }
  }
  .feature-row { display: flex; align-items: center; padding: 1px 0; line-height: 1.32; cursor: pointer; }
  .feature-cb { margin: 0 10px 0 0; cursor: pointer; flex-shrink: 0; }
  .feature-label { flex: 1 1 auto; }
  .knob .controls { display: flex; align-items: center; justify-content: center; width: 168px; flex-shrink: 0; margin-left: 16px; }
  .knob .btn-sm { width: 34px; flex-shrink: 0; text-align: center; margin: 0 2px; }
  .knob .px { width: 72px; flex-shrink: 0; text-align: center; font-family: var(--vscode-editor-font-family); font-variant-numeric: tabular-nums; color: var(--vscode-textLink-foreground); }
  .knob .note { font-size: .85em; color: var(--vscode-descriptionForeground); margin-left: 8px; }
  .btn { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 5px 16px; border-radius: 2px; cursor: pointer; font-size: inherit; font-weight: 600; }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn-green { background: #3fa34d; color: #fff; }
  .btn-green:hover { background: #368c42; }
  /* Quiet (nothing pending): "Restore Last Applied" has nothing to revert, so it
     recedes to an outline instead of shouting in solid green. The border is an
     inset box-shadow, not a real border, so the box stays the same size as the
     solid state and toggling between them never shifts layout. */
  .btn-green.quiet { background: transparent; color: #3fa34d; box-shadow: inset 0 0 0 1px #3fa34d; }
  .btn-green.quiet:hover { background: rgba(63, 163, 77, 0.12); }
  .btn-red { background: #c74e39; color: #fff; }
  .btn-red:hover { background: #b13f2c; }
  .btn-sm { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 2px 0; border-radius: 2px; cursor: pointer; font-size: inherit; font-weight: bold; }
  .btn-sm:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .knob .btn-toggle { width: 100%; text-align: center; border: none; border-radius: 2px; padding: 3px 0; cursor: pointer; font-size: inherit; font-weight: 600; }
  .knob .btn-toggle.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .knob .btn-toggle.off { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .knob .btn-toggle.on:hover { background: var(--vscode-button-hoverBackground); }
  .knob .btn-toggle.off:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .actions { margin-top: 6px; display: flex; flex-direction: row; justify-content: space-between; align-items: center; gap: 10px; }
  .actions-right { display: flex; flex-direction: row; align-items: center; gap: 18px; }
  .actions-right a.link { margin-top: 0; }
  .divider { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 4px 0; }
  /* Every header status is a full-width banner so the strip never changes height
     between states: green when everything is applied, yellow when a reload is due
     or the version is unsupported. */
  .status-banner { display: block; color: #fff; padding: 4px 12px; border-radius: 3px; font-weight: 700; }
  .status-banner.ok { background: #3fa34d; }
  .status-banner.warn { background: var(--vscode-statusBarItem-warningBackground, #b7791f); }
  .dot { font-size: .8em; }
  .dot-ok { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .dot-warn { color: var(--vscode-editorWarning-foreground); }
  a.link { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; font-size: 1.1em; margin-top: 12px; display: block; }
  /* The reload link is always a badge with the same box in both states, so it
     never jitters when the pending state flips: green while everything is
     applied, yellow when a reload is due. */
  a.link.link-reload { display: inline-block; background: #3fa34d; color: #fff; padding: 3px 12px; border-radius: 3px; font-weight: 700; }
  a.link.link-reload.link-reload-pending { background: var(--vscode-statusBarItem-warningBackground, #b7791f); }
`;

// Per-render nonce so the Content-Security-Policy can allow only this panel's
// own inline <script> (the HTML is fully extension-generated, so this is
// defense in depth rather than a fix for a known injection).
function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
