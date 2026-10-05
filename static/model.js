/* model.js: inline 3D model viewer for `![name](/abs/path.stl)` embeds.

   _md() in app.js emits <span class="genmodel-wrap" data-model="/file?..."
   data-name="part.stl"> around a <canvas>. This file hydrates every such wrap
   it sees (a MutationObserver on the document, so it works for streamed,
   replayed and imported bubbles alike), loads the mesh through three.js and
   draws it as a slow turntable. Drag orbits, wheel zooms, double-click resets.

   Cost model. Each viewer renders straight into its own WebGL canvas (no
   readback, no blit). WebKit allows about 16 live contexts, so at most
   MAX_LIVE viewers hold one at a time: a viewer acquires a context when it
   scrolls into view and gives it back (parking on a PNG still of its last
   frame) when it leaves the viewport, when the pool is full, or when it has
   been idle. The turntable runs at SPIN_FPS for SPIN_SECONDS after load or a
   reset, at pixel ratio 1 while moving, then stops and draws one frame at full
   device resolution. Nothing animates on an idle page.

   three.js (vendor/three.js, MIT, bundled with OrbitControls + the STL/3MF/OBJ/
   glTF loaders) loads lazily on the first embed. Units are taken as
   millimetres, which is what every slicer assumes for STL and 3MF. STL and 3MF
   are Z-up; OBJ and glTF are Y-up and are rotated onto the same floor. The
   share snapshot asks for a PNG via window.MistModel.snapshotPNG(wrap). */
