// Chat DraftSave feature — ported from smarts-claude-patch's standalone
// "Chat DraftSave Feature.js"/".css" asset pair into this extension's inline-injection
// convention (see behaviorFeatures.ts).
//
// Auto-saves the composer's typed text to localStorage IN REAL TIME (debounced), so a
// half-typed message is never lost across a reload, a closed tab, or an app restart. On
// init it RESTORES the saved draft into an empty composer ONLY on a genuine reload of the
// SAME webview instance (never on a brand-new tab/chat's first paint); when the message is
// SENT (Enter or the send button) it CLEARS the key.
//
// STORAGE KEY — GLOBAL, not per-chat: cc-draft:global. Two earlier per-chat-key designs were
// tried and both failed for reasons specific to THIS webview build:
//   1. A session=<uuid> URL param — never exists in this build's real webview URLs at all
//      (verified live), so the key was always null and the feature permanently no-opped.
//   2. id=<uuid> (the actual per-webview URL param this build carries) — works within a live
//      tab session, but id= regenerates on BOTH "Reload Webview" and "Reload Window"
//      (confirmed by real user testing), so the draft was lost on any reload — the exact
//      case this feature exists to protect against.
//   3. vscode.setState()/getState() via a SECOND acquireVsCodeApi() call — CRASHES THE WHOLE
//      CHAT WEBVIEW. acquireVsCodeApi() can only be called once per webview; Claude Code's
//      own extension code already claims it for its React store's postMessage/setState
//      plumbing, and a second call throws during bootstrap, corrupting that store's init
//      ("Something went wrong / Encountered errors while disposing of store"). This is
//      PERMANENTLY FORBIDDEN — see CLAUDE.md. There is no message channel back to our own
//      extension host from inside Claude Code's chat webview at all: our extension only
//      string-patches Claude Code's bundled files on disk before they load; it does not
//      itself host this webview, so there is no onDidReceiveMessage to relay through either.
// localStorage in a VS Code webview is partitioned by webview TYPE/origin, not by webview
// INSTANCE, so it already survives every reload on its own — the bug was never the storage
// medium, only the volatile id= KEY. The fix: a single fixed, non-per-chat key. Tradeoff:
// the draft is not chat-specific — switching chats can surface another chat's last draft.
// Two mitigations keep this acceptable: (a) RESTORE_ON_INIT below fires only for a real
// reload of the SAME instance (guarded by a sessionStorage flag, which — unlike
// localStorage — does NOT survive a reload, so it is unset on this instance's very first
// paint), never for a brand-new tab/chat opened while another tab has a saved draft; (b) a
// saved draft older than STALE_MS is treated as expired and never restored, so a long-stale
// draft from a different chat days ago does not resurface.
//
// Unlike the Antigravity build this was ported from, this target has NO nested chat iframe —
// document IS the chat document — so init(doc, win) is called directly with (document,
// window); there is no frame-hunting/frame-swap wrapper.
//
// DIAGNOSTICS: every save/restore/clear/expire routes through window.__ccFaroLog (see
// behaviorFeatures.faro.ts), passing "draftsave" as its own module id — a record is
// emitted only while BOTH the "Logging (console + Grafana Loki)" feature AND this
// feature's own panel checkbox are checked ON. Never logs the draft TEXT itself, only
// its length and metadata (action, reason, age).
import { registerFeature } from "./behaviorFeatures";

const JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-draft] Chat DraftSave Feature loaded");
  } catch (e) {}

  var KEY = "cc-draft:global";
  var STALE_MS = 10 * 60 * 1000; // a draft older than this is treated as expired, never restored
  var SAME_INSTANCE_FLAG = "cc-draft-instance-live"; // sessionStorage — unset on a fresh webview instance
  var SAVE_DEBOUNCE_MS = 250;

  var D = document;
  var W = window;
  var _saveTimer = null;
  var _boundInput = null; // the composer we've wired listeners onto (avoid double-binding)

  // ---- module id passed to window.__ccFaroLog — lets the Faro Logging feature
  // gate DraftSave's own records on DraftSave's own panel checkbox (see
  // behaviorFeatures.faro.ts): logging happens only while BOTH "Logging" AND
  // "Composer draft save" are checked ON in the panel.
  var MODULE_ID = "draftsave";

  function faroLog(action, extra, level) {
    try {
      if (typeof W.__ccFaroLog !== "function") return;
      var payload = { kind: "cc.draftsave", action: action };
      if (extra) for (var k in extra) payload[k] = extra[k];
      W.__ccFaroLog("cc.draftsave", payload, level || "log", MODULE_ID);
    } catch (e) {}
  }

  function lsGet(k) { try { return W.localStorage ? W.localStorage.getItem(k) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { if (W.localStorage) W.localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { if (W.localStorage) W.localStorage.removeItem(k); } catch (e) {} }

  // ---- reload-vs-new-tab detection --------------------------------------------
  // sessionStorage is scoped to this browsing context's LIFETIME (unlike
  // localStorage, which this VS Code build shares across every webview
  // instance of this type/origin) — it starts EMPTY on a brand-new webview
  // instance and, per the standard sessionStorage lifetime semantic, is
  // expected to survive an in-place reload of that same instance. We use it
  // ONLY as a best-effort signal, never as the sole gate: a saved draft is
  // still subject to the STALE_MS check below regardless of this flag, so a
  // wrong guess here degrades to "a recent global draft reappeared" at worst
  // — never a crash, never data loss.
  function looksLikeReload() {
    try {
      if (!W.sessionStorage) return false;
      return W.sessionStorage.getItem(SAME_INSTANCE_FLAG) === "1";
    } catch (e) { return false; }
  }
  function markInstanceLive() {
    try { if (W.sessionStorage) W.sessionStorage.setItem(SAME_INSTANCE_FLAG, "1"); } catch (e) {}
  }

  // ---- composer -------------------------------------------------------------------

  function findComposer() {
    return (
      D.querySelector('[role="textbox"][aria-label="Message input"]') ||
      D.querySelector('[role="textbox"][contenteditable]') ||
      D.querySelector('[contenteditable="plaintext-only"]') ||
      D.querySelector('[contenteditable="true"]') ||
      D.querySelector("textarea")
    );
  }
  function composerText(input) {
    if (!input) return "";
    if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") return input.value || "";
    return input.innerText || input.textContent || "";
  }
  function composerIsEmpty(input) {
    return composerText(input).trim().length === 0;
  }
  function caretToEnd(el) {
    try {
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
        var n = (el.value || "").length; el.setSelectionRange(n, n); return;
      }
      var range = D.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      var sel = W.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {}
  }

  // ---- save / restore / clear -----------------------------------------------------
  // Stored value is JSON { text, ts } so restoreIfEmpty() can enforce STALE_MS —
  // a long-stale draft from a different chat/session is never silently resurfaced.

  function saveNow() {
    var input = findComposer();
    if (!input) return;
    var text = composerText(input);
    if (text.trim().length === 0) {
      // empty composer → remove the key so a cleared draft is not restored later
      if (lsGet(KEY) != null) { lsDel(KEY); faroLog("cleared", { reason: "empty" }); }
      return;
    }
    try { lsSet(KEY, JSON.stringify({ text: text, ts: Date.now() })); } catch (e) {}
    faroLog("saved", { len: text.length });
  }

  function scheduleSave() {
    if (_saveTimer) W.clearTimeout(_saveTimer);
    _saveTimer = W.setTimeout(function () { _saveTimer = null; try { saveNow(); } catch (e) {} }, SAVE_DEBOUNCE_MS);
  }

  function clearDraft(reason) {
    if (lsGet(KEY) != null) { lsDel(KEY); faroLog("cleared", { reason: reason || "sent" }); }
  }

  function restoreIfEmpty() {
    var input = findComposer();
    if (!input) return;
    if (!composerIsEmpty(input)) return; // never clobber existing text
    var raw = lsGet(KEY);
    if (!raw) return;
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) {}
    // Tolerate a plain-string legacy value (pre-JSON format) as unknown-age —
    // restore it once, but never treat unknown age as fresh forever.
    var text = parsed && typeof parsed.text === "string" ? parsed.text : (typeof raw === "string" ? raw : "");
    var ts = parsed && typeof parsed.ts === "number" ? parsed.ts : 0;
    if (!text || !text.trim()) return;
    if (ts && (Date.now() - ts) > STALE_MS) {
      lsDel(KEY);
      faroLog("expired", { ageMs: Date.now() - ts });
      return;
    }
    try {
      input.focus();
      if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
        input.value = text;
        input.dispatchEvent(new (W.Event || Event)("input", { bubbles: true }));
      } else {
        caretToEnd(input);
        var ok = false;
        try { ok = D.execCommand("insertText", false, text); } catch (e) {}
        if (!ok) {
          input.textContent = text;
          input.dispatchEvent(new (W.Event || Event)("input", { bubbles: true }));
        }
      }
      caretToEnd(input);
      faroLog("restored", { len: text.length, sameInstance: looksLikeReload() });
    } catch (e) {}
  }

  // ---- send detection -------------------------------------------------------------

  function findSendButton() {
    var cands = D.querySelectorAll(
      "[class*='sendButton' i],button[aria-label*='send' i],button[title*='send' i],button[type='submit']"
    );
    for (var i = 0; i < cands.length; i++) { if (!cands[i].disabled) return cands[i]; }
    return null;
  }

  // After a send action, the composer clears — confirm it went empty before wiping the
  // draft, so a non-sending Enter (Shift+Enter newline, an IME confirm) never wipes it.
  function onMaybeSend() {
    W.setTimeout(function () {
      try {
        var input = findComposer();
        if (input && composerIsEmpty(input)) clearDraft("sent");
      } catch (e) {}
    }, 60);
  }

  // ---- wiring ---------------------------------------------------------------------

  function bindComposer() {
    var input = findComposer();
    if (!input || input === _boundInput) return;
    _boundInput = input;

    // real-time save on typing
    input.addEventListener("input", scheduleSave, true);
    input.addEventListener("keyup", scheduleSave, true);

    // send via Enter (without Shift) on the composer
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) onMaybeSend();
    }, true);
  }

  // Bind the send button (delegated, since it re-renders): a document-level click that
  // lands on/inside a send button triggers the post-send clear check.
  function bindSendClick() {
    if (W.__ccDraftSendBound) return;
    W.__ccDraftSendBound = true;
    D.addEventListener("click", function (ev) {
      try {
        var t = ev.target;
        if (t && t.closest && t.closest("[class*='sendButton' i],button[aria-label*='send' i],button[title*='send' i],button[type='submit']")) {
          onMaybeSend();
        }
      } catch (e) {}
    }, true);
  }

  var pending = null;
  function schedule() {
    if (pending) return;
    pending = W.setTimeout(function () {
      pending = null;
      try { bindComposer(); } catch (e) {}
    }, 150);
  }

  // One-time purge of the legacy per-chat "cc-draft:<id>" keys written by earlier
  // builds of this feature (before the single global key). localStorage has no
  // prefix-scan API in a webview-safe way without iterating every key, so this
  // sweeps the whole store once per init and removes any stale legacy entry.
  function purgeLegacyPerChatKeys() {
    try {
      if (!W.localStorage) return;
      var toRemove = [];
      for (var i = 0; i < W.localStorage.length; i++) {
        var k = W.localStorage.key(i);
        if (k && k.indexOf("cc-draft:") === 0 && k !== KEY) toRemove.push(k);
      }
      for (var j = 0; j < toRemove.length; j++) { try { W.localStorage.removeItem(toRemove[j]); } catch (e) {} }
    } catch (e) {}
  }

  // NOTE: acquireVsCodeApi() can only be called ONCE per webview. Claude Code's
  // own extension code already calls it to obtain its VS Code API handle (used
  // for its own React/Redux store's postMessage/setState plumbing). A prior
  // version of this feature called acquireVsCodeApi() a second time here (as a
  // probe for a vscode.setState()-based draft-persistence redesign) — that
  // second call throws inside VS Code's webview runtime, and because it ran
  // during the chat webview's bootstrap, it corrupted Claude Code's own store
  // init and crashed the whole chat panel ("Something went wrong / Error
  // rendering content: Encountered errors while disposing of store"). Do NOT
  // call acquireVsCodeApi() from this injected script again.

  function init(doc, win) {
    D = doc;
    W = win || window;
    _boundInput = null;
    purgeLegacyPerChatKeys();
    markInstanceLive();
    try { bindComposer(); } catch (e) {}
    try { bindSendClick(); } catch (e) {}
    // Restore as soon as the composer exists — NOT after a fixed delay. A 300ms
    // setTimeout here made the composer visibly render small/empty first, then
    // suddenly grow once the delayed restore inserted a saved multi-line draft —
    // a jarring "pop" on every tab open. findComposer() already returns null until
    // the element exists, so poll at animation-frame cadence and restore on the
    // very first frame it's found, instead of waiting on an arbitrary timer.
    try {
      if (findComposer()) {
        restoreIfEmpty();
      } else {
        var _tries = 0;
        var _raf = W.requestAnimationFrame || function (fn) { return W.setTimeout(fn, 16); };
        (function poll() {
          if (findComposer() || ++_tries >= 60) { try { restoreIfEmpty(); } catch (e) {} return; }
          _raf(poll);
        })();
      }
    } catch (e) { try { restoreIfEmpty(); } catch (e2) {} }
    // Route the body observer through the shared self-churn-guarded helper. This
    // observer only calls bindComposer (attaches listeners — no DOM writes), so it
    // emits no mutations of its own; the helper still gives a debounced sweep and a
    // runaway watchdog. DraftSave owns no element/attribute, so no ownClass/prefix.
    try {
      if (W.__ccObserve) {
        W.__ccObserve(D.body, function () { try { bindComposer(); } catch (e) {} });
      } else {
        new W.MutationObserver(schedule).observe(D.body, { childList: true, subtree: true });
      }
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
/* DraftSave has NO visible UI — it silently mirrors the composer's text to
   localStorage (a single global key) and restores it on reload. This stylesheet is
   an intentional (near-)empty placeholder so the feature stays a normal copy-and-inject
   asset PAIR (js + css), matching every other feature. It styles nothing visible. */
[data-cc-draftsave] {
  /* marker only — no visual change */
}
`.trim();

registerFeature({ id: "draftsave", label: "Composer draft save", js: JS, css: CSS });
