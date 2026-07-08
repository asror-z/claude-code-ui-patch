import { registerFeature } from "./behaviorFeatures";

const JS = `
(function () {
  "use strict";

  function register(fn) {
    if (window.__ccOnChatDoc) { window.__ccOnChatDoc(fn); return; }
    (window.__ccPending = window.__ccPending || []).push(fn);
    var tries = 0;
    var t = setInterval(function () {
      if (window.__ccOnChatDoc) { clearInterval(t); return; }
      if (++tries >= 25) { clearInterval(t); try { fn(document, window); } catch (e) {} }
    }, 200);
  }

  // When the user selects text inside a chat message (anywhere that is NOT the
  // prompt-input box), a floating "Reply" button appears just above the
  // selection. Clicking it quotes the selected text into the prompt input as a
  // Markdown blockquote and focuses the editor.
  function init(D, W) {
    try {
      console.log("[cc-reply] Reply Feature loaded");
    } catch (e) {}

    var BTN_ID = "cc-reply-button";
    var current = { text: "" };

    function getButton() {
      var el = D.getElementById(BTN_ID);
      if (el) return el;
      el = D.createElement("button");
      el.id = BTN_ID;
      el.type = "button";
      el.innerHTML = 'Reply <span aria-hidden="true">↩</span>';
      el.setAttribute("aria-label", "Reply to selection");
      el.style.display = "none";
      // Use mousedown so the click fires before the selection is cleared by the
      // subsequent focus change to the input.
      el.addEventListener("mousedown", function (e) {
        e.preventDefault();
        e.stopPropagation();
        insertQuote(current.text);
        hideButton();
      });
      D.body.appendChild(el);
      return el;
    }

    function hideButton() {
      var el = D.getElementById(BTN_ID);
      if (el) el.style.display = "none";
      current.text = "";
    }

    // The prompt input is itself an editable region; never offer "Reply" for text
    // selected inside it (that's editing, not quoting).
    function isInsidePromptInput(node) {
      var n = node && node.nodeType === 3 ? node.parentNode : node;
      while (n && n !== D.body) {
        if (n.getAttribute) {
          var role = n.getAttribute("role");
          var ce = n.getAttribute("contenteditable");
          if (role === "textbox" || ce === "true" || ce === "plaintext-only") {
            return true;
          }
        }
        if (n.classList && n.classList.contains("monaco-editor")) return true;
        n = n.parentNode;
      }
      return false;
    }

    function selectionIsInChat(sel) {
      if (!sel.rangeCount) return false;
      var range = sel.getRangeAt(0);
      var common = range.commonAncestorContainer;
      var node = common.nodeType === 3 ? common.parentNode : common;
      if (isInsidePromptInput(node)) return false;
      return true;
    }

    function showButtonForSelection() {
      var sel = W.getSelection();
      var text = sel ? String(sel).trim() : "";
      if (!text || !selectionIsInChat(sel)) {
        hideButton();
        return;
      }
      var rect;
      try {
        rect = sel.getRangeAt(0).getBoundingClientRect();
      } catch (e) {
        hideButton();
        return;
      }
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        hideButton();
        return;
      }
      current.text = text;
      var btn = getButton();
      btn.style.display = "inline-flex";
      // Position centered above the selection, clamped to the viewport.
      var btnW = btn.offsetWidth || 80;
      var btnH = btn.offsetHeight || 28;
      var left = rect.left + rect.width / 2 - btnW / 2;
      var top = rect.top - btnH - 8;
      left = Math.max(6, Math.min(left, W.innerWidth - btnW - 6));
      if (top < 6) top = rect.bottom + 8; // flip below if no room above
      btn.style.left = Math.round(left) + "px";
      btn.style.top = Math.round(top) + "px";
    }

    // The chat prompt input is a contentEditable element, identified by
    // role="textbox" + aria-label="Message input". Fall back to other editable
    // selectors if the markup changes.
    function findPromptInput() {
      return (
        D.querySelector('[role="textbox"][aria-label="Message input"]') ||
        D.querySelector('[role="textbox"][contenteditable]') ||
        D.querySelector('[contenteditable="plaintext-only"]') ||
        D.querySelector('[contenteditable="true"]')
      );
    }

    // Build the quote as a SINGLE line (no "\\n"). This input mirrors its text
    // into an overlay that ignores line breaks, so any "\\n" makes multi-line
    // text overlap. Collapse the selection's newlines into spaces and prefix
    // once with "> ".
    function buildQuoteText(text, existing) {
      var oneLine = text
        .replace(/\\r\\n/g, "\\n")
        .split("\\n")
        .map(function (l) {
          return l.trim();
        })
        .filter(function (l) {
          return l.length;
        })
        .join(" ");
      var quote = "> " + oneLine + " ";
      // If there is already content, separate with a space so the quote doesn't
      // glue onto it.
      var prefix = existing && existing.trim().length ? " " : "";
      return prefix + quote;
    }

    // Move the caret to the very end of a contentEditable element.
    function caretToEnd(el) {
      var range = D.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      var sel = W.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }

    function insertQuote(text) {
      if (!text) return;
      var input = findPromptInput();
      if (input) {
        try {
          input.focus();
          caretToEnd(input);
          var existing = input.innerText || input.textContent || "";
          var payload = buildQuoteText(text, existing);
          // Single-line payload, single execCommand call: goes through the native
          // editing pipeline and fires the input events React listens for, with
          // no "\\n" to confuse the input's mirror overlay.
          D.execCommand("insertText", false, payload);
          input.focus();
          return;
        } catch (e) {
          /* fall through to clipboard fallback */
        }
      }
      try {
        navigator.clipboard.writeText(buildQuoteText(text, ""));
      } catch (e) {}
    }

    D.addEventListener("mouseup", function () {
      // Defer so the browser finalizes the selection first.
      setTimeout(showButtonForSelection, 0);
    });

    D.addEventListener("selectionchange", function () {
      var sel = W.getSelection();
      if (!sel || !String(sel).trim()) hideButton();
    });

    D.addEventListener("scroll", hideButton, true);
    W.addEventListener("resize", hideButton);
    D.addEventListener("keydown", function (e) {
      if (e.key === "Escape") hideButton();
    });
  }

  register(init);
})();
`.trim();

const CSS = `
/* Floating "Reply" button shown over a text selection in chat messages. */
#cc-reply-button {
  position: fixed;
  z-index: 2147483647;
  display: none;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  font-family: var(--vscode-font-family, sans-serif);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--vscode-button-foreground, #fff);
  background: var(--vscode-button-background, #1f1f1f);
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}

#cc-reply-button:hover {
  background: var(--vscode-button-hoverBackground, #2a2a2a);
}

#cc-reply-button span {
  font-size: 13px;
}
`.trim();

registerFeature({ id: "reply", label: "Reply on selection", js: JS, css: CSS });
