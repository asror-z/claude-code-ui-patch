import * as vscode from "vscode";
import { Patcher, Snapshot, Knob, FeatureState, SECTION_ORDER, STEP, MIN_PX } from "./patcher";

// A webview panel that serves as the detailed control surface (opened by
// clicking the status-bar item). The hover tooltip is a compact read-only
// summary; this panel adds per-knob ▼/▲ adjust, Restore Last Applied / Factory
// Reset, and per-knob sync-state dots. Communication uses postMessage.
//
// Snappiness: clicking an arrow updates the px display in the webview
// immediately (optimistically) and posts the absolute target value. The full
// HTML is rebuilt only when the panel's structure changes (version, which knobs
// exist); ordinary value/dot/status updates are pushed as lightweight "sync"
// messages that patch the DOM in place, so nothing reloads on each click.
export class PatchPanel {
  private static current: PatchPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly sub: vscode.Disposable;
  private shape = ""; // signature of the last full render's structure

  private constructor(private readonly patcher: Patcher) {
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

  static show(patcher: Patcher): void {
    if (PatchPanel.current) {
      PatchPanel.current.panel.reveal();
      return;
    }
    PatchPanel.current = new PatchPanel(patcher);
  }

  // Full re-render on a structural change; otherwise patch the DOM in place.
  private update(): void {
    const snap = this.patcher.snapshot();
    const shape = shapeOf(snap);
    if (shape !== this.shape) {
      this.shape = shape;
      this.panel.webview.html = this.html(snap);
    } else if (snap) {
      void this.panel.webview.postMessage({ type: "sync", ...syncPayload(snap) });
    }
  }

  private async onMessage(msg: {
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

  private html(snap: Snapshot | undefined): string {
    const nonce = getNonce();
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">`;
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

    // Chat Enhancement Features: one real checkbox per feature, shown only while the
    // chatEnhancements master switch is on. Checking/unchecking writes straight to
    // claudeCodeUiPatch.feature.<id> (a seed setting — see Patcher.setFeature), so
    // this is the ONE control surface for per-feature on/off (no in-webview gear).
    // Rendered immediately under the "chat enhancements" knob itself (not appended at
    // the panel's end), so it needs no scrolling to reach.
    const chatEnhOn = snap.knobs.some((k) => k.id === "chatEnhancements" && k.on);
    const featuresBlock = chatEnhOn
      ? `      <div class="feature-grid">\n${snap.features
          .map((f) => this.featureHtml(f))
          .join("\n")}\n      </div>\n`
      : "";

    // Each section (Chat Panel or Tab, Plan Mode Markdown Preview) renders as its
    // own column side-by-side in a 2-column grid, rather than one long vertical
    // flow — this fills the panel's full width instead of leaving the right half
    // empty. Columns wrap to a single stacked column automatically in a narrow
    // window (see .section-grid below).
    const sections = groups
      .map((g) => {
        const rows = g.knobs
          .map((k) => {
            const row = this.knobHtml(k);
            // Splice the feature checkboxes right after the chatEnhancements row.
            return k.id === "chatEnhancements" ? `${row}\n${featuresBlock}` : row;
          })
          .join("\n");
        return `    <div class="section-col">\n      <h2>${g.sec}</h2>\n${rows}\n    </div>`;
      })
      .join("\n");

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
    <button class="btn btn-red" data-cmd="restore" title="Reset every setting to Claude Code's native values">Factory Reset</button>
  </div>
  <a class="link" data-cmd="openSettings">&#9881; Open VS Code Settings</a>
  <a class="link link-reload${snap.needsReload ? " link-reload-pending" : ""}" data-cmd="reload">&#8635; Reload Window</a>
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

// Structure signature: a full re-render happens only when this changes.
function shapeOf(snap: Snapshot | undefined): string {
  if (!snap || !snap.available) return "none";
  // chatEnhancements' on/off also gates whether the Chat Enhancement Features
  // checkboxes render under it, so a flip must trigger a full re-render, not just a
  // value sync.
  const chatEnh = snap.knobs.find((k) => k.id === "chatEnhancements");
  return [
    snap.supported,
    snap.version,
    snap.knobs.map((k) => k.id).join(","),
    chatEnh ? chatEnh.on : "",
  ].join("|");
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
    max-width: 1080px;
    padding: 16px 28px;
  }
  h1 { font-size: 1.7em; font-weight: 700; margin: 0; }
  .spacer { height: 2px; }
  .version-line { font-size: 1.1em; font-weight: 400; margin-bottom: 2px; }
  .version-value { color: #d97757; }
  .header-status { margin-top: 4px; margin-bottom: 1px; font-size: 1.1em; font-weight: 500; }
  h2 { font-size: 1.1em; margin: 6px 0 3px; }
  .knob { display: flex; align-items: center; padding: 1px 0; line-height: 1.15; }
  .knob .dot-slot { width: 14px; flex-shrink: 0; text-align: center; margin-right: 14px; }
  .knob .label { flex: 1 1 auto; min-width: 160px; }
  /* Two columns whenever there's room (>= ~340px per column), one column in a
     narrow panel — auto-fit avoids a forced 2-up layout that would overflow or
     leave an awkward gap in a resized/narrow window. */
  .feature-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); column-gap: 20px; row-gap: 0; padding-left: 28px; }
  /* The two top-level sections (Chat Panel or Tab, Plan Mode Markdown Preview) sit
     side-by-side, each its own column, so the panel's full width is used instead of
     a single long vertical flow with an empty right half. Wraps to one stacked
     column automatically once the panel is too narrow for two ~420px columns. */
  .section-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); column-gap: 32px; align-items: start; }
  .section-col + .section-col { border-left: 1px solid var(--vscode-panel-border); padding-left: 32px; }
  .feature-row { display: flex; align-items: center; padding: 1px 0; line-height: 1.15; cursor: pointer; }
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
