/* voice.js — conversation mode: talk to MIST, hear her answer.
   Layout 1c from design/handoff/2026-10-03: a column beside the chat with the
   live crystal, a one-word state, a caption, and the controls. The chat stays
   the record: every spoken turn is a normal message (sent with voice:true so
   the model gets the spoken-reply hint), and MIST's reply is read sentence by
   sentence as it streams.

   Pieces:
   - Mic + end-of-utterance: Silero VAD in the page (vendor/vad, onnxruntime
     wasm). Hands-free keeps the mic open; "hold" is push-to-talk (Space with
     an empty composer, or the mic button held).
   - Speech to text: POST /voice/stt with a 16 kHz WAV (voice.py, whisper.cpp).
   - Text to speech: "live" = the web view's own speechSynthesis (instant, word
     boundaries) with the server's `say` as the fallback; "mist" = her XTTS
     voice and "chatterbox" = the same clone on Chatterbox Turbo, both via
     POST /voice/tts (they render ahead, so a "rendering" state).
   - Barge-in: real speech while she talks stops the audio and drops the rest
     of that reply's queue; the text still lands in the chat.

   app.js calls in: VOICE.onText(session, block, done) from the stream handler,
   VOICE.onTurnEnd(session) on result, VOICE.onSwitch() from switchTo,
   VOICE.crystalAnim() from crystalResolve, VOICE.stopSpeaking() on Esc/send.
   Nothing here makes a sound until the user turns the mode on. */
