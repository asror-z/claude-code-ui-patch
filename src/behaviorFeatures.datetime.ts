import { registerFeature } from "./behaviorFeatures";

const JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-datetime] Chat DateTime Feature loaded");
  } catch (e) {}

  var TIME_CLASS = "cc-dt-time";
  var SEP_CLASS = "cc-dt-date-sep";
  var STAMPED_ATTR = "data-cc-dt-stamped";
  var TIME_ATTR = "data-cc-dt-time"; // CSS ::after renders this (React-proof, no child node)
  var seen = typeof WeakMap === "function" ? new WeakMap() : null;
  var seq = 0; // tiebreaker so two messages in the same ms keep document order

  // --- Locale-aware formatting (i18n) ----------------------------------------
  // Use the webview's own locale (document.documentElement.lang, then the
  // browser's navigator.language) so dates/times match the user's region — 24h
  // vs 12h, month names, and number system all follow the locale. Falls back to
  // a manual HH:MM / English long date only if Intl is unavailable.
  function userLocale() {
    var l =
      (document.documentElement && document.documentElement.lang) ||
      (navigator.languages && navigator.languages[0]) ||
      navigator.language ||
      "en";
    return l;
  }

  var _timeFmt, _dateFmt, _relFmt, _localeUsed;
  function intlFormatters() {
    var loc = userLocale();
    if (_localeUsed !== loc) {
      _localeUsed = loc;
      _timeFmt = _dateFmt = _relFmt = null;
      try {
        _timeFmt = new Intl.DateTimeFormat(loc, { hour: "2-digit", minute: "2-digit" });
      } catch (e) {}
      try {
        _dateFmt = new Intl.DateTimeFormat(loc, {
          year: "numeric", month: "long", day: "numeric",
        });
      } catch (e) {}
      try {
        if (typeof Intl.RelativeTimeFormat === "function") {
          _relFmt = new Intl.RelativeTimeFormat(loc, { numeric: "auto" });
        }
      } catch (e) {}
    }
    return { time: _timeFmt, date: _dateFmt, rel: _relFmt };
  }

  function pad(n) {
    return n < 10 ? "0" + n : "" + n;
  }

  function fmtTime(d) {
    var f = intlFormatters().time;
    if (f) {
      try { return f.format(d); } catch (e) {}
    }
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  // The date separator label ALWAYS begins with the explicit YYYY-MM-DD numeric
  // date, then the relative/localized word — e.g. "2026-06-30 Today",
  // "2026-06-29 Yesterday", "2026-06-10 June 10, 2026". The numeric prefix is
  // unambiguous; the trailing word stays locale-aware.
  function ymdDate(d) {
    return (
      d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
    );
  }

  function relativeLabel(d) {
    var today = new Date();
    var y = new Date(today.getTime() - 86400000);
    var rel = intlFormatters().rel;
    // "Today"/"Yesterday" localized via RelativeTimeFormat where available.
    if (sameDay(d, today)) {
      if (rel) { try { return capitalize(rel.format(0, "day")); } catch (e) {} }
      return "Today";
    }
    if (sameDay(d, y)) {
      if (rel) { try { return capitalize(rel.format(-1, "day")); } catch (e) {} }
      return "Yesterday";
    }
    var f = intlFormatters().date;
    if (f) {
      try { return f.format(d); } catch (e) {}
    }
    var months = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];
    return months[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
  }

  function fmtDate(d) {
    return ymdDate(d) + " " + relativeLabel(d);
  }

  function capitalize(s) {
    return s && s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  function sameDay(a, b) {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  function dayKey(d) {
    return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
  }

  // D/W are bound to the real chat document/window by init() below (this target
  // has no nested chat iframe — document IS the chat document). Until init()
  // runs they default to the current document so the fallback path still works.
  var D = document;
  var W = window;

  // The chat scroll/content root, within the active document D.
  function chatRoot() {
    return (
      D.getElementById("root") ||
      D.querySelector("[data-chat], main, .chat, .conversation") ||
      D.body
    );
  }

  // Heuristically find the message elements to stamp. We target leaf-ish blocks
  // that carry a recognized message role/marker, falling back to common chat
  // selectors. Each is stamped at most once.
  // Target ONLY real conversation messages — a user prompt bubble or an
  // assistant/timeline message. The broad \`[class*='message']\` used to also match
  // the PROMPT INPUT box (messageInput / messageInputContainer / messageGradient)
  // and the scroll container (messagesContainer), so the time stamp rendered on
  // the input box instead of on each message. We match the specific wrappers and
  // then EXCLUDE the input/container/composer classes below.
  // One stamp per conversation TURN (a turn_… wrapper = one user→assistant
  // exchange), plus each user message bubble. We deliberately do NOT target
  // \`timelineMessage\` — there are hundreds of those (one per tool-call / sub-step
  // row inside an assistant turn), and stamping every one floods the chat with
  // time labels. \`data-message-id\` / \`[role='listitem']\` are kept as
  // cross-version fallbacks for builds that expose them.
  var MESSAGE_SELECTORS = [
    "[class*='turn_']",
    "[class*='userMessageContainer']",
    "[data-message-id]",
    "[data-testid*='message']",
    "[role='listitem']",
  ];

  // Class fragments that mark NON-message UI (the composer/input + scroll
  // container) — any element whose className matches is never stamped.
  var EXCLUDE_RE =
    /messageInput|messagesContainer|messageGradient|fullEditor|composer|inputContainer|promptInput|stickyMode/i;

  function isExcludedTarget(el) {
    var cn = el && el.className;
    if (typeof cn !== "string") cn = (el && el.getAttribute && el.getAttribute("class")) || "";
    return EXCLUDE_RE.test(cn);
  }

  function candidateMessages() {
    var root = chatRoot();
    var set = new Set();
    for (var i = 0; i < MESSAGE_SELECTORS.length; i++) {
      var nodes = root.querySelectorAll(MESSAGE_SELECTORS[i]);
      for (var j = 0; j < nodes.length; j++) {
        if (!isExcludedTarget(nodes[j])) set.add(nodes[j]);
      }
    }
    // Keep only the outermost matched elements (drop nested matches) so a single
    // message bubble is stamped once, not once per inner block.
    // Array.prototype.slice.call(set) returns [] (a Set has no \`length\`); use
    // Array.from to materialise the matched nodes.
    var list = Array.from(set);
    return list.filter(function (el) {
      var p = el.parentElement;
      while (p) {
        if (set.has(p)) return false;
        p = p.parentElement;
      }
      return el.textContent && el.textContent.trim().length > 0;
    });
  }

  // Derive a stable Date for a message element.
  function messageTime(el) {
    if (seen && seen.has(el)) return seen.get(el);
    var d = readTimeCue(el) || new Date();
    // Remember so re-renders never shift the stamp; seq breaks same-ms ties.
    d.__seq = ++seq;
    if (seen) seen.set(el, d);
    return d;
  }

  // Look for a real time cue on or inside the element (best effort).
  function readTimeCue(el) {
    var t = el.querySelector ? el.querySelector("time[datetime]") : null;
    if (t) {
      var dt = new Date(t.getAttribute("datetime"));
      if (!isNaN(dt.getTime())) return dt;
    }
    var attr =
      el.getAttribute &&
      (el.getAttribute("data-timestamp") ||
        el.getAttribute("data-time") ||
        el.getAttribute("title"));
    if (attr) {
      var n = Number(attr);
      var d = !isNaN(n) && n > 0 ? new Date(n) : new Date(attr);
      if (!isNaN(d.getTime())) return d;
    }
    return null;
  }

  // Stamp the time as an ATTRIBUTE rendered via CSS ::after — NOT an appended
  // child node. The React chat app re-renders message subtrees and DELETES any
  // child element we inject (that is why an earlier appendChild(span) version
  // left messages flagged \`stamped\` but with the <span> gone — 4 stamped, only 1
  // span survived). An attribute set on the message element survives React's
  // reconciliation (it ignores unknown data-* attrs), exactly like UserStyle's
  // and Blockquote's data-cc-* hooks. The stylesheet draws the time with
  //   [data-cc-dt-time]::after { content: attr(data-cc-dt-time); … }
  // so there is no child node for React to strip. STAMPED_ATTR also carries the
  // value, and we only re-write when the value drifts, so this stays idempotent
  // and self-healing across re-renders.
  function stampTime(el, d) {
    var t = fmtTime(d);
    if (el.getAttribute(STAMPED_ATTR) === "1" && el.getAttribute(TIME_ATTR) === t) {
      return;
    }
    el.setAttribute(TIME_ATTR, t);
    el.setAttribute(STAMPED_ATTR, "1");
  }

  function makeSeparator(d) {
    var sep = D.createElement("div");
    sep.className = SEP_CLASS;
    sep.setAttribute("data-cc-dt-day", dayKey(d));
    var inner = D.createElement("span");
    inner.textContent = fmtDate(d);
    sep.appendChild(inner);
    return sep;
  }

  // Warn ONCE if the chat clearly has content but our selectors matched nothing —
  // the strong signal that an extension redesign broke this feature's selectors,
  // surfaced loudly in the console instead of failing silently.
  var _warnedEmpty = false;
  function warnIfBlind(found) {
    if (found || _warnedEmpty) return;
    var root = chatRoot();
    var hasContent = root && (root.textContent || "").trim().length > 200;
    if (hasContent) {
      _warnedEmpty = true;
      try {
        console.warn(
          "[cc-datetime] no message elements matched on a non-empty chat — " +
            "the webview layout likely changed; update MESSAGE_SELECTORS in " +
            "behaviorFeatures.datetime.ts."
        );
      } catch (e) {}
    }
  }

  function run() {
    var msgs = candidateMessages();
    // Cheap, EVERY-sweep headline so a stalled sweep is visible in the console,
    // independent of any richer diagnostic.
    try {
      console.log("[cc-datetime] sweep candidateCount=" + ((msgs && msgs.length) || 0) + " docHasChat=" + (!!(D.querySelector && D.querySelector("[class*='userMessage'],[class*='turn_']"))));
    } catch (e) {}
    if (!msgs.length) {
      warnIfBlind(false);
      return;
    }
    // Sort by the stable derived time so separators land in chronological order.
    msgs.sort(function (a, b) {
      var da = messageTime(a);
      var db = messageTime(b);
      return da - db || (da.__seq || 0) - (db.__seq || 0);
    });

    var lastDay = null;
    for (var i = 0; i < msgs.length; i++) {
      var el = msgs[i];
      var d = messageTime(el);
      stampTime(el, d);
      var key = dayKey(d);
      if (key !== lastDay) {
        // Insert a date separator before the first message of a new day, unless
        // one for that day is already directly before it.
        var prev = el.previousElementSibling;
        var already =
          prev &&
          prev.classList &&
          prev.classList.contains(SEP_CLASS) &&
          prev.getAttribute("data-cc-dt-day") === key;
        if (!already && el.parentNode) {
          el.parentNode.insertBefore(makeSeparator(d), el);
        }
        lastDay = key;
      }
    }
  }

  // Re-stamp on DOM changes (streamed/added messages), debounced.
  var pending = null;
  function schedule() {
    if (pending) return;
    pending = W.setTimeout(function () {
      pending = null;
      try {
        run();
      } catch (e) {}
    }, 120);
  }

  // init(doc, win) — called by window.__ccOnChatDoc with the real chat document.
  // Bind D/W to that document/window, then run + observe it.
  function init(doc, win) {
    D = doc;
    W = win || window;
    try {
      run();
    } catch (e) {}
    try {
      // Route the body observer through the shared self-churn-guarded helper so a
      // steady-state sweep that re-touches our own data-cc-dt-* attrs / .cc-dt-time
      // nodes never reschedules itself (the ~6Hz freeze class). __ccObserve owns the
      // debounce, so the local \`schedule\` is not passed — \`run\` is the sweep.
      if (W.__ccObserve) {
        W.__ccObserve(D.body, run, {
          ownClass: TIME_CLASS,          // cc-dt-time (+ date-sep is our node too)
          ownAttrPrefix: "data-cc-dt",   // data-cc-dt-time / -stamped / -day
        });
      } else {
        new W.MutationObserver(schedule).observe(D.body, {
          childList: true,
          subtree: true,
        });
      }
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
      if (++tries >= 25) { clearInterval(t); try { fn(document, window); } catch (e) {} }
    }, 200);
  }
})();
`.trim();

const CSS = `
/* Messenger-style date separators + per-message time stamps. */

