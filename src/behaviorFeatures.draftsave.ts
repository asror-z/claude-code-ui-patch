// Chat DraftSave feature — ported from smarts-claude-patch's standalone
// "Chat DraftSave Feature.js"/".css" asset pair into this extension's inline-injection
// convention (see behaviorFeatures.ts).
//
// Auto-saves the composer's typed text to localStorage IN REAL TIME (debounced) under a
// PER-CHAT key, so a half-typed message is never lost across a reload, a closed tab, or an
// app restart. On init/reload it RESTORES the saved draft into an empty composer; when the
// message is SENT (Enter or the send button) it CLEARS that chat's key.
//
// PER-CHAT KEY: cc-draft:<chatId>, where <chatId> is the STABLE chat/session id from the
// webview page_url (?…&session=<uuid>). The volatile per-webview id=<uuid> (which changes on
// reload) is deliberately NOT used, so the same chat keeps the same key across reloads. A
// tab with NO session param yet (a brand-new tab, before its session is created) has NO
// stable identity — it never saves and never restores, and does NOT fall back to a shared
// key. An earlier version fell back to the literal key "cc-draft:default" for every such
// tab, so a brand-new tab's empty composer could be silently filled with whatever draft
// text another session-less tab had last saved — cross-tab draft leakage into a fresh chat.
//
// Unlike the Antigravity build this was ported from, this target has NO nested chat iframe —
// document IS the chat document — so init(doc, win) is called directly with (document,
// window); there is no frame-hunting/frame-swap wrapper.
import { registerFeature } from "./behaviorFeatures";

const JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-draft] Chat DraftSave Feature loaded");
  } catch (e) {}

  var KEY_PREFIX = "cc-draft:";
  var SAVE_DEBOUNCE_MS = 250;

  var D = document;
  var W = window;
  var _saveTimer = null;
  var _boundInput = null; // the composer we've wired listeners onto (avoid double-binding)

  // ---- per-chat key ---------------------------------------------------------------

  // The STABLE chat id = the \`session\` query param of the webview URL. It survives a reload
  // (the volatile \`id\` param does not). Read from location.search. Returns null — NOT a
  // shared fallback string — when no session id is present yet (a brand-new tab, before its
  // Claude Code session is created). A shared "default" fallback here previously made EVERY
  // session-less tab read and write the SAME localStorage key, so a new tab's empty composer
  // got clobbered with whatever draft another such tab had last saved — cross-tab draft
  // leakage. Callers must treat null as "no stable identity yet" and skip save/restore.
  function chatId() {
    try {
      var qs = (W.location && W.location.search) || "";
      var m = /[?&]session=([^&]+)/.exec(qs);
      if (m && m[1]) return decodeURIComponent(m[1]);
      // some hosts put it on the parent frame's URL; try the top document too
      try {
        var pqs = (W.top && W.top.location && W.top.location.search) || "";
        var pm = /[?&]session=([^&]+)/.exec(pqs);
        if (pm && pm[1]) return decodeURIComponent(pm[1]);
      } catch (e) {}
    } catch (e) {}
    return null;
  }
  function draftKey() {
    var id = chatId();
    return id ? KEY_PREFIX + id : null;
  }

  function lsGet(k) { try { return W.localStorage ? W.localStorage.getItem(k) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { if (W.localStorage) W.localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { if (W.localStorage) W.localStorage.removeItem(k); } catch (e) {} }

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

  // ---- diagnose — LENGTH ONLY, never the draft text --------------------------------
  function diagLog(action, extra) {
    try {
      var payload = { kind: "cc.draftsave", action: action, chatId: chatId() };
      if (extra) for (var k in extra) payload[k] = extra[k];
      console.debug("[cc-draft]", payload);
    } catch (e) {}
  }

  // ---- save / restore / clear -----------------------------------------------------

  function saveNow() {
    var input = findComposer();
    if (!input) return;
    var key = draftKey();
    if (!key) return; // no stable session id yet — never save/restore under a shared key
    var text = composerText(input);
    if (text.trim().length === 0) {
      // empty composer → remove the key so a cleared draft is not restored later
      if (lsGet(key) != null) { lsDel(key); diagLog("cleared", { reason: "empty" }); }
      return;
    }
    lsSet(key, text);
    diagLog("saved", { len: text.length });
  }

  function scheduleSave() {
    if (_saveTimer) W.clearTimeout(_saveTimer);
    _saveTimer = W.setTimeout(function () { _saveTimer = null; try { saveNow(); } catch (e) {} }, SAVE_DEBOUNCE_MS);
  }

  function clearDraft(reason) {
    var key = draftKey();
    if (!key) return; // no stable session id yet — nothing to clear
    if (lsGet(key) != null) { lsDel(key); diagLog("cleared", { reason: reason || "sent" }); }
  }

  function restoreIfEmpty() {
    var input = findComposer();
    if (!input) return;
    if (!composerIsEmpty(input)) return; // never clobber existing text
    var key = draftKey();
    if (!key) return; // no stable session id yet — never restore a shared/cross-tab draft
    var draft = lsGet(key);
    if (!draft || !draft.trim()) return;
    try {
      input.focus();
      if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
        input.value = draft;
        input.dispatchEvent(new (W.Event || Event)("input", { bubbles: true }));
      } else {
        caretToEnd(input);
        var ok = false;
        try { ok = D.execCommand("insertText", false, draft); } catch (e) {}
        if (!ok) {
          input.textContent = draft;
          input.dispatchEvent(new (W.Event || Event)("input", { bubbles: true }));
        }
      }
      caretToEnd(input);
      diagLog("restored", { len: draft.length });
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

  // One-time purge of the legacy shared "cc-draft:default" key written by earlier builds
  // of this feature (before per-tab session ids were required). That key was read/written
  // by EVERY session-less tab, so it could hold another tab's leaked draft text; removing
  // it here stops it from ever being restored again, from any tab, going forward.
  function purgeLegacyDefaultKey() {
    try { lsDel(KEY_PREFIX + "default"); } catch (e) {}
  }

  // ---- TEMPORARY diagnostic: pinpoint where unexpected composer text comes from ----
  // A user-reported bug: a brand-new, never-used tab shows the composer pre-filled
  // with garbage (concatenated tool-call/log text) the instant it opens. DraftSave's
  // own restoreIfEmpty() requires draftKey() to be non-null (a session id must be
  // present), so if this fires on a truly session-less tab, either (a) chatId() found
  // a session id we didn't expect (e.g. a stale W.top fallback), or (b) something
  // OTHER than DraftSave is writing into the composer and this is a red herring. This
  // block force-prints, as a highly visible console.error, WHICH branch actually ran
  // and what chatId()/draftKey() resolved to, the instant restoreIfEmpty() considers
  // acting — so a single repro pinpoints the real cause instead of guessing further.
  // Remove once the report above is resolved and confirmed fixed.
  function diagDump(label, extra) {
    try {
      var input = findComposer();
      console.error(
        "[cc-draft][DIAG] " + label,
        {
          chatId: chatId(),
          draftKey: draftKey(),
          locationSearch: (W.location && W.location.search) || null,
          topLocationSearch: (function () { try { return (W.top && W.top.location && W.top.location.search) || null; } catch (e) { return "<cross-origin, blocked>"; } })(),
          composerFound: !!input,
          composerText: input ? composerText(input).slice(0, 120) : null,
          composerTag: input ? input.tagName : null,
          storedDraftForKey: draftKey() ? lsGet(draftKey()) : null,
          extra: extra || null,
        }
      );
    } catch (e) { try { console.error("[cc-draft][DIAG] dump failed", e); } catch (e2) {} }
  }

  function init(doc, win) {
    D = doc;
    W = win || window;
    _boundInput = null;
    purgeLegacyDefaultKey();
    diagDump("init start");
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
        diagDump("restoring immediately (composer already present)");
        restoreIfEmpty();
        diagDump("after immediate restoreIfEmpty");
      } else {
        var _tries = 0;
        var _raf = W.requestAnimationFrame || function (fn) { return W.setTimeout(fn, 16); };
        (function poll() {
          if (findComposer() || ++_tries >= 60) {
            diagDump("restoring via poll (tries=" + _tries + ")");
            try { restoreIfEmpty(); } catch (e) {}
            diagDump("after poll restoreIfEmpty");
            return;
          }
          _raf(poll);
        })();
      }
    } catch (e) { try { restoreIfEmpty(); } catch (e2) {} }
    // TEMPORARY diagnostic watchdog: independent of whether DraftSave itself acted,
    // poll the composer for the first 5s after mount and fire the instant it is found
    // NON-empty for the first time — this catches the culprit even if it turns out to
    // be native harness behavior or another feature entirely, not DraftSave. Remove
    // once the garbage-composer-on-new-tab report is resolved and confirmed fixed.
    (function watchFirstNonEmpty() {
      var seenNonEmpty = false;
      var start = (W.performance && W.performance.now) ? W.performance.now() : Date.now();
      var iv = W.setInterval(function () {
        try {
          var now = (W.performance && W.performance.now) ? W.performance.now() : Date.now();
          if (now - start > 5000) { W.clearInterval(iv); return; }
          if (seenNonEmpty) return;
          var input = findComposer();
          if (input && !composerIsEmpty(input)) {
            seenNonEmpty = true;
            diagDump("WATCHDOG: composer first seen NON-EMPTY at t=" + Math.round(now - start) + "ms");
            W.clearInterval(iv);
          }
        } catch (e) {}
      }, 100);
    })();
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
   localStorage (per-chat key) and restores it on reload. This stylesheet is an
   intentional (near-)empty placeholder so the feature stays a normal copy-and-inject
   asset PAIR (js + css), matching every other feature. It styles nothing visible. */
[data-cc-draftsave] {
  /* marker only — no visual change */
}
`.trim();

registerFeature({ id: "draftsave", label: "Composer draft save", js: JS, css: CSS });
