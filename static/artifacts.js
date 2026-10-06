/* artifacts.js: the side drawer of everything MIST made in the active chat.
 *
 * Images, audio, video, 3D models, HTML pages and any other file MIST embedded
 * with `![name](/abs/path)` show up here as tiles, newest first, with a filter
 * row by kind. The drawer reads the chat's own bubbles (the .genimg-wrap,
 * .genaudio-wrap, .genvideo-wrap, .genmodel-wrap and .genfile elements the
 * markdown pass emits), so it needs no server state, follows the active chat,
 * and stays correct through streaming re-renders and history replays: a
 * MutationObserver on the transcript schedules a rescan.
 *
 * A tile's thumbnail opens the artifact (lightbox for an image, a sandboxed
 * preview for an HTML page, the message itself for the rest); its buttons
 * jump to the message and save the file (to the Mac's Downloads, or on the
 * phone through the shell's share sheet, see saveToDownloads in app.js).
 *
 * Same element on every surface: a fixed panel on the Mac, full width on a
 * phone, where it opens from the chat-details sheet or a swipe in from the
 * right edge.
 */
(function () {
  const panel = $("#artPanel"), list = $("#artList"), count = $("#nArtifacts"), btn = $("#artBtn");
  if (!panel || !list) return;
  const filters = $("#artFilters");
  const KINDS = ["image", "audio", "video", "model", "file"];
  const ICON = { image: "image", audio: "music_note", video: "movie", model: "view_in_ar", file: "draft",
                 html: "code", pdf: "picture_as_pdf", md: "article", json: "data_object", csv: "table",
                 txt: "notes", zip: "folder_zip", svg: "shapes" };
  const HTML_EXT = /\.(html?|svg)$/i;
  let kind = "all";
  let timer = 0;
  let lastSig = "";

  // ---- collect ------------------------------------------------------------
  function pathOf(src) {
    try {
      const qs = new URLSearchParams(String(src).slice(String(src).indexOf("?") + 1));
      return qs.get("path") || "";
    } catch (_) { return ""; }
  }
  function extOf(name) { return (String(name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || ""; }
  function tsOf(msg) {
    const t = msg && msg.querySelector(".who .ts");
    if (!t || !t.title) return 0;
    const d = Date.parse(t.title);
    return isNaN(d) ? 0 : d;
  }
  /* Every embed in MIST's bubbles of chat `s`, newest first, one entry per
     distinct file (the same path embedded twice lists once, at its latest). */
  function collect(s) {
    const out = [];
    if (!s || !s.logEl) return out;
    const seen = new Map();
    const push = (el, k, src) => {
      if (!src) return;
      const msg = el.closest(".msg");
      if (!msg || msg.classList.contains("user")) return;
      const path = pathOf(src);
      const key = path || src;
      const name = path ? (path.split("/").filter(Boolean).pop() || path) : fileBaseName(src);
      const ext = extOf(name);
      const item = { kind: k, src, path, name, ext, msg, el, ts: tsOf(msg), html: k === "file" && HTML_EXT.test(name) };
      const prev = seen.get(key);
      if (prev) { out[prev] = item; return; }   // later bubble wins; keep one tile per file
      seen.set(key, out.length);
      out.push(item);
    };
    const body = s.logEl;
    body.querySelectorAll(".genimg-wrap").forEach((w) => {
      const a = w.querySelector("a.imglink");
      push(w, "image", (a && (a.getAttribute("data-full") || a.getAttribute("href"))) || "");
    });
    body.querySelectorAll(".genaudio-wrap").forEach((w) => {
      const a = w.querySelector("audio"), d = w.querySelector("[data-dl]");
      push(w, "audio", (d && d.getAttribute("data-dl")) || (a && a.getAttribute("src")) || "");
    });
    body.querySelectorAll(".genvideo-wrap").forEach((w) => {
      const d = w.querySelector("[data-dl]"), v = w.querySelector("video");
      push(w, "video", (d && d.getAttribute("data-dl")) || (v && v.getAttribute("src")) || "");
    });
    body.querySelectorAll(".genmodel-wrap").forEach((w) => push(w, "model", w.dataset.model || ""));
    body.querySelectorAll(".genfile[data-dl]").forEach((w) => push(w, "file", w.getAttribute("data-dl")));
    out.sort((x, y) => (y.ts - x.ts) || 0);
    return out;
  }

  // ---- render -------------------------------------------------------------
  function fmtWhen(ts) {
    if (!ts) return "";
    const d = new Date(ts), now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
                   : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  function iconFor(it) {
    if (it.kind !== "file") return ICON[it.kind];
    if (it.html) return ICON.html;
    return ICON[it.ext] || ICON.file;
  }
  function thumb(it) {
    const b = el("button", "art-thumb");
    b.type = "button";
    b.title = it.kind === "image" ? "Open" : (it.html || it.ext === "pdf") ? "Preview" : "Show in the chat";
    if (it.kind === "image") {
      const img = el("img"); img.loading = "lazy"; img.alt = ""; img.src = it.src;
      b.appendChild(img);
    } else if (it.kind === "video") {
      const v = el("video"); v.muted = true; v.preload = "metadata"; v.playsInline = true; v.src = it.src;
      b.appendChild(v);
    } else if (it.kind === "model") {
      // The viewer may still be loading its mesh; try again for a while and
      // swap the icon for a frame once it has one.
      const icon = el("span", "msi", iconFor(it));
      b.appendChild(icon);
      let tries = 0;
      const tryPng = () => {
        if (!b.isConnected) return;
        const png = window.MistModel && MistModel.snapshotPNG(it.el);
        if (png) { const img = el("img"); img.alt = ""; img.src = png; icon.replaceWith(img); return; }
        if (++tries < 10) setTimeout(tryPng, 1500);
      };
      tryPng();
    } else {
      b.appendChild(el("span", "msi", iconFor(it)));
    }
    if (it.ext) b.appendChild(el("span", "ext", esc(it.ext)));
    b.addEventListener("click", () => openItem(it));
    return b;
  }
  function act(icon, title, run) {
    const b = el("button", null, '<span class="msi">' + icon + "</span>");
    b.type = "button"; b.title = title; b.setAttribute("aria-label", title);
    b.addEventListener("click", (e) => { e.stopPropagation(); run(b); });
    return b;
  }
  function tile(it) {
    const t = el("div", "art-tile");
    t.appendChild(thumb(it));
    const meta = el("div", "art-meta");
    const nm = el("div", "art-name", esc(it.name)); nm.title = it.path || it.name;
    meta.appendChild(nm);
    const sub = el("div", "art-sub");
    sub.appendChild(el("span", null, esc(it.kind === "model" ? "3D model" : it.html ? "HTML" : it.ext === "pdf" ? "PDF" : it.kind)));
    if (it.ts) sub.appendChild(el("span", null, esc(fmtWhen(it.ts))));
    meta.appendChild(sub);
    t.appendChild(meta);
    const acts = el("div", "art-acts");
    acts.appendChild(act("my_location", "Show in the chat", () => reveal(it)));
    if (it.html || it.ext === "pdf") acts.appendChild(act("preview", "Preview", () => openPreview(it)));
    else if (it.kind === "image") acts.appendChild(act("open_in_full", "Open", () => openLightbox(it.src)));
    acts.appendChild(act("download", IS_SHELL ? "Save to this phone" : "Save to Downloads", (b) => saveToDownloads(it.src, b)));
    t.appendChild(acts);
    return t;
  }
  function render() {
    const s = activeId && sessions.get(activeId);
    const items = collect(s);
    const sig = items.map((i) => i.kind + "|" + i.src + "|" + i.ts).join("\n") + "|" + kind;
    paintBadge(items.length);
    if (panel.hidden || sig === lastSig) return;
    lastSig = sig;
    const n = {}; KINDS.forEach((k) => { n[k] = 0; });
    items.forEach((i) => { n[i.kind]++; });
    filters.querySelectorAll(".art-tab").forEach((b) => {
      const k = b.dataset.kind;
      b.classList.toggle("sel", k === kind);
      b.setAttribute("aria-selected", k === kind ? "true" : "false");
      b.innerHTML = esc(b.dataset.label || (b.dataset.label = b.textContent.trim())) +
        (k !== "all" && n[k] ? '<span class="n">' + n[k] + "</span>" : "");
      b.hidden = k !== "all" && !n[k] && k !== kind;
    });
    count.textContent = items.length ? String(items.length) : "";
    list.innerHTML = "";
    const shown = kind === "all" ? items : items.filter((i) => i.kind === kind);
    if (!shown.length) {
      list.appendChild(el("div", "art-empty", items.length
        ? "Nothing of that kind in this chat."
        : "Nothing made in this chat yet. Images, audio, video, 3D models and files MIST embeds with <code>![name](/path)</code> collect here."));
      return;
    }
    const grid = el("div", "art-grid");
    shown.forEach((it) => grid.appendChild(tile(it)));
    list.appendChild(grid);
  }
  function paintBadge(n) {
    if (!btn) return;
    btn.classList.toggle("has", n > 0);
    btn.title = (n ? n + (n === 1 ? " artifact" : " artifacts") + " in this chat" : "Artifacts") +
      " · every image, audio clip, video, 3D model and file made in this chat";
  }

  // ---- actions ------------------------------------------------------------
  function reveal(it) {
    const s = activeId && sessions.get(activeId);
    if (!s || !it.msg.isConnected) return;
    if (isTouch()) close();   // on a phone the drawer covers the chat
    revealMessage(s, it.msg);
  }
  function openItem(it) {
    if (it.kind === "image") openLightbox(it.src);
    else if (it.html || it.ext === "pdf") openPreview(it);
    else reveal(it);
  }
  /* An HTML (or SVG) file in a sandboxed frame: /preview serves it with a
     CSP sandbox, and the frame has no allow-same-origin, so the page runs in
     an opaque origin with no reach into the Console. A PDF opens from /file
     in an unsandboxed frame, because the WebView's PDF viewer does not run in
     a sandboxed one and a PDF carries no script into the page. */
  function openPreview(it) {
    const pdf = it.ext === "pdf";
    const url = pdf ? it.src : "/preview" + it.src.slice(it.src.indexOf("?"));
    const ov = el("div", "lightbox artprev");
    const bar = el("div", "lightbox-bar");
    bar.appendChild(el("span", "artprev-name", esc(it.name)));
    const dlBtn = el("button", "lightbox-btn", IS_SHELL ? "Save" : "Download");
    const closeBtn = el("button", "lightbox-btn", "Close");
    if (!IS_SHELL) {
      const extBtn = el("button", "lightbox-btn", "Open in browser");
      extBtn.addEventListener("click", (ev) => { ev.stopPropagation(); openExternal(location.origin + url); });
      bar.appendChild(extBtn);
    }
    bar.appendChild(dlBtn); bar.appendChild(closeBtn);
    const frame = el("iframe");
    if (!pdf) frame.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.title = it.name;
    frame.src = url;
    ov.appendChild(bar); ov.appendChild(frame);
    const shut = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (ev) => { if (ev.key === "Escape") shut(); };
    ov.addEventListener("click", (ev) => { if (ev.target === ov) shut(); });
    closeBtn.addEventListener("click", shut);
    dlBtn.addEventListener("click", (ev) => { ev.stopPropagation(); saveToDownloads(it.src, dlBtn); });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(ov);
  }

  // ---- open / close -------------------------------------------------------
  function open() {
    $("#capPanel").hidden = true;
    $("#bmPanel").hidden = true;
    if (typeof closeAnchoredCards === "function") closeAnchoredCards();
    panel.hidden = false;
    if (btn) btn.setAttribute("aria-pressed", "true");
    lastSig = "";
    render();
  }
  function close() {
    panel.hidden = true;
    if (btn) btn.setAttribute("aria-pressed", "false");
  }
  function toggle() { if (panel.hidden) open(); else close(); }
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = 0; render(); }, 400);
  }

  if (btn) btn.addEventListener("click", toggle);
  $("#artClose").addEventListener("click", close);
  filters.addEventListener("click", (e) => {
    const b = e.target.closest(".art-tab");
    if (!b) return;
    kind = b.dataset.kind || "all";
    lastSig = "";
    render();
  });
  // keep the close button's aria state honest when something else hides the panel (Esc, settings)
  new MutationObserver(() => { if (btn) btn.setAttribute("aria-pressed", panel.hidden ? "false" : "true"); })
    .observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  // bubbles stream, replay and import: any change to the transcript is a reason to look again
  const logs = $("#logs");
  if (logs) new MutationObserver(schedule).observe(logs, { childList: true, subtree: true });

  // phone: a swipe in from the right edge opens the drawer (the left edge is the chat list)
  (function wireSwipe() {
    const EDGE = 28, MOVE = 48, SLOP = 12;
    let st = null;
    document.addEventListener("touchstart", (e) => {
      st = null;
      if (!isPhone() || e.touches.length !== 1 || !panel.hidden) return;
      const t = e.touches[0];
      if (t.clientX < window.innerWidth - EDGE) return;
      if (e.target.closest && e.target.closest("input, textarea, select, .genmodel-stage")) return;
      st = { x: t.clientX, y: t.clientY };
    }, { passive: true });
    document.addEventListener("touchmove", (e) => {
      if (!st) return;
      const t = e.touches[0];
      const dx = st.x - t.clientX, dy = Math.abs(t.clientY - st.y);
      if (dy > SLOP && dy > dx) { st = null; return; }
      if (dx > MOVE) { st = null; open(); }
    }, { passive: true });
    document.addEventListener("touchend", () => { st = null; }, { passive: true });
  })();

  window.ARTIFACTS = {
    switched() { lastSig = ""; schedule(); },
    open, close, toggle,
    collect() { return collect(activeId && sessions.get(activeId)); },
  };
  schedule();
})();
