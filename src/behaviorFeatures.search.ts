// Chat Search feature — ported from smarts-claude-patch's standalone
// "Chat Search Feature.js" / "Chat Search Feature.css" asset pair into this
// extension's inline-injection convention (see behaviorFeatures.ts).
import { registerFeature } from "./behaviorFeatures";

const JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-search] Chat Search Feature.js loaded");
  } catch (e) {}

  var BAR_ID = "cc-search-bar";
  var HL_NAME = "cc-search-hl";
  var HL_ACTIVE_NAME = "cc-search-hl-active";
  var supportsHighlightApi =
    typeof window.Highlight === "function" &&
    window.CSS &&
    CSS.highlights &&
    typeof Range !== "undefined";

  var state = {
    open: false,
    query: "",
    regex: false, // regex mode (the .* toggle)
    ranges: [], // array of Range (highlight API) or <mark> els (fallback)
    index: -1,
    fallbackMarks: [],
  };

  function register(fn) {
    if (window.__ccOnChatDoc) { window.__ccOnChatDoc(fn); return; }
    (window.__ccPending = window.__ccPending || []).push(fn);
    var tries = 0;
    var t = setInterval(function () {
      if (window.__ccOnChatDoc) { clearInterval(t); return; }
      if (++tries >= 25) { clearInterval(t); try { fn(document, window); } catch (e) {} }
    }, 200);
  }

  function init(D, W) {
    // ---- the scroll/content root of the chat (NOT the search bar itself) -----
    function chatRoot() {
      return (
        D.getElementById("root") ||
        D.querySelector("[data-chat], main, .chat, .conversation") ||
        D.body
      );
    }

    // Never search inside our own UI or the prompt input editor.
    function isExcluded(node) {
      var n = node && node.nodeType === 3 ? node.parentNode : node;
      while (n && n !== D.body) {
        if (n.id === BAR_ID) return true;
        if (n.classList && n.classList.contains("monaco-editor")) return true;
        if (n.getAttribute) {
          var role = n.getAttribute("role");
          var ce = n.getAttribute("contenteditable");
          if (role === "textbox" || ce === "true" || ce === "plaintext-only") {
            // The prompt input is editable; skip it so search never targets it.
            return true;
          }
        }
        n = n.parentNode;
      }
      return false;
    }

    // ---- build the floating bar -----------------------------------------------
    function getBar() {
      var el = D.getElementById(BAR_ID);
      if (el) return el;
      el = D.createElement("div");
      el.id = BAR_ID;
      el.style.display = "none";
      // a11y: the bar is a labelled search landmark; the counter is an ARIA live
      // region so screen readers announce "3 of 17" as the user navigates.
      el.setAttribute("role", "search");
      el.setAttribute("aria-label", "Find in chat");
      el.innerHTML =
        '<input id="cc-search-input" type="text" placeholder="Find in chat…" ' +
        'aria-label="Find in chat" autocomplete="off" spellcheck="false">' +
        '<button id="cc-search-regex" type="button" title="Regular expression" ' +
        'aria-label="Toggle regular expression" aria-pressed="false">.*</button>' +
        '<span id="cc-search-count" role="status" aria-live="polite" aria-atomic="true">0/0</span>' +
        '<button id="cc-search-prev" type="button" title="Previous (Shift+Enter)" aria-label="Previous match">↑</button>' +
        '<button id="cc-search-next" type="button" title="Next (Enter)" aria-label="Next match">↓</button>' +
        '<button id="cc-search-close" type="button" title="Close (Esc)" aria-label="Close search">✕</button>';
      D.body.appendChild(el);

      var input = el.querySelector("#cc-search-input");
      var regexBtn = el.querySelector("#cc-search-regex");
      regexBtn.addEventListener("mousedown", function (e) {
        e.preventDefault();
        state.regex = !state.regex;
        regexBtn.setAttribute("aria-pressed", state.regex ? "true" : "false");
        regexBtn.classList.toggle("cc-active", state.regex);
        runSearch(input.value);
      });
      input.addEventListener("input", function () {
        runSearch(input.value);
      });
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          e.shiftKey ? gotoRelative(-1) : gotoRelative(1);
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          gotoRelative(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          gotoRelative(-1);
        } else if (e.key === "Escape") {
          e.preventDefault();
          closeBar();
        }
      });
      el.querySelector("#cc-search-prev").addEventListener("mousedown", function (e) {
        e.preventDefault();
        gotoRelative(-1);
      });
      el.querySelector("#cc-search-next").addEventListener("mousedown", function (e) {
        e.preventDefault();
        gotoRelative(1);
      });
      el.querySelector("#cc-search-close").addEventListener("mousedown", function (e) {
        e.preventDefault();
        closeBar();
      });

      // a11y: trap Tab/Shift+Tab within the bar so keyboard focus cycles through
      // input → prev → next → close and never escapes behind the open bar.
      el.addEventListener("keydown", function (e) {
        if (e.key !== "Tab") return;
        var focusable = Array.prototype.slice.call(
          el.querySelectorAll("input, button")
        );
        if (!focusable.length) return;
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        if (e.shiftKey && D.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && D.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      });
      return el;
    }

    function openBar() {
      var bar = getBar();
      // Remember what had focus so it can be restored when the bar closes (a11y).
      if (!state.open) state.prevFocus = D.activeElement;
      bar.style.display = "flex";
      state.open = true;
      var input = bar.querySelector("#cc-search-input");
      input.focus();
      input.select();
      if (input.value) runSearch(input.value);
    }

    function closeBar() {
      var bar = D.getElementById(BAR_ID);
      if (bar) bar.style.display = "none";
      state.open = false;
      clearHighlights();
      updateCount();
      // a11y: return focus to wherever it was before the bar opened.
      if (state.prevFocus && state.prevFocus.focus) {
        try { state.prevFocus.focus(); } catch (e) {}
      }
      state.prevFocus = null;
    }

    // ---- highlight management -------------------------------------------------
    function clearHighlights() {
      state.ranges = [];
      state.index = -1;
      if (supportsHighlightApi) {
        try {
          CSS.highlights.delete(HL_NAME);
          CSS.highlights.delete(HL_ACTIVE_NAME);
        } catch (e) {}
      }
      // Always unwrap any fallback <mark>s, even if the API later became available.
      for (var i = 0; i < state.fallbackMarks.length; i++) {
        var m = state.fallbackMarks[i];
        var parent = m.parentNode;
        if (!parent) continue;
        while (m.firstChild) parent.insertBefore(m.firstChild, m);
        parent.removeChild(m);
        parent.normalize();
      }
      state.fallbackMarks = [];
    }

    // Walk the chat root for matches. In plain mode it's a case-insensitive
    // substring scan; in regex mode (state.regex) the query is a case-insensitive,
    // global regex. An invalid regex yields zero matches (never throws), and a
    // regex that can match empty is guarded so the scan always advances.
    function collectMatches(query) {
      var matches = [];
      var root = chatRoot();
      var useRe = !!state.regex;
      var re = null;
      if (useRe) {
        try { re = new RegExp(query, "gi"); } catch (e) { return matches; }
      }
      var q = query.toLowerCase();
      var walker = D.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
          if (!node.nodeValue || !node.nodeValue.trim())
            return NodeFilter.FILTER_REJECT;
          if (isExcluded(node)) return NodeFilter.FILTER_REJECT;
          if (useRe) { re.lastIndex = 0; return re.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; }
          return node.nodeValue.toLowerCase().indexOf(q) !== -1
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      });
      var node;
      while ((node = walker.nextNode())) {
        var text = node.nodeValue;
        if (useRe) {
          re.lastIndex = 0;
          var m;
          while ((m = re.exec(text)) !== null) {
            var len = m[0].length;
            if (len === 0) { re.lastIndex++; continue; } // avoid an infinite loop on empty match
            matches.push({ node: node, start: m.index, end: m.index + len });
          }
        } else {
          var lower = text.toLowerCase();
          var from = 0;
          var pos;
          while ((pos = lower.indexOf(q, from)) !== -1) {
            matches.push({ node: node, start: pos, end: pos + query.length });
            from = pos + query.length;
          }
        }
      }
      return matches;
    }

    function runSearch(query) {
      clearHighlights();
      state.query = query || "";
      if (!state.query) {
        updateCount();
        return;
      }
      var matches = collectMatches(state.query);
      if (!matches.length) {
        updateCount();
        return;
      }

      if (supportsHighlightApi) {
        for (var i = 0; i < matches.length; i++) {
          var r = D.createRange();
          try {
            r.setStart(matches[i].node, matches[i].start);
            r.setEnd(matches[i].node, matches[i].end);
            state.ranges.push(r);
          } catch (e) {}
        }
      } else {
        // Fallback: wrap each match in a <mark>. Process per text node back-to-front
        // so earlier offsets stay valid while we split the node.
        var byNode = new Map();
        for (var j = 0; j < matches.length; j++) {
          var arr = byNode.get(matches[j].node) || [];
          arr.push(matches[j]);
          byNode.set(matches[j].node, arr);
        }
        byNode.forEach(function (list, textNode) {
          list.sort(function (a, b) {
            return b.start - a.start;
          });
          for (var k = 0; k < list.length; k++) {
            var seg = list[k];
            try {
              var range = D.createRange();
              range.setStart(textNode, seg.start);
              range.setEnd(textNode, seg.end);
              var mark = D.createElement("mark");
              mark.className = "cc-search-mark";
              range.surroundContents(mark);
              state.fallbackMarks.push(mark);
            } catch (e) {}
          }
        });
        // Restore document order for navigation.
        state.fallbackMarks.reverse();
        state.ranges = state.fallbackMarks.slice();
      }

      state.index = 0;
      applyHighlights();
      updateCount();
      scrollActiveIntoView();
    }

    function applyHighlights() {
      if (!supportsHighlightApi) {
        for (var i = 0; i < state.ranges.length; i++) {
          var el = state.ranges[i];
          if (el && el.classList)
            el.classList.toggle("cc-search-mark-active", i === state.index);
        }
        return;
      }
      try {
        var all = new Highlight();
        var active = new Highlight();
        for (var j = 0; j < state.ranges.length; j++) {
          if (j === state.index) active.add(state.ranges[j]);
          else all.add(state.ranges[j]);
        }
        CSS.highlights.set(HL_NAME, all);
        CSS.highlights.set(HL_ACTIVE_NAME, active);
      } catch (e) {}
    }

    function gotoRelative(delta) {
      if (!state.ranges.length) return;
      state.index =
        (state.index + delta + state.ranges.length) % state.ranges.length;
      applyHighlights();
      updateCount();
      scrollActiveIntoView();
    }

    function scrollActiveIntoView() {
      if (state.index < 0 || !state.ranges.length) return;
      var target = state.ranges[state.index];
      try {
        if (supportsHighlightApi) {
          var rect = target.getBoundingClientRect();
          var el = target.startContainer;
          el = el.nodeType === 3 ? el.parentElement : el;
          if (el && rect && (rect.top < 60 || rect.bottom > W.innerHeight - 40)) {
            el.scrollIntoView({ block: "center", behavior: "smooth" });
          }
        } else if (target && target.scrollIntoView) {
          target.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      } catch (e) {}
    }

    function updateCount() {
      var bar = D.getElementById(BAR_ID);
      if (!bar) return;
      var countEl = bar.querySelector("#cc-search-count");
      if (!countEl) return;
      var total = state.ranges.length;
      var cur = total ? state.index + 1 : 0;
      countEl.textContent = cur + "/" + total;
      // a11y: a spoken-friendly label for the live region.
      countEl.setAttribute(
        "aria-label",
        total
          ? "Match " + cur + " of " + total
          : state.query
          ? "No matches"
          : "No search"
      );
      countEl.classList.toggle("cc-search-none", state.query && total === 0);
    }

    // ---- key handling ---------------------------------------------------------
    D.addEventListener(
      "keydown",
      function (e) {
        var isFind = (e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F");
        if (isFind) {
          e.preventDefault();
          e.stopPropagation();
          openBar();
        } else if (e.key === "Escape" && state.open) {
          closeBar();
        }
      },
      true
    );
  }

  register(init);
})();
`.trim();

const CSS = `
/* Floating in-chat find bar (browser Ctrl+F-style). */
#cc-search-bar {
  position: fixed;
  top: 10px;
  right: 16px;
  z-index: 2147483646;
  display: none;
  align-items: center;
  gap: 4px;
  padding: 5px 6px;
  font-family: var(--vscode-font-family, sans-serif);
  font-size: 12px;
  color: var(--vscode-editor-foreground, #ddd);
  background: var(--vscode-editorWidget-background, #252526);
  border: 1px solid var(--vscode-editorWidget-border, #454545);
  border-radius: 6px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.45);
  user-select: none;
}

#cc-search-bar #cc-search-input {
  width: 180px;
  padding: 4px 8px;
  font-size: 12px;
  color: var(--vscode-input-foreground, #ddd);
  background: var(--vscode-input-background, #1e1e1e);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 4px;
  outline: none;
}

#cc-search-bar #cc-search-input:focus {
  border-color: var(--vscode-focusBorder, #007fd4);
}

#cc-search-bar #cc-search-count {
  min-width: 38px;
  padding: 0 4px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  color: var(--vscode-descriptionForeground, #999);
}

#cc-search-bar #cc-search-count.cc-search-none {
  color: var(--vscode-errorForeground, #f48771);
}

#cc-search-bar button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  font-size: 13px;
  line-height: 1;
  color: var(--vscode-icon-foreground, #ccc);
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

#cc-search-bar button:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.1));
}

/* a11y: a visible focus ring for keyboard users on every control. */
#cc-search-bar button:focus-visible,
#cc-search-bar #cc-search-input:focus-visible {
  outline: 2px solid var(--vscode-focusBorder, #007fd4);
  outline-offset: 1px;
}

/* CSS Custom Highlight API styling (preferred path). */
::highlight(cc-search-hl) {
  background-color: rgba(255, 214, 0, 0.35);
  color: inherit;
}

::highlight(cc-search-hl-active) {
  background-color: #ff9632;
  color: #000;
}

/* Fallback <mark> styling (when the Highlight API is unavailable). */
mark.cc-search-mark {
  background-color: rgba(255, 214, 0, 0.35);
  color: inherit;
  border-radius: 2px;
}

mark.cc-search-mark.cc-search-mark-active {
  background-color: #ff9632;
  color: #000;
}

/* regex toggle button in the search bar. */
#cc-search-regex {
  font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
  font-size: 11px;
  cursor: pointer;
  border: 1px solid var(--cc-border, rgba(128,128,128,0.35));
  background: transparent;
  color: inherit;
  border-radius: 4px;
  padding: 2px 5px;
  opacity: 0.7;
}
#cc-search-regex:hover,
#cc-search-regex.cc-active { opacity: 1; background: var(--cc-accent, #0e639c); color: var(--cc-accent-fg, #fff); }
`.trim();

registerFeature({ id: "search", label: "Chat Search (Ctrl+F)", js: JS, css: CSS });
