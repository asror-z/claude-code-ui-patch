import { registerFeature } from "./behaviorFeatures";

const JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-usercol] Chat UserCollapse Feature.js loaded");
  } catch (e) {}

  var BTN_ATTR = "data-cc-usercol-btn"; // marks OUR injected menu item

  // D/W = the chat Document/Window (set by init()).
  var D = document;
  var W = window;

  /*
   * Native "Show more" / "Show less" controls Claude Code itself only renders when a message's content actually overflows its collapsed height (its own >2-line truncation heuristic) — never guessed here, just detected.
   * Version-proof: matched by CLASS-NAME SUBSTRING (the extension mints the hash suffix), never a literal hashed token.
   *
   * CRITICAL: "Show more" (expandButton_) is rendered ONLY while the message is actively HOVERED — Claude Code's own component gates it on a local hover state, so on a collapsed, non-hovered message it does not exist in the DOM AT ALL (confirmed live: our popup item never appeared for a collapsed message, hover or not, because by the time this ran the hover state had already lapsed).
   * "Show less" (collapseButton_) has NO such gate — it is present whenever the message is expanded, regardless of hover.
   *
   * The FIX: detect "collapsed with overflow" via the hover-INDEPENDENT collapsed_<hash> class Claude Code applies to the content div itself (set purely from expanded/overflow state, never from hover) — and click its PARENT contentWrapper_<hash> div instead of the maybe-absent "Show more" button.
   * The button itself has NO click handler of its own; it relies entirely on bubbling from the wrapper's own onClick (attached whenever collapsed+overflowing, independent of hover) — so dispatching a click directly on the wrapper reproduces the exact same effect, reliably, whether or not "Show more" happens to be currently rendered.
   */
  var EXPAND_SEL = "[class*='expandButton_']"; // used opportunistically when it IS present
  var COLLAPSE_SEL = "[class*='collapseButton_']"; // always reliable when expanded
  var COLLAPSED_MARKER_SEL = "[class*='collapsed_']"; // hover-independent: collapsed WITH overflow
  var CONTENT_WRAPPER_SEL = "[class*='contentWrapper_']"; // click target when Show-more isn't rendered

  /*
   * Claude Code's own "Message actions" (⤴) button — a round icon-only button native to EVERY message, opening a dropdown POPUP with options like "Fork conversation from here" / "Rewind code to here".
   * Matched by its title attribute, which is stable, human-readable UI text — not a minifier-hashed class name — so no hash-suffix wildcard is needed.
   */
  var MSG_ACTIONS_SEL = "button[title='Message actions']";
  // The popup itself and its option rows — version-proof CLASS-NAME SUBSTRING
  // match (the extension mints the hash suffix), mirroring EXPAND_SEL/COLLAPSE_SEL.
  var POPUP_SEL = "[class*='popup_']";
  var POPUP_OPTION_SEL = "[class*='popupOption_']";
  var OPTION_TEXT_SEL = "[class*='optionText_']";

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

  /**
   * Find the currently-live overflow state + click target inside this message.
   * Checked in this order:
   * 1. "Show less" (collapseButton_) — reliable, hover-independent signal of EXPANDED + overflowing. Click it directly to collapse.
   * 2. The hover-independent "collapsed_" marker — signals COLLAPSED + overflowing even when "Show more" itself isn't currently rendered (not hovered).
   *    Prefer clicking the real "Show more" button when it DOES happen to be present (marginally more "native"-feeling), else fall back to its parent contentWrapper_, which carries the same click-to-expand handler regardless of hover.
   * Returns null only when the message genuinely has no overflow at all (no native control would ever exist for it, hover or not).
   * @param {Element} msgEl - The user message element to inspect.
   * @returns {{el: Element, collapsed: boolean}|null} The live control + its collapsed state, or null when no overflow exists.
   */
  function nativeControl(msgEl) {
    var col = msgEl.querySelector ? msgEl.querySelector(COLLAPSE_SEL) : null;
    if (col) return { el: col, collapsed: false };
    var collapsedMarker = msgEl.querySelector ? msgEl.querySelector(COLLAPSED_MARKER_SEL) : null;
    if (!collapsedMarker) return null;
    var exp = msgEl.querySelector ? msgEl.querySelector(EXPAND_SEL) : null;
    if (exp) return { el: exp, collapsed: true };
    var wrapper = msgEl.querySelector ? msgEl.querySelector(CONTENT_WRAPPER_SEL) : null;
    if (wrapper) return { el: wrapper, collapsed: true };
    return null;
  }

  function fireClick(el) {
    try {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: W }));
    } catch (e) {
      try { el.click(); } catch (e2) {}
    }
  }

  /**
   * Grab the FIRST popupOption's class list so our injected item matches the native ones exactly (font, padding, hover state) without hardcoding the hash.
   * Falls back to a bare class name if no option ever rendered yet (harmless — it just means nothing is open to copy from right now).
   * @param {Element} popupEl - The open native "Message actions" popup element.
   * @returns {string} The sampled popupOption class list, or an empty string when no sample exists.
   */
  function popupOptionClass(popupEl) {
    var sample = popupEl.querySelector ? popupEl.querySelector(POPUP_OPTION_SEL) : null;
    return sample ? sample.className : "";
  }
  function optionTextClass(popupEl) {
    var sample = popupEl.querySelector ? popupEl.querySelector(OPTION_TEXT_SEL) : null;
    return sample ? sample.className : "";
  }

  function makeMenuItem(msgEl, popupEl) {
    var btn = D.createElement("button");
    btn.type = "button";
    btn.className = popupOptionClass(popupEl) + " cc-usercol-item";
    btn.setAttribute(BTN_ATTR, "1");
    var span = D.createElement("span");
    span.className = optionTextClass(popupEl) + " cc-usercol-item-text";
    btn.appendChild(span);
    btn.addEventListener("click", function (ev) {
      try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
      var ctl = nativeControl(msgEl);
      if (ctl) fireClick(ctl.el);
      /*
       * Close the native popup the same way a real option click would.
       * It has its own outside-click / onClick handlers we don't control, so dispatching a click on the "Message actions" trigger toggles it shut.
       */
      var trigger = msgEl.querySelector ? msgEl.querySelector(MSG_ACTIONS_SEL) : null;
      if (trigger) fireClick(trigger);
    });
    return btn;
  }

  /*
   * Insert OUR menu item as the FIRST row of the native "Message actions" POPUP — never as a persistently-docked floating icon.
   * Two things this sidesteps, both confirmed live on this project:
   * (1) A message with no overflowing content (or one where the always-on "Message actions" trigger itself never rendered in time, e.g. a harness <task-notification> block) has nothing stable to anchor a floating icon to at all — a bare "no native control found" case.
   * (2) Even when anchored correctly, "Message actions" is a live React component (uYe) that re-renders on hover/state changes and reconciles ANY manually-inserted sibling out of existence — a floating icon docked next to it can vanish on the very next hover.
   * The popup itself only exists in the DOM while OPEN (a real user click, not hover), so it is a far rarer, more deliberate re-render trigger — and menu items are a well-understood, already-idiomatic place users look for "more actions on this message" in this exact UI.
   */
  function enabled() {
    try { return window.__ccFeature ? window.__ccFeature("usercollapse") !== false : true; } catch (e) { return true; }
  }

  function ensurePopupItem(msgEl) {
    var popupEl = msgEl.querySelector ? msgEl.querySelector(POPUP_SEL) : null;
    if (!popupEl) return;
    if (!enabled()) {
      var off = popupEl.querySelector ? popupEl.querySelector("[" + BTN_ATTR + "]") : null;
      if (off && off.parentElement) off.parentElement.removeChild(off);
      return;
    }
    var ctl = nativeControl(msgEl);
    if (!ctl) {
      // No overflow on this message right now — nothing to toggle, so no item to inject even while the popup happens to be open.
      var stale = popupEl.querySelector ? popupEl.querySelector("[" + BTN_ATTR + "]") : null;
      if (stale && stale.parentElement) stale.parentElement.removeChild(stale);
      return;
    }
    var item = popupEl.querySelector ? popupEl.querySelector("[" + BTN_ATTR + "]") : null;
    if (!item) {
      item = makeMenuItem(msgEl, popupEl);
      popupEl.insertBefore(item, popupEl.firstChild);
    } else if (item.parentElement !== popupEl || popupEl.firstChild !== item) {
      popupEl.insertBefore(item, popupEl.firstChild);
    }
    var label = ctl.collapsed ? "Expand message" : "Collapse message";
    var span = item.querySelector ? item.querySelector(".cc-usercol-item-text") : null;
    if (span) span.textContent = label;
    item.setAttribute("aria-label", label);
  }

  function run() {
    var msgs = findUserMessages();
    for (var i = 0; i < msgs.length; i++) ensurePopupItem(msgs[i]);
  }

  /**
   * NEVER route this feature's observer through window.__ccObserve.
   * Its self-churn filter classifies a mutation as "ours" by checking whether the ADDED/REMOVED node itself carries our own class/attribute — which is exactly backwards for this feature's failure mode: when Claude Code's OWN React reconciliation removes OUR previously-inserted popup item (rebuilding the popup's children on every re-render of its owning component, per this feature's own CLAUDE.md history), the REMOVED node still carries our "cc-usercol-item" class, so __ccObserve's isOwnNode() matches it and the whole removal gets misclassified as harmless self-churn — silently suppressing the very resweep that would put the item back.
   * This is the SAME class of bug userstyle.ts's own comment documents ("the shared filter treated the tag-attribute write as self-churn... suppressed the sweep so NEW messages never got tagged"), just triggered by React's removal instead of a streaming batch.
   * The fix mirrors userstyle.ts's own choice: use the PLAIN observer below, whose schedule() checks the mutation's TARGET (the popup's parent, which never carries our class) rather than the added/removed nodes — so React silently wiping our item still counts as an external change and correctly re-triggers run().
   * @param {MutationRecord[]} mutations - Mutations reported by the plain MutationObserver.
   * @returns {void}
   */
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
      new W.MutationObserver(schedule).observe(D.body, { childList: true, subtree: true });
    } catch (e) {}
  }

  register(init);

  /**
   * Order-independent registration: if the bootstrap is already installed, hand off now; otherwise queue onto window.__ccPending — the bootstrap drains it the moment it installs.
   * A last-resort timer covers the impossible case where no bootstrap ever appears, running once against the current document.
   * @param {Function} fn - The init function to register against the chat document.
   * @returns {void}
   */
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
/*
 * UserCollapse — adds an "Expand message" / "Collapse message" MENU ITEM as the first row of Claude Code's own native "Message actions" popup (beside "Fork conversation from here", "Rewind code to here", etc.) for a long user prompt that has native overflow.
 * It reuses the popup's own native popupOption/optionText classes (copied live from a sibling option, so it inherits the exact same font/padding/hover styling with no hash to hardcode) and only adds a thin visual affordance on top.
 * The native "Show more" / "Show less" TEXT controls stay fully in place, untouched and unhidden — clicking our item proxies a real click onto whichever native control is currently live, so Claude Code's own expand/collapse logic (and its own overflow heuristic deciding whether a control exists AT ALL) is untouched.
 */

button.cc-usercol-item[data-cc-usercol-btn="1"] {
  width: 100%;
  text-align: left;
}
`.trim();

registerFeature({ id: "usercollapse", label: "User-message expand/collapse icon", js: JS, css: CSS });
