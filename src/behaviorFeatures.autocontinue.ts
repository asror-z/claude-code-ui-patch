import { registerFeature } from "./behaviorFeatures";

const JS = `
/*
 * Chat AutoContinue feature for the Claude Code chat webview.
 * A stream drop or a transient server throttle ends a turn mid-response.
 * In the webview this surfaces only as a BANNER in the chat.
 * Often WITHOUT ever being written to the transcript as an error entry, so the \`auto-resume-on-drop\` Stop hook cannot see it and a human has to retype "continue".
 * This feature closes that gap FROM INSIDE the webview.
 * It watches the chat DOM and, the moment such an error/throttle banner appears, TYPES "continue" INTO THE COMPOSER AND SUBMITS IT — resuming the interrupted turn automatically.
 *
 * It handles banners like these (and similar):
 *   API Error: Connection closed mid-response
 *   API Error: Server is temporarily limiting requests (not your usage limit)
 *   Rate limited / stream stall / "the response above may be incomplete"
 *
 * BOUNDED — no loop.
 * Fires ONCE per distinct banner (data-cc-autocont="1"), only when the composer is EMPTY and idle, after a COOLDOWN, and stops after a per-session CAP (localStorage).
 * Off switch: localStorage 'cc-autocontinue' = 'off'.
 * Detection is scoped to error/banner-looking elements so ordinary prose that merely QUOTES the phrase never false-fires.
 *
 * SESSION-LIMIT branch (same feature/toggle, separate detection+wait path).
 * Claude's own usage-limit banner ("You've hit your session limit · resets 7:50pm" and known variants — "usage limit reached", "5-hour limit", "weekly limit", each paired with a reset word) names a specific future RESET TIME rather than "retry shortly".
 * Correct response is to wait until that moment (+ a fixed buffer), not the short QUIET_MS guess the stream-drop path uses.
 * Reset time is parsed out of the banner's own text, tolerating several shapes (clock time with optional am/pm, bare 24h clock, or a relative "in Nh Mm" duration).
 * No time confidently parsed → a fixed FALLBACK wait arms instead, so an unrecognized-but-real banner still eventually retries.
 * Wait persists to localStorage so it survives a webview reload/VS Code restart — a session-limit wait can span hours, easily outliving one webview lifetime.
 * Shares the SAME off switch, composer-submit mechanism, and per-session cap as the stream-drop path above.
 */
(function () {
  "use strict";

  try {
    console.log("[cc-autocont] Chat AutoContinue Feature.js loaded");
  } catch (e) {}

  var DONE_ATTR = "data-cc-autocont";     // marks a banner we already handled
  var COUNT_KEY = "cc-autocontinue-count"; // localStorage session counter
  var OFF_KEY = "cc-autocontinue";         // localStorage 'off' override

  /**
   * Reads a USER-CONFIGURABLE VS Code setting (e.g. smartsClaudeManager.autoContinueCooldownMs/autoContinueDefaultCap) seeded into localStorage on every webview load by behaviorInject.ts's seedScript() — same mechanism and same missing/invalid-value fallback contract as QUIET_MS below.
   * @param {string} key - localStorage key the setting was seeded under.
   * @param {number} fallback - value to use when missing/invalid.
   * @returns {number} the parsed setting value, or fallback.
   */
  function readNumSetting(key, fallback) {
    try {
      var v = parseInt(W.localStorage.getItem(key), 10);
      return v > 0 ? v : fallback;
    } catch (e) {
      return fallback;
    }
  }
  var COOLDOWN_MS = readNumSetting("cc-autocontinue-cooldownms", 4000); // min gap between two auto-continues
  var DEFAULT_CAP = readNumSetting("cc-autocontinue-defaultcap", 5);    // max auto-continues per session

  /*
   * Session-limit branch tunables (see file-header comment).
   * BUFFER_MS: fixed grace period after the parsed reset time before firing — never fire exactly AT reset, since a reset boundary can be off by a few seconds server-side.
   * FALLBACK_MS: used only when the banner's own text has NO parseable time at all, so an unrecognized-but-real limit banner still eventually retries instead of being silently ignored.
   */
  var SESSIONLIMIT_BUFFER_MS = readNumSetting("cc-autocontinue-sessionlimit-bufferms", 60000);
  var SESSIONLIMIT_FALLBACK_MS = readNumSetting("cc-autocontinue-sessionlimit-fallbackms", 30 * 60000);
  var SESSIONLIMIT_DONE_ATTR = "data-cc-autocont-sl"; // separate marker from DONE_ATTR (different wait shape)
  var SESSIONLIMIT_ARMED_KEY = "cc-autocontinue-sessionlimit-armed"; // persists across reload

  /*
   * Loose phrase match for Claude's own usage/session-limit banner.
   * Wording already observed to vary: "session limit" / "usage limit" / "5-hour limit" / "weekly limit" / "daily limit".
   * Always paired with a reset-ing word in the same banner.
   */
  var LIMIT_RE = /\\b(?:session|usage|5-hour|weekly|daily)\\s+limit\\b/i;
  var RESET_WORD_RE = /\\breset(?:s|ting)?\\b/i;

  /*
   * Reset-time parsing — tolerates several shapes seen in the wild.
   *   clock time, optional am/pm, optional leading zero: "7:50pm" "7:50 PM" "19:50"
   *   relative duration: "in 2h 30m" "in 45 minutes" "in 2 hours" "in 1h"
   * A trailing timezone abbreviation/offset next to a clock time (if ever present) is simply not matched by CLOCK_RE and has no effect.
   * The clock value itself is taken at face value in the viewer's own local time, same as the banner displays it.
   */
  var CLOCK_RE = /\\b(\\d{1,2}):(\\d{2})\\s*(am|pm)?\\b/i;
  var DURATION_RE = /\\bin\\s+(?:(\\d+)\\s*h(?:ours?)?)?\\s*(?:(\\d+)\\s*m(?:in(?:ute)?s?)?)?\\b/i;

  /**
   * Parses a session-limit reset moment out of a banner's own text.
   * Caller falls back to SESSIONLIMIT_FALLBACK_MS when this returns null — never guesses.
   * @param {string} text - banner text to scan.
   * @param {Date} now - reference "now" for relative-duration/clock-time math.
   * @returns {Date|null} parsed future reset moment, or null when no well-formed time is found.
   */
  function parseResetTime(text, now) {
    var mDur = DURATION_RE.exec(text);
    if (mDur && (mDur[1] || mDur[2])) {
      var hh = parseInt(mDur[1] || "0", 10);
      var mm = parseInt(mDur[2] || "0", 10);
      if (hh > 0 || mm > 0) return new Date(now.getTime() + (hh * 60 + mm) * 60000);
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
        // Already-passed today (or no am/pm to disambiguate) → next occurrence is tomorrow.
        if (target.getTime() <= now.getTime()) target = new Date(target.getTime() + 24 * 60 * 60000);
        return target;
      }
    }
    return null;
  }

  /*
   * ANY "API Error:" banner auto-continues (explicit user requirement), plus a few stream-drop/throttle phrases that a real error banner uses WITHOUT necessarily leading with the literal words "API Error:" (a stall/abort/reset banner).
   * The bare "\\bAPI Error\\b" alternative previously false-fired when matched against ANY sentence containing those two words anywhere in the page — but that hazard is guarded structurally, not by narrowing this regex: isBannerEl() requires an actual role=alert/status or error/banner/alert/toast-classed element, insideMessage() excludes anything inside a chat message/blockquote container, and phraseLeads() requires the match to be within the first 40 chars of that banner's own short text.
   * A user message merely quoting "> API Error: …" is inside a message container and is rejected by insideMessage() regardless of how broad this regex is.
   */
  var DROP_RE = new RegExp(
    [
      "\\\\bAPI Error\\\\b",
      "connection closed mid-?response",
      "connection (?:reset|aborted) by peer",
      "stream (?:disconnected|closed|error|stall)",
      "streaming stall detected",
      "the response above may be incomplete",
      "request was aborted",
      "premature close",
      "socket hang ?up",
      "\\\\b(?:ECONNRESET|ETIMEDOUT|EPIPE)\\\\b",
      "server is temporarily limiting requests",
      "temporarily limiting requests",
      "\\\\bRate limited\\\\b",
      "internal server error",
    ].join("|"),
    "i"
  );

  var D = document;
  var W = window;
  var lastFireAt = 0;

  function chatRoot() {
    return D.getElementById("root") || D.body;
  }

  function offOverride() {
    try {
      var v = (W.localStorage && W.localStorage.getItem(OFF_KEY)) || "";
      return String(v).toLowerCase() === "off";
    } catch (e) { return false; }
  }
  function cap() {
    return DEFAULT_CAP;
  }
  function getCount() {
    try { return parseInt(W.localStorage.getItem(COUNT_KEY) || "0", 10) || 0; }
    catch (e) { return 0; }
  }
  function setCount(n) {
    try { W.localStorage.setItem(COUNT_KEY, String(n)); } catch (e) {}
  }
  function resetCount() {
    if (getCount() !== 0) setCount(0);
  }

  // ---- banner detection (hardened after a live false-fire) ------------------------

  /*
   * HARD EXCLUSION: a candidate inside a MESSAGE container is chat prose, never a banner — a user prompt, an assistant message, a quoted blockquote.
   * This is the decisive guard: however the text phrases the error, if it lives in a message it cannot trigger.
   */
  var MSG_CONTAINER_RE =
    /userMessageContainer|timelineMessage|messageContent|markdown|prose|turn_/i;
  function insideMessage(el) {
    var n = el;
    var hops = 0;
    while (n && n.nodeType === 1 && hops < 20) {
      var tag = n.tagName;
      if (tag === "BLOCKQUOTE") return true;
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

  // Is this element an EXPLICIT error banner? role=alert/status, or a class matching the
  // NARROW banner set (error|banner|alert|apiError|toast — NOT the over-broad
  // notice|warning that let generic UI through).
  function isBannerEl(el) {
    if (!el || el.nodeType !== 1) return false;
    var role = el.getAttribute("role");
    if (role === "alert" || role === "status") return true;
    var cn = el.getAttribute("class") || "";
    return /error|banner|alert|apiError|toast/i.test(cn);
  }

  // Does the drop phrase sit at/near the START of the text? An error banner LEADS with the
  // error ("API Error: Connection closed…"); prose buries it mid-paragraph. We accept a
  // match within the first 40 chars.
  function phraseLeads(text) {
    var m = DROP_RE.exec(text);
    return !!m && m.index <= 40;
  }

  var rejected = 0; // count of near-miss rejects this sweep (for diagnose)

  // A message-shaped element — user turn, assistant turn, or any timeline entry.
  // Same class-substring set messageCount() below reuses for consistency.
  var MSG_SEL = "[class*='userMessageContainer'],[class*='timelineMessage'],[class*='turn_']";

  // The NEWEST message in the chat, if (and only if) its own text LEADS with a
  // drop phrase — regardless of whether it is a user or assistant/system turn.
  //
  // WHY THIS EXISTS (confirmed live, not theoretical): a real drop/throttle event
  // does NOT always surface as a styled role=alert/error-classed banner element —
  // Claude Code can instead surface it as an ORDINARY NEW MESSAGE in the timeline
  // (observed directly: "API Error: Server is temporarily limiting requests (not
  // your usage limit) · Rate limited" arrived framed exactly like a fresh user
  // turn). findErrorBanners()'s own insideMessage() guard EXCLUDES anything inside
  // a message container on purpose (so ordinary chat prose discussing "API Error"
  // never false-fires) — that guard stays exactly as-is for the banner-ELEMENT
  // scan below. This is a SEPARATE, additive detection path: only the CHAT'S OWN
  // NEWEST message is ever checked (never an older one buried mid-history), so a
  // user's earlier, unrelated message that happens to mention the phrase can never
  // retroactively trigger this — only the single most recent turn can, exactly
  // the same "eng oxirida" (the newest/latest one) semantics requested.
  function findLastMessageDrop() {
    var root = chatRoot();
    var msgs = root.querySelectorAll(MSG_SEL);
    if (!msgs.length) return null;
    var last = msgs[msgs.length - 1];
    if (last.getAttribute(DONE_ATTR) === "1") return null;
    var t = (last.textContent || "").trim();
    if (!t || t.length > 220) return null; // a real drop message is compact, not a long turn
    if (!phraseLeads(t)) return null;      // phrase must lead this message's own text
    return last;
  }

  // Find TRUE error banners: an explicit banner element, NOT inside a message container,
  // whose own short text LEADS with a specific drop phrase. No leaf-block escape hatch.
  // PLUS (see findLastMessageDrop above): the chat's own newest message, whichever side
  // authored it, when ITS text leads with the same drop phrase.
  function findErrorBanners() {
    var root = chatRoot();
    var out = [];
    rejected = 0;
    var banners = root.querySelectorAll(
      "[role='alert'],[role='status'],[class*='error' i],[class*='banner' i]," +
      "[class*='alert' i],[class*='apiError' i],[class*='toast' i]"
    );
    for (var i = 0; i < banners.length; i++) {
      var b = banners[i];
      if (b.getAttribute(DONE_ATTR) === "1") continue;
      if (!isBannerEl(b)) continue;               // narrow banner set only
      if (insideMessage(b)) { rejected++; continue; } // chat prose — never a banner
      var t = (b.textContent || "").trim();
      if (!t || t.length > 220) { rejected++; continue; } // a real banner is compact
      if (!DROP_RE.test(t)) continue;             // not a drop/throttle phrase at all
      if (!phraseLeads(t)) { rejected++; continue; }  // phrase must lead, not be buried
      // dedup: skip if an already-collected banner contains it (or vice versa)
      var contained = false;
      for (var k = 0; k < out.length; k++) {
        if (out[k].contains(b) || b.contains(out[k])) { contained = true; break; }
      }
      if (!contained) out.push(b);
    }
    var msgDrop = findLastMessageDrop();
    if (msgDrop) {
      var msgContained = false;
      for (var k2 = 0; k2 < out.length; k2++) {
        if (out[k2].contains(msgDrop) || msgDrop.contains(out[k2])) { msgContained = true; break; }
      }
      if (!msgContained) out.push(msgDrop);
    }
    return out;
  }

  /**
   * Checks whether the limit phrase sits at/near the START of the text.
   * A real limit banner LEADS with it ("You've hit your session limit · resets…"); ordinary prose (a question ABOUT limits) buries it mid-sentence or phrases it as a question.
   * Mirrors phraseLeads() above.
   * @param {string} text - candidate text to test.
   * @returns {boolean} true when LIMIT_RE matches within the first 40 chars.
   */
  function limitPhraseLeads(text) {
    var m = LIMIT_RE.exec(text);
    return !!m && m.index <= 40;
  }

  /**
   * Finds Claude's own session/usage-limit banner: an explicit banner-shaped element, or (mirroring findLastMessageDrop) the chat's own newest message — Claude can surface this as an ordinary message instead of a styled banner.
   * Never matches inside ordinary chat prose — the short text must LEAD with a limit phrase and mention reset.
   * @returns {Element|null} the banner/message element, or null when none qualifies.
   */
  function findSessionLimitBanner() {
    var root = chatRoot();
    var cands = root.querySelectorAll(
      "[role='alert'],[role='status'],[class*='error' i],[class*='banner' i]," +
      "[class*='alert' i],[class*='toast' i],[class*='notice' i],[class*='limit' i]"
    );
    for (var i = 0; i < cands.length; i++) {
      var b = cands[i];
      if (b.getAttribute(SESSIONLIMIT_DONE_ATTR) === "1") continue;
      if (!isBannerEl(b)) continue;
      if (insideMessage(b)) continue;
      var t = (b.textContent || "").trim();
      if (!t || t.length > 300) continue;
      if (!limitPhraseLeads(t) || !RESET_WORD_RE.test(t)) continue;
      return b;
    }
    var msgs = root.querySelectorAll(MSG_SEL);
    if (msgs.length) {
      var last = msgs[msgs.length - 1];
      if (last.getAttribute(SESSIONLIMIT_DONE_ATTR) !== "1") {
        var lt = (last.textContent || "").trim();
        if (lt && lt.length <= 300 && limitPhraseLeads(lt) && RESET_WORD_RE.test(lt)) return last;
      }
    }
    return null;
  }

  // ---- composer submit ------------------------------------------------------------

  function findComposer() {
    return (
      D.querySelector('[role="textbox"][aria-label="Message input"]') ||
      D.querySelector('[role="textbox"][contenteditable]') ||
      D.querySelector('[contenteditable="plaintext-only"]') ||
      D.querySelector('[contenteditable="true"]')
    );
  }

  function composerIsEmpty(input) {
    var t = (input.innerText || input.textContent || "").trim();
    return t.length === 0;
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

  // Type "continue" and submit. Returns true if it dispatched a submit.
  function submitContinue(input) {
    try {
      input.focus();
      caretToEnd(input);
      var okInsert = false;
      try { okInsert = D.execCommand("insertText", false, "continue"); } catch (e) {}
      if (!okInsert) {
        // fallback: set text + fire an input event so React sees it
        try {
          input.textContent = "continue";
          input.dispatchEvent(new (W.Event || Event)("input", { bubbles: true }));
        } catch (e) {}
      }
      // Submit via Enter keydown (Claude Code sends on Enter).
      var sent = false;
      try {
        var kd = new W.KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true,
        });
        input.dispatchEvent(kd);
        sent = true;
      } catch (e) {}
      // Fallback: click a visible send button if Enter did not clear the input.
      try {
        if (!composerIsEmpty(input)) {
          var send = findSendButton();
          if (send) { send.click(); sent = true; }
        }
      } catch (e) {}
      return sent;
    } catch (e) { return false; }
  }

  function findSendButton() {
    var cands = D.querySelectorAll(
      "button[aria-label*='send' i],button[title*='send' i],[class*='send' i][role='button'],button[type='submit']"
    );
    for (var i = 0; i < cands.length; i++) {
      var b = cands[i];
      if (b.disabled) continue;
      return b;
    }
    return null;
  }

  // ---- diagnose (console only — no Faro/telemetry backend in this target) --------
  function diagLog(payload) {
    try { console.info("[cc-autocont]", payload); } catch (e) {}
  }

  // ---- main sweep -----------------------------------------------------------------
  //
  // TWO-PHASE fire ("N ms davomida yangi message kelmasa — Automatically continue deb
  // yozvoradi": if no new message arrives for N ms, auto-type "continue"): detecting an
  // error banner does NOT submit "continue" immediately — it arms a QUIET_MS countdown.
  // The countdown RESTARTS whenever the chat's message count increases (a real new
  // message/turn appearing — not just any DOM churn, which would make the timer
  // effectively never fire in a live, constantly-repainting chat UI), and is cancelled
  // outright if the banner itself clears (the run recovered on its own). Only once
  // QUIET_MS has elapsed with NO new message AND the same banner still present does it
  // actually submit "continue".
  //
  // QUIET_MS is a USER-CONFIGURABLE VS Code setting (smartsClaudeManager.autoContinueQuietMs,
  // default 500ms), never a hardcoded constant — behaviorInject.ts's seedScript() writes
  // it into localStorage on every webview load (the same seed mechanism the per-feature
  // on/off toggles already use), read via the shared readNumSetting() helper above. A
  // missing/invalid value (an older cached webview from before this setting existed, a
  // corrupted localStorage entry) falls back to the same 500ms default the setting
  // itself ships with.
  var QUIET_MS = readNumSetting("cc-autocontinue-quietms", 500);
  var quietTimer = null;
  var armedBanner = null; // the banner element the current quiet-timer is waiting on
  var lastMsgCount = -1;  // message-container count as of the last successful arm/restart

  // A cheap count of real chat message containers (turns/bubbles), used ONLY to detect
  // "a new message arrived" — reuses the same container-class heuristic as
  // insideMessage()'s MSG_CONTAINER_RE so it tracks genuine chat content, not incidental
  // DOM noise (cursor blink, hover states, timestamp re-renders).
  function messageCount() {
    try {
      return chatRoot().querySelectorAll(
        "[class*='userMessageContainer'],[class*='timelineMessage'],[class*='turn_']"
      ).length;
    } catch (e) { return -1; }
  }

  function cancelQuietTimer(reason) {
    if (!quietTimer) return;
    W.clearTimeout(quietTimer);
    quietTimer = null;
    if (armedBanner) {
      diagLog({ kind: "cc.autocontinue", action: "quiet-wait-cancelled", reason: reason || "activity" });
    }
    armedBanner = null;
  }

  function armQuietTimer(banner) {
    if (quietTimer) W.clearTimeout(quietTimer);
    armedBanner = banner;
    lastMsgCount = messageCount();
    quietTimer = W.setTimeout(onQuietTimeout, QUIET_MS);
  }

  function onQuietTimeout() {
    quietTimer = null;
    var stillArmed = armedBanner;
    armedBanner = null;
    if (!stillArmed) return;
    // A new message arrived at some point during the wait but the observer's debounced
    // run() didn't get a chance to restart the timer before it fired (a race at the
    // boundary) — re-check the count directly here too, belt-and-braces.
    if (messageCount() !== lastMsgCount) {
      diagLog({ kind: "cc.autocontinue", action: "quiet-wait-resolved", reason: "new-message-detected" });
      return;
    }
    // Re-check the banner is STILL present/undone after the full quiet period — a run
    // that resumed mid-wait already cleared/removed it (covered by cancelQuietTimer in
    // run() too, but this is a defensive second check at fire-time).
    var recheck = findErrorBanners();
    var stillThere = false;
    for (var i = 0; i < recheck.length; i++) {
      if (recheck[i] === stillArmed || stillArmed.contains(recheck[i]) || recheck[i].contains(stillArmed)) {
        stillThere = true;
        break;
      }
    }
    if (!stillThere) {
      diagLog({ kind: "cc.autocontinue", action: "quiet-wait-resolved", reason: "banner-gone-by-timeout" });
      return;
    }
    try { fireContinue(stillArmed); } catch (e) {}
  }

  function fireContinue(banner) {
    var count = getCount();
    var maxN = cap();
    if (count >= maxN) {
      diagLog({ kind: "cc.autocontinue", action: "capped", attempts: count, cap: maxN });
      return;
    }
    var now = (W.performance && W.performance.now) ? W.performance.now() : Date.parse(new Date().toString());
    if (lastFireAt && now - lastFireAt < COOLDOWN_MS) {
      diagLog({ kind: "cc.autocontinue", action: "cooldown", sinceMs: Math.round(now - lastFireAt) });
      return;
    }
    var input = findComposer();
    if (!input) {
      diagLog({ kind: "cc.autocontinue", action: "no-composer" });
      return;
    }
    if (!composerIsEmpty(input)) {
      diagLog({ kind: "cc.autocontinue", action: "composer-busy" });
      return; // never clobber a half-typed message
    }
    banner.setAttribute(DONE_ATTR, "1"); // mark handled only once we actually act
    var matched = (banner.textContent || "").trim().slice(0, 120);
    var sent = submitContinue(input);
    lastFireAt = now;
    setCount(count + 1);
    diagLog({
      kind: "cc.autocontinue",
      action: sent ? "continued" : "insert-only",
      attempt: count + 1,
      cap: maxN,
      quietMs: QUIET_MS,
      matched: matched,
    });
  }

  // ---- session-limit arm/wait/fire (separate wait shape from QUIET_MS above) ------
  /*
   * Unlike the stream-drop path (a short quiet-period guess), a session-limit banner names a specific future reset moment.
   * So this arms a real setTimeout for that moment (+ SESSIONLIMIT_BUFFER_MS), persisted to localStorage so the wait survives a webview reload/VS Code restart — it can span hours, easily outliving one webview lifetime.
   * Shares fireContinue's own cap/cooldown/composer-submit machinery by calling the SAME submitContinue()/findComposer() helpers directly.
   */
  var slFireTimer = null;

  /**
   * Persists the armed session-limit wait so it survives a webview reload/VS Code restart.
   * @param {number} fireAtMs - epoch ms when "continue" should fire.
   * @param {string} matched - short snippet of the matched banner text (diagnostics only).
   * @returns {void}
   */
  function slSaveArmed(fireAtMs, matched) {
    try { W.localStorage.setItem(SESSIONLIMIT_ARMED_KEY, JSON.stringify({ fireAt: fireAtMs, matched: matched })); }
    catch (e) {}
  }

  /**
   * Reads back a previously persisted armed session-limit wait, if any.
   * @returns {{fireAt: number, matched: string}|null} the armed record, or null when none exists.
   */
  function slReadArmed() {
    try {
      var raw = W.localStorage.getItem(SESSIONLIMIT_ARMED_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  /**
   * Clears the persisted armed session-limit wait.
   * @returns {void}
   */
  function slClearArmed() {
    try { W.localStorage.removeItem(SESSIONLIMIT_ARMED_KEY); } catch (e) {}
  }

  /**
   * Schedules slFire() for a future moment, chunking a long wait into bounded setTimeout hops.
   * setTimeout has a practical max delay (~24.8 days) — this re-checks in bounded chunks so an unusually long wait still fires rather than silently overflowing.
   * @param {number} fireAtMs - epoch ms when "continue" should fire.
   * @returns {void}
   */
  function slSchedule(fireAtMs) {
    if (slFireTimer) { W.clearTimeout(slFireTimer); slFireTimer = null; }
    var delay = fireAtMs - Date.now();
    var MAX_CHUNK = 30 * 60000;
    if (delay > MAX_CHUNK) {
      slFireTimer = W.setTimeout(function () { slSchedule(fireAtMs); }, MAX_CHUNK);
      return;
    }
    slFireTimer = W.setTimeout(function () { slFire(fireAtMs); }, Math.max(0, delay));
  }

  /**
   * Fires the session-limit auto-continue at (or retries shortly after) the armed moment.
   * @param {number} fireAtMs - epoch ms this fire was armed for (diagnostics + retry re-arm).
   * @returns {void}
   */
  function slFire(fireAtMs) {
    slFireTimer = null;
    if (offOverride()) { diagLog({ kind: "cc.autocontinue", action: "sessionlimit-disabled" }); slClearArmed(); return; }
    var count = getCount();
    var maxN = cap();
    if (count >= maxN) {
      diagLog({ kind: "cc.autocontinue", action: "sessionlimit-capped", attempts: count, cap: maxN });
      slClearArmed();
      return;
    }
    var input = findComposer();
    if (!input) {
      diagLog({ kind: "cc.autocontinue", action: "sessionlimit-composer-not-ready-retry" });
      slFireTimer = W.setTimeout(function () { slFire(fireAtMs); }, 5000);
      return;
    }
    if (!composerIsEmpty(input)) {
      diagLog({ kind: "cc.autocontinue", action: "sessionlimit-composer-busy-retry" });
      slFireTimer = W.setTimeout(function () { slFire(fireAtMs); }, 5000);
      return;
    }
    var sent = submitContinue(input);
    lastFireAt = (W.performance && W.performance.now) ? W.performance.now() : Date.parse(new Date().toString());
    setCount(count + 1);
    slClearArmed();
    diagLog({ kind: "cc.autocontinue", action: sent ? "sessionlimit-continued" : "sessionlimit-insert-only", fireAt: fireAtMs, attempt: count + 1, cap: maxN });
  }

  /**
   * Marks a banner handled and arms (or re-arms) the session-limit wait against it.
   * @param {Element} banner - the matched banner/message element.
   * @param {Date} fireAtDate - base moment to fire at (before buffer/fallback adjustment).
   * @param {boolean} isFallback - true when fireAtDate is the fixed FALLBACK_MS wait rather than a parsed reset time.
   * @returns {void}
   */
  function slArm(banner, fireAtDate, isFallback) {
    banner.setAttribute(SESSIONLIMIT_DONE_ATTR, "1");
    var fireAtMs = fireAtDate.getTime() + (isFallback ? 0 : SESSIONLIMIT_BUFFER_MS);
    var matched = (banner.textContent || "").trim().slice(0, 160);
    slSaveArmed(fireAtMs, matched);
    slSchedule(fireAtMs);
    diagLog({ kind: "cc.autocontinue", action: "sessionlimit-armed", fireAt: fireAtMs, fallback: !!isFallback, matched: matched });
  }

  /**
   * Session-limit sweep: resumes a persisted wait, then looks for a fresh limit banner to arm.
   * @returns {void}
   */
  function runSessionLimit() {
    if (offOverride()) return;

    // Resume a wait armed before a reload, if it hasn't fired yet.
    if (!slFireTimer) {
      var armed = slReadArmed();
      if (armed && armed.fireAt) {
        if (armed.fireAt <= Date.now()) slFire(armed.fireAt);
        else slSchedule(armed.fireAt);
      }
    }

    var banner = findSessionLimitBanner();
    if (!banner || banner.getAttribute(SESSIONLIMIT_DONE_ATTR) === "1") return;

    var text = (banner.textContent || "").trim();
    var resetAt = parseResetTime(text, new Date());
    if (resetAt) {
      slArm(banner, resetAt, false);
    } else {
      // No parseable time at all — arm the fixed fallback wait rather than ignoring a
      // real (but unrecognized-shape) limit banner outright.
      diagLog({ kind: "cc.autocontinue", action: "sessionlimit-unparseable-fallback", text: text.slice(0, 160), fallbackMs: SESSIONLIMIT_FALLBACK_MS });
      slArm(banner, new Date(Date.now() + SESSIONLIMIT_FALLBACK_MS), true);
    }
  }

  function run() {
    try { runSessionLimit(); } catch (e) {}

    var banners = findErrorBanners();
    if (!banners.length) {
      // a clean sweep (no error banner visible) means the run recovered on its own —
      // cancel any pending quiet-wait and reset the per-session budget so a later,
      // unrelated drop gets a fresh cap. If near-misses were rejected this sweep, log
      // WHY so a future false-fire (or missed banner) is observable.
      cancelQuietTimer("banner-cleared");
      if (rejected) diagLog({ kind: "cc.autocontinue", action: "rejected-candidates", rejected: rejected });
      resetCount();
      return;
    }
    if (offOverride()) {
      cancelQuietTimer("off-override");
      for (var m = 0; m < banners.length; m++) banners[m].setAttribute(DONE_ATTR, "1");
      diagLog({ kind: "cc.autocontinue", action: "disabled", reason: "off-override", banners: banners.length });
      return;
    }

    var fresh = banners[0];
    var curMsgCount = messageCount();

    if (armedBanner === fresh) {
      // Same banner still pending: restart the QUIET_MS countdown only if a genuinely
      // NEW message arrived since we last armed (not on incidental DOM churn) — this is
      // the literal "no new message for 5 seconds" condition.
      if (curMsgCount !== lastMsgCount) {
        diagLog({ kind: "cc.autocontinue", action: "quiet-wait-restarted", reason: "new-message", quietMs: QUIET_MS });
        armQuietTimer(fresh);
      }
      return;
    }

    // A NEW (or different) banner arrived — arm/restart the wait against it.
    diagLog({ kind: "cc.autocontinue", action: "quiet-wait-started", quietMs: QUIET_MS });
    armQuietTimer(fresh);
  }

  var pending = null;
  function schedule(mutations) {
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
      // PLAIN debounced observer (NOT __ccObserve). The observer sweep's ONLY write is a
      // guarded idempotent setAttribute (DONE_ATTR on handled banners), so it is ALREADY
      // freeze-safe: a re-run stamps nothing new → emits no mutation → the observer goes
      // quiet on its own. Routing it through __ccObserve with ownAttrPrefix was a mistake —
      // the shared filter treats the DONE_ATTR write as self-churn and, in a mixed streaming
      // batch, suppresses the sweep so a NEW "run limit" banner streaming in right after a
      // handled one is missed (the same regression that broke UserStyle: userTagged=0).
      // __ccObserve is only for element-APPENDING features. (The textContent write to the
      // input is in the click action, not the sweep.) schedule() debounces run() ~250ms.
      new W.MutationObserver(schedule).observe(D.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    } catch (e) {}
  }

  register(init);

  // Order-independent registration (copied verbatim from the sibling features).
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
/* AutoContinue has NO visible UI of its own — it is an event-driven watcher that
   auto-submits "continue" when a stream-error / throttle banner appears. This
   stylesheet is an intentional (near-)empty placeholder so the feature remains a
   normal copy-and-inject asset PAIR (js + css), matching every other feature.

   The only rule here is a marker so the injected <link> is never mistaken for empty
   by tooling; it styles nothing visible. */
[data-cc-autocont] {
  /* handled-banner marker — no visual change */
}
`.trim();

registerFeature({ id: "autocontinue", label: "Auto-continue on error", js: JS, css: CSS });
