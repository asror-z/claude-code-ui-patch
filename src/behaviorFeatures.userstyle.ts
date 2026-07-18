import { registerFeature } from "./behaviorFeatures";

const JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-userstyle] Chat UserStyle Feature.js loaded");
  } catch (e) {}

  var TAG = "data-cc-user";

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

  // Harness-injected NOTIFICATION blocks (a <task-notification> reporting a background
  // agent finished, and similar <tool-use-id>/<system-reminder> blocks) are AGENT/system
  // messages that the webview renders INSIDE a user-role container (userMessageContainer).
  // They are NOT user messages and must NOT be turned into a right-aligned user bubble —
  // they stay in the standard agent style. Detect them version-proof by one of these
  // leading notification tags (a raw angle-bracket tag the webview shows verbatim)
  // appearing near the start of the element's own trimmed text, mirroring how
  // AutoContinue hard-excludes containers. NOT anchored to position 0 (no leading ^):
  // a "Show more" toggle or a role/avatar label sharing the same container can push the
  // real tag text past the very first character, silently defeating a ^-anchored match
  // (confirmed live — see behaviorBootstrap.ts's own hideNotificationBlocks for the same
  // fix and the incident it was found from). Checking only the first ~200 chars keeps
  // this from false-matching a tag name merely quoted deep inside unrelated prose.
  var NOTIFICATION_RE = /<\\s*(?:task-notification|task-id|tool-use-id|output-file|system-notification|system-reminder)\\b/i;
  function isUserNotification(el) {
    if (!el) return false;
    // (a) the candidate itself leads with a notification tag …
    var t = (el.textContent || "").slice(0, 200);
    if (NOTIFICATION_RE.test(t)) return true;
    // (b) … or it lives inside such a block (an ancestor leads with the tag).
    var p = el.parentElement;
    while (p) {
      if (p.textContent && NOTIFICATION_RE.test(p.textContent.slice(0, 200))) return true;
      p = p.parentElement;
    }
    return false;
  }

  function findUserMessages(doc) {
    var set = new Set();
    for (var i = 0; i < USER_SELECTORS.length; i++) {
      var nodes = doc.querySelectorAll(USER_SELECTORS[i]);
      for (var j = 0; j < nodes.length; j++) {
        // Hard-exclude harness notification blocks — never style them as a user bubble.
        if (isUserNotification(nodes[j])) continue;
        set.add(nodes[j]);
      }
    }
    // NOTE: Array.prototype.slice.call(set) returns [] — a Set has no \`length\`,
    // so slice sees nothing. Use Array.from to actually materialise the members.
    var list = Array.from(set);
    // keep only the outermost matches (so a bubble is tagged once)
    return list.filter(function (el) {
      var p = el.parentElement;
      while (p) {
        if (set.has(p)) return false;
        p = p.parentElement;
      }
      return true;
    });
  }

  // Warn ONCE per document if the chat clearly has content but no user message
  // matched — surfaces a webview redesign loudly instead of failing silently.
  var _warned = false;
  function warnIfBlind(doc, found) {
    if (found || _warned) return;
    if (doc.body && (doc.body.textContent || "").trim().length > 200) {
      _warned = true;
      try {
        console.warn(
          "[cc-userstyle] no user messages matched on a non-empty chat — the " +
            "webview layout likely changed; update USER_SELECTORS in " +
            "Chat UserStyle Feature.js."
        );
      } catch (e) {}
    }
  }

  function run(doc) {
    var msgs = findUserMessages(doc);
    warnIfBlind(doc, msgs.length > 0);
    for (var i = 0; i < msgs.length; i++) {
      if (msgs[i].getAttribute(TAG) !== "1") msgs[i].setAttribute(TAG, "1");
    }
  }

  // init(doc, win) — called by the bootstrap with the chat document, and again
  // whenever the bootstrap re-detects the chat DOM. Each call wires a fresh
  // observer on that document.
  function init(doc, win) {
    var pending = null;
    function schedule() {
      if (pending) return;
      pending = win.setTimeout(function () {
        pending = null;
        try { run(doc); } catch (e) {}
      }, 100);
    }
    try { run(doc); } catch (e) {}
    // PLAIN debounced observer (NOT __ccObserve). UserStyle's ONLY write is an idempotent
    // setAttribute (run() guards it with getAttribute(TAG) !== "1"), so it is ALREADY
    // freeze-safe: a re-run tags nothing new → emits no mutation → the observer goes quiet
    // on its own. Routing it through __ccObserve with ownAttrPrefix was a mistake — the
    // shared filter treated the tag-attribute write as self-churn and, in a mixed streaming
    // batch, suppressed the sweep so NEW messages never got tagged (observed live:
    // userTagged=0). __ccObserve is for element-APPENDING features (React-strip loops), not
    // for pure attribute tags. schedule() debounces run() ~100ms.
    try {
      new win.MutationObserver(schedule).observe(doc.body, {
        childList: true,
        subtree: true,
      });
    } catch (e) {}
  }

  register(init);

  // Order-independent registration: if the bootstrap is already installed, hand
  // off now; otherwise queue onto window.__ccPending — the bootstrap drains it the
  // moment it installs (it is injected too, so it WILL load). A last-resort timer
  // covers the impossible case where no bootstrap ever appears, running once
  // against the current document (the chat DOM lives in THIS document).
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
/* User-message styling. The JS tags each user-message bubble with
   data-cc-user="1"; these rules target that hook.

   STYLE: a messenger-style CHAT BUBBLE for the user prompt — a filled, rounded,
   padded card aligned to the RIGHT side of the chat (like the reference: a soft
   gray bubble hugging the right edge). Bold text, no quote bar, no border. */

[data-cc-user="1"] {
  /* filled rounded bubble */
  background: var(--vscode-toolbar-hoverBackground, rgba(140, 140, 140, 0.16)) !important;
  border: none !important;
  border-radius: 14px !important;
  padding: 12px 16px !important;
  /* push the bubble to the RIGHT and cap its width so it reads as a sent message */
  width: fit-content;
  max-width: 80%;
  margin: 10px 0 10px auto !important; /* auto-left → right-aligned */
  box-sizing: border-box;
  font-weight: 600;
  /* keep long content readable inside the bubble */
  overflow-wrap: anywhere;
}

/* Text inside the bubble: bold, left-aligned within the right-aligned card. */
[data-cc-user="1"] p,
[data-cc-user="1"] span,
[data-cc-user="1"] li,
[data-cc-user="1"] div {
  font-weight: 600;
  text-align: left;
}

[data-cc-user="1"] code,
[data-cc-user="1"] pre {
  font-weight: 600;
}

/* The bubble already has padding; drop the first/last child's stray margins so the
   text sits snugly inside the card. */
[data-cc-user="1"] > :first-child { margin-top: 0; }
[data-cc-user="1"] > :last-child { margin-bottom: 0; }
`.trim();

registerFeature({ id: "userstyle", label: "User-message styling", js: JS, css: CSS });
