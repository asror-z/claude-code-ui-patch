// Shared docked toolbar: a single inline cluster of chip buttons docked into the
// composer's action-footer row, to the LEFT of the native "Bypass permissions"/send
// group. Toc, Export, Scroll, UserNav, and FeatureToggle register into it via
// window.__ccToolbar.add(...) instead of each floating its own button, so every
// injected action lives in one stable, freeze-proof host (an earlier per-message
// floating button design self-fed a MutationObserver loop that froze the webview).
export const TOOLBAR_SOURCE = `
(function () {
  "use strict";
  var D = document;
  var W = window;
  var BAR_ID = "cc-toolbar";
  var FOOTER_SEL = "[class*='inputFooter']";
  var RIGHT_GROUP_SEL = "[class*='container_']";

  var queue = (W.__ccToolbarQueue = W.__ccToolbarQueue || []);
  var specs = (W.__ccToolbarSpecs = W.__ccToolbarSpecs || {});

  function barEl() { return D.getElementById(BAR_ID); }
  function footerEl() { return D.querySelector(FOOTER_SEL); }

  function ensureBar() {
    var footer = footerEl();
    if (!footer) return null;
    var bar = barEl();
    if (bar && bar.parentElement === footer) return bar;
    if (!bar) {
      bar = D.createElement("div");
      bar.id = BAR_ID;
      bar.className = "cc-toolbar";
      bar.setAttribute("role", "toolbar");
      bar.setAttribute("aria-label", "Chat tools");
    } else if (bar.parentElement && bar.parentElement !== footer) {
      bar.parentElement.removeChild(bar);
    }
    var rightGroup = footer.querySelector(":scope > " + RIGHT_GROUP_SEL) ||
      footer.querySelector(RIGHT_GROUP_SEL);
    if (rightGroup && rightGroup.parentElement === footer) footer.insertBefore(bar, rightGroup);
    else footer.appendChild(bar);
    return bar;
  }

  function cssEsc(s) { return String(s).replace(/["\\\\]/g, "\\\\$&"); }

  function renderButton(bar, spec) {
    var existing = bar.querySelector(':scope > [data-cc-tool="' + cssEsc(spec.id) + '"]');
    if (existing) return existing;
    var btn = D.createElement("button");
    btn.type = "button";
    btn.className = "cc-toolbar-btn cc-btn";
    btn.setAttribute("data-cc-tool", spec.id);
    btn.setAttribute("aria-label", spec.label || spec.id);
    btn.setAttribute("title", spec.label || spec.id);
    btn.textContent = spec.icon || "\\u2022";
    if (typeof spec.onClick === "function") {
      btn.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        try { spec.onClick(ev, btn); } catch (e) {}
      });
    }
    var order = typeof spec.order === "number" ? spec.order : 100;
    btn.setAttribute("data-cc-order", String(order));
    var kids = bar.querySelectorAll(":scope > [data-cc-order]");
    var before = null;
    for (var i = 0; i < kids.length; i++) {
      if (parseInt(kids[i].getAttribute("data-cc-order"), 10) > order) { before = kids[i]; break; }
    }
    bar.insertBefore(btn, before);
    return btn;
  }

  function add(spec) {
    if (!spec || !spec.id) return null;
    specs[spec.id] = spec;
    var bar = ensureBar();
    if (bar) return renderButton(bar, spec);
    queue.push(spec);
    return null;
  }
  function get(id) {
    var bar = barEl();
    return bar ? bar.querySelector(':scope > [data-cc-tool="' + cssEsc(id) + '"]') : null;
  }

  function drain() {
    var bar = ensureBar();
    if (!bar) return;
    var all = {};
    for (var k in specs) all[k] = specs[k];
    for (var i = 0; i < queue.length; i++) {
      if (queue[i] && queue[i].id) { all[queue[i].id] = queue[i]; specs[queue[i].id] = queue[i]; }
    }
    queue.length = 0;
    var list = Object.keys(all).map(function (k) { return all[k]; });
    list.sort(function (a, b) {
      return (typeof a.order === "number" ? a.order : 100) - (typeof b.order === "number" ? b.order : 100);
    });
    for (var j = 0; j < list.length; j++) renderButton(bar, list[j]);
  }

  W.__ccToolbar = { add: add, get: get, _ensure: ensureBar };

  var pending = null;
  function schedule(mutations) {
    if (mutations && mutations.length) {
      var external = false;
      for (var i = 0; i < mutations.length; i++) {
        var t = mutations[i].target;
        if (!(t && (t.id === BAR_ID || (t.closest && t.closest("#" + BAR_ID))))) { external = true; break; }
      }
      if (!external) return;
    }
    if (pending) return;
    pending = W.setTimeout(function () { pending = null; try { drain(); } catch (e) {} }, 150);
  }

  function init(doc, win) {
    D = doc; W = win || window;
    queue = (W.__ccToolbarQueue = W.__ccToolbarQueue || queue || []);
    specs = (W.__ccToolbarSpecs = W.__ccToolbarSpecs || specs || {});
    W.__ccToolbar = { add: add, get: get, _ensure: ensureBar };
    try { drain(); } catch (e) {}
    try {
      var obs = new W.MutationObserver(schedule);
      obs.observe(D.body, { childList: true, subtree: true });
    } catch (e) {}
  }

  window.__ccOnChatDoc(init);
})();
`.trim();

export const TOOLBAR_CSS = `
.cc-toolbar {
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;
  margin: 0 6px 0 0;
  padding: 0;
  background: transparent;
  border: none;
  vertical-align: middle;
}
.cc-toolbar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 23px;
  height: 23px;
  padding: 0;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  color: var(--cc-fg, #ddd);
  background: var(--cc-surface-2, var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.18)));
  border: 1px solid var(--cc-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35)));
  border-radius: 7px;
  box-shadow: var(--cc-shadow-sm, 0 2px 8px rgba(0, 0, 0, 0.35));
  opacity: 0.95;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease, transform 0.08s ease;
}
.cc-toolbar-btn:hover,
.cc-toolbar-btn[aria-expanded="true"],
.cc-toolbar-btn[aria-pressed="true"],
.cc-toolbar-btn.cc-active {
  opacity: 1;
  color: var(--cc-accent-fg, #fff);
  background: var(--cc-accent, #0e639c);
  border-color: var(--cc-accent, #0e639c);
}
.cc-toolbar-btn:active { transform: translateY(0.5px) scale(0.96); box-shadow: none; }
@media (prefers-reduced-motion: reduce) { .cc-toolbar-btn { transition: none; } }
`.trim();
