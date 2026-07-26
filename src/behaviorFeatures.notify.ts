import { registerFeature } from "./behaviorFeatures";

const JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-notify] Chat Notify Feature.js loaded");
  } catch (e) {}

  function register(fn) {
    if (window.__ccOnChatDoc) { window.__ccOnChatDoc(fn); return; }
    (window.__ccPending = window.__ccPending || []).push(fn);
    var tries = 0;
    var t = setInterval(function () {
      if (window.__ccOnChatDoc) { clearInterval(t); return; }
      if (++tries >= 25) { clearInterval(t); try { fn(document, window); } catch (e) {} }
    }, 200);
  }

  // Notify: flashes the VS Code taskbar icon (via the openExternalBridge's
  // extension-host ccNotify handler -- see openExternalBridge.ts) and/or plays
  // a soft audible ping when (a) an AskUserQuestion dialog appears, or (b) a
  // reply finishes streaming. Two independent VS Code settings gate each
  // trigger (notifyFlashOnAsk / notifyFlashOnComplete); a third
  // (notifySoundOnComplete) gates the sound, seeded into localStorage the same
  // way every other per-feature tunable is (see behaviorInject.ts's
  // seedScript()/NOTIFY_KEYS) so a settings.json edit takes effect on the next
  // window reload without any other plumbing.
  function init(D, W) {
    var FLASH_ASK_KEY = "cc-notify-flash-on-ask";
    var FLASH_COMPLETE_KEY = "cc-notify-flash-on-complete";
    var SOUND_COMPLETE_KEY = "cc-notify-sound-on-complete";

    function boolSetting(key, fallback) {
      try {
        var v = W.localStorage.getItem(key);
        if (v === "true") return true;
        if (v === "false") return false;
        return fallback;
      } catch (e) { return fallback; }
    }

    // ---- taskbar flash: relayed through the extension host -----------------
    // The webview cannot flash the OS taskbar itself -- only the extension
    // host can (via vscode.window.showInformationMessage, which Windows uses
    // as the trigger to flash an unfocused app's taskbar icon). Reuses the
    // SAME bridge googlesearch/filelinks already ride (window.__ccVsCodeApi,
    // captured as a side effect of the webview's own single acquireVsCodeApi()
    // call -- never called a second time here). Silently no-ops if the bridge
    // isn't available (an older/mismatched Claude Code build).
    function flashWindow(text) {
      try {
        if (W.__ccVsCodeApi && typeof W.__ccVsCodeApi.postMessage === "function") {
          W.__ccVsCodeApi.postMessage({ type: "ccNotify", flash: true, text: text });
        }
      } catch (e) {}
    }

    // ---- audible ping: played FROM the webview itself (WebAudio) -----------
    // No extension-host sound API is used here (VS Code has none built for
    // this); a short, soft two-tone beep is synthesized locally so no external
    // audio asset needs to be shipped/loaded under this webview's CSP.
    var audioCtx = null;
    function beep() {
      try {
        var Ctx = W.AudioContext || W.webkitAudioContext;
        if (!Ctx) return;
        if (!audioCtx) audioCtx = new Ctx();
        if (audioCtx.state === "suspended" && audioCtx.resume) { try { audioCtx.resume(); } catch (e) {} }
        var now = audioCtx.currentTime;
        var gain = audioCtx.createGain();
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
        gain.connect(audioCtx.destination);
        var osc = audioCtx.createOscillator();
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.setValueAtTime(1108.73, now + 0.12);
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + 0.3);
      } catch (e) {}
    }

    function notify(text, flashKey, soundKey) {
      try {
        if (boolSetting(flashKey, true)) flashWindow(text);
        if (soundKey && boolSetting(soundKey, false)) beep();
      } catch (e) {}
    }

    // ---- trigger 1: AskUserQuestion dialog appears --------------------------
    // Reuses the SAME structural dialog-detection as behaviorFeatures.askcollapse.ts
    // (role=dialog/alertdialog, or a dialog/modal/popover/question/askuser-classed
    // element) -- a lighter subset of it (existence check only, no card/backdrop
    // resolution) since this feature only needs to know a question dialog is on
    // screen, not manipulate it. Fires at most once per distinct dialog element
    // (data-cc-notify-asked), so re-renders of the SAME dialog never re-notify.
    var ASKED_ATTR = "data-cc-notify-asked";
    function chatRoot() { return D.getElementById("root") || D.body; }

    function findQuestionDialogs() {
      var root = chatRoot();
      var cands = root.querySelectorAll(
        "[role='dialog'],[role='alertdialog'],[class*='dialog' i],[class*='modal' i],[class*='question' i],[class*='askUser' i],[class*='permission' i]"
      );
      var out = [];
      for (var i = 0; i < cands.length; i++) {
        var el = cands[i];
        if (el.getAttribute(ASKED_ATTR) === "1") continue;
        // must actually look like a real dialog card, not just a class-name
        // fragment on an unrelated element (e.g. "dialog_header")
        var role = el.getAttribute("role");
        var looksReal = role === "dialog" || role === "alertdialog";
        if (!looksReal) {
          var r = null;
          try { r = el.getBoundingClientRect ? el.getBoundingClientRect() : null; } catch (e) {}
          looksReal = !!(r && r.width >= 240 && r.height >= 80);
        }
        if (looksReal) out.push(el);
      }
      return out;
    }

    function checkAskDialog() {
      var dialogs = findQuestionDialogs();
      for (var i = 0; i < dialogs.length; i++) {
        dialogs[i].setAttribute(ASKED_ATTR, "1");
      }
      if (dialogs.length) notify("Claude is asking a question", FLASH_ASK_KEY, SOUND_COMPLETE_KEY);
    }

    // ---- trigger 2: a reply finishes streaming ------------------------------
    // Claude Code shows a "Stop" control (aria-label/title containing "stop") in
    // the composer's send-button slot while a reply is actively streaming, which
    // reverts back to the ordinary Send control the moment the stream ends. This
    // is the same structural signal a user watches for visually, so it is a
    // reliable, bundle-version-independent way to detect "the reply just
    // finished" without hooking into Claude Code's own internal stream state.
    var wasStreaming = false;
    function isStreamingNow() {
      var stopBtn = D.querySelector(
        "button[aria-label*='stop' i],button[title*='stop' i]"
      );
      return !!stopBtn;
    }

    function checkStreamingEdge() {
      var streaming = isStreamingNow();
      if (wasStreaming && !streaming) {
        notify("Claude finished replying", FLASH_COMPLETE_KEY, SOUND_COMPLETE_KEY);
      }
      wasStreaming = streaming;
    }

    function run() {
      try { checkAskDialog(); } catch (e) {}
      try { checkStreamingEdge(); } catch (e) {}
    }

    var pending = null;
    function schedule() {
      if (pending) return;
      pending = W.setTimeout(function () {
        pending = null;
        try { run(); } catch (e) {}
      }, 200);
    }

    try { run(); } catch (e) {}
    try {
      new W.MutationObserver(schedule).observe(D.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["aria-label", "title", "class"],
      });
    } catch (e) {}
  }

  register(init);
})();
`.trim();

const CSS = `
/* Notify has no visible UI of its own -- it is an event-driven watcher that
   flashes the VS Code taskbar / plays a soft ping on an AskUserQuestion
   dialog or a finished reply. This near-empty stylesheet keeps the feature a
   normal copy-and-inject asset PAIR (js + css), matching every other
   feature; it styles nothing visible. */
[data-cc-notify-asked] {
  /* handled-dialog marker -- no visual change */
}
`.trim();

registerFeature({
  id: "notify",
  label: "Flash window / sound on question or completion",
  js: JS,
  css: CSS,
  // No smartsClaudeManager.feature.notify master checkbox — its own three
  // Notifications-section settings (notifyFlashOnAsk/notifyFlashOnComplete/
  // notifySoundOnComplete) already fully gate it; a redundant master switch
  // would be one more control the user has to also remember to check.
  noMasterToggle: true,
});
