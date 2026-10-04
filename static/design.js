/* design.js — the Claude Design pane beside the chat.
 *
 * claude.ai sends X-Frame-Options: SAMEORIGIN, so the page cannot iframe it. The
 * Mac app (desktop.py) owns a second native WKWebView instead, and this file
 * tells it where to sit: the rectangle of #designBody, re-sent on every layout
 * change, plus the URL for the active chat's project. The project comes from
 * GET /design?session=<id>, which reads design/claude-design.json in that chat's
 * working directory, so switching chats switches canvases. MIST drives the same
 * pane from inside a chat with bin/mist-design (a `design` event on the stream).
 *
 * Outside the Mac app (a browser tab, the iOS shell) there is no native view;
 * the slot shows a link to the project instead.
 */
(function () {
  const dock = $("#designDock"), body = $("#designBody"), btn = $("#designBtn");
  if (!dock || !body || !btn) return;
  const nameEl = $("#designName"), fallback = $("#designFallback"), fbLink = $("#designFallbackLink");
  const root = document.documentElement;
  const HOME = "https://claude.ai/design";
  const native = () => (window.pywebview && window.pywebview.api && window.pywebview.api.design_pane) ? window.pywebview.api : null;
  let open = false;            // the pane is wanted on screen
  let url = HOME;              // what the native view shows (or should)
  let shownUrl = null;         // what the native view was last told to load
  let raf = 0;

  // The native view works in window points; the page may be zoomed (text size),
  // so measure the real scale instead of trusting CSS px.
  function frame() {
    const r = body.getBoundingClientRect();
    const doc = root.getBoundingClientRect();
    const k = doc.width ? window.innerWidth / doc.width : 1;
    return { x: r.left * k, y: r.top * k, w: r.width * k, h: r.height * k };
  }

  function push(force) {
    const api = native();
    if (!api) { fallback.hidden = false; return; }
    fallback.hidden = true;
    const visible = open && !dock.hidden && document.visibilityState !== "hidden";
    const f = visible ? frame() : { x: 0, y: 0, w: 0, h: 0 };
    const spec = { show: visible, url: (force || url !== shownUrl) ? url : null, ...f };
    if (spec.url) shownUrl = url;
    try { api.design_pane(spec); } catch (_) {}
  }
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; push(false); });
  }

  function setOpen(v) {
    open = !!v;
    dock.hidden = !open;
    document.body.classList.toggle("design-open", open);
    btn.setAttribute("aria-pressed", open ? "true" : "false");
    localStorage.setItem("designOpen", open ? "1" : "0");
    push(false);
  }

  async function load(s) {
    const q = s ? "?session=" + encodeURIComponent(s.id) : "";
    try {
      const r = await (await fetch("/design" + q)).json();
      url = r.url || HOME;
      nameEl.textContent = r.linked ? (r.name || "") : "no project linked";
      nameEl.title = r.linked ? r.url : "no design/claude-design.json in " + (r.cwd || "this repo") + "; MIST links one with mist-design link";
    } catch (_) {
      url = HOME; nameEl.textContent = "";
    }
    fbLink.href = url;
    fbLink.textContent = url.replace(/^https?:\/\//, "");
    push(false);
  }

  window.DESIGN = {
    switched(s) { load(s); },
    // a `design` event from the stream: {url, project, name, show}
    event(s, o) {
      if (s.id !== activeId) return;   // the pane follows the chat on screen; the link file carries the rest
      if (o.url) { url = o.url; fbLink.href = url; fbLink.textContent = url.replace(/^https?:\/\//, ""); }
      if (o.name) { nameEl.textContent = o.name; nameEl.title = o.url || ""; }
      if (o.show === false) setOpen(false);
      else { setOpen(true); push(true); }
    },
    toggle() { setOpen(!open); },
  };

  btn.addEventListener("click", () => DESIGN.toggle());
  $("#designClose").addEventListener("click", () => setOpen(false));
  $("#designReload").addEventListener("click", () => push(true));
  $("#designExt").addEventListener("click", () => {
    const api = native();
    if (api && api.open_url) api.open_url(url); else window.open(url, "_blank", "noopener");
  });

  // Follow every layout change: window resize, rail drag, pane dock, zoom.
  if (window.ResizeObserver) new ResizeObserver(schedule).observe(body);
  window.addEventListener("resize", schedule);
  document.addEventListener("visibilitychange", schedule);
  new MutationObserver(schedule).observe(root, { attributes: true, attributeFilter: ["style"] });

  // Resizable, same shape as the mod pane dock's handle (left edge of the dock).
  (function wireResize() {
    const handle = $("#designResize");
    if (!handle) return;
    const saved = parseInt(localStorage.getItem("designW") || "", 10);
    if (saved >= 320 && saved <= 1400) root.style.setProperty("--design-w", saved + "px");
    let dragging = false, r2 = 0, px = null;
    handle.addEventListener("mousedown", (e) => { dragging = true; handle.classList.add("dragging"); document.body.classList.add("col-resizing"); e.preventDefault(); });
    handle.addEventListener("dblclick", () => { root.style.removeProperty("--design-w"); localStorage.removeItem("designW"); schedule(); });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      px = e.clientX;
      if (r2) return;
      r2 = requestAnimationFrame(() => {
        r2 = 0;
        const w = Math.max(320, Math.min(1400, window.innerWidth - px));
        root.style.setProperty("--design-w", w + "px");
        schedule();
      });
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false; handle.classList.remove("dragging"); document.body.classList.remove("col-resizing");
      const cur = parseInt(getComputedStyle(root).getPropertyValue("--design-w"), 10);
      if (cur) localStorage.setItem("designW", cur);
      schedule();
    });
  })();

  // Reopen the way it was left; the chat's own project loads on the first switchTo.
  if (localStorage.getItem("designOpen") === "1") setOpen(true);
})();
