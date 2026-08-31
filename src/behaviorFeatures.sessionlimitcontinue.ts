/*
   SessionLimitContinue — when Claude Code's own session-usage-limit banner appears in the chat ("You've hit your session limit · resets 7:50pm" and its variants), this feature parses the RESET time out of the banner's own text.
   It waits until that moment (plus a fixed buffer), then auto-submits "continue" — so a long-running session resumes on its own instead of sitting idle until a human notices and retypes it.

   Distinct from AutoContinue (behaviorFeatures.autocontinue.ts): AutoContinue reacts to a TRANSIENT stream-drop/throttle banner after a short QUIET_MS with no new message.
   This feature reacts to Claude's own USAGE-LIMIT banner, which names a specific future RESET TIME rather than "retry shortly" — the correct response is to wait until that exact moment (+ a buffer), not a short quiet-period guess.
   Both share the same composer-submit mechanism (copied here, not imported — this is a standalone injected script, no cross-file JS import exists in this asset-pair model).

   Claude's own usage-limit banner text is known to vary — this extension has seen (and this feature is written to tolerate) several shapes:
     * "You've hit your session limit · resets 7:50pm"
     * "You've reached your usage limit. Resets at 7:50 PM"
     * "Usage limit reached. Your limit will reset at 19:50"
     * "5-hour limit reached · resets in 2h 30m"
     * "Session limit reached, resets in 45 minutes"
   The detector is a LOOSE phrase match ("session limit" / "usage limit" / "5-hour limit" combined with "reset") deliberately kept broad rather than pinned to one exact string, since Claude's own wording has already been observed to change.
   The TIME parser separately tries several shapes (clock time with optional am/pm, bare 24h clock time, or a relative "in Nh Mm"/"in N minutes"/"in N hours" duration) and only ever arms a wait when a real, well-formed time is actually found.
   An unparseable banner is logged and left alone rather than guessed at, since a wrong guess (firing too early) would waste the user's next session window.
*/
import { registerFeature } from "./behaviorFeatures";

const JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-sessionlimit] Chat SessionLimitContinue Feature loaded");
  } catch (e) {}

  var DONE_ATTR = "data-cc-sessionlimit"; // marks a banner we already armed/handled
  var ARMED_KEY = "cc-sessionlimit-armed"; // localStorage: survives a webview reload
  var OFF_KEY = "cc-sessionlimit-off";     // localStorage 'off' override

  var D = document;
  var W = window;

  // Loose phrase match on the LIMIT side — Claude's own wording has already varied
  // ("session limit" / "usage limit" / "5-hour limit" / "weekly limit"), always paired
  // with a reset-ing word somewhere in the same short banner.
  var LIMIT_RE = /\\\\b(?:session|usage|5-hour|weekly|daily)\\\\s+limit\\\\b/i;
  var RESET_WORD_RE = /\\\\breset(?:s|ting)?\\\\b/i;

  function offOverride() {
    try {
      return String((W.localStorage && W.localStorage.getItem(OFF_KEY)) || "").toLowerCase() === "off";
    } catch (e) { return false; }
  }

  // ---- time parsing (several tolerated shapes) -------------------------------------

  // Shape 1: clock time, optional am/pm — "7:50pm", "7:50 PM", "19:50", "07:50".
  var CLOCK_RE = /\\\\b(\\\\d{1,2}):(\\\\d{2})\\\\s*(am|pm)?\\\\b/i;
  // Shape 2: relative duration — "in 2h 30m", "in 45 minutes", "in 2 hours", "in 1h".
  var DURATION_RE = /\\\\bin\\\\s+(?:(\\\\d+)\\\\s*h(?:ours?)?)?\\\\s*(?:(\\\\d+)\\\\s*m(?:in(?:ute)?s?)?)?\\\\b/i;

  /**
   * Parses a session-limit reset moment out of banner text.
   * Never guesses — a banner whose time can't be confidently parsed yields null and this feature does nothing (logged), rather than arming a wrong wait.
   * @param {string} text - banner text to scan.
   * @param {Date} now - reference "now" for relative-duration/clock-time math.
   * @returns {Date|null} parsed future reset moment, or null when no well-formed time is found.
   */
  function parseResetTime(text, now) {
    var mDur = DURATION_RE.exec(text);
    if (mDur && (mDur[1] || mDur[2])) {
      var hh = parseInt(mDur[1] || "0", 10);
      var mm = parseInt(mDur[2] || "0", 10);
      if (hh > 0 || mm > 0) {
        return new Date(now.getTime() + (hh * 60 + mm) * 60000);
      }
    }
    var mClock = CLOCK_RE.exec(text);
    if (mClock) {
      var h = parseInt(mClock[1], 10);
      var m = parseInt(mClock[2], 10);
      var ap = (mClock[3] || "").toLowerCase();
      if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
        if (ap === "pm" && h < 12) h += 12;
        if (ap === "am" && h === 12) h = 0;
        var target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
        // A clock time with no am/pm and no later-than-now guarantee, or one that has
        // already passed today, means the reset is tomorrow (a "7:50pm" reset seen at
        // 8pm can only mean the NEXT occurrence of that clock time).
        if (target.getTime() <= now.getTime()) {
          target = new Date(target.getTime() + 24 * 60 * 60000);
        }
        return target;
      }
    }
    return null;
  }

  // ---- banner detection --------------------------------------------------------------

  function isBannerEl(el) {
    if (!el || el.nodeType !== 1) return false;
    var role = el.getAttribute("role");
    if (role === "alert" || role === "status") return true;
    var cn = el.getAttribute("class") || "";
    return /error|banner|alert|toast|notice|limit/i.test(cn);
  }

  var MSG_CONTAINER_RE = /userMessageContainer|timelineMessage|messageContent|markdown|prose|turn_/i;
  function insideMessage(el) {
    var n = el, hops = 0;
    while (n && n.nodeType === 1 && hops < 20) {
      if (n.tagName === "BLOCKQUOTE") return true;
      if (n.getAttribute) {
        if (n.getAttribute("data-cc-user") === "1") return true;
        if (n.getAttribute("data-cc-blockquote") === "1") return true;
        var cn = n.getAttribute("class") || "";
        if (cn && MSG_CONTAINER_RE.test(cn)) return true;
      }
      n = n.parentElement; hops++;
    }
    return false;
  }

  function chatRoot() {
    return D.getElementById("root") || D.body;
  }

  /**
   * Finds the current limit banner, if any: an explicit banner-shaped element (or the chat's own newest message, mirroring AutoContinue's dual detection path), not inside ordinary chat prose, whose short text mentions both a limit phrase and a reset word.
   * @returns {Element|null} the matching banner/message element, or null when none qualifies.
   */
  function findLimitBanner() {
    var root = chatRoot();
    var cands = root.querySelectorAll(
      "[role='alert'],[role='status'],[class*='error' i],[class*='banner' i]," +
      "[class*='alert' i],[class*='toast' i],[class*='notice' i],[class*='limit' i]"
    );
    for (var i = 0; i < cands.length; i++) {
      var b = cands[i];
      if (!isBannerEl(b)) continue;
      if (insideMessage(b)) continue;
      var t = (b.textContent || "").trim();
      if (!t || t.length > 300) continue;
      if (!LIMIT_RE.test(t) || !RESET_WORD_RE.test(t)) continue;
      return b;
    }
    // Fallback: the chat's own newest message, same rationale as AutoContinue's
    // findLastMessageDrop() — Claude can surface this as an ordinary message instead
    // of a styled banner.
    var msgs = root.querySelectorAll(
      "[class*='userMessageContainer'],[class*='timelineMessage'],[class*='turn_']"
    );
    if (msgs.length) {
      var last = msgs[msgs.length - 1];
      var lt = (last.textContent || "").trim();
      if (lt && lt.length <= 300 && LIMIT_RE.test(lt) && RESET_WORD_RE.test(lt)) {
        return last;
      }
    }
    return null;
  }

  // ---- composer submit (same mechanism as AutoContinue) -----------------------------

  function findComposer() {
    return (
      D.querySelector('[role="textbox"][aria-label="Message input"]') ||
      D.querySelector('[role="textbox"][contenteditable]') ||
      D.querySelector('[contenteditable="plaintext-only"]') ||
      D.querySelector('[contenteditable="true"]')
    );
  }

  function composerIsEmpty(input) {
    return ((input.innerText || input.textContent || "").trim()).length === 0;
  }

  function caretToEnd(el) {
    try {
      var range = D.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      var sel = W.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {}
  }

  function findSendButton() {
    var cands = D.querySelectorAll(
      "button[aria-label*='send' i],button[title*='send' i],[class*='send' i][role='button'],button[type='submit']"
    );
    for (var i = 0; i < cands.length; i++) {
      if (!cands[i].disabled) return cands[i];
    }
    return null;
  }

  function submitContinue(input) {
    try {
      input.focus();
      caretToEnd(input);
      var okInsert = false;
      try { okInsert = D.execCommand("insertText", false, "continue"); } catch (e) {}
      if (!okInsert) {
        try {
          input.textContent = "continue";
          input.dispatchEvent(new (W.Event || Event)("input", { bubbles: true }));
        } catch (e) {}
      }
      var sent = false;
      try {
        var kd = new W.KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true,
        });
        input.dispatchEvent(kd);
        sent = true;
      } catch (e) {}
      try {
        if (!composerIsEmpty(input)) {
          var send = findSendButton();
          if (send) { send.click(); sent = true; }
        }
      } catch (e) {}
      return sent;
    } catch (e) { return false; }
  }

  function diagLog(payload) {
    try { console.info("[cc-sessionlimit]", payload); } catch (e) {}
  }

  // ---- arm / wait / fire --------------------------------------------------------------

  // BUFFER_MS is the fixed post-reset grace period before firing ("+1 minut o'tib
  // continue yozvorsin" — the explicit requirement: never fire exactly AT reset, always
  // a short buffer after, since a reset boundary can be off by a few seconds server-side).
  var BUFFER_MS = readNumSetting("cc-sessionlimit-bufferms", 60000);
  var fireTimer = null;

  function readNumSetting(key, fallback) {
    try {
      var v = parseInt(W.localStorage.getItem(key), 10);
      return v > 0 ? v : fallback;
    } catch (e) { return fallback; }
  }

  /**
   * Persists the armed wait so it survives a webview reload (a long wait, e.g. hours, easily outlives a single webview lifetime — window reload, VS Code restart, tab switch).
   * @param {number} fireAtMs - epoch ms when "continue" should fire.
   * @param {string} matched - short snippet of the matched banner text (diagnostics only).
   * @returns {void}
   */
  function saveArmed(fireAtMs, matched) {
    try {
      W.localStorage.setItem(ARMED_KEY, JSON.stringify({ fireAt: fireAtMs, matched: matched }));
    } catch (e) {}
  }
  function readArmed() {
    try {
      var raw = W.localStorage.getItem(ARMED_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function clearArmed() {
    try { W.localStorage.removeItem(ARMED_KEY); } catch (e) {}
  }

  function scheduleFire(fireAtMs) {
    if (fireTimer) { W.clearTimeout(fireTimer); fireTimer = null; }
    var delay = fireAtMs - Date.now();
    // setTimeout has a practical max delay (~24.8 days); re-check in chunks of at
    // most 30 minutes so an unusually long wait (should not happen for a session
    // limit, but never trust an upstream-provided duration blindly) still fires.
    var MAX_CHUNK = 30 * 60000;
    if (delay > MAX_CHUNK) {
      fireTimer = W.setTimeout(function () { scheduleFire(fireAtMs); }, MAX_CHUNK);
      return;
    }
    fireTimer = W.setTimeout(function () { doFire(fireAtMs); }, Math.max(0, delay));
  }

  function doFire(fireAtMs) {
    fireTimer = null;
    if (offOverride()) { diagLog({ kind: "cc.sessionlimit", action: "disabled" }); clearArmed(); return; }
    var input = findComposer();
    if (!input) {
      // Composer not mounted yet (webview mid-load) — retry shortly rather than
      // dropping the fire entirely.
      diagLog({ kind: "cc.sessionlimit", action: "composer-not-ready-retry" });
      fireTimer = W.setTimeout(function () { doFire(fireAtMs); }, 5000);
      return;
    }
    if (!composerIsEmpty(input)) {
      diagLog({ kind: "cc.sessionlimit", action: "composer-busy-retry" });
      fireTimer = W.setTimeout(function () { doFire(fireAtMs); }, 5000);
      return;
    }
    var sent = submitContinue(input);
    clearArmed();
    diagLog({ kind: "cc.sessionlimit", action: sent ? "continued" : "insert-only", fireAt: fireAtMs });
  }

  function armFor(banner, fireAtDate) {
    banner.setAttribute(DONE_ATTR, "1");
    var fireAtMs = fireAtDate.getTime() + BUFFER_MS;
    var matched = (banner.textContent || "").trim().slice(0, 160);
    saveArmed(fireAtMs, matched);
    scheduleFire(fireAtMs);
    diagLog({ kind: "cc.sessionlimit", action: "armed", fireAt: fireAtMs, matched: matched });
  }

  function run() {
    if (offOverride()) return;

    // Resume a wait that was armed before a reload, if it hasn't fired yet.
    if (!fireTimer) {
      var armed = readArmed();
      if (armed && armed.fireAt) {
        if (armed.fireAt <= Date.now()) {
          doFire(armed.fireAt);
        } else {
          scheduleFire(armed.fireAt);
        }
      }
    }

    var banner = findLimitBanner();
    if (!banner) return;
    if (banner.getAttribute(DONE_ATTR) === "1") return;

    var text = (banner.textContent || "").trim();
    var resetAt = parseResetTime(text, new Date());
    if (!resetAt) {
      diagLog({ kind: "cc.sessionlimit", action: "unparseable-time", text: text.slice(0, 160) });
      banner.setAttribute(DONE_ATTR, "1"); // never re-attempt the same unparseable banner
      return;
    }
    armFor(banner, resetAt);
  }

  var pending = null;
  function schedule() {
    if (pending) return;
    pending = W.setTimeout(function () {
      pending = null;
      try { run(); } catch (e) {}
    }, 250);
  }

  function init(doc, win) {
    D = doc;
    W = win || window;
    try { run(); } catch (e) {}
    try {
      new W.MutationObserver(schedule).observe(D.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    } catch (e) {}
  }

  register(init);

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
   SessionLimitContinue has no visible UI of its own — it is an event-driven watcher that auto-submits "continue" once a parsed session-limit reset time (+ buffer) arrives.
   This stylesheet is an intentional (near-)empty placeholder so the feature stays a normal copy-and-inject asset PAIR (js + css), matching every other feature.
   The only rule here is a marker so the injected <link> is never mistaken for empty by tooling; it styles nothing visible.
*/
[data-cc-sessionlimit] {
  /* handled-banner marker — no visual change */
}
`.trim();

registerFeature({
  id: "sessionlimitcontinue",
  label: "Auto-continue after session-limit reset",
  js: JS,
  css: CSS,
});
