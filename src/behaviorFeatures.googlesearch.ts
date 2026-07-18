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

  // Right-clicking a text selection inside a chat message adds a "Search
  // <selection> on Google" item to the browser's own native context menu (Cut/
  // Copy/Paste). Selecting it copies the Google search URL for the selected
  // text to the clipboard (the chat webview's sandbox blocks opening a new
  // browser window directly -- see copyToClipboard()'s comment below).
  // Mirrors behaviorFeatures.reply.ts's own selection-scoping: never offered
  // for text selected inside the composer (that is editing, not researching).
  function init(D, W) {
    try {
      console.log("[cc-googlesearch] Google Search Feature loaded");
    } catch (e) {}

    var MENU_ID = "cc-googlesearch-menu";
    var MAX_LABEL_CHARS = 40;

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

    function truncate(text) {
      if (text.length <= MAX_LABEL_CHARS) return text;
      return text.slice(0, MAX_LABEL_CHARS - 1) + "\\u2026";
    }

    function getMenu() {
      var el = D.getElementById(MENU_ID);
      if (el) return el;
      el = D.createElement("div");
      el.id = MENU_ID;
      el.setAttribute("role", "menu");
      el.style.display = "none";
      D.body.appendChild(el);
      return el;
    }

    function hideMenu() {
      var el = D.getElementById(MENU_ID);
      if (el) el.style.display = "none";
    }

    // The chat webview is an iframe VS Code sandboxes WITHOUT "allow-popups"
    // (confirmed live: "Blocked opening '...' in a new window because the
    // request was made in a sandboxed frame whose 'allow-popups' permission is
    // not set" -- both window.open() and a real <a target="_blank"> click hit
    // this same wall, since it blocks new-window navigation outright, not just
    // the API used to request it). Reaching the extension host's real
    // vscode.env.openExternal would need a postMessage bridge into Claude
    // Code's own webview panel, which this extension does not own/create and
    // cannot safely patch (their message dispatcher is a private, minified
    // router -- see acquireVsCodeApi's documented double-acquire crash for why
    // we don't reach for our own vscode API handle here either). So: copy the
    // URL to the clipboard instead (the one channel this sandbox does not
    // block) and show a brief on-screen confirmation telling the user to
    // paste it into their browser.
    function copyToClipboard(text, done) {
      try {
        if (W.navigator && W.navigator.clipboard && W.navigator.clipboard.writeText) {
          W.navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text, done); });
          return;
        }
      } catch (e) {}
      legacyCopy(text, done);
    }

    function legacyCopy(text, done) {
      try {
        var ta = D.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        ta.style.pointerEvents = "none";
        D.body.appendChild(ta);
        ta.focus();
        ta.select();
        try { D.execCommand("copy"); } catch (e) {}
        D.body.removeChild(ta);
        if (done) done();
      } catch (e) {}
    }

    function showCopiedToast(x, y) {
      var el = D.createElement("div");
      el.id = "cc-googlesearch-toast";
      el.setAttribute("role", "status");
      el.textContent = "Search link copied \\u2014 paste it into your browser";
      D.body.appendChild(el);
      var w = el.offsetWidth || 260;
      var h = el.offsetHeight || 32;
      var left = Math.min(x, W.innerWidth - w - 6);
      var top = Math.min(y, W.innerHeight - h - 6);
      el.style.left = Math.max(6, Math.round(left)) + "px";
      el.style.top = Math.max(6, Math.round(top)) + "px";
      W.setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 2200);
    }

    function openGoogleSearch(text, x, y) {
      var url = "https://www.google.com/search?q=" + encodeURIComponent(text);
      try {
        copyToClipboard(url, function () { showCopiedToast(x, y); });
      } catch (e) {
        try { console.error("[cc-googlesearch] failed to copy search link", e); } catch (e2) {}
      }
    }

    function showMenu(x, y, text) {
      var menu = getMenu();
      menu.innerHTML = "";
      var item = D.createElement("div");
      item.className = "cc-googlesearch-item";
      item.setAttribute("role", "menuitem");
      item.textContent = 'Search "' + truncate(text) + '" on Google';
      item.addEventListener("mousedown", function (e) {
        e.preventDefault();
        e.stopPropagation();
        openGoogleSearch(text, x, y);
        hideMenu();
      });
      menu.appendChild(item);
      menu.style.display = "block";
      // Clamp inside the viewport (the menu is measured after it's visible).
      var w = menu.offsetWidth || 220;
      var h = menu.offsetHeight || 32;
      var left = Math.min(x, W.innerWidth - w - 6);
      var top = Math.min(y, W.innerHeight - h - 6);
      menu.style.left = Math.max(6, Math.round(left)) + "px";
      menu.style.top = Math.max(6, Math.round(top)) + "px";
    }

    D.addEventListener("contextmenu", function (e) {
      var sel = W.getSelection();
      var text = sel ? String(sel).trim() : "";
      if (!text || !selectionIsInChat(sel)) {
        hideMenu();
        return;
      }
      e.preventDefault();
      showMenu(e.clientX, e.clientY, text);
    });

    D.addEventListener("mousedown", function (e) {
      var menu = D.getElementById(MENU_ID);
      if (menu && menu.style.display !== "none" && !menu.contains(e.target)) hideMenu();
    });
    D.addEventListener("scroll", hideMenu, true);
    W.addEventListener("resize", hideMenu);
    D.addEventListener("keydown", function (e) {
      if (e.key === "Escape") hideMenu();
    });
    W.addEventListener("blur", hideMenu);
  }

  register(init);
})();
`.trim();

const CSS = `
/* Custom context-menu item: "Search <selection> on Google". */
#cc-googlesearch-menu {
  position: fixed;
  z-index: 2147483647;
  display: none;
  min-width: 160px;
  max-width: 320px;
  padding: 4px;
  font-family: var(--vscode-font-family, sans-serif);
  font-size: 13px;
  color: var(--vscode-menu-foreground, var(--vscode-foreground));
  background: var(--vscode-menu-background, #1f1f1f);
  border: 1px solid var(--vscode-menu-border, transparent);
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}

.cc-googlesearch-item {
  padding: 6px 10px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: none;
}

.cc-googlesearch-item:hover {
  background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
  color: var(--vscode-menu-selectionForeground, var(--vscode-foreground));
}

/* Brief "copied" confirmation shown after the search link is copied (the chat
   webview's sandbox blocks opening a new browser window directly). */
#cc-googlesearch-toast {
  position: fixed;
  z-index: 2147483647;
  padding: 6px 10px;
  font-family: var(--vscode-font-family, sans-serif);
  font-size: 12px;
  color: var(--vscode-menu-foreground, var(--vscode-foreground));
  background: var(--vscode-menu-background, #1f1f1f);
  border: 1px solid var(--vscode-menu-border, transparent);
  border-radius: 6px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  pointer-events: none;
}
`.trim();

registerFeature({ id: "googlesearch", label: "Search selection on Google", js: JS, css: CSS });
