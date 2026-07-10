// Chat DraftSave feature — ported from smarts-claude-patch's standalone
// "Chat DraftSave Feature.js"/".css" asset pair into this extension's inline-injection
// convention (see behaviorFeatures.ts).
//
// Auto-saves the composer's typed text to localStorage IN REAL TIME (debounced) under a
// PER-CHAT key, so a half-typed message is never lost across a reload, a closed tab, or an
// app restart. On init/reload it RESTORES the saved draft into an empty composer; when the
// message is SENT (Enter or the send button) it CLEARS that chat's key.
//
// PER-CHAT KEY: cc-draft:<chatId>, where <chatId> is read from the webview page_url's
// id=<uuid> param (?id=<uuid>&parentId=...&origin=...&extensionId=Anthropic.claude-code&...).
// An earlier version read a session=<uuid> param instead, on the assumption that id= was a
// volatile per-reload value and session= was the stable per-chat one — but real webview URLs
// captured from this VS Code Claude Code build NEVER contain a session= param at all, so
// chatId() always returned null and draftKey() was always null too: saveNow()/restoreIfEmpty()
// permanently no-opped at their `if (!key) return;` guards, meaning DraftSave never actually
// saved or restored anything in this extension despite looking fully implemented. id= is now
// read directly (session= kept as a fallback in case a future build ever adds it). This trades
// away persistence across a FULL WINDOW RELOAD (id= is per-webview-instance, so a reload that
// tears down and recreates the iframe gets a new id=) for the primary goal actually working:
// within a tab's live session (typing, navigating the chat, switching away and back without a
// reload), the draft correctly round-trips. A tab with NO id= param yet (should not happen in
// practice, since Claude Code assigns id= immediately) has NO stable identity — it never saves
// and never restores, and does NOT fall back to a shared key. An earlier version fell back to
// the literal key "cc-draft:default" for every such tab, so a brand-new tab's empty composer
// could be silently filled with whatever draft text another session-less tab had last saved —
// cross-tab draft leakage into a fresh chat.
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

  // Returns null — NOT a shared fallback string — when no id is present yet (should not
  // happen in practice, since Claude Code assigns id= to every webview immediately). A
  // shared "default" fallback here previously made EVERY id-less tab read and write the
  // SAME localStorage key, so a new tab's empty composer got clobbered with whatever draft
  // another such tab had last saved — cross-tab draft leakage. Callers must treat null as
  // "no stable identity yet" and skip save/restore.
  function chatId() {
    try {
      var qs = (W.location && W.location.search) || "";
      // id= is the param this VS Code Claude Code webview ACTUALLY carries (verified
      // live: every captured URL is "?id=<uuid>&parentId=...&origin=...&extensionId=
      // Anthropic.claude-code&..."). session= is tried first only as a forward-compat
      // fallback in case a future build adds a genuinely stable per-chat param — it has
      // never been observed to exist here.
      var m = /[?&]session=([^&]+)/.exec(qs) || /[?&]id=([^&]+)/.exec(qs);
      if (m && m[1]) return decodeURIComponent(m[1]);
      // some hosts put it on the parent frame's URL; try the top document too
      try {
        var pqs = (W.top && W.top.location && W.top.location.search) || "";
        var pm = /[?&]session=([^&]+)/.exec(pqs) || /[?&]id=([^&]+)/.exec(pqs);
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

  // NOTE: acquireVsCodeApi() can only be called ONCE per webview. Claude Code's
  // own extension code already calls it to obtain its VS Code API handle (used
  // for its own React/Redux store's postMessage/setState plumbing). A prior
  // version of this feature called acquireVsCodeApi() a second time here (as a
  // probe for a vscode.setState()-based draft-persistence redesign) — that
  // second call throws inside VS Code's webview runtime, and because it ran
  // during the chat webview's bootstrap, it corrupted Claude Code's own store
  // init and crashed the whole chat panel ("Something went wrong / Error
  // rendering content: Encountered errors while disposing of store"). Do NOT
  // call acquireVsCodeApi() from this injected script again — draft persistence
  // stays on the per-webview id= URL param (see chatId() above), which does not
  // survive a full reload but never crashes the host.

  function init(doc, win) {
    D = doc;
    W = win || window;
    _boundInput = null;
    purgeLegacyDefaultKey();
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
   localStorage (per-chat key) and restores it on reload. This stylesheet is an
   intentional (near-)empty placeholder so the feature stays a normal copy-and-inject
   asset PAIR (js + css), matching every other feature. It styles nothing visible. */
[data-cc-draftsave] {
  /* marker only — no visual change */
}
`.trim();

registerFeature({ id: "draftsave", label: "Composer draft save", js: JS, css: CSS });
