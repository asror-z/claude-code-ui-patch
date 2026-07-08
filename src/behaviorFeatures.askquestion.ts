import { registerFeature } from "./behaviorFeatures";

const JS = `
(function () {
  "use strict";

  try {
    (window.__ccLog || console.log.bind(console, "askquestion", "log"))("askquestion", "log", "[cc-askq] Chat AskQuestion Feature.js loaded");
  } catch (e) {}

  var DONE_ATTR = "data-cc-md";

  // Selectors that identify an AskUserQuestion card. The webview markup is
  // minified/obfuscated, so match on several cues and fall back to a text probe.
  var CARD_SELECTORS = [
    "[data-testid*='question']",
    "[data-testid*='ask']",
    "[class*='question']",
    "[class*='Question']",
    "[class*='askUser']",
    "[class*='AskUser']",
    "[class*='option']",
    "[class*='choice']",
  ];

  // D = the chat document, W = its window (bound by init()).
  var D = document;
  var W = window;

  function chatRoot() {
    return D.getElementById("root") || D.body;
  }

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Render a single line of inline Markdown to safe HTML (input already escaped).
  function inlineMd(escaped) {
    return escaped
      .replace(/\`([^\`]+)\`/g, "<code>$1</code>")
      .replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>")
      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\\*([^*\\n]+)\\*/g, "$1<em>$2</em>")
      .replace(/(^|[^_])_([^_\\n]+)_/g, "$1<em>$2</em>");
  }

  // Convert raw text (with literal "\\n" or real newlines and inline markdown)
  // into safe rendered HTML with <br> breaks and simple bullet handling.
  function renderText(raw) {
    var normalized = raw.replace(/\\\\r\\\\n|\\\\n|\\r\\n|\\r/g, "\\n").replace(/\\\\t/g, "    ");
    var lines = normalized.split("\\n");
    var html = lines
      .map(function (line) {
        var escaped = escapeHtml(line);
        var bullet = escaped.match(/^(\\s*)[-*]\\s+(.*)$/);
        if (bullet) {
          return (
            '<span class="cc-md-bullet">' +
            "&bull; " +
            inlineMd(bullet[2]) +
            "</span>"
          );
        }
        return inlineMd(escaped);
      })
      .join("<br>");
    return html;
  }

  // A text node is worth rendering only if it carries markup we transform.
  function looksMarkdownish(text) {
    return (
      /\\\\n|\\\\t/.test(text) ||
      /\\n/.test(text) ||
      /\\*\\*[^*]+\\*\\*/.test(text) ||
      /__[^_]+__/.test(text) ||
      /\`[^\`]+\`/.test(text) ||
      /(^|\\n)\\s*[-*]\\s+\\S/.test(text) ||
      /[*_][^*_\\s][^*_]*[*_]/.test(text)
    );
  }

  function isExcluded(node) {
    var n = node && node.nodeType === 3 ? node.parentNode : node;
    while (n && n !== D.body) {
      if (n.nodeType === 1) {
        if (n.getAttribute && n.getAttribute(DONE_ATTR) === "1") return true;
        var tag = n.tagName;
        if (tag === "CODE" || tag === "PRE" || tag === "SCRIPT" || tag === "STYLE")
          return true;
        if (n.classList && n.classList.contains("monaco-editor")) return true;
        var ce = n.getAttribute && n.getAttribute("contenteditable");
        if (ce === "true" || ce === "plaintext-only") return true;
      }
      n = n.parentNode;
    }
    return false;
  }

  function processCard(card) {
    if (!card || card.getAttribute(DONE_ATTR + "-card") === "1") {
      // already swept once; mutation observer will re-check new descendants
    }
    var walker = D.createTreeWalker(card, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || !node.nodeValue.trim())
          return NodeFilter.FILTER_REJECT;
        if (isExcluded(node)) return NodeFilter.FILTER_REJECT;
        return looksMarkdownish(node.nodeValue)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    var targets = [];
    var n;
    while ((n = walker.nextNode())) targets.push(n);
    for (var i = 0; i < targets.length; i++) {
      var node = targets[i];
      var span = D.createElement("span");
      span.setAttribute(DONE_ATTR, "1");
      span.className = "cc-md-rendered";
      span.innerHTML = renderText(node.nodeValue);
      if (node.parentNode) node.parentNode.replaceChild(span, node);
    }
    // Re-runs every sweep on an already-processed card; write only when it differs,
    // so a steady-state sweep emits ZERO attribute mutations (no observer churn).
    if (card.getAttribute(DONE_ATTR + "-card") !== "1") card.setAttribute(DONE_ATTR + "-card", "1");
  }

  function findCards() {
    var root = chatRoot();
    var set = new Set();
    for (var i = 0; i < CARD_SELECTORS.length; i++) {
      var nodes = root.querySelectorAll(CARD_SELECTORS[i]);
      for (var j = 0; j < nodes.length; j++) set.add(nodes[j]);
    }
    // Array.prototype.slice.call(set) returns [] (a Set has no \`length\`); use
    // Array.from to materialise the matched cards.
    return Array.from(set);
  }

  function run() {
    var cards = findCards();
    for (var i = 0; i < cards.length; i++) processCard(cards[i]);
  }

  var pending = null;
  function schedule() {
    if (pending) return;
    pending = W.setTimeout(function () {
      pending = null;
      try {
        run();
      } catch (e) {}
    }, 100);
  }

  // init(doc, win) — bootstrap hands us the chat document; bind + observe it.
  function init(doc, win) {
    D = doc;
    W = win || window;
    try {
      run();
    } catch (e) {}
    try {
      // Route the body observer through the shared self-churn-guarded helper: our
      // rendered <span class="cc-md-rendered" data-cc-md="1"> writes never reschedule
      // the sweep. __ccObserve debounces internally, so the local \`schedule\` timer is
      // no longer needed to feed it. Defensive fallback when the helper is absent.
      if (W.__ccObserve) {
        W.__ccObserve(D.body, run, { ownClass: "cc-md-rendered", ownAttrPrefix: "data-cc-md" });
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
    var t = W.setInterval(function () {
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
/* AskUserQuestion card Markdown/newline rendering fix. */

.cc-md-rendered {
  white-space: normal;
}

.cc-md-rendered code {
  padding: 0.5px 4px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 0.92em;
  background: var(--vscode-textCodeBlock-background, rgba(120, 120, 120, 0.18));
  border-radius: 3px;
}

.cc-md-rendered strong {
  font-weight: 700;
}

.cc-md-rendered em {
  font-style: italic;
}

.cc-md-rendered .cc-md-bullet {
  display: block;
  padding-left: 6px;
}
`.trim();

registerFeature({ id: "askquestion", label: "AskQuestion render fix", js: JS, css: CSS });
