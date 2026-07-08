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
    if (k.kind === "toggle") {
      return `      <div class="knob" data-id="${k.id}" data-kind="toggle">
        <span class="label">${k.label}</span>
        <span class="controls"><button class="switch ${k.on ? "on" : "off"}" data-cmd="toggle" role="switch" aria-checked="${k.on}"><span class="switch-track"><span class="switch-thumb"></span></span><span class="switch-text">${k.on ? "On" : "Off"}</span></button></span>
      </div>`;
    }
    const cmd = k.native ? "nativeSet" : "set";
    return `      <div class="knob" data-id="${k.id}" data-min="${MIN_PX}" data-max="${k.max}" data-cmd="${cmd}">
        <span class="label">${k.label}</span>
        <span class="controls">
          <input type="number" class="px-input" value="${k.px}" min="${MIN_PX}" max="${k.max}" step="1">
          <span class="px-unit">px</span>
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
<div class="empty-state">
  <span class="empty-icon">&#128268;</span>
  <p>Claude Code extension not detected.</p>
</div>
</body></html>`;
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
      <h2><span class="h2-icon">&#10022;</span>Chat Enhancement Features</h2>
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
        return `    <div class="section-col">\n      <h2>${sectionIcon(g.sec)}${g.sec}</h2>\n${rows}\n    </div>`;
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
  <div class="app-header">
    <div class="app-title">
      <span class="app-icon">&#9889;</span>
      <h1>Claude Code UI Patch</h1>
    </div>
    <span class="version-pill">v${snap.version}</span>
  </div>
  <div class="header-status">${statusInner(snap)}</div>
  <div class="card">
    <div class="section-grid">
