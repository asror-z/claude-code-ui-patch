// Registry of chat-enhancement features (ported from the smarts-claude-patch skill's
// standalone webview/assets/*.js|.css pair-per-feature model into this extension's
// inline-injection convention — see behaviorInject.ts for how these are assembled and
// spliced into extension.js/webview/index.js|css).
//
// Each entry's `js`/`css` is the feature's IIFE source (registers via
// window.__ccOnChatDoc, exactly like the shared bootstrap in behaviorBootstrap.ts
// expects) and matching stylesheet. `label` is shown in the FeatureToggle gear panel
// and the settings description; order matches load/sweep order (a dependent, e.g.
// CopyButtons on DateTime, is listed after its dependency).
import { BOOTSTRAP_SOURCE, BOOTSTRAP_CSS } from "./behaviorBootstrap";
import { TOOLBAR_SOURCE, TOOLBAR_CSS } from "./behaviorToolbar";

export interface BehaviorFeature {
  id: string;
  label: string;
  js: string;
  css: string;
}

// Populated by behaviorFeatures.*.ts modules (one per feature) via registerFeature().
const REGISTRY: BehaviorFeature[] = [];

export function registerFeature(f: BehaviorFeature): void {
  if (REGISTRY.some((x) => x.id === f.id)) return; // idempotent against re-import
  REGISTRY.push(f);
}

// bootstrap + toolbar are infrastructure, always injected first, before any
// user-facing feature and not listed as toggleable rows themselves.
export function infrastructureSources(): { js: string; css: string }[] {
  return [
    { js: BOOTSTRAP_SOURCE, css: BOOTSTRAP_CSS },
    { js: TOOLBAR_SOURCE, css: TOOLBAR_CSS },
  ];
}

export function allFeatures(): BehaviorFeature[] {
  return REGISTRY;
}
