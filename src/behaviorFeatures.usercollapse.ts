import { registerFeature } from "./behaviorFeatures";

const JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-usercol] Chat UserCollapse Feature.js loaded");
  } catch (e) {}

  var BTN_ATTR = "data-cc-usercol-btn";   // marks OUR toggle button
  var ATTACHED_ATTR = "data-cc-usercol";  // "1" once a message has been processed

  // D/W = the chat Document/Window (set by init()).
  var D = document;
  var W = window;

  var EXPAND_ICON = "⌄";   // chevron-down: message is collapsed, click to expand
  var COLLAPSE_ICON = "⌃"; // chevron-up: message is expanded, click to collapse

  // Native "Show more" / "Show less" controls Claude Code itself only renders when
  // a message's content actually overflows its collapsed height (its own >2-line
  // truncation heuristic) — never guessed here, just detected. Version-proof:
  // matched by CLASS-NAME SUBSTRING (the extension mints the hash suffix), never a
  // literal hashed token.
  var EXPAND_SEL = "[class*='expandButton_']";
  var COLLAPSE_SEL = "[class*='collapseButton_']";

  // Claude Code's own "Message actions" (⤴) button — a round icon-only button
  // native to EVERY message, always present regardless of overflow, sitting in
  // its own small top-right action row. Docking OUR toggle here (instead of
  // beside the native Show-more/Show-less control, which is position:absolute
  // bottom:0;right:0 on the expandable content box and only appears on hover —
  // see patcher.ts's SHOW_MORE_MARKER comment) keeps our icon in a fixed,
  // always-visible top-right spot next to a control the user already looks at,
  // rather than floating separately near the bottom of long messages (reported
  // live: the icon appeared "in the middle at the bottom" instead of up top).
  // Matched by its title attribute, which is stable, human-readable UI text —
  // not a minifier-hashed class name — so no hash-suffix wildcard is needed.
  var MSG_ACTIONS_SEL = "button[title='Message actions']";

  // The user-bubble selector (mirrors UserStyle's own robust list) — restricted to
  // USER prompts only, per this feature's scope.
  var USER_SELECTORS = [
    "[data-role='user']",
    "[data-message-author-role='user']",
    "[data-author='user']",
    "[data-testid*='user-message']",
    "[data-testid*='user_message']",
    "[class*='userMessage']",
    "[class*='UserMessage']",
    "[class*='user-message']",
    "[class*='message-user']",
    "[class*='userMessageContainer']",
  ];
  var EXCLUDE_RE = /messageInput|messagesContainer|messageGradient|fullEditor|stickyHeader/i;

  function findUserMessages() {
    var set = new Set();
    for (var i = 0; i < USER_SELECTORS.length; i++) {
      var nodes = D.querySelectorAll ? D.querySelectorAll(USER_SELECTORS[i]) : [];
      for (var j = 0; j < nodes.length; j++) {
        var cn = (nodes[j].getAttribute && nodes[j].getAttribute("class")) || "";
        if (EXCLUDE_RE.test(cn)) continue;
        set.add(nodes[j]);
      }
    }
    var list = Array.from(set);
    // outermost-only, so a bubble is processed once
    return list.filter(function (el) {
      var p = el.parentElement;
      while (p) {
        if (set.has(p)) return false;
        p = p.parentElement;
      }
      return true;
    });
  }

  // Find the currently-live native control inside this message: whichever of
  // "Show more" (collapsed state) / "Show less" (expanded state) is present. Only
  // one exists in the DOM at a time (React swaps them), so this also IS the
  // collapsed/expanded signal — no separate state to track ourselves.
  function nativeControl(msgEl) {
    var exp = msgEl.querySelector ? msgEl.querySelector(EXPAND_SEL) : null;
    if (exp) return { el: exp, collapsed: true };
    var col = msgEl.querySelector ? msgEl.querySelector(COLLAPSE_SEL) : null;
    if (col) return { el: col, collapsed: false };
    return null;
  }

  function fireClick(el) {
    try {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: W }));
    } catch (e) {
      try { el.click(); } catch (e2) {}
    }
  }

  function makeButton(msgEl) {
    var b = D.createElement("button");
    b.type = "button";
    b.className = "cc-usercol-btn cc-btn";
    b.setAttribute(BTN_ATTR, "1");
    b.addEventListener("click", function (ev) {
      try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
      var ctl = nativeControl(msgEl);
      if (ctl) fireClick(ctl.el);
    });
    return b;
  }

  // Dock OUR toggle immediately to the LEFT of the native "Message actions"
  // button's OWN CONTAINER — as a SIBLING of that container (one level up),
  // never as a child inserted INSIDE it. Claude Code's "Message actions"
  // wrapper is a live React component (uYe) that attaches its own
  // mouseenter/mouseleave listeners on the message and re-renders itself
  // (toggling its own container/actionButton classes) on every hover
  // transition. React reconciles that component's own children against its
  // virtual DOM on every such re-render, and a manually-inserted DOM node
  // living INSIDE that container is exactly the kind of "unexpected child"
  // React removes as part of reconciling it back to what its render function
  // returned — confirmed live: our button existed right after insertion, then
  // vanished the moment the message was hovered (the same interaction that
  // reveals the container's own hover-only Show more/less button). Docking
  // one level higher, as a sibling of the whole actions-button container
  // instead of a child inside it, keeps our button in a DOM slot that
  // component's own
  // reconciliation never inspects, since it only ever touches its own
  // subtree, not its position among ITS parent's other children.
  // Falls back to docking beside the native Show-more/Show-less control
  // itself when "Message actions" can't be found at all (a future Claude
  // Code build renaming/removing it), so the feature degrades instead of
  // silently doing nothing.
  function anchorRow(msgEl, ctl) {
    var actionsBtn = msgEl.querySelector ? msgEl.querySelector(MSG_ACTIONS_SEL) : null;
    if (actionsBtn) {
      var actionsContainer = actionsBtn.parentElement; // uYe's own <div class="container">
      var siblingParent = actionsContainer && actionsContainer.parentElement;
      if (siblingParent) {
        return { parent: siblingParent, before: actionsContainer };
      }
    }
    return { parent: ctl.el.parentElement, before: ctl.el };
  }

  function ensureButton(msgEl, ctl) {
    var anchor = anchorRow(msgEl, ctl);
    if (!anchor.parent) return;
    var btn = msgEl.querySelector ? msgEl.querySelector("[" + BTN_ATTR + "]") : null;
    if (!btn) {
      btn = makeButton(msgEl);
      anchor.parent.insertBefore(btn, anchor.before);
    } else if (btn.parentElement !== anchor.parent || btn.nextElementSibling !== anchor.before) {
      anchor.parent.insertBefore(btn, anchor.before);
    }
    btn.textContent = ctl.collapsed ? EXPAND_ICON : COLLAPSE_ICON;
    var label = ctl.collapsed ? "Expand message" : "Collapse message";
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
    btn.setAttribute("aria-expanded", ctl.collapsed ? "false" : "true");
    return btn;
  }

  function removeButton(msgEl) {
    var btn = msgEl.querySelector ? msgEl.querySelector("[" + BTN_ATTR + "]") : null;
    if (btn && btn.parentElement) btn.parentElement.removeChild(btn);
  }

  function process(msgEl) {
    var ctl = nativeControl(msgEl);
    if (!ctl) {
      // 1-2 line message (or already fully native, no overflow): no native
      // control exists, so no button of ours either — nothing to do.
      if (msgEl.getAttribute(ATTACHED_ATTR) === "1") removeButton(msgEl);
      msgEl.removeAttribute(ATTACHED_ATTR);
      return false;
    }
    msgEl.setAttribute(ATTACHED_ATTR, "1");
    ensureButton(msgEl, ctl);
    return true;
  }

  function run() {
    var msgs = findUserMessages();
    for (var i = 0; i < msgs.length; i++) process(msgs[i]);
    // Drop stray buttons left behind in a message that no longer has a native
    // expand/collapse control at all (e.g. content shrank after an edit).
    var strays = D.querySelectorAll ? D.querySelectorAll("[" + BTN_ATTR + "]") : [];
    for (var s = 0; s < strays.length; s++) {
      var host = null;
      for (var m = 0; m < msgs.length; m++) {
        if (msgs[m].contains(strays[s])) { host = msgs[m]; break; }
      }
      if (!host || !nativeControl(host)) {
        if (strays[s].parentElement) strays[s].parentElement.removeChild(strays[s]);
      }
    }
  }

  var pending = null;
  function schedule(mutations) {
    // Ignore mutations confined to our own button (icon/label swap self-churn).
    if (mutations && mutations.length) {
      var external = false;
      for (var i = 0; i < mutations.length; i++) {
        var t = mutations[i].target;
        if (!(t && t.closest && t.closest("[" + BTN_ATTR + "]"))) { external = true; break; }
      }
      if (!external) return;
    }
    if (pending) return;
    pending = W.setTimeout(function () {
      pending = null;
      try { run(); } catch (e) {}
    }, 140);
  }

  // init(doc, win) — bootstrap hands us the chat document; bind + observe it.
  function init(doc, win) {
    D = doc;
    W = win || window;
    try { run(); } catch (e) {}
    try {
      if (W.__ccObserve) {
        W.__ccObserve(D.body, run, { ownClass: "cc-usercol-btn", ownAttrPrefix: "data-cc-usercol" });
      } else {
        new W.MutationObserver(schedule).observe(D.body, { childList: true, subtree: true });
      }
    } catch (e) {}
  }

  register(init);

  // Order-independent registration: if the bootstrap is already installed, hand
  // off now; otherwise queue onto window.__ccPending — the bootstrap drains it the
  // moment it installs. A last-resort timer covers the impossible case where no
  // bootstrap ever appears, running once against the current document.
  function register(fn) {
    if (window.__ccOnChatDoc) { window.__ccOnChatDoc(fn); return; }
    (window.__ccPending = window.__ccPending || []).push(fn);
    var tries = 0;
    var t = setInterval(function () {
      if (window.__ccOnChatDoc) { clearInterval(t); return; }
      if (++tries >= 25) {
        clearInterval(t);
        try { fn(document, window); } catch (e) {}
      }
    }, 200);
  }
})();
`.trim();

const CSS = `
/* UserCollapse — adds a small ICON toggle for a long user prompt, docked
   immediately to the LEFT of the native "Message actions" button in its
   always-present top-right action row. The native "Show more" / "Show less"
   TEXT controls are left fully in place, untouched and unhidden — ours is an
   ADDITIONAL shortcut, not a replacement; clicking it proxies a real click onto
   whichever native control is currently live, so Claude Code's own
   expand/collapse logic (and its own >2-line overflow heuristic that decides
   whether a control exists AT ALL) is untouched. */

button.cc-usercol-btn[data-cc-usercol-btn="1"] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.7em;
  height: 1.7em;
  padding: 0 0.3em;
  margin: 0 0.25em 0 0;
  font-size: 1.05em;
  line-height: 1;
  cursor: pointer;
  border: none;
  border-radius: var(--cc-radius, 6px);
  background: transparent;
  color: inherit;
  opacity: 0.75;
}
button.cc-usercol-btn[data-cc-usercol-btn="1"]:hover {
  opacity: 1;
  background: var(--cc-chip-bg, var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.18)));
}
`.trim();

registerFeature({ id: "usercollapse", label: "User-message expand/collapse icon", js: JS, css: CSS });
