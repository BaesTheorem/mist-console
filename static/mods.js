/* Claude Mods in the Console.
 *
 * A mod (a plugin of function hooks, CLI 2.1.287+) may draw: a pane
 * ($.ui.open), the band above the prompt, status lines ($.ui.status), toasts
 * ($.ui.toast), transcript lines ($.ui.log), and trees over transcript rows
 * (a tool row, a message). The CLI draws none of it in a headless session; a
 * remote surface asks for each site with `ui_render` and draws the tree the
 * hooks answer, then relays presses, typed text and picks back (ui_press,
 * ui_input, ui_select). The bridge attached each backend as the `desktop`
 * surface; this file is the drawing side.
 *
 * Loaded after app.js and shares its globals (Session, sessions, activeId,
 * el, esc, md, input, openExternal, copyText...). app.js calls into the
 * `MODS` object at a few hook points; everything else lives here.
 */
(function () {
  "use strict";

  const COMPONENT_PROBE_SET = ["ToolUse", "UserMessage", "AssistantMessage"];
  const MAX_SITES = 80;          // transcript sites kept live per chat (older ones stay drawn, stop re-rendering)
  const COLOR = {                 // terminal color names -> the Console's palette
    cyan: "var(--teal)", teal: "var(--teal)", blue: "var(--md-sys-color-primary)",
    green: "var(--ok)", red: "var(--err)", yellow: "var(--warn)", magenta: "var(--violet)",
    purple: "var(--violet)", gray: "var(--dim)", grey: "var(--dim)", white: "var(--text)",
    black: "var(--bg)", blackBright: "var(--dim)", gold: "var(--gold)",
    cyanBright: "var(--teal)", greenBright: "var(--ok)", redBright: "var(--err)",
    yellowBright: "var(--warn)", magentaBright: "var(--violet)", whiteBright: "var(--text)",
  };

  function post(sid, path, body) {
    return fetch("/sessions/" + sid + "/" + path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then((r) => r.json());
  }
  function cssColor(c) {
    if (!c) return "";
    if (COLOR[c]) return COLOR[c];
    if (/^#[0-9a-f]{3,8}$/i.test(c) || /^(rgb|hsl)a?\(/.test(c)) return c;
    return "";
  }
  function cells(v, axis) {
    if (v == null) return "";
    if (typeof v === "number") return axis === "y" ? "calc(" + v + " * var(--mod-row))" : v + "ch";
    return String(v);
  }
  function charWidth() {
    if (charWidth._w) return charWidth._w;
    const probe = el("span", null, "0000000000");
    probe.style.cssText = "position:absolute;visibility:hidden;font-family:var(--mono);font-size:12px;white-space:pre";
    document.body.appendChild(probe);
    const w = probe.getBoundingClientRect().width / 10 || 7.2;
    probe.remove();
    charWidth._w = w;
    return w;
  }
  function rowHeight() { return 12 * 1.45; }

  /* ------------------------------------------------------------------ */
  /* per-session mod state                                              */
  /* ------------------------------------------------------------------ */
  function state(s) {
    if (!s._mods) {
      s._mods = {
        status: new Map(),        // plugin -> status line
        hooked: new Map(),        // component -> true | false (false: stop asking until ui_invalidate)
        sites: new Map(),         // instance_id -> {component, props, host, original}
        siteOrder: [],
        panes: null,              // the roster as the engine pushed it
        paneTrees: new Map(),     // pane id -> {tree, el}
        band: null,               // {tree, el}
        suggestion: "",
        hooksCard: null,          // the current turn's hook details element
        inputs: new Map(),        // element key -> text the person typed (kept across redraws)
        focusedPane: null,
      };
    }
    return s._mods;
  }
  const isActive = (s) => s && s.id === activeId;

  /* ------------------------------------------------------------------ */
  /* status strip, toasts, log lines                                    */
  /* ------------------------------------------------------------------ */
  function paintStatus(s) {
    const box = $("#modStatus");
    if (!box || !isActive(s)) return;
    const st = state(s);
    box.innerHTML = "";
    st.status.forEach((text, plugin) => {
      const chip = el("span", "ms-chip");
      chip.appendChild(el("b", null, esc(plugin)));
      chip.appendChild(document.createTextNode(text));
      box.appendChild(chip);
    });
    box.hidden = st.status.size === 0;
    syncComposerHeight();
  }
  function syncComposerHeight() {
    // #composer's height var drives the log padding; the band and status
    // strip sit above it, so fold them into the same measurement.
    const root = document.documentElement;
    const c = $("#composer"), b = $("#aboveBand"), m = $("#modStatus");
    const h = (c ? c.offsetHeight : 0) + (b && !b.hidden ? b.offsetHeight : 0) + (m && !m.hidden ? m.offsetHeight : 0);
    root.style.setProperty("--composer-h", h + "px");
  }
  function toast(text, plugin, ms) {
    const box = $("#toasts");
    if (!box) return;
    const t = el("div", "toast");
    if (plugin) t.appendChild(el("b", null, esc(plugin)));
    t.appendChild(document.createTextNode(text));
    box.appendChild(t);
    const dur = Math.max(1500, Math.min(20000, ms || 4000));
    setTimeout(() => { t.classList.add("leaving"); setTimeout(() => t.remove(), 260); }, dur);
    t.addEventListener("click", () => t.remove());
  }
  function logLine(s, o) {
    const line = el("div", "mod-log");
    line.appendChild(el("b", null, esc(o.plugin || "mod")));
    line.appendChild(document.createTextNode(String(o.text || "")));
    (s.current && s.current.body ? s.current.body : s.logEl).appendChild(line);
    s.scroll();
  }

  /* ------------------------------------------------------------------ */
  /* hook events (--include-hook-events)                                */
  /* ------------------------------------------------------------------ */
  function hookEvent(s, o) {
    if (o.subtype !== "hook_response") return;   // started / progress: live chrome only
    const st = state(s);
    const turnHost = s.current && s.current.body ? s.current.body : s.logEl;
    // One card per turn (turnEnded clears it), wherever the turn's first hook
    // landed; a card per bubble fragmented a turn into several "1 hook" rows.
    let card = st.hooksCard;
    if (!card || !card.isConnected) {
      card = el("details", "hooks");
      card._n = 0; card._err = 0;
      card.appendChild(el("summary", null, "hooks"));
      turnHost.appendChild(card);
      st.hooksCard = card;
    }
    const bad = o.outcome && o.outcome !== "success";
    const row = el("div", "hook-row" + (bad ? " err" : ""));
    row.appendChild(el("span", "hk-ev", esc(o.hook_event || "")));
    row.appendChild(el("span", "hk-name", esc(o.hook_name || "")));
    row.appendChild(el("span", "hk-out", esc(o.outcome || "") + (o.exit_code != null && o.exit_code !== 0 ? " · exit " + o.exit_code : "")));
    const detail = String(o.stderr || o.output || o.stdout || "").trim();
    if (bad && detail) row.appendChild(el("pre", null, esc(detail.slice(0, 2000))));
    card.appendChild(row);
    card._n++;
    if (bad) { card._err++; card.classList.add("has-err"); }
    card.querySelector("summary").textContent = card._n + (card._n === 1 ? " hook" : " hooks")
      + (card._err ? " · " + card._err + " failed" : "");
    s.scroll();
  }

  /* ------------------------------------------------------------------ */
  /* subagent text (--forward-subagent-text)                            */
  /* ------------------------------------------------------------------ */
  function subagentEvent(s, o) {
    if (o.type !== "assistant") return;   // partial deltas and tool results stay in the monitor
    const parent = o.parent_tool_use_id;
    let card = null;
    for (const idx in s.blocks) {
      const b = s.blocks[idx];
      if (b && b.type === "tool" && b.id === parent) { card = b.el; break; }
    }
    if (!card) card = s.logEl.querySelector('details.tool[data-tool-id="' + parent + '"]');
    if (!card) return;
    card.dataset.toolId = parent;
    let box = card.querySelector("details.subagent");
    if (!box) {
      box = el("details", "subagent");
      box.appendChild(el("summary", null, "subagent"));
      box.appendChild(el("div", "sub-body"));
      card.appendChild(box);
    }
    const body = box.querySelector(".sub-body");
    const parts = ((o.message || {}).content || []).filter((c) => c && c.type === "text" && c.text);
    parts.forEach((c) => {
      const d = el("div", "md", md(c.text, o.ts));
      d._mdsrc = c.text;
      body.appendChild(d);
    });
    const n = body.querySelectorAll(".md").length;
    box.querySelector("summary").textContent = "subagent · " + n + (n === 1 ? " message" : " messages");
  }

  /* ------------------------------------------------------------------ */
  /* prompt suggestion (--prompt-suggestions and $.prompt.suggest)      */
  /* ------------------------------------------------------------------ */
  const DEFAULT_PLACEHOLDER = input ? input.placeholder : "";
  function setSuggestion(s, text) {
    const st = state(s);
    st.suggestion = (text || "").trim();
    if (isActive(s)) paintSuggestion(s);
    return !!st.suggestion && !input.value && !s.busy();
  }
  function paintSuggestion(s) {
    const comp = $("#composer");
    const st = s ? state(s) : null;
    const show = st && st.suggestion && !input.value;
    input.placeholder = show ? "⇥ Tab:  " + st.suggestion : DEFAULT_PLACEHOLDER;
    if (comp) comp.classList.toggle("has-suggest", !!show);
  }
  function acceptSuggestion() {
    const s = activeId && sessions.get(activeId);
    if (!s) return false;
    const st = state(s);
    if (!st.suggestion || input.value) return false;
    input.value = st.suggestion;
    st.suggestion = "";
    s.draft = input.value;
    paintSuggestion(s);
    if (typeof growInput === "function") growInput();
    if (typeof reflectSend === "function") reflectSend();
    return true;
  }
  if (input) input.addEventListener("input", () => { const s = activeId && sessions.get(activeId); if (s) paintSuggestion(s); });

  /* ------------------------------------------------------------------ */
  /* engine-originated asks (ui_copy, ui_prompt_read / fill / suggest)  */
  /* ------------------------------------------------------------------ */
  function answerAsk(s, o) {
    let response = null;
    const live = isActive(s);
    try {
      if (o.ask === "ui_copy") {
        if (typeof copyText === "function") copyText(String(o.text || ""));
        response = { copied: true };
      } else if (o.ask === "ui_prompt_read") {
        response = live
          ? { text: input.value, cursor: input.selectionStart == null ? input.value.length : input.selectionStart }
          : { text: s.draft || "", cursor: (s.draft || "").length };
      } else if (o.ask === "ui_prompt_fill") {
        const text = String(o.text || "");
        const mode = o.mode || "replace";
        if (live) {
          if (mode === "append") input.value = input.value + text;
          else if (mode === "insert") {
            const at = input.selectionStart == null ? input.value.length : input.selectionStart;
            input.value = input.value.slice(0, at) + text + input.value.slice(at);
          } else input.value = text;
          s.draft = input.value;
          if (typeof growInput === "function") growInput();
          if (typeof reflectSend === "function") reflectSend();
          paintSuggestion(s);
        } else {
          s.draft = mode === "append" ? (s.draft || "") + text : mode === "insert" ? (s.draft || "") + text : text;
        }
        response = { filled: true };
      } else if (o.ask === "ui_prompt_suggest") {
        response = { shown: setSuggestion(s, o.text) };
      }
    } catch (_) { response = null; }
    post(s.id, "ui/answer", { request_id: o.request_id, response }).catch(() => {});
  }

  /* ------------------------------------------------------------------ */
  /* request_user_dialog cards                                          */
  /* ------------------------------------------------------------------ */
  function dialogCard(s, o) {
    if (!s.permCards) s.permCards = new Map();
    if (s.permCards.has(o.request_id)) return;
    const card = el("div", "perm-card dialog");
    const head = el("div", "perm-head");
    const pl = o.payload || {};
    const body = el("div", "perm-body");
    const row = el("div", "perm-actions");
    const finish = (verdict, result) => {
      if (card._answered) return;
      card._answered = true;
      card.classList.add("answered");
      row.remove();
      head.appendChild(el("span", "perm-verdict", verdict));
      s.permCards.delete(o.request_id);
      if (typeof crystalRefresh === "function") crystalRefresh();
      post(s.id, "dialog-response", { request_id: o.request_id, result }).catch(() => {});
    };
    if (o.kind === "refusal_fallback_prompt") {
      head.innerHTML = '<span class="perm-icon msi">block</span> The API refused this request';
      const txt = "Refused on <b>" + esc(pl.originalModel || "the current model") + "</b>"
        + (pl.apiRefusalCategory ? " (" + esc(pl.apiRefusalCategory) + ")" : "") + ". "
        + (pl.guidanceText ? esc(pl.guidanceText) + " " : "")
        + "Retry the same request on <b>" + esc(pl.fallbackModel || "the fallback model") + "</b>, or take the prompt back to edit it.";
      body.innerHTML = txt;
      const retry = el("button", "perm-btn allow", "Retry on " + (pl.fallbackModel || "fallback"));
      const edit = el("button", "perm-btn always", "Edit prompt");
      const cancel = el("button", "perm-btn deny", "Cancel");
      retry.addEventListener("click", () => finish("retrying", "retry_fallback"));
      edit.addEventListener("click", () => {
        // Put the last prompt back in the composer so "edit" has something to edit.
        const msgs = s.logEl.querySelectorAll(".msg.user");
        const last = msgs[msgs.length - 1];
        if (last && last._utext && isActive(s)) { input.value = last._utext; s.draft = input.value; if (typeof growInput === "function") growInput(); input.focus(); }
        finish("editing", "edit_prompt");
      });
      cancel.addEventListener("click", () => finish("cancelled", "cancelled"));
      row.appendChild(retry); row.appendChild(edit); row.appendChild(cancel);
    } else {
      head.innerHTML = '<span class="perm-icon msi">help</span> ' + esc(o.kind || "dialog");
      body.textContent = JSON.stringify(pl, null, 1).slice(0, 2000);
      const cancel = el("button", "perm-btn deny", "Dismiss");
      cancel.addEventListener("click", () => finish("dismissed", "cancelled"));
      row.appendChild(cancel);
    }
    card.appendChild(head); card.appendChild(body); card.appendChild(row);
    (s.current && s.current.body ? s.current.body : s.logEl).appendChild(card);
    s.permCards.set(o.request_id, card);
    if (typeof crystalRefresh === "function") crystalRefresh();
    s.scroll();
  }

  /* ------------------------------------------------------------------ */
  /* the tree renderer                                                  */
  /* ------------------------------------------------------------------ */
  function styleBox(node, props) {
    const p = props || {};
    const st = node.style;
    st.cssText = "";
    node.classList.toggle("bordered", !!(p.borderStyle && p.borderStyle !== "none"));
    if (p.flexDirection) st.flexDirection = p.flexDirection;
    if (p.flexGrow != null) st.flexGrow = p.flexGrow;
    if (p.flexShrink != null) st.flexShrink = p.flexShrink;
    if (p.flexWrap) st.flexWrap = p.flexWrap;
    if (p.alignItems) st.alignItems = p.alignItems;
    if (p.alignSelf) st.alignSelf = p.alignSelf;
    if (p.justifyContent) st.justifyContent = p.justifyContent;
    const horiz = (p.flexDirection || "column").startsWith("row");
    if (p.gap != null) st.gap = horiz ? cells(p.gap, "y") + " " + cells(p.gap, "x") : cells(p.gap, "y") + " " + cells(p.gap, "x");
    if (p.columnGap != null) st.columnGap = cells(p.columnGap, "x");
    if (p.rowGap != null) st.rowGap = cells(p.rowGap, "y");
    if (p.width != null) st.width = cells(p.width, "x");
    if (p.height != null) st.height = cells(p.height, "y");
    if (p.minWidth != null) st.minWidth = cells(p.minWidth, "x");
    if (p.minHeight != null) st.minHeight = cells(p.minHeight, "y");
    const m = (k, axis) => (p[k] != null ? cells(p[k], axis) : null);
    const mt = m("marginTop", "y") || m("marginY", "y") || m("margin", "y");
    const mb = m("marginBottom", "y") || m("marginY", "y") || m("margin", "y");
    const ml = m("marginLeft", "x") || m("marginX", "x") || m("margin", "x");
    const mr = m("marginRight", "x") || m("marginX", "x") || m("margin", "x");
    if (mt) st.marginTop = mt; if (mb) st.marginBottom = mb; if (ml) st.marginLeft = ml; if (mr) st.marginRight = mr;
    const pt = m("paddingTop", "y") || m("paddingY", "y") || m("padding", "y");
    const pb = m("paddingBottom", "y") || m("paddingY", "y") || m("padding", "y");
    const pl = m("paddingLeft", "x") || m("paddingX", "x") || m("padding", "x");
    const pr = m("paddingRight", "x") || m("paddingX", "x") || m("padding", "x");
    if (pt) st.paddingTop = pt; if (pb) st.paddingBottom = pb; if (pl) st.paddingLeft = pl; if (pr) st.paddingRight = pr;
    if (p.borderColor) { const c = cssColor(p.borderColor); if (c) st.borderColor = c; }
    if (p.borderDimColor) st.borderColor = "var(--line-soft)";
    if (p.backgroundColor) { const c = cssColor(p.backgroundColor); if (c) st.backgroundColor = c; }
    if (p.overflow) st.overflow = p.overflow;
    if (p.display === "none") st.display = "none";
    if (p.position === "absolute") {
      st.position = "absolute";
      ["top", "left", "right", "bottom"].forEach((k) => { if (p[k] != null) st[k] = cells(p[k], k === "top" || k === "bottom" ? "y" : "x"); });
    }
  }
  function styleText(node, props) {
    const p = props || {};
    const st = node.style;
    st.cssText = "";
    node.classList.toggle("dim", !!p.dimColor);
    node.classList.toggle("inverse", !!p.inverse);
    node.classList.toggle("trunc", !!(p.wrap && /^truncate/.test(p.wrap)));
    if (p.color) { const c = cssColor(p.color); if (c) st.color = c; }
    if (p.backgroundColor) { const c = cssColor(p.backgroundColor); if (c) st.backgroundColor = c; }
    if (p.bold) st.fontWeight = "700";
    if (p.italic) st.fontStyle = "italic";
    const deco = [];
    if (p.underline) deco.push("underline");
    if (p.strikethrough) deco.push("line-through");
    if (deco.length) st.textDecoration = deco.join(" ");
  }
  function wireHover(node, props, hover, apply, ctx) {
    if (!hover || typeof hover !== "object") return;
    const scope = node.closest("[data-mod-key]") || node;
    const on = () => apply(node, Object.assign({}, props, hover));
    const off = () => apply(node, props);
    scope.addEventListener("mouseenter", on);
    scope.addEventListener("mouseleave", off);
    if (hover.scope && ctx.groups) {
      const key = String(hover.scope);
      if (!ctx.groups.has(key)) ctx.groups.set(key, new Set());
      const set = ctx.groups.get(key);
      set.add({ on, off });
      scope.addEventListener("mouseenter", () => set.forEach((h) => h.on()));
      scope.addEventListener("mouseleave", () => set.forEach((h) => h.off()));
    }
  }
  function diffLines(src) {
    const frag = document.createDocumentFragment();
    String(src || "").split("\n").forEach((line) => {
      let cls = "dl";
      if (/^\+(?!\+\+)/.test(line)) cls += " add"; else if (/^-(?!--)/.test(line)) cls += " del";
      else if (/^@@/.test(line)) cls += " hunk";
      const d = el("div", cls);
      d.textContent = line;
      frag.appendChild(d);
    });
    return frag;
  }
  function render(node, ctx) {
    if (node == null || node === false) return null;
    if (typeof node === "string") return document.createTextNode(node);
    if (typeof node !== "object") return document.createTextNode(String(node));
    const type = node.type;
    const props = node.props || {};
    let out;
    if (type === "Box" || type === "div") {
      out = el("div", "mb");
      if (props.key) out.dataset.modKey = props.key;
      if (type === "div" && typeof props.style === "string") out.style.cssText = props.style; else styleBox(out, props);
      (node.children || []).forEach((c) => {
        const k = render(c, ctx);
        if (!k) return;
        // A bare string in a Box is wrapped in a Text by the engine.
        if (k.nodeType === 3) { const t = el("span", "mt"); t.appendChild(k); out.appendChild(t); } else out.appendChild(k);
      });
      if (type === "Box") wireHover(out, props, node.hover, styleBox, ctx);
    } else if (type === "Text" || type === "span" || type === "b") {
      out = el(type === "b" ? "b" : "span", "mt");
      if (type !== "Text" && typeof props.style === "string") out.style.cssText = props.style; else styleText(out, props);
      (node.children || []).forEach((c) => { const k = render(c, ctx); if (k) out.appendChild(k); });
      if (type === "Text") wireHover(out, props, node.hover, styleText, ctx);
    } else if (type === "Button") {
      out = el("button", "mod-btn" + (props.variant === "primary" ? " primary" : "") + (props.plain ? " plain" : "") + (props.dimColor ? " dim" : ""));
      out.type = "button";
      if (props.hotkey) out.appendChild(el("span", "hk", esc(props.hotkey) + ":"));
      out.appendChild(document.createTextNode(props.label || ""));
      if (props.key) out.dataset.modKey = props.key;
      if (props.role === "dismiss") out.title = "close";
      out.addEventListener("click", () => ctx.press(node.press, props.key, out));
      if (node.hover) wireHover(out, {}, node.hover, (n, p) => { const c = cssColor(p.color); n.style.color = c || ""; }, ctx);
    } else if (type === "Input") {
      out = el("div", "mod-field");
      if (props.key) out.dataset.modKey = props.key;
      if (props.label) out.appendChild(el("label", null, esc(props.label)));
      const inp = el("input");
      inp.type = "text";
      if (props.placeholder) inp.placeholder = props.placeholder;
      const kept = props.key && ctx.inputs.has(props.key) ? ctx.inputs.get(props.key) : null;
      inp.value = kept != null ? kept : (props.value || "");
      inp.addEventListener("input", () => {
        if (props.key) ctx.inputs.set(props.key, inp.value);
        clearTimeout(inp._t);
        inp._t = setTimeout(() => ctx.input(node.press, "change", inp.value, props.key), 150);
      });
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); clearTimeout(inp._t); ctx.input(node.press, "submit", inp.value, props.key); }
        if (e.key === "Escape") { e.preventDefault(); inp.blur(); if (typeof ctx.escape === "function") ctx.escape(); }
      });
      out.appendChild(inp);
      if (props.submitLabel) out.appendChild(el("span", "sub", "↵ " + esc(props.submitLabel)));
    } else if (type === "Select") {
      out = el("div", "mod-field");
      if (props.key) out.dataset.modKey = props.key;
      if (props.label) out.appendChild(el("label", null, esc(props.label)));
      const sel = el("select");
      (props.options || []).forEach((o) => {
        const opt = el("option", null, esc(o.label != null ? o.label : o.value));
        opt.value = o.value;
        if (props.value != null && o.value === props.value) opt.selected = true;
        sel.appendChild(opt);
      });
      sel.addEventListener("change", () => ctx.select(node.press, sel.value, props.key));
      out.appendChild(sel);
    } else if (type === "Link") {
      out = el("a", "mod-link");
      out.href = props.href || "#";
      const kids = (node.children || []).map((c) => render(c, ctx)).filter(Boolean);
      if (kids.length) kids.forEach((k) => out.appendChild(k)); else out.textContent = props.label || props.href || "";
      out.addEventListener("click", (e) => { e.preventDefault(); if (typeof openExternal === "function") openExternal(props.href); else window.open(props.href, "_blank"); });
    } else if (type === "Code") {
      out = el("pre", "mod-code" + (props.wrap === "truncate-end" ? "" : " wrap"));
      if (props.format === "diff") out.appendChild(diffLines(props.source));
      else if (props.startLine != null) {
        String(props.source || "").split("\n").forEach((line, i) => {
          out.appendChild(el("span", "ln", String(props.startLine + i)));
          out.appendChild(document.createTextNode(line + "\n"));
        });
      } else out.textContent = String(props.source || "");
      if (props.path) out.title = props.path;
    } else if (type === "Markdown") {
      out = el("div", "md mod-md" + (props.dimColor ? " dim" : ""));
      out.innerHTML = md(String(props.text || ""));
      if (props.key) out.dataset.modKey = props.key;
      out.addEventListener("click", (e) => {
        const a = e.target.closest && e.target.closest("a[href]");
        if (!a) return;
        const href = a.getAttribute("href") || "";
        const answers = node.press && (!props.pressableLinks || props.pressableLinks.includes(href));
        e.preventDefault();
        if (answers) ctx.press(node.press, props.key, a, href);
        else if (/^(https?:|file:)/.test(href) && typeof openExternal === "function") openExternal(href);
      });
    } else if (type === "Svg") {
      const src = String(props.source || "");
      if (props.isInteractive) {
        out = el("iframe", "mod-svg");
        out.setAttribute("sandbox", "allow-scripts");
        out.srcdoc = src;
      } else {
        out = el("img", "mod-svg");
        out.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(src);
        out.alt = props.alt || "";
      }
      if (props.width) out.style.width = props.width + "px";
      if (props.height) out.style.height = props.height + "px";
    } else if (type === "Client") {
      // A plugin-side surface module (a React tree the desktop app runs in a
      // frame). The Console has no runtime for those yet; the spec lets a
      // surface draw nothing, so say so instead of a blank.
      out = el("div", "mod-client", "module " + esc(props.module || "") + " (surface modules are not drawn in the Console yet)");
      if (props.width) out.style.width = cells(props.width, "x");
    } else if (type === "engine") {
      // The engine's own drawing of this site sits here: the Console's row.
      out = el("div", "mod-engine");
      if (ctx.engine) { const e = ctx.engine(node.ref); if (e) out.appendChild(e); }
    } else {
      out = el("span", "mt dim", "[" + esc(String(type)) + "]");
    }
    return out;
  }
  function renderTree(tree, ctx) {
    const root = el("div", "mod-tree");
    ctx.groups = ctx.groups || new Map();
    const node = render(tree, ctx);
    if (node) root.appendChild(node);
    return root;
  }

  /* ------------------------------------------------------------------ */
  /* asking the engine                                                  */
  /* ------------------------------------------------------------------ */
  function viewport(s) {
    const logs = $("#logs");
    const cw = charWidth(), rh = rowHeight();
    const dock = $("#paneDock");
    const w = (dock && !dock.hidden ? dock.clientWidth : 380) - 20;
    const h = logs ? logs.clientHeight : 600;
    return { columns: Math.max(20, Math.floor(w / cw)), rows: Math.max(8, Math.floor(h / rh)), isFullscreen: true };
  }
  function bandColumns() {
    const comp = $("#composer");
    return Math.max(20, Math.floor(((comp ? comp.clientWidth : 800) - 28) / charWidth()));
  }
  async function ask(s, component, instanceId, props, extra) {
    const st = state(s);
    if (st.hooked.get(component) === false) return null;
    let j;
    try {
      j = await post(s.id, "ui/render", Object.assign({ component, instance_id: instanceId, props }, extra || {}));
    } catch (_) { return null; }
    if (!j || !j.ok) return null;
    const r = j.response || {};
    st.hooked.set(component, !!r.hooked);
    return r;
  }
  function ctxFor(s, component, instanceId, rerender) {
    const st = state(s);
    const after = () => { if (typeof rerender === "function") rerender(); };
    return {
      inputs: st.inputs,
      press(press, key, node, href) {
        if (!press) return;
        if (node && node.disabled !== undefined) node.disabled = true;
        const body = { plugin: press.plugin, handle: press.handle };
        if (key) body.key = key;
        if (href) body.href = href;
        post(s.id, "ui/press", body).then(after).catch(after).finally(() => { if (node && node.disabled !== undefined) node.disabled = false; });
      },
      input(press, kind, value, key) {
        if (!press) return;
        const body = { plugin: press.plugin, handle: press.handle, kind, value: String(value || "") };
        if (key) body.key = key;
        if (component) { body.component = component; body.instance_id = instanceId; }
        post(s.id, "ui/input", body).then(() => { if (kind === "submit") after(); }).catch(() => {});
      },
      select(press, value, key) {
        if (!press) return;
        const body = { plugin: press.plugin, handle: press.handle, value: String(value) };
        if (key) body.key = key;
        post(s.id, "ui/select", body).then(after).catch(() => {});
      },
      escape() { paneFocus(s, null); },
    };
  }

  /* ------------------------------------------------------------------ */
  /* panes                                                              */
  /* ------------------------------------------------------------------ */
  function paintPanes(s) {
    if (!isActive(s)) return;
    const st = state(s);
    const dock = $("#paneDock"), tabs = $("#paneTabs"), body = $("#paneBody");
    if (!dock) return;
    const roster = st.panes && Array.isArray(st.panes.panes) ? st.panes.panes : [];
    if (!roster.length) { dock.hidden = true; body.innerHTML = ""; tabs.innerHTML = ""; document.body.classList.remove("pane-open"); return; }
    dock.hidden = false;
    document.body.classList.add("pane-open");
    const shown = st.panes.shown_id || roster[roster.length - 1].id;
    tabs.innerHTML = "";
    roster.forEach((p) => {
      const t = el("div", "pane-tab" + (p.id === shown ? " sel" : ""));
      t.setAttribute("role", "tab");
      t.appendChild(el("span", "pt-title", esc(p.title || p.id)));
      t.title = p.plugin ? "opened by " + p.plugin : "";
      const x = el("button", "pt-x", '<span class="msi">close</span>');
      x.type = "button"; x.title = "Close pane";
      x.addEventListener("click", (e) => { e.stopPropagation(); paneClose(s, p.id); });
      t.appendChild(x);
      t.addEventListener("click", () => paneShow(s, p.id));
      tabs.appendChild(t);
    });
    drawPane(s, shown);
    if (st.panes.focus_requested_id && !input.value && !s.busy()) paneFocus(s, st.panes.focus_requested_id);
    else if (st.panes.focus_requested_id) paneFocus(s, null);
  }
  async function drawPane(s, id) {
    const st = state(s);
    const body = $("#paneBody");
    const roster = (st.panes && st.panes.panes) || [];
    const pane = roster.find((p) => p.id === id);
    if (!pane || !body) return;
    const vp = viewport(s);
    const props = { title: pane.title || id, isFocused: st.focusedPane === id, bodyColumns: vp.columns,
                    placement: "dock", scroll: { offset: 0, bodyRows: vp.rows }, view: {} };
    const r = await ask(s, "Pane", id, props, { viewport: vp });
    if (!isActive(s) || !st.panes || (st.panes.shown_id || id) !== id) return;
    body.innerHTML = "";
    if (!r || !r.tree) { body.appendChild(el("div", "pane-empty", "nothing drawn yet")); return; }
    const tree = renderTree(r.tree, ctxFor(s, "Pane", id, () => drawPane(s, id)));
    body.appendChild(tree);
    const auto = tree.querySelector("[autofocus], .mod-field input");
    if (st.focusedPane === id && auto) auto.focus();
  }
  function paneShow(s, id) {
    post(s.id, "ui/pane-show", { id }).then((j) => {
      if (j && j.ok) { const st = state(s); if (st.panes) st.panes.shown_id = (j.response || {}).shown_id || id; paintPanes(s); }
    }).catch(() => {});
  }
  function paneClose(s, id) {
    post(s.id, "ui/pane-close", { id }).then((j) => {
      if (j && j.ok && j.response && j.response.closed) {
        const st = state(s);
        if (st.panes) { st.panes.panes = (st.panes.panes || []).filter((p) => p.id !== id); if (st.panes.shown_id === id) st.panes.shown_id = null; }
        paintPanes(s);
      }
    }).catch(() => {});
  }
  function paneFocus(s, id) {
    const st = state(s);
    st.focusedPane = id;
    const body = $("#paneBody");
    if (body && isActive(s)) body.classList.toggle("focused", !!id);
    post(s.id, "ui/pane-focus", { id }).catch(() => {});
    if (!id && isActive(s) && !isTouch()) input.focus();
  }
  (function wirePaneDock() {
    const body = $("#paneBody");
    if (!body) return;
    body.addEventListener("pointerdown", () => {
      const s = activeId && sessions.get(activeId);
      const st = s && state(s);
      const shown = st && st.panes && (st.panes.shown_id || ((st.panes.panes || [])[0] || {}).id);
      if (s && shown && st.focusedPane !== shown) paneFocus(s, shown);
    });
    body.addEventListener("keydown", (e) => {
      const s = activeId && sessions.get(activeId);
      if (!s) return;
      const st = state(s);
      if (e.key === "Escape") {
        e.preventDefault();
        const shown = st.panes && st.panes.shown_id;
        const pane = shown && (st.panes.panes || []).find((p) => p.id === shown);
        if (pane && pane.close_on_escape) paneClose(s, shown); else paneFocus(s, null);
        return;
      }
      // A Button's hotkey (one digit or lowercase letter) presses it while the pane holds the keyboard.
      if (st.focusedPane && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey
          && !(e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName))) {
        const btn = [...body.querySelectorAll(".mod-btn .hk")].find((h) => h.textContent === e.key + ":");
        if (btn) { e.preventDefault(); btn.parentNode.click(); }
      }
    });
    // Resizable dock, same shape as the rail's handle.
    const handle = $("#paneResize"), root = document.documentElement;
    if (!handle) return;
    const saved = parseInt(localStorage.getItem("paneW") || "", 10);
    if (saved >= 220 && saved <= 900) root.style.setProperty("--pane-w", saved + "px");
    let dragging = false, raf = 0, px = null;
    handle.addEventListener("mousedown", (e) => { dragging = true; handle.classList.add("dragging"); document.body.classList.add("col-resizing"); e.preventDefault(); });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      px = e.clientX;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const w = Math.max(220, Math.min(900, window.innerWidth - px));
        root.style.setProperty("--pane-w", w + "px");
      });
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false; handle.classList.remove("dragging"); document.body.classList.remove("col-resizing");
      const cur = parseInt(getComputedStyle(root).getPropertyValue("--pane-w"), 10);
      if (cur) localStorage.setItem("paneW", cur);
      const s = activeId && sessions.get(activeId);
      if (s) { reattach(s); const st = state(s); if (st.panes && st.panes.shown_id) drawPane(s, st.panes.shown_id); }
    });
  })();

  /* ------------------------------------------------------------------ */
  /* the band above the prompt                                          */
  /* ------------------------------------------------------------------ */
  async function drawBand(s) {
    const st = state(s);
    const box = $("#aboveBand");
    if (!box) return;
    const cols = bandColumns();
    const props = { hasSurvey: false, isWorking: !!(s.busy && s.busy()), maxRows: 8, bodyColumns: cols,
                    scroll: { offset: 0, bodyRows: 8 }, view: {} };
    const r = await ask(s, "AbovePrompt", "above-prompt", props);
    if (!isActive(s)) return;
    if (!r || !r.tree) { st.band = null; box.hidden = true; box.innerHTML = ""; syncComposerHeight(); return; }
    box.innerHTML = "";
    box.appendChild(renderTree(r.tree, ctxFor(s, "AbovePrompt", "above-prompt", () => drawBand(s))));
    box.hidden = false;
    st.band = r.tree;
    syncComposerHeight();
  }

  /* ------------------------------------------------------------------ */
  /* transcript sites (ToolUse, UserMessage, AssistantMessage)          */
  /* ------------------------------------------------------------------ */
  function mountSite(s, component, instanceId, props, original) {
    const st = state(s);
    if (st.hooked.get(component) === false) return;
    if (s._replaying) return;   // a replay would ask once per historical row; mods decorate live rows
    const rec = { component, props, original, host: null };
    st.sites.set(instanceId, rec);
    st.siteOrder.push(instanceId);
    while (st.siteOrder.length > MAX_SITES) st.sites.delete(st.siteOrder.shift());
    drawSite(s, instanceId);
  }
  async function drawSite(s, instanceId) {
    const st = state(s);
    const rec = st.sites.get(instanceId);
    if (!rec || !rec.original || !rec.original.isConnected) return;
    const r = await ask(s, rec.component, instanceId, rec.props);
    // An unhooked site comes back as a bare {type:"engine"} tree: the row as
    // it is. Leave the row alone then, or the engine node below moves it
    // into a host that never reaches the page and the reply vanishes.
    const bare = !r || !r.hooked || !r.tree || r.tree.type === "engine";
    if (bare || !rec.original.isConnected) {
      if (rec.host) {
        if (rec.host.contains(rec.original)) rec.host.replaceWith(rec.original); else rec.host.remove();
        rec.host = null; rec.original.classList.remove("engine-hidden");
      }
      return;
    }
    // Hold the row's place before rendering: engine() moves the row itself
    // into the new host, and the row is then no longer a valid anchor.
    const anchor = rec.host || rec.original.parentNode.insertBefore(document.createComment("mod-site"), rec.original);
    let usedEngine = false;
    const host = el("div", "mod-site");
    const tree = renderTree(r.tree, Object.assign(ctxFor(s, rec.component, instanceId, () => drawSite(s, instanceId)), {
      engine() { usedEngine = true; return rec.original; },
    }));
    host.appendChild(tree);
    anchor.replaceWith(host);
    rec.host = host;
    if (!usedEngine) { rec.original.classList.add("engine-hidden"); host.classList.add("hides-engine"); }
  }

  /* ------------------------------------------------------------------ */
  /* attach / invalidate / switching                                    */
  /* ------------------------------------------------------------------ */
  function reattach(s) {
    if (!s) return;
    post(s.id, "ui/attach", viewport(s)).then((j) => {
      if (j && j.panes) { state(s).panes = j.panes; paintPanes(s); }
    }).catch(() => {});
  }
  function invalidate(s, o) {
    const st = state(s);
    const only = Array.isArray(o && o.instances) ? o.instances : null;
    if (!only) st.hooked.clear();
    const wants = (component, id) => !only || only.some((i) => i.component === component && i.instance_id === id);
    if (isActive(s)) {
      if (st.panes && st.panes.shown_id && wants("Pane", st.panes.shown_id)) drawPane(s, st.panes.shown_id);
      if (wants("AbovePrompt", "above-prompt")) drawBand(s);
    }
    st.sites.forEach((rec, id) => { if (wants(rec.component, id)) drawSite(s, id); });
  }
  function onSwitch(s) {
    if (!s) return;
    paintStatus(s);
    paintSuggestion(s);
    paintPanes(s);
    drawBand(s);
    reattach(s);
  }
  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { const s = activeId && sessions.get(activeId); if (s) { reattach(s); drawBand(s); } }, 300);
  });

  /* ------------------------------------------------------------------ */
  /* settings: mods + flags                                             */
  /* ------------------------------------------------------------------ */
  async function loadModsPanel() {
    const body = $("#modsBody");
    const s = activeId && sessions.get(activeId);
    if (!body) return;
    if (!s) { body.innerHTML = ""; return; }
    let j;
    try { j = await (await fetch("/sessions/" + s.id + "/mods")).json(); }
    catch (_) { body.innerHTML = ""; body.appendChild(el("div", "mcp-stale", "couldn't reach the server")); return; }
    body.innerHTML = "";
    const dirEl = $("#modsDir");
    if (dirEl && j.dir) dirEl.textContent = j.dir.replace(/^\/Users\/[^/]+/, "~");
    const plugins = Array.isArray(j.plugins) ? j.plugins : [];
    const mine = plugins.filter((p) => !/@builtin$/.test(p.source || ""));
    const builtin = plugins.filter((p) => /@builtin$/.test(p.source || ""));
    if (typeof setCount === "function") setCount("#nMods", mine);
    if (!j.live) body.appendChild(el("div", "mcp-stale", plugins.length ? "backend dormant · the set from its last start" : "no backend yet · send a message to load the mods"));
    (j.errors || []).forEach((e) => body.appendChild(el("div", "mod-err", esc(typeof e === "string" ? e : (e.path || e.name || "") + ": " + (e.error || e.message || JSON.stringify(e))))));
    const row = (p, cls) => {
      const r = el("div", "mod-row" + (cls ? " " + cls : ""));
      r.appendChild(el("span", "mod-name", esc(p.name || "")));
      r.appendChild(el("span", "mod-src", esc([p.version, p.source].filter(Boolean).join(" · "))));
      if (p.path && p.path !== "builtin") r.title = p.path;
      const stat = j.status && j.status[p.name];
      if (stat) r.appendChild(el("div", "mod-stat", esc(stat)));
      body.appendChild(r);
    };
    if (!mine.length) body.appendChild(el("div", "panel-empty", "no mods in the folder yet"));
    mine.forEach((p) => row(p));
    builtin.forEach((p) => row(p, "builtin"));
  }
  const FLAG_ROWS = [
    { key: "prompt_suggestions", label: "prompt suggestions", code: "--prompt-suggestions · a predicted next prompt, Tab to take it", kind: "bool" },
    { key: "hook_events", label: "hook events in the transcript", code: "--include-hook-events", kind: "bool" },
    { key: "subagent_text", label: "subagent text under its Agent card", code: "--forward-subagent-text", kind: "bool" },
    { key: "chrome", label: "Claude in Chrome", code: "--chrome · needs the browser extension", kind: "bool" },
    { key: "fallback_model", label: "fallback model", code: "--fallback-model · when the main one is overloaded", kind: "text", ph: "sonnet" },
    { key: "autocompact", label: "auto-compact window", code: "--autocompact · auto, or 100k–1M tokens", kind: "text", ph: "auto" },
    { key: "max_budget_usd", label: "per-chat budget (USD)", code: "--max-budget-usd · stops a runaway turn", kind: "text", ph: "5" },
  ];
  async function loadFlagsPanel() {
    const body = $("#flagsBody");
    if (!body) return;
    let flags = {};
    try { flags = ((await (await fetch("/flags")).json()) || {}).flags || {}; } catch (_) {}
    body.innerHTML = "";
    const save = async (patch) => {
      try {
        const j = await (await fetch("/flags", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) })).json();
        if (!j.ok) { const s = activeId && sessions.get(activeId); if (s) s.notice("Flag not saved: " + (j.error || "invalid"), true); }
      } catch (_) {}
    };
    FLAG_ROWS.forEach((f) => {
      const row = el("div", "flag-row");
      const lab = el("label", null, esc(f.label) + '<span class="flag-code">' + esc(f.code) + "</span>");
      row.appendChild(lab);
      if (f.kind === "bool") {
        const sw = document.createElement("md-switch");
        if (flags[f.key]) sw.setAttribute("selected", "");
        sw.addEventListener("change", () => save({ [f.key]: !!sw.selected }));
        row.appendChild(sw);
      } else {
        const inp = el("input"); inp.type = "text"; inp.value = flags[f.key] || ""; inp.placeholder = f.ph || "";
        inp.addEventListener("change", () => save({ [f.key]: inp.value.trim() }));
        row.appendChild(inp);
      }
      body.appendChild(row);
    });
  }
  const reloadBtn = $("#modsReload");
  if (reloadBtn) reloadBtn.addEventListener("click", async () => {
    const s = activeId && sessions.get(activeId);
    if (!s) return;
    reloadBtn.disabled = true; reloadBtn.textContent = "reloading…";
    try {
      const j = await post(s.id, "mods/reload", {});
      if (!j.ok) s.notice("Mods reload: " + (j.error || "failed"), true);
      else { s.notice("Mods reloaded."); const st = state(s); st.hooked.clear(); invalidate(s, null); }
    } catch (e) { s.notice("Mods reload: " + e, true); }
    reloadBtn.disabled = false; reloadBtn.textContent = "reload mods";
    loadModsPanel();
  });
  const revealBtn = $("#modsReveal");
  if (revealBtn) revealBtn.addEventListener("click", () => fetch("/mods/reveal", { method: "POST" }).catch(() => {}));

  /* ------------------------------------------------------------------ */
  /* usage card (get_usage)                                             */
  /* ------------------------------------------------------------------ */
  async function renderUsageCard() {
    const body = $("#usageBody");
    const s = activeId && sessions.get(activeId);
    if (!body) return;
    body.innerHTML = "";
    if (!s) { body.textContent = "no chat"; return; }
    body.appendChild(el("div", "mcp-stale", "reading…"));
    let j;
    try { j = await (await fetch("/sessions/" + s.id + "/usage-detail")).json(); }
    catch (e) { body.innerHTML = ""; body.appendChild(el("div", "mcp-stale", "couldn't reach the server")); return; }
    body.innerHTML = "";
    if (!j.ok) { body.appendChild(el("div", "mcp-stale", /not running/.test(j.error || "") ? "this chat's backend is dormant · send a message, then look again" : (j.error || "unavailable"))); return; }
    const u = j.usage || {};
    const row = (k, v, pct) => {
      const r = el("div", "ctx-row");
      r.appendChild(el("span", null, esc(k)));
      r.appendChild(el("span", "ctx-n", esc(v)));
      body.appendChild(r);
      if (pct != null) {
        const bar = el("div", "ctx-bar");
        const fill = el("div", null);
        fill.style.cssText = "height:100%;width:" + Math.max(0, Math.min(100, pct)) + "%;background:" + (pct >= 80 ? "var(--err)" : pct >= 60 ? "var(--warn)" : "var(--ok)");
        bar.appendChild(fill); body.appendChild(bar);
      }
    };
    const fmtReset = (iso) => { if (!iso) return ""; const d = new Date(iso); return isNaN(d) ? "" : " · resets " + (typeof fmtResetRel === "function" ? fmtResetRel(d.getTime() / 1000) : d.toLocaleString()); };
    body.appendChild(el("div", "u-head", "plan windows" + (u.subscription_type ? " · " + esc(u.subscription_type) : "")));
    const rl = u.rate_limits || {};
    const names = { five_hour: "5 hours", seven_day: "7 days", seven_day_oauth_apps: "7 days · apps", seven_day_opus: "7 days · Opus", seven_day_sonnet: "7 days · Sonnet", seven_day_cowork: "7 days · Cowork" };
    let any = false;
    Object.keys(rl).forEach((k) => {
      const w = rl[k];
      if (!w || w.utilization == null) return;
      any = true;
      row(names[k] || k.replace(/_/g, " "), Math.round(w.utilization) + "%" + fmtReset(w.resets_at), w.utilization);
    });
    if (!any) body.appendChild(el("div", "mcp-stale", u.rate_limits_available === false ? "plan limits do not apply to this login" : "no window reported"));
    const sess = u.session || {};
    body.appendChild(el("div", "u-head", "this chat"));
    if (sess.total_cost_usd != null) row("cost", "$" + Number(sess.total_cost_usd).toFixed(4));
    if (sess.total_api_duration_ms != null) row("api time", (sess.total_api_duration_ms / 1000).toFixed(1) + "s");
    if (sess.total_lines_added != null) row("lines", "+" + sess.total_lines_added + " −" + (sess.total_lines_removed || 0));
    const mu = sess.model_usage || {};
    Object.keys(mu).forEach((m) => {
      const x = mu[m] || {};
      row(m.replace(/^claude-/, ""), [x.inputTokens != null ? x.inputTokens + " in" : "", x.outputTokens != null ? x.outputTokens + " out" : "", x.costUSD != null ? "$" + Number(x.costUSD).toFixed(3) : ""].filter(Boolean).join(" · "));
    });
  }
  function openUsageCard(ev) {
    const card = $("#usageCard");
    if (!card) return;
    if (!card.hidden) { card.hidden = true; return; }
    if (typeof closeAnchoredCards === "function") closeAnchoredCards("#usageCard");
    renderUsageCard();
    card.hidden = false;
    if (typeof anchorCard === "function") anchorCard(card, (ev && ev.currentTarget) || $("#r5h"));
  }
  ["#r5h", "#r7d"].forEach((id) => { const b = $(id); if (b) b.addEventListener("click", openUsageCard); });
  const usageClose = $("#usageClose"); if (usageClose) usageClose.addEventListener("click", () => { $("#usageCard").hidden = true; });
  const usageRefresh = $("#usageRefresh"); if (usageRefresh) usageRefresh.addEventListener("click", renderUsageCard);
  document.addEventListener("pointerdown", (e) => {
    const c = $("#usageCard");
    if (c && !c.hidden && !(e.target.closest && e.target.closest("#usageCard, #r5h, #r7d"))) c.hidden = true;
  });

  /* ------------------------------------------------------------------ */
  /* workspace diff (get_workspace_diff)                                */
  /* ------------------------------------------------------------------ */
  async function openDiffCard() {
    const card = $("#diffCard"), body = $("#diffBody"), hint = $("#diffHint");
    const s = activeId && sessions.get(activeId);
    if (!card || !s) return;
    card.hidden = false;
    $("#capPanel").hidden = true;
    body.innerHTML = "";
    body.appendChild(el("div", "mcp-stale", "reading the diff…"));
    let j;
    try { j = await (await fetch("/sessions/" + s.id + "/diff")).json(); }
    catch (e) { body.innerHTML = ""; body.appendChild(el("div", "mcp-stale", "couldn't reach the server")); return; }
    body.innerHTML = "";
    if (!j.ok) { body.appendChild(el("div", "mcp-stale", j.error || "unavailable")); return; }
    const d = (j.diff || {}).diff || j.diff || {};
    const files = Array.isArray(d.files) ? d.files : [];
    if (typeof setCount === "function") setCount("#nDiff", files);
    if (hint) hint.textContent = d.source && d.source.kind === "branch"
      ? "Against " + (d.source.baseBranch || d.source.baseRef) + ": committed and uncommitted changes together."
      : "Working tree against HEAD.";
    if (!files.length) { body.appendChild(el("div", "panel-empty", d === null || j.diff === null ? "not a git repo, or mid-merge" : "no changes")); return; }
    files.forEach((f) => {
      const box = el("div", "df-file");
      const head = el("div", "df-head");
      head.appendChild(el("span", "df-path", esc(f.path || f.file || "")));
      if (f.insertions != null || f.additions != null) head.appendChild(el("span", "df-plus", "+" + (f.insertions != null ? f.insertions : f.additions)));
      if (f.deletions != null) head.appendChild(el("span", "df-minus", "−" + f.deletions));
      if (f.status) head.appendChild(el("span", "df-note", esc(f.status)));
      box.appendChild(head);
      const hunks = Array.isArray(f.hunks) ? f.hunks : [];
      if ((d.skippedLarge || []).includes(f.path)) box.appendChild(el("div", "df-note", "too large to show"));
      else if ((d.restricted || []).includes(f.path)) box.appendChild(el("div", "df-note", "content withheld by the CLI"));
      else if (!hunks.length) box.appendChild(el("div", "df-note", "no hunks"));
      else {
        const pre = el("div", "diff");
        hunks.forEach((h) => {
          const text = typeof h === "string" ? h : (h.text || h.content || h.patch || "");
          if (h && h.header) pre.appendChild(Object.assign(el("div", "dl hunk"), { textContent: h.header }));
          pre.appendChild(diffLines(text));
        });
        box.appendChild(pre);
      }
      body.appendChild(box);
    });
  }
  const diffBtn = $("#diffBtn"); if (diffBtn) diffBtn.addEventListener("click", openDiffCard);
  const diffClose = $("#diffClose"); if (diffClose) diffClose.addEventListener("click", () => { $("#diffCard").hidden = true; });

  /* ------------------------------------------------------------------ */
  /* ratings (message_rated) and file rewind (rewind_files)             */
  /* ------------------------------------------------------------------ */
  function rate(s, wrap, sentiment) {
    const uuid = wrap && wrap._cliUuid;
    if (!uuid) { s.notice("This reply has no CLI id yet, so it can't be rated."); return; }
    const was = wrap._rated;
    const cleared = was === sentiment;
    wrap._rated = cleared ? null : sentiment;
    wrap.querySelectorAll(".msg-actions .rate").forEach((b) => b.classList.toggle("on", !cleared && b.dataset.sent === sentiment));
    post(s.id, "rate", { uuid, sentiment, cleared }).then((j) => { if (!j.ok) s.notice("Rating not recorded: " + (j.error || "failed"), true); }).catch(() => {});
  }
  async function rewindFiles(s, userMsg) {
    const seq = s.cutSeqFor(userMsg);
    if (seq == null || seq === Infinity) { s.notice("This message has no position on disk yet."); return; }
    let j;
    try { j = await post(s.id, "rewind-files", { cut_seq: seq, dry_run: true }); }
    catch (e) { s.notice("Couldn't check the files: " + e, true); return; }
    if (!j.ok) { s.notice("Can't restore files here: " + (j.error || "unknown"), true); return; }
    const r = j.result || {};
    if (!r.canRewind) { s.notice("Nothing to restore: " + (r.error || "no file changes since that message") + "."); return; }
    const files = r.filesChanged || [];
    s.confirmOn(userMsg, "Restore " + files.length + (files.length === 1 ? " file" : " files") + " to how they were before this message"
      + (r.insertions != null ? " (−" + r.insertions + " +" + (r.deletions || 0) + " lines)" : "") + ": " + files.slice(0, 6).join(", ") + (files.length > 6 ? "…" : "")
      + ". The chat itself is left alone.", async () => {
      try {
        const k = await post(s.id, "rewind-files", { cut_seq: seq, dry_run: false });
        if (!k.ok || !(k.result || {}).canRewind) s.notice("Restore failed: " + (k.error || (k.result || {}).error || "unknown"), true);
        else s.notice("Restored " + ((k.result || {}).filesChanged || files).length + " files.");
      } catch (e) { s.notice("Restore failed: " + e, true); }
    });
  }

  /* ------------------------------------------------------------------ */
  /* the hooks app.js calls                                             */
  /* ------------------------------------------------------------------ */
  window.MODS = {
    // system events with a mod subtype; returns true when consumed
    system(s, o) {
      const sub = o.subtype;
      if (sub === "ui_status") { const st = state(s); if (o.text) st.status.set(o.plugin || "mod", String(o.text)); else st.status.delete(o.plugin || "mod"); paintStatus(s); return true; }
      if (sub === "ui_toast") { if (!s._replaying) toast(String(o.text || ""), o.plugin, o.timeout_ms); return true; }
      if (sub === "ui_log") { logLine(s, o); return true; }
      if (sub === "ui_panes") { const st = state(s); st.panes = { panes: o.panes || [], shown_id: o.shown_id, focused_id: o.focused_id, focus_requested_id: o.focus_requested_id }; paintPanes(s); return true; }
      if (sub === "ui_invalidate") { invalidate(s, o); return true; }
      if (sub === "ui_focus") {
        if (isActive(s)) { const host = o.component === "Pane" ? $("#paneBody") : $("#aboveBand"); const t = host && host.querySelector('[data-mod-key="' + CSS.escape(String(o.key || "")) + '"]'); const f = t && (t.matches("button, input, select") ? t : t.querySelector("button, input, select")); if (f) f.focus(); }
        return true;
      }
      if (sub === "ui_scroll") {
        if (isActive(s)) { const host = o.component === "Pane" ? $("#paneBody") : $("#aboveBand"); if (host) { if (o.follow_end) host.scrollTop = host.scrollHeight; else host.scrollTop = (o.offset || 0) * rowHeight(); } }
        return true;
      }
      if (sub === "hook_started" || sub === "hook_progress" || sub === "hook_response") { hookEvent(s, o); return true; }
      return false;
    },
    suggestion(s, o) { setSuggestion(s, o.suggestion); },
    ask(s, o) { answerAsk(s, o); },
    dialog(s, o) { dialogCard(s, o); },
    subagent(s, o) { subagentEvent(s, o); },
    acceptSuggestion,
    switched(s) { onSwitch(s); },
    turnEnded(s) { const st = state(s); st.hooksCard = null; if (isActive(s)) drawBand(s); },
    turnStarted(s) { if (isActive(s)) drawBand(s); },
    exited(s) { const st = state(s); st.status.clear(); st.panes = null; st.hooked.clear(); st.suggestion = ""; if (isActive(s)) { paintStatus(s); paintPanes(s); paintSuggestion(s); const b = $("#aboveBand"); if (b) { b.hidden = true; b.innerHTML = ""; } } },
    siteUser(s, wrap, o) { mountSite(s, "UserMessage", "user-" + (o.seq != null ? o.seq : Date.now()), { text: String(o.text || ""), origin: { kind: "sdk" }, isExpanded: true }, wrap); },
    siteTool(s, block, result) {
      if (!block || !block.id || !block.el) return;
      let out = result && result.content;
      if (Array.isArray(out)) out = out.map((p) => (p && p.text) || "").join("");
      let inputObj = block._input;
      if (inputObj == null) { try { inputObj = JSON.parse(block.pre ? block.pre.textContent : "{}"); } catch (_) { inputObj = {}; } }
      mountSite(s, "ToolUse", block.id, { tool_use_id: block.id, tool: block.name || "", input: inputObj, isRunning: false,
        isErrored: !!(result && result.is_error), isInterrupted: false, output: out == null ? undefined : String(out).slice(0, 65536) }, block.el);
    },
    siteAssistant(s, node, text, first) { if (node) mountSite(s, "AssistantMessage", "msg-" + (node._siteId || (node._siteId = Math.random().toString(36).slice(2))), { text: String(text || ""), isFirstOfReply: !!first }, node); },
    rate, rewindFiles, loadModsPanel, loadFlagsPanel, openDiffCard, renderUsageCard, toast,
  };

  // "/diff" in the composer opens the workspace diff.
  if (input) input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && /^\/diff\s*$/i.test(input.value)) { e.preventDefault(); e.stopImmediatePropagation(); input.value = ""; const s = activeId && sessions.get(activeId); if (s) s.draft = ""; openDiffCard(); }
  }, true);
})();