/* Big, bold, centered date separator at each day boundary. */
.cc-dt-date-sep {
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 18px 0 12px;
  text-align: center;
  user-select: none;
}

.cc-dt-date-sep span {
  display: inline-block;
  padding: 4px 14px;
  font-family: var(--vscode-font-family, sans-serif);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.02em;
  /* badge-foreground is the token VS Code themes pair with badge-background for
     contrast — using descriptionForeground here (a token meant for plain text on
     the editor background) produced unreadable dark-on-blue text in some themes. */
  color: var(--vscode-badge-foreground, #ffffff);
  background: var(--vscode-badge-background, rgba(120, 120, 120, 0.25));
  border-radius: 12px;
}

/* Small time label on each message, rendered via a CSS ::after on a data-
   attribute — NOT an injected child node. The React chat app re-renders message
   subtrees and strips any <span> we append (an earlier appendChild version left
   messages flagged stamped but with the span gone), but it preserves unknown
   data-* attributes, so an attribute-driven ::after survives re-renders. */
/* Guard: never render the stamp on the prompt composer / scroll container, even
   if a stale attribute lingers there from an earlier build (that is what blew the
   input box up). The [class*=…] guards keep the ::after off the input area. */
[data-cc-dt-time][class*="messageInput"]::after,
[data-cc-dt-time][class*="messagesContainer"]::after,
[data-cc-dt-time][class*="messageGradient"]::after,
[data-cc-dt-time][class*="fullEditor"]::after {
  content: none !important;
}

[data-cc-dt-time]::after {
  content: attr(data-cc-dt-time);
  display: inline-block;
  /* logical margin so it flips correctly in RTL locales (Arabic, Hebrew, …) */
  margin-inline-start: 8px;
  padding: 0 2px;
  font-family: var(--vscode-font-family, sans-serif);
  font-size: 10px;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
  vertical-align: baseline;
  color: var(--vscode-descriptionForeground, #8a8a8a);
  opacity: 0.75;
  user-select: none;
  pointer-events: none;
}

/* Legacy child-span form — kept so any older injected span still styles. */
.cc-dt-time {
  display: inline-block;
  margin-inline-start: 8px;
  padding: 0 2px;
  font-size: 10px;
  color: var(--vscode-descriptionForeground, #8a8a8a);
  opacity: 0.75;
  user-select: none;
  pointer-events: none;
}
`.trim();

registerFeature({ id: "datetime", label: "Date / time stamps", js: JS, css: CSS });