(() => {
  "use strict";
  const WRAP = ".genmodel-wrap";
  const W = 480, H = 320;
  const MESH_COLOR = 0x8aa0b8;        // same slate as the f3d preview sheets
  const MAX_LIVE = 4;                 // WebGL contexts held at once
  const SPIN_SECONDS = 8;             // turntable duration after load / reset
  const SPIN_FPS = 30;
  const PARK_IDLE_MS = 20000;         // release a context after this long with no frames
  const PARK_OFFSCREEN_MS = 1500;     // ...or this long out of the viewport
  const HI_DPR = Math.min(window.devicePixelRatio || 1, 2);

  let libPromise = null;
  const viewers = new Map();          // wrap element -> state
  const live = new Set();             // states that currently own a renderer

  function lib() {
    if (window.THREE && window.THREE.STLLoader) return Promise.resolve(window.THREE);
    if (!libPromise) {
      libPromise = new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = "vendor/three.js";
        s.onload = () => res(window.THREE);
        s.onerror = () => { libPromise = null; rej(new Error("viewer library failed to load")); };
        document.head.appendChild(s);
      });
    }
    return libPromise;
  }
  function cssColor(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }
  function fmt(mm) { return mm >= 100 ? Math.round(mm) : Math.round(mm * 10) / 10; }
  function extOf(name) { return (String(name).toLowerCase().match(/\.(stl|3mf|obj|glb|gltf)$/) || [])[1] || "stl"; }

  function loadObject(THREE, src, ext) {
    return new Promise((res, rej) => {
      const err = (e) => rej(e instanceof Error ? e : new Error("could not read the file"));
      if (ext === "stl") new THREE.STLLoader().load(src, (g) => res(new THREE.Mesh(g)), undefined, err);
      else if (ext === "3mf") new THREE.ThreeMFLoader().load(src, res, undefined, err);
      else if (ext === "obj") new THREE.OBJLoader().load(src, res, undefined, err);
      else new THREE.GLTFLoader().load(src, (g) => res(g.scene), undefined, err);
    });
  }

  /* One material (unless the file brought textures), triangle count, Y-up
     formats rotated to Z-up, centred in XY with the lowest point on z = 0. */
  function prepare(THREE, obj, ext) {
    const keep = ext === "glb" || ext === "gltf";
    const mat = new THREE.MeshStandardMaterial({ color: MESH_COLOR, metalness: 0.05, roughness: 0.6 });
    let tris = 0;
    obj.traverse((n) => {
      if (!n.isMesh) return;
      if (!keep) n.material = mat;
      const g = n.geometry;
      if (!g.attributes.normal) g.computeVertexNormals();
      tris += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    });
    if (ext === "obj" || keep) obj.rotation.x = Math.PI / 2;
    const root = new THREE.Group();
    root.add(obj);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    root.position.set(-center.x, -center.y, -box.min.z);
    return { root, size, tris: Math.round(tris), mat };
  }

  function buildScene(THREE, prep) {
    const scene = new THREE.Scene();
    scene.add(prep.root);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x55606c, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(1, -1.2, 1.8); scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5); fill.position.set(-1.5, 1, 0.6); scene.add(fill);
    // Build-plate grid in mm so the size reads at a glance.
    const maxXY = Math.max(prep.size.x, prep.size.y, 1);
    const cell = maxXY > 300 ? 50 : maxXY > 120 ? 20 : 10;
    const span = Math.max(cell * 4, Math.ceil((maxXY * 1.6) / cell) * cell);
    const lineCol = new THREE.Color(cssColor("--line", "#888888"));
    const grid = new THREE.GridHelper(span, span / cell, lineCol, lineCol);
    grid.rotation.x = Math.PI / 2;           // GridHelper lies in XZ; lay it on XY
    grid.material.transparent = true;
    grid.material.opacity = 0.5;
    grid.position.z = -0.02;
    scene.add(grid);
    const diag = Math.max(prep.size.length(), 1);
    const cam = new THREE.PerspectiveCamera(32, W / H, diag / 100, diag * 40);
    cam.up.set(0, 0, 1);
    const d = diag * 1.9;
    const target = new THREE.Vector3(0, 0, prep.size.z / 2);
    cam.position.set(d * 0.62, -d * 0.62, d * 0.5).add(target);
    cam.lookAt(target);
    return { scene, cam, target, home: cam.position.clone(), diag, cell };
  }

  /* ---- context pool ---- */
  function acquire(st) {
    if (st.renderer) return st.renderer;
    while (live.size >= MAX_LIVE) {
      let victim = null;
      for (const o of live) if (!o.dragging && (!victim || o.lastFrame < victim.lastFrame)) victim = o;
      if (!victim) break;
      park(victim);
    }
    const canvas = document.createElement("canvas");
    canvas.className = "genmodel";
    canvas.width = W; canvas.height = H;
    canvas.setAttribute("aria-label", "3D model " + (st.name || ""));
    st.stage.insertBefore(canvas, st.still);
    st.canvas = canvas;
    st.renderer = new st.THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
    st.renderer.setClearColor(0x000000, 0);
    st.dpr = 0;
    st.still.hidden = true;
    live.add(st);
    return st.renderer;
  }
  function park(st) {
    if (!st.renderer) return;
    if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; }
    try {
      setDpr(st, HI_DPR);
      st.renderer.render(st.scene, st.cam);
      st.still.src = st.canvas.toDataURL("image/png");
      st.still.hidden = false;
    } catch (_) { /* keep whatever still we had */ }
    st.renderer.dispose();
    st.renderer.forceContextLoss();
    st.renderer = null;
    st.canvas.remove();
    st.canvas = null;
    live.delete(st);
  }
  function setDpr(st, dpr) {
    if (st.dpr === dpr) return;
    st.dpr = dpr;
    st.renderer.setPixelRatio(dpr);
    st.renderer.setSize(W, H, false);
  }

  /* ---- frame loop ---- */
  function frame(st, now) {
    st.raf = 0;
    if (!st.visible || document.hidden || !st.controls) return;
    const spinning = st.controls.autoRotate && now < st.spinUntil;
    if (st.controls.autoRotate && !spinning) st.controls.autoRotate = false;
    if (spinning && now - st.lastFrame < 1000 / SPIN_FPS - 1) {
      st.raf = requestAnimationFrame((t) => frame(st, t));
      return;
    }
    const moved = st.controls.update();
    const busy = spinning || moved || st.dragging;
    acquire(st);
    setDpr(st, busy ? 1 : HI_DPR);
    st.renderer.render(st.scene, st.cam);
    st.lastFrame = now;
    if (busy) st.raf = requestAnimationFrame((t) => frame(st, t));
    else if (st.dpr !== HI_DPR) st.raf = requestAnimationFrame((t) => frame(st, t));  // one hi-res settle frame
    else armIdlePark(st);
  }
  function schedule(st) { if (!st.raf) st.raf = requestAnimationFrame((t) => frame(st, t)); }
  function armIdlePark(st) {
    clearTimeout(st.parkTimer);
    st.parkTimer = setTimeout(() => { if (!st.dragging) park(st); }, PARK_IDLE_MS);
  }
  function spin(st) {
    st.controls.autoRotate = true;
    st.spinUntil = performance.now() + SPIN_SECONDS * 1000;
    schedule(st);
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const st = viewers.get(e.target);
      if (!st) continue;
      st.visible = e.isIntersecting;
      clearTimeout(st.offTimer);
      if (st.visible) { if (st.controls) schedule(st); }
      else st.offTimer = setTimeout(() => { if (!st.visible) park(st); }, PARK_OFFSCREEN_MS);
    }
  }, { rootMargin: "80px" });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) viewers.forEach((st) => { if (st.visible && st.controls) schedule(st); });
  });

  function setCaption(st, text, isErr) {
    const cap = st.wrap.querySelector(".genmodel-cap");
    if (cap) cap.textContent = text;
    st.wrap.classList.toggle("is-error", !!isErr);
    st.wrap.classList.remove("is-loading");
  }
  function toolButton(icon, title, onClick) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "genmodel-btn"; b.title = title; b.setAttribute("aria-label", title);
    const i = document.createElement("span"); i.className = "msi"; i.setAttribute("aria-hidden", "true"); i.textContent = icon;
    b.appendChild(i);
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return b;
  }
  function resetView(st) {
    st.cam.position.copy(st.home);
    st.controls.target.copy(st.target);
    st.controls.update();
    spin(st);
  }

  async function hydrate(wrap) {
    if (viewers.has(wrap)) return;
    const first = wrap.querySelector("canvas.genmodel");
    const src = wrap.dataset.model;
    if (!first || !src) return;
    // The markdown pass emits a bare canvas; wrap it in a stage that owns the
    // pointer events, with an <img> for the parked still beside it.
    const stage = document.createElement("span");
    stage.className = "genmodel-stage";
    const still = document.createElement("img");
    still.className = "genmodel-still"; still.alt = ""; still.hidden = true; still.width = W; still.height = H;
    first.replaceWith(stage);
    stage.appendChild(still);
    const st = { wrap, stage, still, canvas: null, renderer: null, src, name: wrap.dataset.name || "model",
                 visible: false, raf: 0, controls: null, dragging: false, lastFrame: 0, spinUntil: 0, dpr: 0 };
    viewers.set(wrap, st);
    wrap.classList.add("is-loading");
    try {
      const THREE = await lib();
      st.THREE = THREE;
      const ext = extOf(st.name);
      const obj = await loadObject(THREE, src, ext);
      if (!viewers.has(wrap)) return;   // removed while loading
      const prep = prepare(THREE, obj, ext);
      Object.assign(st, buildScene(THREE, prep), { prep });
      const controls = new THREE.OrbitControls(st.cam, stage);
      controls.target.copy(st.target);
      controls.enableDamping = true; controls.dampingFactor = 0.15;
      controls.autoRotateSpeed = 1.1;
      controls.minDistance = st.diag * 0.25; controls.maxDistance = st.diag * 10;
      controls.addEventListener("start", () => { st.dragging = true; controls.autoRotate = false; clearTimeout(st.parkTimer); schedule(st); });
      controls.addEventListener("end", () => { st.dragging = false; schedule(st); });
      controls.addEventListener("change", () => schedule(st));
      st.controls = controls;
      stage.addEventListener("dblclick", () => resetView(st));
      const tools = document.createElement("span");
      tools.className = "genmodel-tools";
      tools.appendChild(toolButton("center_focus_weak", "Reset view", () => resetView(st)));
      tools.appendChild(toolButton("deployed_code", "Toggle wireframe", () => {
        prep.mat.wireframe = !prep.mat.wireframe; st.dpr = 0; schedule(st);
      }));
      wrap.appendChild(tools);
      const s = prep.size;
      setCaption(st, `${st.name} · ${fmt(s.x)} × ${fmt(s.y)} × ${fmt(s.z)} mm · ${prep.tris.toLocaleString()} tris · grid ${st.cell} mm`);
      io.observe(wrap);
      st.visible = true;   // the observer corrects this on its first callback
      spin(st);
    } catch (e) {
      setCaption(st, `${st.name} · ${e && e.message ? e.message : "could not load"}`, true);
    }
  }
  function dispose(wrap) {
    const st = viewers.get(wrap);
    if (!st) return;
    viewers.delete(wrap);
    io.unobserve(wrap);
    clearTimeout(st.parkTimer); clearTimeout(st.offTimer);
    if (st.raf) cancelAnimationFrame(st.raf);
    if (st.renderer) { st.renderer.dispose(); st.renderer.forceContextLoss(); live.delete(st); }
    if (st.controls) st.controls.dispose();
    if (st.scene) st.scene.traverse((n) => {
      if (n.geometry) n.geometry.dispose();
      if (n.material && n.material !== st.prep.mat) {
        (Array.isArray(n.material) ? n.material : [n.material]).forEach((m) => m.dispose && m.dispose());
      }
    });
    if (st.prep) st.prep.mat.dispose();
  }

  function scan(root) {
    if (!(root instanceof Element)) return;
    if (root.matches(WRAP)) hydrate(root);
    root.querySelectorAll(WRAP).forEach(hydrate);
  }
  function unscan(root) {
    if (!(root instanceof Element)) return;
    if (root.matches(WRAP)) dispose(root);
    root.querySelectorAll(WRAP).forEach(dispose);
  }
  new MutationObserver((muts) => {
    for (const m of muts) {
      m.removedNodes.forEach(unscan);
      m.addedNodes.forEach(scan);
    }
  }).observe(document.body, { childList: true, subtree: true });
  scan(document.body);

  window.MistModel = {
    /* PNG data URL of the viewer's current view (live render or parked still),
       or null if it has not loaded. buildShareSnapshot() uses it. */
    snapshotPNG(wrap) {
      const st = viewers.get(wrap);
      if (!st || !st.controls) return null;
      if (!st.renderer) return st.still.src || null;
      try {
        setDpr(st, HI_DPR);
        st.renderer.render(st.scene, st.cam);
        return st.canvas.toDataURL("image/png");
      } catch (_) { return st.still.src || null; }
    },
    count() { return viewers.size; },
    liveCount() { return live.size; },
  };
})();