${sections}
    </div>
  </div>
  <div class="actions">
    <button class="btn btn-green${snap.needsReload ? "" : " quiet"}" data-cmd="discard" title="Revert to the values on disk at the last window reload">&#8617; Restore Last Applied</button>
    <button class="btn btn-outline" data-cmd="openSettings" title="Open the claudeCodeUiPatch.* settings in VS Code Settings"><span class="link-icon">&#9881;</span>Open VS Code Settings</button>
    <button class="btn btn-outline${snap.needsReload ? " btn-reload-pending" : ""}" data-cmd="reload" title="Reload the window to apply changes">&#8635; Reload Window</button>
    <button class="btn btn-red" data-cmd="restore" title="Reset every setting to Claude Code's native values">&#8635; Factory Reset</button>
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
      const txt = btn.querySelector('.switch-text');
      if (txt) txt.textContent = on ? 'On' : 'Off';
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
      vscode.postMessage({ command: cmd, key: el.dataset.key });
    });

    function commitPxInput(input) {
      const knob = input.closest('.knob');
      if (!knob) return;
      const id = knob.dataset.id;
      const min = parseFloat(knob.dataset.min);
      const max = parseFloat(knob.dataset.max);
      let next = parseFloat(input.value);
      if (isNaN(next)) { input.value = pending[id] !== undefined ? pending[id] : input.defaultValue; return; }
      next = Math.min(max, Math.max(min, Math.round(next * 100) / 100));
      input.value = fmt(next); // normalize (clamped/rounded) the field itself
      pending[id] = fmt(next);
      vscode.postMessage({ command: knob.dataset.cmd, target: id, value: next });
    }

    document.addEventListener('change', function (e) {
      const px = e.target.closest('.px-input');
      if (px) { commitPxInput(px); return; }
      const cb = e.target.closest('.feature-cb');
      if (!cb) return;
      const row = cb.closest('.feature-row');
      if (!row) return;
      const id = row.dataset.featureId;
      pendingFeature[id] = cb.checked; // optimistic: the checkbox already shows the new state
      vscode.postMessage({ command: 'featureSet', target: id, on: cb.checked });
    });

    // Commit on Enter too (change already fires on blur/native spinner clicks).
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      const px = e.target.closest && e.target.closest('.px-input');
      if (px) { e.preventDefault(); px.blur(); }
    });

    window.addEventListener('message', function (e) {
      const m = e.data;
      if (!m || m.type !== 'sync') return;
      (m.knobs || []).forEach(function (k) {
        const knob = document.querySelector('.knob[data-id="' + k.id + '"]');
        if (!knob) return;
        const pxEl = knob.querySelector('.px-input');
        if (pxEl && document.activeElement !== pxEl) {
          if (pending[k.id] === undefined) { pxEl.value = k.px; }
          else if (pending[k.id] === k.px) { pxEl.value = k.px; delete pending[k.id]; }
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

function sectionIcon(sec: string): string {
  const glyph = sec === "Plan Mode Markdown Preview" ? "&#128221;" : "&#128172;";
  return `<span class="h2-icon">${glyph}</span>`;
}

function statusInner(snap: Snapshot): string {
  if (!snap.supported)
    return `<span class="status-banner warn"><span class="status-icon">&#9888;</span>Patch not supported on Claude Code v${snap.version}</span>`;
  if (snap.needsReload)
    return `<span class="status-banner warn"><span class="status-icon">&#8635;</span>Reload window to apply changes</span>`;
  return `<span class="status-banner ok"><span class="status-icon">&#10003;</span>All settings applied</span>`;
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
  :root {
    --ccp-accent: #d97757;
    --ccp-accent-soft: rgba(217, 119, 87, 0.14);
    --ccp-green: #3fa34d;
    --ccp-green-hover: #368c42;
    --ccp-red: #c74e39;
    --ccp-red-hover: #b13f2c;
    --ccp-radius: 6px;
    --ccp-radius-sm: 4px;
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    font-size: calc(var(--vscode-font-size) * 1.2);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    max-width: 1400px;
    padding: 18px 24px 24px;
  }
  .empty-state { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 48px 16px; color: var(--vscode-descriptionForeground); text-align: center; }
  .empty-icon { font-size: 2em; opacity: .7; }

  /* --- Header --- */
  .app-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
  .app-title { display: flex; align-items: center; gap: 9px; }
  .app-icon { font-size: 1.15em; color: var(--ccp-accent); filter: drop-shadow(0 0 6px var(--ccp-accent-soft)); }
  h1 { font-size: 1.4em; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
  .version-pill {
    font-family: var(--vscode-editor-font-family); font-variant-numeric: tabular-nums;
    font-size: .78em; font-weight: 700; color: var(--ccp-accent); background: var(--ccp-accent-soft);
    border: 1px solid rgba(217, 119, 87, 0.35); border-radius: 999px; padding: 3px 11px; white-space: nowrap;
  }
  .header-status { margin-bottom: 12px; }
  h2 {
    font-size: .82em; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
    color: var(--vscode-descriptionForeground); margin: 0 0 9px; display: flex; align-items: center; gap: 7px;
  }
  .h2-icon { font-size: 1.15em; filter: grayscale(0.15); }

  /* --- Card frame around all sections --- */
  .card {
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    border: 1px solid var(--vscode-panel-border);
    border-radius: var(--ccp-radius);
    padding: 16px 18px;
  }

  /* --- Knob rows --- */
  .knob { display: flex; align-items: center; padding: 5px 4px; line-height: 1.5; border-radius: var(--ccp-radius-sm); transition: background-color .12s ease; }
  .knob:hover { background: var(--vscode-list-hoverBackground); }
  .knob .dot-slot { width: 14px; flex-shrink: 0; text-align: center; margin-right: 12px; }
  .knob .label { flex: 1 1 auto; min-width: 160px; }
  /* Two columns whenever there's room (>= ~340px per column), one column in a
     narrow panel — auto-fit avoids a forced 2-up layout that would overflow or
     leave an awkward gap in a resized/narrow window. */
  .feature-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); column-gap: 20px; row-gap: 1px; }
  /* Inside its OWN section-col (narrower than the whole panel), the feature list
     stays a single column — a nested 2-up auto-fit would cramp each label. */
  .feature-grid-1col { grid-template-columns: 1fr; }
  /* 3 columns whenever there's room (feature checkboxes, Chat Panel or Tab knobs,
     Plan Mode Markdown Preview knobs); wraps down to 2, then 1, in a narrower
     window rather than ever overflowing or leaving an awkward gap. */
  .section-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); column-gap: 28px; row-gap: 18px; align-items: start; }
  .section-col { min-width: 0; }
  .section-col + .section-col { border-left: 1px solid var(--vscode-panel-border); padding-left: 28px; }
  /* Below ~500px (the Activity Bar sidebar's typical width, far narrower than the
     editor-tab panel this layout was originally designed for) a knob row's fixed
     168px control group + 160px label simply cannot fit side-by-side. Stack each
     row's label above its controls instead of letting it clip or forcing a
     horizontal scrollbar — a real responsive layout, not a scroll-escape hatch. */
  @media (max-width: 500px) {
    .feature-grid, .section-grid { grid-template-columns: 1fr; }
    .section-col + .section-col { border-left: none; padding-left: 0; border-top: 1px solid var(--vscode-panel-border); padding-top: 12px; margin-top: 4px; }
    /* Stay on ONE row (not stacked) even at this width, but put the controls
       (the input/switch) BEFORE the label visually via CSS order, without
       reordering the actual DOM/data-cmd wiring — the label shrinks/truncates
       instead of pushing the row wider than the sidebar. */
    .knob { flex-wrap: nowrap; gap: 8px; padding: 6px 4px; }
    .knob .label { order: 2; min-width: 0; flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .knob .controls { order: 1; margin-left: 0; flex-shrink: 0; }
    /* 4 action buttons as a real 2x2 grid (2 rows, 2 columns) instead of a row
       that overflows/wraps unpredictably — smaller font/padding so each button
       fits its half-width cell without its label wrapping onto 3+ lines. */
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .btn { padding: 6px 8px; font-size: 0.85em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  }
  .feature-row { display: flex; align-items: center; padding: 3px 4px; line-height: 1.32; cursor: pointer; border-radius: var(--ccp-radius-sm); transition: background-color .12s ease; }
  .feature-row:hover { background: var(--vscode-list-hoverBackground); }
  .feature-cb { margin: 0 10px 0 0; cursor: pointer; flex-shrink: 0; accent-color: var(--ccp-accent); width: 14px; height: 14px; }
  .feature-label { flex: 1 1 auto; }
  .knob .controls { display: flex; align-items: center; justify-content: flex-end; gap: 4px; width: 136px; flex-shrink: 0; margin-left: 16px; }
  .knob .px-input {
    width: 104px; text-align: right; font-family: var(--vscode-editor-font-family);
    font-variant-numeric: tabular-nums; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent);
    border-radius: var(--ccp-radius-sm); padding: 3px 6px; font-size: inherit; transition: border-color .12s ease;
  }
  .knob .px-input:hover { border-color: var(--vscode-inputOption-activeBorder, var(--vscode-focusBorder)); }
  .knob .px-input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .knob .px-unit { color: var(--vscode-descriptionForeground); flex-shrink: 0; font-size: .9em; }
  .knob .note { font-size: .85em; color: var(--vscode-descriptionForeground); margin-left: 8px; }

  /* --- Buttons --- */
  .btn { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 6px 18px; border-radius: var(--ccp-radius-sm); cursor: pointer; font-size: inherit; font-weight: 600; transition: background-color .12s ease, transform .08s ease; }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn:active { transform: scale(0.97); }
  .btn-green { background: var(--ccp-green); color: #fff; }
  .btn-green:hover { background: var(--ccp-green-hover); }
  /* Quiet (nothing pending): "Restore Last Applied" has nothing to revert, so it
     recedes to an outline instead of shouting in solid green. The border is an
     inset box-shadow, not a real border, so the box stays the same size as the
     solid state and toggling between them never shifts layout. */
  .btn-green.quiet { background: transparent; color: var(--ccp-green); box-shadow: inset 0 0 0 1px var(--ccp-green); }
  .btn-green.quiet:hover { background: rgba(63, 163, 77, 0.12); }
  .btn-red { background: var(--ccp-red); color: #fff; }
  .btn-red:hover { background: var(--ccp-red-hover); }
  /* Open VS Code Settings / Reload Window: a quieter outline button, same size
     and shape as the green/red actions so all 4 read as one cohesive row instead
     of a mix of buttons and bare links. */
  .btn-outline {
    background: transparent; color: var(--vscode-foreground);
    box-shadow: inset 0 0 0 1px var(--vscode-panel-border); display: inline-flex;
    align-items: center; gap: 6px;
  }
  .btn-outline:hover { background: var(--vscode-list-hoverBackground); }
  /* Reload Window becomes the same green/warning badge language as
     "Restore Last Applied" once a reload is actually pending, so the one
     action that matters right now stands out from the row. */
  .btn-outline.btn-reload-pending {
    background: var(--vscode-statusBarItem-warningBackground, #b7791f);
    color: #fff; box-shadow: none;
  }
  .btn-outline.btn-reload-pending:hover { filter: brightness(1.08); }

  /* --- Toggle switch (pill + sliding thumb) replacing the plain On/Off button --- */
  .knob .switch { display: flex; align-items: center; justify-content: flex-end; gap: 8px; width: 100%; background: none; border: none; padding: 0; cursor: pointer; font-size: inherit; font-weight: 600; }
  .switch-track {
    position: relative; width: 34px; height: 18px; border-radius: 999px; flex-shrink: 0;
    background: var(--vscode-button-secondaryBackground); transition: background-color .15s ease;
  }
  .switch.on .switch-track { background: var(--ccp-green); }
  .switch-thumb {
    position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
    background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.35); transition: transform .15s ease;
  }
  .switch.on .switch-thumb { transform: translateX(16px); }
  .switch-text { min-width: 26px; text-align: right; color: var(--vscode-descriptionForeground); font-size: .92em; }
  .switch.on .switch-text { color: var(--ccp-green); }

  /* --- Bottom action bar --- */
  .actions { margin-top: 16px; display: flex; flex-direction: row; justify-content: space-between; align-items: center; gap: 10px; }
  .actions-right { display: flex; flex-direction: row; align-items: center; gap: 16px; }
  .actions-right a.link { margin-top: 0; }

  /* Every header status is a full-width banner so the strip never changes height
     between states: green when everything is applied, yellow when a reload is due
     or the version is unsupported. */
  .status-banner { display: flex; align-items: center; gap: 8px; color: #fff; padding: 6px 14px; border-radius: var(--ccp-radius-sm); font-weight: 700; font-size: .92em; }
  .status-banner.ok { background: var(--ccp-green); }
  .status-banner.warn { background: var(--vscode-statusBarItem-warningBackground, #b7791f); }
  .status-icon { font-size: 1.05em; }
  .dot { font-size: .8em; }
  .dot-ok { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .dot-warn { color: var(--vscode-editorWarning-foreground); }
  a.link { display: inline-flex; align-items: center; gap: 6px; color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; font-size: 1em; }
  a.link:hover { text-decoration: underline; }
  .link-icon { font-size: 1.05em; }
  /* The reload link is always a badge with the same box in both states, so it
     never jitters when the pending state flips: green while everything is
     applied, yellow when a reload is due. */
  a.link.link-reload { background: var(--ccp-green); color: #fff; padding: 4px 13px; border-radius: 999px; font-weight: 700; }
  a.link.link-reload:hover { text-decoration: none; filter: brightness(1.08); }
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
