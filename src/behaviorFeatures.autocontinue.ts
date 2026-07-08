import { registerFeature } from "./behaviorFeatures";

const JS = `
// Chat AutoContinue feature for the Claude Code chat webview.
//
// A stream drop or a transient server throttle ends a turn mid-response and, in the
// webview, surfaces only as a BANNER in the chat — often WITHOUT ever being written to
// the transcript as an error entry, so the \`auto-resume-on-drop\` Stop hook cannot see
// it and a human has to retype "continue". This feature closes that gap FROM INSIDE the
// webview: it watches the chat DOM and, the moment such an error/throttle banner
// appears, TYPES "continue" INTO THE COMPOSER AND SUBMITS IT — resuming the interrupted
// turn automatically.
//
// It handles all of these banners (and similar):
//   * API Error: Connection closed mid-response
//   * API Error: Server is temporarily limiting requests (not your usage limit)
//   * Rate limited / stream stall / "the response above may be incomplete"
//
// BOUNDED — no loop: fires ONCE per distinct banner (data-cc-autocont="1"), only when
// the composer is EMPTY and idle, after a COOLDOWN, and stops after a per-session CAP
// (localStorage). Off switch: localStorage 'cc-autocontinue' = 'off'. Detection is
// scoped to error/banner-looking elements so ordinary prose that merely QUOTES the
// phrase never false-fires.
(function () {
  "use strict";

  try {
    console.log("[cc-autocont] Chat AutoContinue Feature.js loaded");
  } catch (e) {}

  var DONE_ATTR = "data-cc-autocont";     // marks a banner we already handled
  var COOLDOWN_MS = 4000;                  // min gap between two auto-continues
  var DEFAULT_CAP = 5;                     // max auto-continues per session
  var COUNT_KEY = "cc-autocontinue-count"; // localStorage session counter
  var OFF_KEY = "cc-autocontinue";         // localStorage 'off' override

  // ANY "API Error:" banner auto-continues (explicit user requirement), plus a few
  // stream-drop/throttle phrases that a real error banner uses WITHOUT necessarily
  // leading with the literal words "API Error:" (a stall/abort/reset banner). The bare
  // "\\bAPI Error\\b" alternative previously false-fired when matched against ANY
  // sentence containing those two words anywhere in the page — but that hazard is
  // guarded structurally, not by narrowing this regex: isBannerEl() requires an actual
  // role=alert/status or error/banner/alert/toast-classed element, insideMessage()
  // excludes anything inside a chat message/blockquote container, and phraseLeads()
  // requires the match to be within the first 40 chars of that banner's own short text.
  // A user message merely quoting "> API Error: …" is inside a message container and is
  // rejected by insideMessage() regardless of how broad this regex is.
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

  // HARD EXCLUSION: a candidate inside a MESSAGE container is chat prose, never a banner —
  // a user prompt, an assistant message, a quoted blockquote. This is the decisive guard:
  // however the text phrases the error, if it lives in a message it cannot trigger.
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

  // Find TRUE error banners: an explicit banner element, NOT inside a message container,
  // whose own short text LEADS with a specific drop phrase. No leaf-block escape hatch.
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
    return out;
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
  // TWO-PHASE fire, matching "5 soniya davomida yangi message kelmasa — Automatically
  // continue deb yozvoradi" (if no new message arrives for 5 seconds, auto-type
  // "continue"): detecting an error banner does NOT submit "continue" immediately — it
  // arms a QUIET_MS countdown. The countdown RESTARTS whenever the chat's message count
  // increases (a real new message/turn appearing — not just any DOM churn, which would
  // make the timer effectively never fire in a live, constantly-repainting chat UI), and
  // is cancelled outright if the banner itself clears (the run recovered on its own).
  // Only once QUIET_MS has elapsed with NO new message AND the same banner still present
  // does it actually submit "continue".
  var QUIET_MS = 5000;
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

  function run() {
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
