import { registerFeature } from "./behaviorFeatures";

const JS = `
(function () {
  "use strict";

  try {
    console.log("[cc-copybtns] Chat CopyButtons Feature.js loaded");
  } catch (e) {}

  var GROUP_CLASS = "cc-copy-group";
  var BTN_CLASS = "cc-copy-btn";
  var TIME_LABEL_CLASS = "cc-copy-time"; // the time text rendered INSIDE our group
  var ATTACHED_ATTR = "data-cc-copy-attached"; // guard: message already has its group
  var HASTIME_ATTR = "data-cc-copy-hastime"; // CSS hides DateTime's ::after for this msg
  var TIME_ATTR = "data-cc-dt-time"; // the DateTime feature's per-message stamp anchor
  var COPIED_CLASS = "cc-copy-done"; // transient "Copied!" feedback state

  // Tool-call/tool-result chip containers. An assistant OUTPUT turn interleaves the
  // assistant's prose with TOOL blocks (Read/Edit/Bash) whose collapsed bodies render
  // only a SUMMARY LABEL ("49 lines of output", "Added 12 lines", "Write failed") — NOT
  // the assistant's words. We match these by SUBSTRING (the extension mints the classes
  // minified/hashed, e.g. \`toolSummary_ZUQaOA\`), a version-proof anchor that survives a
  // re-minify — never a literal hashed token.
  var TOOL_SELECTOR =
    "[class*='toolUse'],[class*='toolResult'],[class*='toolBody']," +
    "[class*='toolSummary'],[class*='toolItem'],[class*='toolName']," +
    "[class*='collapsibleToolCalls']";

  // D/W = the chat Document/Window (set by the bootstrap in init()).
  var D = document;
  var W = window;

  // --- content extraction ----------------------------------------------------
  // The webview renders message content as real DOM (paragraphs, code blocks,
  // lists, inline emphasis). We derive BOTH a Markdown and an HTML form from that
  // rendered subtree. HTML is just the message's innerHTML, lightly trimmed.
  // Markdown is a small, dependency-free DOM→Markdown walk covering the elements
  // the chat actually uses (headings, p, strong/em, code, pre, a, ul/ol/li,
  // blockquote, br, hr). Anything unknown degrades to its text content.

  // Find EVERY element that holds a piece of the message's rendered content. The
  // stamped element is the message wrapper (a turn_/userMessageContainer block);
  // an assistant OUTPUT turn can render its reply as SEVERAL SEPARATE
  // markdown/prose sub-containers (e.g. prose interleaved with tool-call chips,
  // or a long streamed reply split across multiple markdown blocks) — a single
  // "return the first one found" used to silently drop every other block, which
  // is why Copy as Markdown/HTML only ever copied one paragraph. So this now
  // returns ALL qualifying, non-nested candidates in DOCUMENT ORDER, not just one.
  // CRITICAL: a live \`turn_…\` OUTPUT wrapper NESTS the user prompt bubble
  // (\`userMessageContainer_…\`, which has its OWN \`messageContent\`) BEFORE the
  // assistant response's \`markdown\` container(s). A naive querySelector returns
  // that nested user content first — so "Copy" copied the USER message instead of
  // the OUTPUT. So we (a) collect ALL candidate containers, (b) SKIP any that live
  // inside a \`userMessageContainer\` subtree (unless msgEl itself is that user
  // bubble), (c) SKIP any tool-call/tool-result chip, (d) prefer \`markdown\`/\`prose\`
  // containers (the response) over a generic \`messageContent\`/\`content\` one when
  // BOTH kinds are present, and (e) drop any candidate that is an ANCESTOR of
  // another kept candidate, so a message never counts once as a whole AND again
  // via its own children.
  function contentRoots(msgEl) {
    var selfIsUser = isUserMessage(msgEl);
    var cands = msgEl.querySelectorAll
      ? msgEl.querySelectorAll(
          "[class*='markdown'],[class*='Markdown'],[class*='prose']," +
            "[class*='messageContent'],[class*='content']"
        )
      : [];
    var prose = [];
    var generic = [];
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (!c.textContent || !c.textContent.trim().length) continue; // skip empty shells
      // Skip a candidate that sits inside a NESTED user bubble (when the message
      // itself is NOT a user message) — that is the prompt, not the response.
      if (!selfIsUser) {
        try {
          var inUser = c.closest && c.closest('[class*="userMessageContainer"],[class*="userMessage"]');
          if (inUser && inUser !== msgEl && msgEl.contains(inUser)) continue;
        } catch (e) {}
      }
      // Skip any candidate that IS, or lives INSIDE, a tool-call/tool-result chip —
      // its text is a collapsed SUMMARY label ("49 lines of output", "Added 12 lines",
      // "Write failed"), never the assistant's prose.
      if (isInToolBlock(c)) continue;
      var cn = (c.getAttribute && c.getAttribute("class")) || "";
      var isProse = /markdown|prose/i.test(cn);
      (isProse ? prose : generic).push(c);
    }
    // Prefer the markdown/prose set when it has anything; fall back to the
    // generic messageContent/content set only when NO prose candidate exists.
    var kept = prose.length ? prose : generic;
    if (!kept.length) return [msgEl];
    // Drop any candidate that is an ancestor of another kept candidate (keep only
    // the innermost/outermost-non-overlapping set so nothing is double-counted).
    var out = [];
    for (var k = 0; k < kept.length; k++) {
      var el = kept[k];
      var isAncestorOfAnother = false;
      for (var m = 0; m < kept.length; m++) {
        if (m !== k && el !== kept[m] && el.contains(kept[m])) { isAncestorOfAnother = true; break; }
      }
      if (!isAncestorOfAnother) out.push(el);
    }
    // Sort into document order (querySelectorAll already returns document order,
    // but the prose/generic split plus the ancestor-drop above can reorder it).
    out.sort(function (a, b) {
      try { return (a.compareDocumentPosition(b) & 4) !== 0 ? -1 : 1; } catch (e) { return 0; }
    });
    return out.length ? out : [msgEl];
  }

  // Back-compat single-root accessor for callers that only need ONE anchor
  // element (e.g. indent measurement) — never used for content extraction.
  function contentRoot(msgEl) {
    var roots = contentRoots(msgEl);
    return roots[0] || msgEl;
  }

  // True if \`el\` is, or lives inside, a tool-call/tool-result chip block (whose
  // collapsed body is only a summary label, not the assistant's prose).
  function isInToolBlock(el) {
    if (!el) return false;
    try {
      if (el.matches && el.matches(TOOL_SELECTOR)) return true;
      if (el.closest && el.closest(TOOL_SELECTOR)) return true;
    } catch (e) {}
    return false;
  }

  function htmlOf(msgEl) {
    var roots = contentRoots(msgEl);
    var parts = [];
    for (var i = 0; i < roots.length; i++) {
      // Clone so we can strip our own button group AND any tool-chip blocks out of the copy.
      var clone = roots[i].cloneNode(true);
      stripOwnNodes(clone);
      var inner = (clone.innerHTML || "").trim();
      if (inner) parts.push(inner);
    }
    // Wrap the prose in a full standalone HTML document (<html><body>…</body></html>) so
    // the clipboard holds a complete document, not a bare fragment.
    return "<html>\\n<body>\\n" + parts.join("\\n") + "\\n</body>\\n</html>";
  }

  // Remove any of OUR nodes (button groups) AND any tool-call/tool-result chip blocks
  // from a clone before serializing — so a mixed prose+tool message copies only the
  // assistant's words, never a "49 lines of output" / "Added 12 lines" summary label.
  function stripOwnNodes(node) {
    if (!node.querySelectorAll) return;
    var kill = node.querySelectorAll("." + GROUP_CLASS + "," + TOOL_SELECTOR);
    for (var i = 0; i < kill.length; i++) {
      if (kill[i].parentNode) kill[i].parentNode.removeChild(kill[i]);
    }
  }

  function markdownOf(msgEl) {
    var roots = contentRoots(msgEl);
    var parts = [];
    for (var i = 0; i < roots.length; i++) {
      var clone = roots[i].cloneNode(true);
      stripOwnNodes(clone);
      var md = mdFromNode(clone).replace(/\\n{3,}/g, "\\n\\n").trim();
      if (md) parts.push(md);
    }
    return parts.join("\\n\\n").replace(/\\n{3,}/g, "\\n\\n").trim();
  }

  // Minimal, dependency-free DOM→Markdown. Recurses children; block elements get
  // surrounding newlines, inline elements wrap their text. Unknown tags fall back
  // to their children's Markdown (so structure is preserved, formatting dropped).
  function mdFromNode(node) {
    if (node.nodeType === 3) return node.nodeValue || ""; // text node
    if (node.nodeType !== 1) return ""; // comment / other
    var tag = node.tagName ? node.tagName.toLowerCase() : "";
    var inner = childrenMd(node);

    switch (tag) {
      case "h1": return "\\n# " + inner.trim() + "\\n\\n";
      case "h2": return "\\n## " + inner.trim() + "\\n\\n";
      case "h3": return "\\n### " + inner.trim() + "\\n\\n";
      case "h4": return "\\n#### " + inner.trim() + "\\n\\n";
      case "h5": return "\\n##### " + inner.trim() + "\\n\\n";
      case "h6": return "\\n###### " + inner.trim() + "\\n\\n";
      case "p": return "\\n" + inner.trim() + "\\n\\n";
      case "br": return "\\n";
      case "hr": return "\\n---\\n\\n";
      case "strong":
      case "b": return "**" + inner + "**";
      case "em":
      case "i": return "_" + inner + "_";
      case "del":
      case "s": return "~~" + inner + "~~";
      case "code":
        // Inline code only if NOT inside a <pre> (pre is handled below).
        if (node.parentNode && node.parentNode.tagName &&
            node.parentNode.tagName.toLowerCase() === "pre") return inner;
        return "\`" + (node.textContent || "") + "\`";
      case "pre": {
        var codeEl = node.querySelector ? node.querySelector("code") : null;
        var code = (codeEl ? codeEl.textContent : node.textContent) || "";
        var lang = "";
        if (codeEl && codeEl.className) {
          var m = /language-([A-Za-z0-9+#-]+)/.exec(codeEl.className);
          if (m) lang = m[1];
        }
        return "\\n\`\`\`" + lang + "\\n" + code.replace(/\\n$/, "") + "\\n\`\`\`\\n\\n";
      }
      case "a": {
        var href = node.getAttribute ? node.getAttribute("href") || "" : "";
        var txt = inner.trim() || href;
        return href ? "[" + txt + "](" + href + ")" : txt;
      }
      case "ul":
      case "ol": {
        var out = "\\n";
        var idx = 1;
        var kids = node.children || [];
        for (var i = 0; i < kids.length; i++) {
          if (kids[i].tagName && kids[i].tagName.toLowerCase() === "li") {
            var bullet = tag === "ol" ? idx++ + ". " : "- ";
            var liMd = childrenMd(kids[i]).trim().replace(/\\n/g, "\\n  ");
            out += bullet + liMd + "\\n";
          }
        }
        return out + "\\n";
      }
      case "li": return childrenMd(node); // handled by ul/ol; bare li → inline
      case "blockquote": {
        var bq = inner.trim().split("\\n").map(function (l) { return "> " + l; }).join("\\n");
        return "\\n" + bq + "\\n\\n";
      }
      case "table": return "\\n" + tableMd(node) + "\\n\\n";
      case "img": {
        var alt = node.getAttribute ? node.getAttribute("alt") || "" : "";
        var src = node.getAttribute ? node.getAttribute("src") || "" : "";
        return src ? "![" + alt + "](" + src + ")" : "";
      }
      default:
        return inner; // span, div, and unknowns: pass children through
    }
  }

  function childrenMd(node) {
    var s = "";
    var kids = node.childNodes || [];
    for (var i = 0; i < kids.length; i++) s += mdFromNode(kids[i]);
    return s;
  }

  // Minimal GFM table: header row + separator + body rows.
  function tableMd(table) {
    var rows = table.querySelectorAll ? table.querySelectorAll("tr") : [];
    if (!rows.length) return "";
    var lines = [];
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].querySelectorAll("th,td");
      var cols = [];
      for (var c = 0; c < cells.length; c++) {
        cols.push((cells[c].textContent || "").trim().replace(/\\|/g, "\\\\|"));
      }
      lines.push("| " + cols.join(" | ") + " |");
      if (r === 0) {
        var sep = [];
        for (var k = 0; k < cols.length; k++) sep.push("---");
        lines.push("| " + sep.join(" | ") + " |");
      }
    }
    return lines.join("\\n");
  }

  // --- clipboard -------------------------------------------------------------
  function copyText(text, kind, btn) {
    var done = function () { flash(btn); };
    try {
      if (W.navigator && W.navigator.clipboard && W.navigator.clipboard.writeText) {
        W.navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text, done); });
        return;
      }
    } catch (e) {}
    legacyCopy(text, done);
  }

  // Fallback for webviews where navigator.clipboard is blocked: a hidden textarea
  // + execCommand("copy"). Best-effort; swallows errors.
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

  // --- inline SVG icons (currentColor, 14px viewBox) -------------------------
  // Each button shows an icon, never a word; the title/aria-label carry the text.
  var SVG_MARKDOWN =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18v14H3z"/><path d="M7 15V9l3 3 3-3v6"/><path d="M18 9v4m0 0l-1.5-1.5M18 13l1.5-1.5"/></svg>';
  var SVG_HTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 8l-4 4 4 4"/><path d="M16 8l4 4-4 4"/><path d="M14 5l-4 14"/></svg>';
  var SVG_CHECK =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>';

  // Brief "copied" feedback: swap the copy icon to a green check, then restore.
  function flash(btn) {
    if (!btn) return;
    var prevSvg = btn.innerHTML;
    btn.classList.add(COPIED_CLASS);
    btn.innerHTML = SVG_CHECK;
    W.setTimeout(function () {
      btn.classList.remove(COPIED_CLASS);
      btn.innerHTML = prevSvg;
    }, 1100);
  }

  // --- button group ----------------------------------------------------------
  // An ICON button: the SVG is the content; the full text lives in title/aria-label
  // (hover tooltip + accessibility). No visible word.
  function makeButton(label, svg, onClick) {
    var b = D.createElement("button");
    b.type = "button";
    b.className = BTN_CLASS;
    b.innerHTML = svg;
    b.setAttribute("title", label);
    b.setAttribute("aria-label", label);
    b.setAttribute("data-cc-label", label);
    b.setAttribute("tabindex", "-1"); // don't steal tab order from the chat
    b.addEventListener("click", function (ev) {
      try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
      onClick(b);
    });
    return b;
  }

  // Per-message captured timestamp, remembered so the displayed stamp never shifts
  // when React re-renders the subtree. Keyed by the message element.
  var _stampAt = (typeof WeakMap !== "undefined") ? new WeakMap() : null;

  function stampFor(msgEl) {
    if (_stampAt) {
      var got = _stampAt.get(msgEl);
      if (got) return got;
      var made = new Date();
      _stampAt.set(msgEl, made);
      return made;
    }
    return new Date();
  }

  // Build the full "YYYY-MM-DD HH:MM:SS" label (24-hour, with seconds) for a message,
  // from the message's stable captured Date — NOT from DateTime's locale ::after string.
  function dateTimeLabel(msgEl) {
    var d = stampFor(msgEl);
    return (
      d.getFullYear() +
      "-" + pad2(d.getMonth() + 1) +
      "-" + pad2(d.getDate()) +
      " " + pad2(d.getHours()) +
      ":" + pad2(d.getMinutes()) +
      ":" + pad2(d.getSeconds())
    );
  }

  function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
  }

  function attach(msgEl) {
    // Already has a LIVE group? (React may have stripped a prior one — re-check
    // the DOM, not just the guard attribute.)
    var existing = msgEl.querySelector ? msgEl.querySelector(":scope > ." + GROUP_CLASS) : null;
    if (existing) {
      // Keep the in-group date+time text in sync if DateTime re-stamped a new value.
      var lbl = existing.querySelector ? existing.querySelector("." + TIME_LABEL_CLASS) : null;
      var dt = dateTimeLabel(msgEl);
      if (lbl && dt && lbl.textContent !== dt) lbl.textContent = dt;
      return;
    }

    var group = D.createElement("span");
    group.className = GROUP_CLASS;
    // Stop selection/clicks on the group from bubbling into the message.
    group.addEventListener("mousedown", function (e) { try { e.stopPropagation(); } catch (x) {} });

    // FIRST element of the group is the full DATE + TIME (e.g. "2026-07-01 13:38:57"):
    // a YYYY-MM-DD HH:MM:SS 24-hour timestamp built from the message's own stable
    // captured Date (stored in a WeakMap, so it never shifts on re-render) — NOT from
    // DateTime's locale ::after string. The date+time + buttons live in ONE flex row,
    // always visible. We then hide DateTime's own ::after time for THIS message (via
    // data-cc-copy-hastime) so it isn't shown twice.
    var timeLbl = D.createElement("span");
    timeLbl.className = TIME_LABEL_CLASS;
    timeLbl.textContent = dateTimeLabel(msgEl);
    group.appendChild(timeLbl);

    var mdBtn = makeButton("Copy as Markdown", SVG_MARKDOWN, function (btn) { copyText(markdownOf(msgEl), "md", btn); });
    var htmlBtn = makeButton("Copy as HTML", SVG_HTML, function (btn) { copyText(htmlOf(msgEl), "html", btn); });
    mdBtn.className += " cc-copy-do"; // copy-action accent (blue)
    htmlBtn.className += " cc-copy-do";
    group.appendChild(mdBtn);
    group.appendChild(htmlBtn);

    // NO prev/next navigation buttons here — message navigation is the toolbar UserNav's
    // job. The row holds only the date+time label and the two copy buttons.

    // Append as the message's LAST child; the group carries its own time label, so
    // time + buttons render together as one inline row at the message's end.
    msgEl.setAttribute(ATTACHED_ATTR, "1");
    msgEl.setAttribute(HASTIME_ATTR, "1"); // CSS hides DateTime's ::after for this msg
    msgEl.appendChild(group);
    // ALIGN the row's left edge with the message's PROSE content, not the outer turn
    // wrapper. msgEl is the DateTime-stamped outermost element (the turn), which is less
    // indented than the actual response text, so the timestamp would otherwise sit
    // outdented in the left gutter. Measure the real indent = prose-left − msgEl-left
    // and pad the group by it, so the timestamp starts in the same column as the text.
    // Measured once at creation (read-only rects; the group is idempotent so this never
    // re-runs on an already-attached message → no observer churn).
    try {
      var proseEl = contentRoot(msgEl);
      if (proseEl && proseEl !== msgEl && msgEl.getBoundingClientRect && proseEl.getBoundingClientRect) {
        var indent = proseEl.getBoundingClientRect().left - msgEl.getBoundingClientRect().left;
        if (indent > 0 && indent < 200) group.style.paddingLeft = Math.round(indent) + "px";
      }
    } catch (e) {}
  }

  var _warnedEmpty = false;
  function warnIfBlind(found) {
    if (found || _warnedEmpty) return;
    // Only warn if DateTime clearly ran (stamps exist) but we attached nothing.
    var stamped = D.querySelectorAll ? D.querySelectorAll("[" + TIME_ATTR + "]").length : 0;
    if (stamped > 0) {
      _warnedEmpty = true;
      try {
        console.warn(
          "[cc-copybtns] DateTime stamps exist but no copy buttons attached — " +
            "check the [data-cc-dt-time] anchor in Chat CopyButtons Feature.js."
        );
      } catch (e) {}
    }
  }

  // --- message navigation (context-aware: user OR output) --------------------
  // Is this stamped element a USER message? (used to pick the nav kind + label).
  function isUserMessage(el) {
    // Classify by the element's OWN identity, never by what it CONTAINS. A live
    // \`turn_…\` OUTPUT wrapper contains BOTH the user prompt bubble
    // (\`userMessageContainer_…\`) and the assistant response, so a descendant
    // \`querySelector('[class*="userMessage"]')\` test wrongly marks every output turn
    // as a user message — which skipped them all and attached zero copy groups
    // (proven live: stampedTimeAttr=13, copyGroups=0). So we test ONLY the element's
    // own class (and an explicit user-bubble ancestor), NOT its descendants.
    var cn = (el.getAttribute && el.getAttribute("class")) || "";
    if (/userMessage/i.test(cn)) return true;
    // An explicit user-bubble ancestor (the element sits INSIDE a user bubble) — but
    // a \`turn_\` wrapper is NOT inside a user bubble, so this stays correct for output.
    try {
      var anc = el.closest && el.closest('[class*="userMessage"]');
      if (anc && anc !== el) return true;
    } catch (e) {}
    return false;
  }

  // Collect, in document order, the OUTERMOST stamped messages of the given kind
  // ("user" or "output"). We anchor on the same [data-cc-dt-time] elements the
  // group attaches to, classify each by isUserMessage, drop the composer, and
  // keep only outermost matches so a bubble counts once.
  function messageBubbles(kind) {
    var stamped = D.querySelectorAll ? D.querySelectorAll("[" + TIME_ATTR + "]") : [];
    var all = [];
    for (var i = 0; i < stamped.length; i++) {
      var el = stamped[i];
      var cn = (el.getAttribute && el.getAttribute("class")) || "";
      if (/messageInput|messagesContainer|messageGradient|fullEditor/i.test(cn)) continue;
      var isUser = isUserMessage(el);
      if ((kind === "user") !== isUser) continue; // keep only the requested kind
      all.push(el);
    }
    // outermost-only within the kept set
    var out = [];
    for (var k = 0; k < all.length; k++) {
      var e = all[k], p = all[k].parentElement, nested = false;
      while (p) { if (all.indexOf(p) !== -1) { nested = true; break; } p = p.parentElement; }
      if (!nested) out.push(e);
    }
    return out;
  }

  // Document-order position comparison: returns true if a comes before b.
  function isBefore(a, b) {
    try {
      // Node.DOCUMENT_POSITION_FOLLOWING (4) => b follows a => a is before b.
      return (a.compareDocumentPosition(b) & 4) !== 0;
    } catch (e) {
      return false;
    }
  }

  function run() {
    // Anchor to every message the DateTime feature stamped.
    var stamped = D.querySelectorAll ? D.querySelectorAll("[" + TIME_ATTR + "]") : [];
    var found = 0;
    for (var i = 0; i < stamped.length; i++) {
      var el = stamped[i];
      // Skip the composer/input guard classes (same exclusions DateTime uses).
      var cn = (el.getAttribute && el.getAttribute("class")) || "";
      if (/messageInput|messagesContainer|messageGradient|fullEditor/i.test(cn)) continue;
      // Controls belong ONLY on assistant OUTPUT messages — never on a user prompt.
      // A user message gets no date+time label and no copy/nav buttons.
      if (isUserMessage(el)) continue;
      attach(el);
      found++;
    }
    // AskUserQuestion safety net: when an output message is immediately followed by
    // an AskUserQuestion block, also place the controls at the END of that output
    // (before the question). The question can be interrupted (its X), which would
    // otherwise leave that output with no controls — this guarantees they are there.
    try { attachBeforeAskQuestion(); } catch (e) {}
    warnIfBlind(found > 0);
  }

  // Find AskUserQuestion blocks and ensure the OUTPUT message that precedes each one
  // carries the controls. The question card is recognized by the AskQuestion
  // feature's markers (data-cc-md / a question/option container) or an "askuser"
  // class; we walk back to the nearest stamped output message and attach to it.
  function attachBeforeAskQuestion() {
    if (!D.querySelectorAll) return;
    var cards = D.querySelectorAll(
      "[data-cc-md],[class*='askUser'],[class*='AskUser'],[class*='question'],[class*='Question']"
    );
    for (var i = 0; i < cards.length; i++) {
      var out = precedingOutput(cards[i]);
      if (out && !out.querySelector(":scope > ." + GROUP_CLASS)) attach(out);
    }
  }

  // The nearest stamped OUTPUT (non-user, non-composer) message that comes before
  // \`node\` in document order — the output an AskUserQuestion was emitted at the end of.
  function precedingOutput(node) {
    var outs = messageBubbles("output");
    var best = null;
    for (var i = 0; i < outs.length; i++) {
      if (isBefore(outs[i], node)) best = outs[i];
      else break;
    }
    return best;
  }

  var pending = null;
  function schedule() {
    if (pending) return;
    pending = W.setTimeout(function () {
      pending = null;
      try { run(); } catch (e) {}
    }, 140);
  }

  // init(doc, win) — bootstrap hands us the chat document; bind + observe it.
  function init(doc, win) {
    D = doc;
    W = win || window;
    try { run(); } catch (e) {}
    try {
      // Expose the pure content-extraction builders so OTHER features (e.g.
      // MultiSelect's batch-copy) can reuse the exact same markdownOf()/htmlOf()
      // a single message's own Copy buttons use, rather than re-deriving
      // DOM->text logic independently and risking the two disagreeing on what
      // "a message's content" means.
      W.__ccCopyButtons = { markdownOf: markdownOf, htmlOf: htmlOf, contentRoots: contentRoots };
    } catch (e) {}
    try {
      // Route the body observer through the shared self-churn-guarded helper so our
      // OWN group/text-node writes never reschedule the sweep (the webview-freeze
      // class). __ccObserve debounces internally, so the local \`schedule\` timer is
      // no longer needed to feed it. Defensive fallback: the old raw observer only
      // when the bootstrap helper is somehow absent.
      if (W.__ccObserve) {
        W.__ccObserve(D.body, run, { ownClass: GROUP_CLASS, ownAttrPrefix: "data-cc-copy" });
      } else {
        new W.MutationObserver(schedule).observe(D.body, { childList: true, subtree: true });
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
/* Per-message "Copy as Markdown" / "Copy as HTML" buttons, injected alongside
   the CopyButtons feature JS.

   The JS appends ONE inline-flex group at the end of each stamped message that
   holds, in order: the TIME text (read from DateTime's data-cc-dt-time value),
   then the two buttons. So the time and both buttons render together on ONE line,
   to the right, and are ALWAYS visible (no hover gating). DateTime's own ::after
   time for that message is hidden (data-cc-copy-hastime) so the time isn't shown
   twice. */

/* Make the stamped message a flex column and push our group to the very BOTTOM
   (order:9999), on its own full-width row UNDER the message content — so the
   date+time + buttons sit beneath the message, not above it. */
[data-cc-copy-attached] {
  display: flex !important;
  flex-direction: column;
}

.cc-copy-group {
  order: 9999; /* always the last visual child → below the message body */
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  width: 100%;
  /* Clear top margin so the controls are NOT glued to the user-message bubble that
     precedes the output — plus a little bottom breathing room before the next turn. */
  margin-top: 14px;
  margin-bottom: 8px;
  user-select: none;
}

/* The time text, rendered inside our group (mirrors DateTime's old time look). */
.cc-copy-time {
  font-family: var(--vscode-font-family, sans-serif);
  font-size: 10px;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
  color: var(--vscode-descriptionForeground, #8a8a8a);
  opacity: 0.75;
  margin-inline-end: 2px;
}

/* Hide DateTime's own ::after time on any message we took over, so the time is
   not rendered twice (once by DateTime, once inside our group). */
[data-cc-copy-hastime][data-cc-dt-time]::after {
  content: none !important;
}

/* Small SQUARE ICON buttons: the SVG is the content (no text). A soft tinted
   chip by default with an accent-colored icon; on hover it fills with the accent
   and the icon goes white. */
.cc-copy-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 23px;
  height: 23px;
  padding: 0;
  margin: 0;
  cursor: pointer;
  background: var(--vscode-toolbar-hoverBackground, rgba(130, 150, 255, 0.1));
  border: 1px solid transparent;
  border-radius: 7px;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease,
    transform 0.08s ease;
}

.cc-copy-btn svg {
  display: block;
  pointer-events: none;
}

.cc-copy-btn:active {
  transform: translateY(0.5px) scale(0.96);
}

/* Copy actions (Markdown / HTML) — a pleasant BLUE accent. */
.cc-copy-btn.cc-copy-do {
  color: var(--vscode-textLink-foreground, #4ea1ff);
}
.cc-copy-btn.cc-copy-do:hover {
  color: #ffffff;
  background: var(--vscode-textLink-foreground, #4ea1ff);
  border-color: var(--vscode-textLink-foreground, #4ea1ff);
}


/* "Copied!" confirmation — the icon swaps to a check and the chip turns GREEN. */
.cc-copy-btn.cc-copy-done {
  color: #ffffff !important;
  background: var(--vscode-testing-iconPassed, #3fb950) !important;
  border-color: var(--vscode-testing-iconPassed, #3fb950) !important;
}

/* Transient highlight on a user message we navigated to (Previous/Next). A soft
   pulse that fades; removed by the JS after ~1s. */
.cc-nav-flash {
  animation: cc-nav-pulse 1s ease-out 1;
  border-radius: 8px;
}

@keyframes cc-nav-pulse {
  0% {
    box-shadow: 0 0 0 3px var(--vscode-focusBorder, #4ea1ff);
    background-color: var(--vscode-editor-selectionHighlightBackground, rgba(78, 161, 255, 0.25));
  }
  100% {
    box-shadow: 0 0 0 3px transparent;
    background-color: transparent;
  }
}

/* Never render the group on the prompt composer / scroll container, even if a
   stale data-cc-copy-attached lingers there from an earlier build. */
[data-cc-copy-attached][class*="messageInput"] > .cc-copy-group,
[data-cc-copy-attached][class*="messagesContainer"] > .cc-copy-group,
[data-cc-copy-attached][class*="messageGradient"] > .cc-copy-group,
[data-cc-copy-attached][class*="fullEditor"] > .cc-copy-group {
  display: none !important;
}
`.trim();

registerFeature({ id: "copybuttons", label: "Copy buttons + timestamp", js: JS, css: CSS });
