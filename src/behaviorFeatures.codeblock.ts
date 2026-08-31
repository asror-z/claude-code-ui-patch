import { registerFeature } from "./behaviorFeatures";

const JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-codeblock] Chat CodeBlock Feature.js loaded");
  } catch (e) {}

  var TAG = "data-cc-code"; // guard attr on a processed <pre>
  var BAR_CLASS = "cc-code-bar";

  // D = the chat document (set by the bootstrap in init()).
  var D = document;
  var W = window;

  var LANG_CLASS_RE = /\\b(?:language|lang)-([\\w+#.-]+)/i;
  var HLJS_RE = /\\bhljs\\s+(?:language-)?([\\w+#.-]+)/i;
  /**
   * Derive a language label from a <pre>/<code>.
   * Checks, in order: a \`language-xxx\`/\`lang-xxx\` class, a \`data-language\`/\`data-lang\` attr, an hljs \`hljs-xxx\`, then a CodeMirror mode.
   * Falls back to "code".
   * @param {Element} pre - the <pre> element.
   * @param {Element|null} code - the nested <code> element, if any.
   * @returns {string} detected language id, or "code" if none found.
   */
  function detectLang(pre, code) {
    var srcs = [];
    if (code) {
      srcs.push(code.getAttribute("class") || "");
      srcs.push(code.getAttribute("data-language") || code.getAttribute("data-lang") || "");
    }
    srcs.push(pre.getAttribute("class") || "");
    srcs.push(pre.getAttribute("data-language") || pre.getAttribute("data-lang") || "");
    for (var i = 0; i < srcs.length; i++) {
      var s = srcs[i];
      if (!s) continue;
      var m = LANG_CLASS_RE.exec(s) || HLJS_RE.exec(s);
      if (m && m[1] && m[1].toLowerCase() !== "hljs") return m[1].toLowerCase();
    }
    return "code";
  }

  /**
   * The block's raw text — prefer the <code> element's textContent, else <pre>'s.
   * Our own bar is stripped so the label/button never leak into the copy.
   * @param {Element} pre - the <pre> element.
   * @param {Element|null} code - the nested <code> element, if any.
   * @returns {string} the block's plain text content, trailing newline removed.
   */
  function blockText(pre, code) {
    var host = code || pre;
    var clone = host.cloneNode(true);
    var bars = clone.querySelectorAll ? clone.querySelectorAll("." + BAR_CLASS) : [];
    for (var i = 0; i < bars.length; i++) bars[i].remove();
    return (clone.textContent || "").replace(/\\n$/, "");
  }

  function copyText(text, btn) {
    function done() {
      var old = btn.getAttribute("data-cc-label") || "Copy";
      btn.textContent = "Copied!";
      btn.classList.add("cc-code-done");
      W.setTimeout(function () {
        btn.textContent = old;
        btn.classList.remove("cc-code-done");
      }, 1200);
    }
    try {
      if (W.navigator && W.navigator.clipboard && W.navigator.clipboard.writeText) {
        W.navigator.clipboard.writeText(text).then(done, function () { fallback(text, done); });
        return;
      }
    } catch (e) {}
    fallback(text, done);
  }
  function fallback(text, done) {
    try {
      var ta = D.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      D.body.appendChild(ta);
      ta.focus();
      ta.select();
      D.execCommand("copy");
      ta.remove();
      done();
    } catch (e) {}
  }

  function attach(pre) {
    // Live DOM re-check (React strips appended nodes): re-add the bar if gone.
    if (pre.querySelector(":scope > ." + BAR_CLASS)) return;
    var code = pre.querySelector("code") || null;
    var lang = detectLang(pre, code);

    var bar = D.createElement("div");
    bar.className = BAR_CLASS;

    var btn = D.createElement("button");
    btn.type = "button";
    btn.className = "cc-code-copy";
    btn.textContent = "Copy";
    btn.setAttribute("data-cc-label", "Copy");
    btn.setAttribute("aria-label", "Copy code");
    btn.setAttribute("title", "Copy code (Alt-click: copy as a fenced \`\`\` block)");
    btn.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      var raw = blockText(pre, code);
      // Alt/Option-click copies a fenced Markdown block with the detected language.
      var text = ev.altKey ? ("\`\`\`" + (lang && lang !== "code" ? lang : "") + "\\n" + raw + "\\n\`\`\`") : raw;
      copyText(text, btn);
    });

    bar.appendChild(btn);
    // Make the <pre> a positioning context so the bar can sit at its top-right.
    try {
      var pos = W.getComputedStyle ? W.getComputedStyle(pre).position : "";
      if (pos === "static" || !pos) pre.style.position = "relative";
    } catch (e) { pre.style.position = "relative"; }
    pre.insertBefore(bar, pre.firstChild);
    pre.setAttribute(TAG, "1");
  }

  var _warned = false;
  function run() {
    var pres = D.querySelectorAll("pre");
    var any = false;
    for (var i = 0; i < pres.length; i++) {
      var pre = pres[i];
      // only fenced code blocks: a <pre> holding a <code>, OR any <pre> with text.
      if (!pre.querySelector("code") && !(pre.textContent || "").trim()) continue;
      any = true;
      try { attach(pre); } catch (e) {}
    }
    if (!any && !_warned && D.body && (D.body.textContent || "").trim().length > 400) {
      _warned = true;
      try {
        console.warn(
          "[cc-codeblock] no <pre> code blocks matched on a non-empty chat — the " +
            "webview layout may have changed; check the selector in " +
            "Chat CodeBlock Feature.js."
        );
      } catch (e) {}
    }
  }

  var pending = null;
  function schedule() {
    if (pending) return;
    pending = W.setTimeout(function () {
      pending = null;
      try { run(); } catch (e) {}
    }, 120);
  }

  // init(doc, win) — bootstrap hands us the chat document; bind + observe.
  function init(doc, win) {
    D = doc;
    W = win || window;
    try { run(); } catch (e) {}
    try {
      // Route the body observer through the shared self-churn-guarded helper: the
      // bar (.cc-code-bar) we insert into each <pre> is our own node, so its
      // childList churn must not reschedule the sweep. __ccObserve owns the
      // debounce, so \`run\` is the sweep (the local \`schedule\` becomes the fallback).
      if (W.__ccObserve) {
        var obs = W.__ccObserve(D.body, run, {
          ownClass: BAR_CLASS,          // cc-code-bar
          ownAttrPrefix: "data-cc-code", // TAG guard attr on the <pre>
        });
        try { W.__ccCodeObs = obs; } catch (e) {}
      } else {
        var obs2 = new W.MutationObserver(schedule);
        obs2.observe(D.body, { childList: true, subtree: true });
        try { W.__ccCodeObs = obs2; } catch (e) {}
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
      if (++tries >= 25) {
        clearInterval(t);
        try { fn(document, window); } catch (e) {}
      }
    }, 200);
  }
})();
`.trim();

const CSS = `
/* Chat CodeBlock feature — per-<pre> Copy button bar. */

