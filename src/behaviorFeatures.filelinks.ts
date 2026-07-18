import { registerFeature } from "./behaviorFeatures";

// Makes any INLINE code span (a backtick-quoted `` `path/to/file.ext` `` in
// Markdown, rendered as a plain <code> not inside a <pre>) that looks like a
// file path — relative or absolute, forward- or back-slashed, with or
// without spaces in its segments (this project's own filenames routinely
// contain spaces, e.g. "scripts/Verify Echo.mjs") — clickable: clicking it
// asks the extension host to open that path in a real editor tab via the
// openExternalBridge's ccOpenFile message (see openExternalBridge.ts),
// reusing the SAME window.__ccVsCodeApi bridge already wired for
// googlesearch.ts. A <pre><code> (a full fenced code BLOCK) is deliberately
// excluded — codeblock.ts already owns that surface with its own copy-button
// bar, and a multi-line block is never itself "a file path".
const JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-filelinks] Chat FileLinks Feature loaded");
  } catch (e) {}

  var D = document;
  var W = window;
  var PROCESSED_ATTR = "data-cc-filelink";
  var LINK_CLASS = "cc-filelink";

  // A deliberately WHITELIST-based heuristic (never a generic "ends in
  // \\.\\w+" pattern, which would false-positive on version numbers like
  // "2.0.87" or a decimal like "3.5") -- broad enough to cover source code,
  // config, office documents, images, media, archives, and common data
  // files, since the user asked for "every file path anywhere, any type".
  var FILE_EXT_RE = new RegExp(
    "\\\\.(" +
      "md|mjs|cjs|js|jsx|ts|tsx|json|jsonl|yml|yaml|py|rb|go|rs|java|kt|kts|swift|" +
      "c|cpp|cc|cxx|h|hpp|cs|css|scss|sass|less|html?|xml|sql|sh|bash|zsh|bat|cmd|ps1|" +
      "toml|ini|cfg|conf|env|lock|log|gitignore|dockerignore|editorconfig|npmignore|" +
      "eslintrc|prettierrc|babelrc|gradle|properties|vue|svelte|graphql|proto|" +
      "txt|rtf|csv|tsv|pdf|docx?|xlsx?|pptx?|odt|ods|odp|pages|key|numbers|" +
      "png|jpe?g|gif|bmp|svg|webp|ico|tiff?|heic|" +
      "mp3|mp4|wav|avi|mov|mkv|flac|ogg|webm|m4a|m4v|wmv|" +
      "zip|rar|7z|tar|gz|tgz|bz2|xz|" +
      "exe|dll|msi|apk|ipa|deb|rpm|vsix|dmg|" +
      "db|sqlite3?|parquet|avro" +
      ")$",
    "i",
  );
  var BARE_NAME_RE = /^(dockerfile|makefile|license|readme|changelog|procfile|gemfile|rakefile|vagrantfile)$/i;

  function looksLikeFilePath(raw) {
    var t = (raw || "").trim();
    if (!t || t.length > 400) return false;
    if (t.indexOf("\\n") !== -1) return false; // a single path is never multi-line
    return FILE_EXT_RE.test(t) || BARE_NAME_RE.test(t);
  }

  // Strip common wrapping punctuation the rendered span's own text
  // shouldn't have (belt-and-suspenders against a stray leading/trailing
  // quote or bracket surviving markdown rendering) before treating it as
  // the literal path to send.
  function cleanPath(t) {
    return t.replace(/^[\\s'"([{]+/, "").replace(/[\\s'")\\]}.,;:]+$/, "");
  }

  function openViaBridge(p) {
    try {
      if (W.__ccVsCodeApi && typeof W.__ccVsCodeApi.postMessage === "function") {
        W.__ccVsCodeApi.postMessage({ type: "ccOpenFile", path: p });
        return true;
      }
    } catch (e) {}
    return false;
  }

  function isInlineCode(el) {
    if (!el || el.tagName !== "CODE") return false;
    var p = el.parentElement;
    while (p) {
      if (p.tagName === "PRE") return false; // a fenced block -- codeblock.ts's own territory
      p = p.parentElement;
    }
    return true;
  }

  function process(el) {
    if (el.getAttribute(PROCESSED_ATTR) === "1") return;
    el.setAttribute(PROCESSED_ATTR, "1");
    var text = cleanPath(el.textContent || "");
    if (!looksLikeFilePath(text)) return;
    el.classList.add(LINK_CLASS);
    el.setAttribute("role", "link");
    el.setAttribute("tabindex", "0");
    el.setAttribute("title", "Open " + text);
    el.addEventListener("click", function (ev) {
      // Don't hijack a text-selection drag-then-release as a click-to-open.
      var sel = W.getSelection ? W.getSelection() : null;
      if (sel && String(sel).length > 0) return;
      try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
      openViaBridge(text);
    });
    el.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      try { ev.preventDefault(); } catch (e) {}
      openViaBridge(text);
    });
  }

  function run() {
    var nodes = D.querySelectorAll("code");
    for (var i = 0; i < nodes.length; i++) {
      if (isInlineCode(nodes[i])) process(nodes[i]);
    }
  }

  var pending = null;
  function schedule() {
    if (pending) return;
    pending = W.setTimeout(function () {
      pending = null;
      try { run(); } catch (e) {}
    }, 150);
  }

  // Deliberately NOT window.__ccObserve here: process() touches several
  // DIFFERENT attributes on the same element in one pass (class, role,
  // tabindex, title, plus the PROCESSED_ATTR guard) -- __ccObserve's
  // self-churn filter only recognizes a SINGLE configured attribute prefix
  // as "ours", so a "class"/"role"/"tabindex"/"title" mutation would be
  // misclassified as external and trigger an extra resweep every time (not
  // a runaway loop, since PROCESSED_ATTR still guards re-processing the SAME
  // element, but still the wrong tool for a multi-attribute write). The
  // plain observer + a local debounced schedule() is the correct, simpler
  // fit here, mirroring userstyle.ts's own established choice for the exact
  // same reason.
  function init(doc, win) {
    D = doc;
    W = win || window;
    try { run(); } catch (e) {}
    try {
      new W.MutationObserver(schedule).observe(D.body, { childList: true, subtree: true });
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
/* FileLinks — a clickable file path rendered as inline code. Keeps every
   existing inline-code style (background, monospace font) and only adds a
   pointer cursor + an underline/color shift on hover so it reads as a link
   without losing its "this is code/a path" appearance. */
code.cc-filelink {
  cursor: pointer;
}
code.cc-filelink:hover,
code.cc-filelink:focus-visible {
  text-decoration: underline;
  color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground, #4ea1ff));
}
`.trim();

registerFeature({ id: "filelinks", label: "Clickable file paths (open in editor)", js: JS, css: CSS });
