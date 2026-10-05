/* model.js: inline 3D model viewer for `![name](/abs/path.stl)` embeds.

   _md() in app.js emits <span class="genmodel-wrap" data-model="/file?..."
   data-name="part.stl"> around a 2D <canvas>. This file hydrates every such wrap
   it sees (a MutationObserver on the document, so it works for streamed, replayed
   and imported bubbles alike), loads the mesh through three.js and draws it as a
   slow turntable that stops the first time the model is grabbed. Drag orbits,
   wheel zooms, double-click resets the view.

   One WebGL context for the whole page: WebKit caps live contexts at about 16
   and a long chat holds far more embeds than that. A single shared
   WebGLRenderer renders each viewer's scene into its own drawing buffer, which
   is then blitted into that viewer's 2D canvas (the "multiple elements" pattern
   from the three.js examples). Frames render only while a viewer is on screen
   and either auto-rotating or being moved, so idle chats cost nothing.

   three.js (vendor/three.js, MIT, bundled with OrbitControls + the STL/3MF/OBJ/
   glTF loaders) loads lazily on the first embed, so a chat with no models never
   pays for it. Units are taken as millimetres, which is what every slicer
   assumes for STL and 3MF. STL and 3MF are Z-up; OBJ and glTF are Y-up and are
   rotated onto the same floor. The share snapshot asks for a PNG of the current
   view via window.MistModel.snapshotPNG(wrap). */
(() => {
  "use strict";
  const WRAP = ".genmodel-wrap";
  const W = 480, H = 320;
  const MESH_COLOR = 0x8aa0b8;   // same slate as the f3d preview sheets
  let libPromise = null;
  let shared = null;             // the one WebGLRenderer
  const viewers = new Map();     // wrap element -> state

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
  function renderer(THREE) {
    if (!shared) {
      shared = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      shared.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      shared.setClearColor(0x000000, 0);
    }
    return shared;
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

  /* Give the object one material (unless it brought textures), count its
     triangles, rotate Y-up formats onto Z-up, centre it in XY and put its
     lowest point on z = 0 like a part sitting on the build plate. */
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
    // Build-plate grid in mm so the size reads at a glance: 10 mm cells for
    // hand-sized parts, coarser as the part grows.
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

  function draw(st) {
    const r = renderer(st.THREE);
    r.setSize(W, H, false);
    r.render(st.scene, st.cam);
    const c = st.canvas;
    st.ctx.clearRect(0, 0, c.width, c.height);
    st.ctx.drawImage(r.domElement, 0, 0, c.width, c.height);
  }
  function frame(st) {
    st.raf = 0;
    if (!st.visible || document.hidden || !st.controls) return;
    const moved = st.controls.update();
    draw(st);
    if (st.controls.autoRotate || moved) st.raf = requestAnimationFrame(() => frame(st));
  }
  function schedule(st) { if (!st.raf) st.raf = requestAnimationFrame(() => frame(st)); }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const st = viewers.get(e.target);
      if (!st) continue;
      st.visible = e.isIntersecting;
      if (st.visible) schedule(st);
    }
  }, { rootMargin: "120px" });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) viewers.forEach((st) => { if (st.visible) schedule(st); });
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
    b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
    return b;
  }
  function resetView(st) {
    st.cam.position.copy(st.home);
    st.controls.target.copy(st.target);
    st.controls.autoRotate = true;
    st.controls.update();
    schedule(st);
  }

  async function hydrate(wrap) {
    if (viewers.has(wrap)) return;
    const canvas = wrap.querySelector("canvas.genmodel");
    const src = wrap.dataset.model;
    if (!canvas || !src) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr; canvas.height = H * dpr;
    const st = { wrap, canvas, ctx: canvas.getContext("2d"), src, visible: false, raf: 0, controls: null };
    viewers.set(wrap, st);
    wrap.classList.add("is-loading");
    const name = wrap.dataset.name || "model";
    try {
      const THREE = await lib();
      st.THREE = THREE;
      const ext = extOf(name);
      const obj = await loadObject(THREE, src, ext);
      if (!viewers.has(wrap)) return;   // removed while loading
      const prep = prepare(THREE, obj, ext);
      Object.assign(st, buildScene(THREE, prep), { prep });
      const controls = new THREE.OrbitControls(st.cam, canvas);
      controls.target.copy(st.target);
      controls.enableDamping = true; controls.dampingFactor = 0.12;
      controls.autoRotate = true; controls.autoRotateSpeed = 1.1;
      controls.minDistance = st.diag * 0.25; controls.maxDistance = st.diag * 10;
      controls.addEventListener("start", () => { controls.autoRotate = false; schedule(st); });
      controls.addEventListener("change", () => schedule(st));
      st.controls = controls;
      canvas.addEventListener("dblclick", () => resetView(st));
      const tools = document.createElement("span");
      tools.className = "genmodel-tools";
      tools.appendChild(toolButton("center_focus_weak", "Reset view", () => resetView(st)));
      tools.appendChild(toolButton("deployed_code", "Toggle wireframe", () => {
        prep.mat.wireframe = !prep.mat.wireframe; schedule(st);
      }));
      wrap.appendChild(tools);
      const s = prep.size;
      setCaption(st, `${name} · ${fmt(s.x)} × ${fmt(s.y)} × ${fmt(s.z)} mm · ${prep.tris.toLocaleString()} tris · grid ${st.cell} mm`);
      io.observe(wrap);
      st.visible = true;   // draw one frame right away; the observer corrects it
      schedule(st);
    } catch (e) {
      setCaption(st, `${name} · ${e && e.message ? e.message : "could not load"}`, true);
    }
  }
  function dispose(wrap) {
    const st = viewers.get(wrap);
    if (!st) return;
    viewers.delete(wrap);
    io.unobserve(wrap);
    if (st.raf) cancelAnimationFrame(st.raf);
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
    /* PNG data URL of the viewer's current frame, or null if it is not ready.
       buildShareSnapshot() uses it in place of the live canvas. */
    snapshotPNG(wrap) {
      const st = viewers.get(wrap);
      if (!st || !st.controls) return null;
      draw(st);
      try { return st.canvas.toDataURL("image/png"); } catch (_) { return null; }
    },
    count() { return viewers.size; },
  };
})();