pre[data-cc-code="1"] {
  position: relative;
}

/* Reserve room at the top of the block so the bar doesn't overlap the first line. */
pre[data-cc-code="1"] > code {
  display: block;
}

.cc-code-bar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  position: absolute;
  top: 4px;
  right: 6px;
  left: auto;
  z-index: 5;
  pointer-events: none; /* only the button is interactive */
}

.cc-code-bar > * {
  pointer-events: auto;
}

.cc-code-copy {
  font-family: inherit;
  font-size: 11px;
  line-height: 1;
  padding: 3px 8px;
  border-radius: 5px;
  cursor: pointer;
  border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
  background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.18));
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground, #ddd));
  opacity: 0.55;
  transition: opacity 0.12s ease, background 0.12s ease, color 0.12s ease;
}

pre[data-cc-code="1"]:hover .cc-code-copy {
  opacity: 1;
}

.cc-code-copy:hover {
  background: var(--vscode-button-background, #0e639c);
  color: var(--vscode-button-foreground, #fff);
  opacity: 1;
}

.cc-code-copy.cc-code-done {
  opacity: 1;
  background: var(--vscode-testing-iconPassed, #2ea043);
  color: #fff;
  border-color: transparent;
}
`.trim();

registerFeature({ id: "codeblock", label: "Code-block Copy button", js: JS, css: CSS });