(function () {
  "use strict";
  const $ = (q) => document.querySelector(q);
  const LS = { mode: "voiceMode", voice: "voiceVoice" };
  const VAD_ASSETS = "vendor/vad/";
  // The cloned voices: server engines that render ahead and warm on first use.
  const CLONED = {
    mist: { name: "MIST voice", up: "MIST's XTTS voice (slower than real time)",
            warming: "MIST's XTTS voice is loading (about 80 s)" },
    chatterbox: { name: "Chatterbox voice", up: "MIST's voice on Chatterbox (close to real time)",
                  warming: "The Chatterbox voice is loading (about 20 s)" },
  };
  const st = {
    on: false, sid: null,
    mode: (localStorage.getItem(LS.mode) === "hold") ? "hold" : "handsfree",
    voice: CLONED[localStorage.getItem(LS.voice)] ? localStorage.getItem(LS.voice) : "live",
    muted: false, state: "off", label: "", caption: "", draft: "",
    vad: null, vadBusy: false, level: 0, holdDown: false,
    speaking: false, queue: [], cur: null, dropTurn: false,
    status: null, lastErr: "", warmTimer: null, blocks: new WeakMap(),
  };
  let ui = null;

  /* ---------- text for the ear ---------- */
  const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}️]/gu;
  function stripFaces(t) {
    t = t.replace(EMOJI, " ");
    t = t.replace(/\(([^()]{1,12})\)/g, (m, inner) => {
      if (/^[\s\w.,;:'"!?-]+$/.test(inner) && /[a-zA-Z0-9]{2,}/.test(inner)) return m;   // (e.g.) (1)
      if (/[^\x00-\x7F]/.test(inner) || /^[\s^;:'"<>._\-oO0vuwT=*~`'´\/\\|+\[\]{}#@!?]+$/.test(inner)) return " ";
      return m;
    });
    return t.replace(/[◠◡ᵔωˆ´ˋ눈⇀‸↼ᴗ￢¬→←⊙○●◞◟﹏︵▽×Д皿＃ə]/g, " ");
  }
  function stripMarkdown(md) {
    md = md.replace(/```[\s\S]*?```/g, " ");
    md = md.replace(/`([^`]+)`/g, "$1");
    md = md.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
    md = md.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
    md = md.replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, "$1");
    md = md.replace(/^\s*>\s?/gm, "");
    md = md.replace(/^\s*[-*+]\s+\[[ xX]\]\s*/gm, "");          // task lines, before plain bullets
    md = md.replace(/^\s*(#{1,6}|[-*+]|\d+[.)])\s+/gm, "");
    md = md.replace(/[*_~]{1,3}/g, "");
    md = md.replace(/\|/g, " ");
    md = md.replace(/^[-:\s|]+$/gm, "");
    md = md.replace(/https?:\/\/\S+/g, "link");
    md = stripFaces(md);
    return md.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, " ").trim();
  }
  // Complete sentences at the front of `text`. Returns [sentences, restIndex].
  // Waits on an open code fence (nothing inside is speech) and on a sentence
  // end that is not yet followed by whitespace (the stream may add more).
  function takeSentences(text, done) {
    // Closed code fences become blanks of the same length, so no sentence is
    // found inside them and the indexes still map onto `text`.
    const masked = text.replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length));
    if (/```/.test(masked) && !done) return [[], 0];
    const out = [];
    let i = 0;
    const re = /[.!?…]+["')\]]*(?:\s+|$)|\n{2,}/g;
    let m;
    while ((m = re.exec(masked))) {
      const end = m.index + m[0].length;
      if (end >= masked.length && !done && !/\s$/.test(m[0])) break;
      const seg = masked.slice(i, end);
      if (seg.trim()) out.push(seg);
      i = end;
    }
    if (done && masked.slice(i).trim()) { out.push(masked.slice(i)); i = masked.length; }
    return [out, i];
  }

  /* ---------- state + render ---------- */
  const STATES = {
    listening:    { label: "listening",    cls: "c-teal",   cap: "go ahead" },
    hearing:      { label: "hearing you",  cls: "c-user",   cap: "" },
    transcribing: { label: "transcribing", cls: "c-user",   cap: "on this Mac" },
    thinking:     { label: "thinking",     cls: "c-violet", cap: "" },
    speaking:     { label: "speaking",     cls: "c-teal",   cap: "talk or press Esc to interrupt" },
    rendering:    { label: "rendering",    cls: "c-warn",   cap: "MIST voice · next sentence soon" },
    hold:         { label: "hold to talk", cls: "c-dim",    cap: "hold Space or the mic button" },
    recording:    { label: "recording",    cls: "c-user",   cap: "release to send" },
    muted:        { label: "muted",        cls: "c-dim",    cap: "mic off · typed turns are still read aloud" },
    warming:      { label: "warming up",   cls: "c-warn",   cap: "loading the voice detector" },
    error:        { label: "error",        cls: "c-err",    cap: "" },
  };
  function setState(state, caption) {
    st.state = state;
    st.caption = caption != null ? caption : (STATES[state] || {}).cap || "";
    render();
    if (typeof crystalRefresh === "function") crystalRefresh();
  }
  function idleState() {
    // What the pane shows when nothing is in flight.
    if (st.muted) return "muted";
    return st.mode === "hold" ? "hold" : "listening";
  }
  function render() {
    if (!ui) return;
    const d = STATES[st.state] || STATES.error;
    ui.pane.hidden = !st.on;
    ui.pane.dataset.state = st.state;
    ui.btn.setAttribute("aria-pressed", st.on ? "true" : "false");
    ui.btn.classList.toggle("on", st.on);
    ui.label.textContent = d.label;
    ui.label.className = "voice-label " + d.cls;
    ui.caption.textContent = st.caption;
    ui.caption.classList.toggle("spoken", st.state === "speaking");
    ui.meter.className = "voice-meter " + d.cls + (st.state === "hearing" || st.state === "recording" || st.state === "speaking" ? " live" : " still");
    ui.hf.classList.toggle("on", st.mode === "handsfree");
    ui.hold.classList.toggle("on", st.mode === "hold");
    ui.live.classList.toggle("on", st.voice === "live");
    for (const k in CLONED) {
      const b = ui[k], ms = st.status && st.status[k + "_voice"];
      b.classList.toggle("on", st.voice === k);
      b.title = ms === "up" ? CLONED[k].up : ms === "warming" ? CLONED[k].warming
              : CLONED[k].name + " · starts its voice service on first use";
      b.classList.toggle("warm", ms === "warming");
    }
    ui.micIcon.textContent = st.muted ? "mic_off" : "mic";
    ui.mic.title = st.mode === "hold" ? "Hold to talk" : (st.muted ? "Unmute the mic" : "Mute the mic");
    syncCrystal();
  }
  function syncCrystal() {
    if (!ui) return;
    const live = typeof crystal === "object" && crystal.avail && crystal.on && crystal.cur;
    ui.crystal.hidden = !live; ui.still.hidden = !!live;
    if (live && ui.crystal.getAttribute("src") !== crystal.cur) ui.crystal.src = crystal.cur;
  }
  function setLevel(p) {
    st.level = p;
    if (ui) ui.meter.style.setProperty("--lvl", String(Math.max(0.08, Math.min(1, p))));
  }

  /* ---------- the mic ---------- */
  async function getStream() {
    return navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  }
  async function ensureVad() {
    if (st.vad) return st.vad;
    if (!window.vad || !window.vad.MicVAD) throw new Error("voice detector not loaded (vendor/vad)");
    setState("warming");
    // Absolute URLs: onnxruntime loads its .mjs helper with a dynamic import(),
    // and WebKit rejects a relative specifier there ("does not resolve to a
    // valid URL"). One thread: no cross-origin isolation on this page, so no
    // SharedArrayBuffer for the threaded build to use.
    const assets = new URL(VAD_ASSETS, location.href).href;
    if (window.ort && ort.env && ort.env.wasm) ort.env.wasm.numThreads = 1;
    st.vad = await window.vad.MicVAD.new({
      model: "v5",
      baseAssetPath: assets, onnxWASMBasePath: assets,
      getStream,
      positiveSpeechThreshold: 0.6, negativeSpeechThreshold: 0.35,
      // 600 ms of pre-roll: "Hi" lost its onset at 400 and came back as "I".
      minSpeechMs: 250, preSpeechPadMs: 600, redemptionMs: 900,
      submitUserSpeechOnPause: true,
      onFrameProcessed: (probs) => { if (st.state === "hearing" || st.state === "recording") setLevel(probs.isSpeech); },
      onSpeechStart: () => {
        if (!st.on) return;
        if (st.speaking) return;           // wait for real speech before barging in
        if (st.state !== "recording") setState("hearing", "");
      },
      onSpeechRealStart: () => {
        if (!st.on) return;
        if (st.speaking) { stopSpeaking(true); setState("hearing", ""); }
      },
      onVADMisfire: () => { if (st.on && !st.speaking && st.state === "hearing") setState(idleState()); },
      onSpeechEnd: (audio) => { if (st.on) void heard(audio); },
    });
    return st.vad;
  }
  async function heard(audio) {
    // audio: Float32Array at 16 kHz, the utterance with its pre-roll.
    const secs = audio.length / 16000;
    if (secs < 0.3) { setState(idleState()); return; }
    setState("transcribing", "on this Mac · " + secs.toFixed(1) + " s");
    let text = "";
    try {
      const wav = window.vad.utils.encodeWAV(audio, 1, 16000, 1, 16);
      const r = await fetch("/voice/stt", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "transcription failed");
      text = (j.text || "").trim();
    } catch (e) {
      setState("error", String(e.message || e));
      setTimeout(() => { if (st.state === "error") setState(idleState()); }, 4000);
      return;
    }
    if (!st.on) return;
    if (!text || text.length < 2) { setState(idleState(), "did not catch that"); return; }
    const s = sessions.get(st.sid);
    if (!s) { setState(idleState()); return; }
    if (st.speaking) stopSpeaking(true);
    st.dropTurn = false;
    setState("thinking", text);
    s.send(text, null, true, { voice: true });
  }

  /* ---------- speaking ---------- */
  function ssVoice() {
    if (!("speechSynthesis" in window)) return null;
    const vs = speechSynthesis.getVoices() || [];
    if (!vs.length) return null;
    return vs.find((v) => /samantha/i.test(v.name)) || vs.find((v) => v.lang === "en-US" && v.default)
        || vs.find((v) => /^en/.test(v.lang)) || vs[0];
  }
  function enqueue(text) {
    const item = { text, audio: null, fetching: null, error: null };
    // The cloned voices (and the server fallback) render ahead so playback stays continuous.
    if (CLONED[st.voice] || !ssVoice()) item.fetching = fetchAudio(item);
    st.queue.push(item);
    pump();
  }
  async function fetchAudio(item) {
    try {
      const r = await fetch("/voice/tts", { method: "POST", headers: { "Content-Type": "application/json" },
                                             body: JSON.stringify({ text: item.text, voice: st.voice }) });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        item.error = j.error || ("tts " + r.status);
        if (j.state === "warming" && CLONED[st.voice]) { st.status = Object.assign({}, st.status, { [st.voice + "_voice"]: "warming" }); render(); }
        return;
      }
      item.audio = URL.createObjectURL(await r.blob());
    } catch (e) { item.error = String(e.message || e); }
  }
  function pump() {
    if (!st.on || st.speaking || !st.queue.length) return;
    const item = st.queue.shift();
    st.cur = item;
    st.speaking = true;
    bumpAudio(+1);
    const finish = () => {
      if (st.cur !== item) return;
      st.cur = null; st.speaking = false; bumpAudio(-1);
      if (item.audio) URL.revokeObjectURL(item.audio);
      if (st.queue.length) pump();
      else {
        const s = sessions.get(st.sid);
        setState(s && s.busy && s.busy() ? "thinking" : idleState());
      }
    };
    if (item.fetching) {
      if (!item.audio && !item.error) setState("rendering");
      item.fetching.then(() => {
        if (st.cur !== item) return;
        if (item.error) {
          if (CLONED[st.voice]) {
            // Her voice is not ready: say this one with the live voice rather than go silent.
            const nm = CLONED[st.voice].name;
            setState("rendering", item.error === "warming" ? nm + " is loading · using the live voice" : nm + " unavailable · using the live voice");
            item.fetching = null; item.error = null;
            if (ssVoice()) return speakSS(item, finish);
            fetch("/voice/tts", { method: "POST", headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ text: item.text, voice: "live" }) })
              .then((r) => r.ok ? r.blob() : Promise.reject(new Error("tts failed")))
              .then((b) => { item.audio = URL.createObjectURL(b); playFile(item, finish); })
              .catch(() => finish());
            return;
          }
          finish(); return;
        }
        playFile(item, finish);
      });
      return;
    }
    speakSS(item, finish);
  }
  function speakSS(item, finish) {
    const v = ssVoice();
    if (!v) { finish(); return; }
    const u = new SpeechSynthesisUtterance(item.text);
    u.voice = v; u.rate = 1.0; u.pitch = 1.0;
    item.utt = u;
    const words = item.text.split(/\s+/);
    setState("speaking", item.text);
    u.onboundary = (e) => {
      if (st.cur !== item || e.name !== "word") return;
      // highlight the word at this char index in the caption
      let n = 0, idx = 0;
      for (let i = 0; i < words.length; i++) { if (n > e.charIndex) break; idx = i; n += words[i].length + 1; }
      paintCaption(words, idx);
    };
    u.onend = finish; u.onerror = finish;
    speechSynthesis.speak(u);
  }
  function playFile(item, finish) {
    const a = new Audio(item.audio);
    item.el = a;
    const words = item.text.split(/\s+/);
    setState("speaking", item.text);
    a.ontimeupdate = () => {
      if (st.cur !== item || !a.duration) return;
      paintCaption(words, Math.min(words.length - 1, Math.floor(words.length * a.currentTime / a.duration)));
    };
    a.onended = finish; a.onerror = finish;
    a.play().catch(finish);
  }
  function paintCaption(words, idx) {
    if (!ui) return;
    const frag = document.createDocumentFragment();
    words.forEach((w, i) => {
      const sp = document.createElement("span");
      sp.textContent = w + " ";
      sp.className = i < idx ? "said" : i === idx ? "now" : "tbd";
      frag.appendChild(sp);
    });
    ui.caption.innerHTML = ""; ui.caption.appendChild(frag);
  }
  function bumpAudio(d) {
    if (typeof crystal !== "object") return;
    crystal.audioPlaying = Math.max(0, (crystal.audioPlaying || 0) + d);
    if (typeof crystalRefresh === "function") crystalRefresh();
  }
  function stopSpeaking(dropRest) {
    if (dropRest) { st.queue = []; st.dropTurn = true; }
    const item = st.cur;
    if (!item) return;
    st.cur = null; st.speaking = false; bumpAudio(-1);
    try { if (item.utt) speechSynthesis.cancel(); } catch (_) {}
    try { if (item.el) { item.el.pause(); item.el.src = ""; } } catch (_) {}
    if (item.audio) URL.revokeObjectURL(item.audio);
    if (!dropRest && st.queue.length) pump();
  }

  /* ---------- hooks from app.js ---------- */
  function onText(session, block, done) {
    if (!st.on || !session || session.id !== st.sid || session._replaying || st.dropTurn) return;
    const text = block.text || "";
    let at = st.blocks.get(block) || 0;
    const [sents, used] = takeSentences(text.slice(at), done);
    if (!sents.length) return;
    st.blocks.set(block, at + used);
    for (const s of sents) { const clean = stripMarkdown(s); if (clean && /[a-zA-Z0-9]/.test(clean)) enqueue(clean); }
  }
  function onTurnEnd(session) {
    if (!st.on || !session || session.id !== st.sid) return;
    st.dropTurn = false;
    if (!st.speaking && !st.queue.length) setState(idleState());
  }
  function onSwitch() {
    // Conversation mode belongs to the chat it was started in. Switching away
    // leaves it running there; the pane follows the active chat.
    if (ui) ui.pane.hidden = !(st.on && activeId === st.sid);
    syncCrystal();
  }
  function crystalAnim() {
    if (!st.on || activeId !== st.sid || st.speaking) return null;
    if (st.state === "listening" || st.state === "hearing" || st.state === "recording") return "listening";
    return null;
  }

  /* ---------- controls ---------- */
  async function start() {
    if (!activeId) return;
    st.sid = activeId; st.on = true; st.dropTurn = false;
    render();
    try {
      const r = await fetch("/voice/status"); st.status = await r.json();
    } catch (_) { st.status = null; }
    if (st.status && !st.status.model) {
      setState("error", "transcriber missing · run bin/fetch-whisper-model in mist-console");
      return;
    }
    try { await ensureVad(); }
    catch (e) {
      const msg = String(e.message || e);
      setState("error", /denied|permission|NotAllowed/i.test(msg)
        ? "no mic access · allow MIST Console in System Settings › Privacy & Security › Microphone"
        : "mic failed · " + msg);
      return;
    }
    if (!st.on) return;
    if (st.mode === "handsfree" && !st.muted) st.vad.start(); else st.vad.pause();
    if (CLONED[st.voice]) warm(st.voice);
    setState(idleState());
    if ("speechSynthesis" in window) speechSynthesis.getVoices();   // Safari fills the list lazily
  }
  function stop() {
    st.on = false;
    stopSpeaking(true);
    st.dropTurn = false;
    if (st.vad) { try { st.vad.destroy(); } catch (_) {} st.vad = null; }   // releases the mic (the menu-bar dot goes off)
    setState("off", "");
    if (st.warmTimer) { clearInterval(st.warmTimer); st.warmTimer = null; }
  }
  function toggle() { if (st.on) stop(); else void start(); }
  function setMode(mode) {
    st.mode = mode; localStorage.setItem(LS.mode, mode);
    if (st.vad && st.on) { if (mode === "handsfree" && !st.muted) st.vad.start(); else st.vad.pause(); }
    if (st.on && !st.speaking) setState(idleState());
    render();
  }
  function setVoice(v) {
    st.voice = v; localStorage.setItem(LS.voice, v);
    if (CLONED[v]) warm(v);
    render();
  }
  function warm(engine) {
    fetch("/voice/" + engine + "/start", { method: "POST" }).then((r) => r.json()).then((j) => {
      st.status = Object.assign({}, st.status, { [engine + "_voice"]: j.state }); render();
      if (j.state === "warming" && !st.warmTimer) {
        st.warmTimer = setInterval(async () => {
          try {
            const s = await (await fetch("/voice/status")).json();
            st.status = s; render();
            if (s[engine + "_voice"] !== "warming") { clearInterval(st.warmTimer); st.warmTimer = null; }
          } catch (_) {}
        }, 5000);
      }
    }).catch(() => {});
  }
  function toggleMute() {
    if (st.mode === "hold") return;
    st.muted = !st.muted;
    if (st.vad) { if (st.muted) st.vad.pause(); else st.vad.start(); }
    if (!st.speaking) setState(idleState());
    render();
  }
  function holdStart() {
    if (!st.on || st.mode !== "hold" || st.holdDown || !st.vad) return;
    st.holdDown = true;
    if (st.speaking) stopSpeaking(true);
    st.vad.start();
    setState("recording");
  }
  function holdEnd() {
    if (!st.holdDown) return;
    st.holdDown = false;
    if (st.vad) st.vad.pause();   // submitUserSpeechOnPause hands the utterance to onSpeechEnd
    if (st.state === "recording") setState("transcribing");
  }

  /* ---------- wiring ---------- */
  function init() {
    const pane = $("#voicePane"), btn = $("#voiceBtn");
    if (!pane || !btn) return;
    ui = {
      pane, btn,
      crystal: $("#voiceCrystal"), still: $("#voiceStill"),
      label: $("#voiceLabel"), caption: $("#voiceCaption"), meter: $("#voiceMeter"),
      hf: $("#voiceHandsfree"), hold: $("#voiceHold"), live: $("#voiceLive"), mist: $("#voiceMist"),
      chatterbox: $("#voiceChatterbox"),
      mic: $("#voiceMic"), micIcon: $("#voiceMicIcon"), end: $("#voiceEnd"),
    };
    for (let i = 0; i < 12; i++) ui.meter.appendChild(document.createElement("i"));
    btn.addEventListener("click", toggle);
    ui.end.addEventListener("click", stop);
    ui.hf.addEventListener("click", () => setMode("handsfree"));
    ui.hold.addEventListener("click", () => setMode("hold"));
    ui.live.addEventListener("click", () => setVoice("live"));
    ui.mist.addEventListener("click", () => setVoice("mist"));
    ui.chatterbox.addEventListener("click", () => setVoice("chatterbox"));
    ui.mic.addEventListener("click", () => { if (st.mode !== "hold") toggleMute(); });
    ui.mic.addEventListener("pointerdown", (e) => { if (st.mode === "hold") { e.preventDefault(); holdStart(); } });
    for (const ev of ["pointerup", "pointercancel", "pointerleave"]) ui.mic.addEventListener(ev, holdEnd);
    ui.crystal.addEventListener("click", () => { if (st.speaking) stopSpeaking(true); });
    // Space = push-to-talk while the composer is empty (a space in a typed draft still types).
    const input = $("#input");
    document.addEventListener("keydown", (e) => {
      if (!st.on || st.mode !== "hold" || e.key !== " " || e.repeat) return;
      const t = e.target;
      const typing = t && t !== input && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (typing || (input && input.value)) return;
      e.preventDefault(); holdStart();
    });
    document.addEventListener("keyup", (e) => { if (e.key === " " && st.holdDown) { e.preventDefault(); holdEnd(); } });
    window.addEventListener("blur", holdEnd);
    render();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();

  window.VOICE = { onText, onTurnEnd, onSwitch, crystalAnim, stopSpeaking, syncCrystal, toggle, start, stop,
                   get on() { return st.on; }, get sid() { return st.sid; }, get state() { return st.state; },
                   _stripMarkdown: stripMarkdown, _takeSentences: takeSentences, _setState: setState,
                   _force(on, sid) { st.on = on; st.sid = sid || activeId; render(); } };
})();
