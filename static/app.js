/* MIST Console front-end. Multi-session (left tab rail), each tab a headless
   claude streamed over SSE. We render the whole UI ourselves. */
"use strict";

const $ = (s) => document.querySelector(s);
const logs = $("#logs");
const tabsEl = $("#tabs");
const input = $("#input");
const statusEl = $("#status");
const jumpBtn = $("#jumpBtn");

/* ---------- phone: the iOS shell (ios/) and narrow windows ----------
   Layout flips to the drawer form under 760px (style.css); touch decides the
   input conventions (return = newline, photos attach); the shell attribute is
   set pre-paint from the app's user agent for the few things only it can do. */
const PHONE_MQ = window.matchMedia("(max-width: 760px)");
const TOUCH_MQ = window.matchMedia("(hover: none) and (pointer: coarse)");
const IS_SHELL = document.documentElement.dataset.shell === "ios";
function isPhone() { return PHONE_MQ.matches; }
function isTouch() { return IS_SHELL || TOUCH_MQ.matches; }
let closeRailDrawer = () => false;   // wired once the rail exists (end of file)
let setRailOpen = () => {};
// The phone's top bar shows the active chat's title (the rail is hidden there).
function syncPhoneTitle() {
  const t = $("#phoneTitle");
  if (!t) return;
  const s = activeId && sessions.get(activeId);
  t.textContent = (s && s.title) || "";
}
// The iOS shell listens for these (WKScriptMessageHandler "mist"): the event
// stream going down is its cue that the Mac may have moved (hotspot, VPN, a
// network hop) and that it should re-probe the addresses it knows.
function shellStream(state) {
  try {
    const h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.mist;
    if (IS_SHELL && h) h.postMessage({ type: "stream", state });
  } catch (_) {}
}

// Auto-grow the composer to fit its text, capped at 200px. Show the scrollbar
// ONLY once we hit that cap. Without this, WebKit's custom (non-overlay)
// scrollbar reserves a gutter even on a single line that already fits.
function growInput() {
  input.style.height = "auto";
  const capped = input.scrollHeight > 200;
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
  input.style.overflowY = capped ? "auto" : "hidden";
}

// Show the "jump to present" pill whenever the visible chat is scrolled up
// off the bottom (so MIST's live output isn't yanking us back down).
function updateJumpBtn() {
  if (!jumpBtn) return;
  const s = activeId && sessions.get(activeId);
  jumpBtn.hidden = !(s && !s.stick);
}

// Track the top bar's height (badges wrap, so it varies) into --topbar-h, used
// to start the side panels below it — that keeps their trigger buttons visible
// and clickable, so clicking a button again toggles its panel closed.
(function () {
  const tb = $("#topbar"), root = document.documentElement;
  if (!tb) return;
  const sync = () => root.style.setProperty("--topbar-h", tb.offsetHeight + "px");
  sync();
  if (window.ResizeObserver) new ResizeObserver(sync).observe(tb);
  window.addEventListener("resize", sync);
})();

// Track the composer's height too (it grows to ~220px with a multi-line draft).
// The fixed overlays that sit above it (#usage, #bgMonitor) anchor to
// --composer-h instead of assuming a one-line row.
(function () {
  const c = $("#composer"), root = document.documentElement;
  if (!c) return;
  const sync = () => root.style.setProperty("--composer-h", c.offsetHeight + "px");
  sync();
  if (window.ResizeObserver) new ResizeObserver(sync).observe(c);
  window.addEventListener("resize", sync);
})();

/* ---------- safe markdown ---------- */
function esc(s) {
  // Quotes too: escaped text gets interpolated into attributes (img alt/src),
  // where a raw " would break out of the attribute.
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
/* Map an image path/URL from markdown to something the WebView can load.
   Local absolute paths (and ~ / file://) route through the backend /file
   server so the WebView can fetch them; http(s) passes through. Anything
   else returns null so the markdown is left as plain text. */
/* Timestamp (epoch seconds) of the bubble being rendered, set by md(); /file
   uses it to serve the snapshot of the file taken for that message, so a path
   overwritten in a later turn does not rewrite earlier bubbles (embeds.py). */
let EMBED_AT = 0;
function imgSrc(p) {
  p = String(p).trim();
  // The markdown pass runs esc() BEFORE the image pass, so a path reaching here
  // may carry entities — ~/Pictures/B&W.png arrives as B&amp;W.png and would be
  // looked up (and 404) under that literal name. Undo esc()'s five entities.
  p = p.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
       .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  if (/^https?:\/\//i.test(p)) return p;
  if (p.startsWith("file://")) p = decodeURIComponent(p.slice(7));
  if (p.startsWith("~") || p.startsWith("/")) {
    return "/file?path=" + encodeURIComponent(p) + (EMBED_AT ? "&at=" + EMBED_AT : "");
  }
  return null;
}
/* Display name for an attachment card: entity-undo (same as imgSrc), strip
   query/fragment, take the last path segment. */
function fileBaseName(p) {
  p = String(p).trim()
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[?#].*$/, "");
  if (p.startsWith("file://")) p = p.slice(7);
  const seg = p.split("/").filter(Boolean).pop() || p;
  try { return decodeURIComponent(seg); } catch (_) { return seg; }
}
/* Inline-thumbnail HTML (lightbox + Save-to-Downloads, same chrome as generated
   images) for a local image path. '' if the path can't be served by /file. The
   click + download are handled by the delegated `logs` listener, so this works
   for any bubble it's dropped into. */
function imageThumbHTML(path, alt) {
  let src = imgSrc(path);
  if (!src) return "";
  src = esc(src);   // it lands in attributes; a `"` in an http URL must not break out
  const DL = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path fill="currentColor" d="M11 3h2v8.2l3.1-3.1 1.4 1.4L12 15 6.5 9.5l1.4-1.4L11 11.2V3zM5 18h14v2H5z"/></svg>';
  return '<span class="genimg-wrap">' +
           '<a class="imglink" href="' + src + '" data-full="' + src + '">' +
             '<img class="genimg" src="' + src + '" alt="' + esc(alt || "image") + '" loading="lazy"></a>' +
           '<button class="genimg-dl" type="button" data-dl="' + src + '" ' +
             'title="Save to Downloads" aria-label="Save to Downloads">' + DL + '</button>' +
         '</span>';
}
/* ---------- recipe cards ----------
   A ```recipe fence (JSON per bridge.RECIPE_PROMPT) renders as an interactive
   card: ingredient checklist, steps with inline clickable timers, and a
   full-screen cooking mode. State lives in module registries keyed by stable
   ids, NOT on the DOM — the transcript's innerHTML is rebuilt on every stream
   delta, so chips/checkboxes rehydrate from the registries after each rebuild
   (the 1s ticker and the delegated click handler both repaint from them). */
const recipeData = new Map();    // rid -> parsed recipe object
const recipeTimers = new Map();  // timer id -> {dur, endAt, remaining, state}
const recipeChecks = new Set();  // "rid:idx" of checked-off ingredients

function recipeSlug(s) {
  return String(s || "recipe").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 40) || "recipe";
}
// First duration mentioned in a step ("simmer 10 minutes", "bake 25-30 min",
// "1½ hours", "1 hour 20 minutes") -> seconds. Ranges take the LOWER bound —
// you can add time, you can't un-bake. null if the step mentions none.
function parseDurationSec(text) {
  const t = String(text || "");
  const num = (s) => {
    s = s.replace("½", ".5").replace("¼", ".25").replace("¾", ".75");
    const m = s.match(/^(\d+)[-–](\d+)/);          // range: lower bound
    return m ? parseFloat(m[1]) : parseFloat(s);
  };
  const re = /(\d+(?:[-–]\d+)?(?:\.\d+)?|\d*[½¼¾])\s*(hours?|hrs?|hr|h)\b(?:\s*(?:and\s*)?(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|min|m)\b)?|(\d+(?:[-–]\d+)?(?:\.\d+)?|\d*[½¼¾])\s*(minutes?|mins?|min)\b|(\d+(?:[-–]\d+)?)\s*(seconds?|secs?|sec)\b/i;
  const m = t.match(re);
  if (!m) return null;
  if (m[2]) return Math.round(num(m[1]) * 3600 + (m[3] ? parseFloat(m[3]) * 60 : 0));
  if (m[5]) return Math.round(num(m[4]) * 60);
  return Math.round(num(m[6]));
}
function fmtTimerClock(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0")
           : m + ":" + String(s).padStart(2, "0");
}
function fmtTimerShort(sec) {
  if (sec % 3600 === 0) return (sec / 3600) + (sec === 3600 ? " hr" : " hrs");
  if (sec % 60 === 0) return (sec / 60) + " min";
  return sec < 90 ? sec + " sec" : fmtTimerClock(sec);
}
function timerState(id, dur) {
  let t = recipeTimers.get(id);
  if (!t) { t = { dur, endAt: null, remaining: dur, state: "idle" }; recipeTimers.set(id, t); }
  return t;
}
// One chip: label + live clock + a reset ✕ once it's off idle. All state is in
// the class + text; the ticker re-renders the innards of every visible chip.
function timerChipHTML(id, dur, phrase) {
  const t = timerState(id, dur);
  return '<button type="button" class="rt-chip ' + t.state + '" data-rt="' + esc(id) +
    '" data-dur="' + dur + '" title="' +
    (t.state === "idle" ? "Start timer" : t.state === "running" ? "Pause timer"
      : t.state === "paused" ? "Resume timer" : "Timer finished — click to reset") + '">' +
    '<span class="rt-glyph msi">timer</span>' +
    '<span class="rt-label">' + esc(phrase || fmtTimerShort(dur)) + '</span>' +
    '<span class="rt-clock">' + timerClockText(t) + '</span>' +
    (t.state !== "idle" ? '<span class="rt-reset msi" title="Reset">close</span>' : "") +
    "</button>";
}
function timerClockText(t) {
  if (t.state === "idle") return "";
  if (t.state === "done") return "done";
  const left = t.state === "running" ? (t.endAt - Date.now()) / 1000 : t.remaining;
  return fmtTimerClock(left);
}
// Step text with its timer chip inline at the duration phrase (claude.ai style);
// a model-declared timer with no phrase in the text appends the chip at the end.
function stepHTML(rid, idx, step) {
  const text = typeof step === "string" ? step : (step.text || "");
  const declared = typeof step === "object" && step && Number.isFinite(step.timer)
    ? Math.round(step.timer) : null;
  const detected = parseDurationSec(text);
  const dur = declared != null ? declared : detected;
  let html = esc(text);
  if (dur != null && dur >= 5) {
    const id = rid + ":" + idx;
    const re = /(\d+(?:[-–]\d+)?(?:\.\d+)?|\d*[½¼¾])\s*(?:hours?|hrs?|hr|h)\b(?:\s*(?:and\s*)?\d+(?:\.\d+)?\s*(?:minutes?|mins?|min|m)\b)?|(\d+(?:[-–]\d+)?(?:\.\d+)?|\d*[½¼¾])\s*(?:minutes?|mins?|min)\b|\d+(?:[-–]\d+)?\s*(?:seconds?|secs?|sec)\b/i;
    const m = text.match(re);
    if (m) {
      const phraseEsc = esc(m[0]);
      html = html.replace(phraseEsc, timerChipHTML(id, dur, m[0]));
    } else {
      html += " " + timerChipHTML(id, dur, null);
    }
  }
  return html;
}
function ingredientRows(rid, list) {
  let idx = 0, out = "";
  const row = (item) => {
    const key = rid + ":" + idx++;
    const on = recipeChecks.has(key);
    return '<li class="rc-ing' + (on ? " checked" : "") + '" data-ing="' + esc(key) + '">' +
      '<span class="rc-box msi">' + (on ? "check_box" : "check_box_outline_blank") + "</span>" +
      '<span class="rc-ing-text">' + esc(String(item)) + "</span></li>";
  };
  (list || []).forEach((it) => {
    if (it && typeof it === "object" && Array.isArray(it.items)) {
      out += '<li class="rc-group">' + esc(it.group || "") + "</li>" + it.items.map(row).join("");
    } else {
      out += row(it);
    }
  });
  return out;
}
function recipeCardHTML(obj) {
  const rid = recipeSlug(obj.title);
  recipeData.set(rid, obj);
  const time = obj.time || {};
  const meta = [];
  if (obj.serves) meta.push("serves " + obj.serves);
  if (time.prep) meta.push("prep " + time.prep);
  if (time.cook) meta.push("cook " + time.cook);
  if (time.total) meta.push("total " + time.total);
  const steps = (obj.steps || []).map((s, i) =>
    '<li class="rc-step">' + stepHTML(rid, i, s) + "</li>").join("");
  return '<div class="recipe-card" data-rid="' + esc(rid) + '">' +
    '<div class="rc-head">' +
      '<span class="rc-glyph msi">restaurant</span>' +
      '<div class="rc-titles"><div class="rc-title">' + esc(obj.title || "Recipe") + "</div>" +
        (meta.length ? '<div class="rc-meta">' + esc(meta.join(" · ")) + "</div>" : "") + "</div>" +
      '<button type="button" class="rc-cook-btn" data-cook="' + esc(rid) + '">' +
        '<span class="msi">skillet</span> cooking mode</button>' +
    "</div>" +
    '<div class="rc-body">' +
      '<div class="rc-col rc-ings"><div class="rc-col-head">ingredients</div><ul>' +
        ingredientRows(rid, obj.ingredients) + "</ul></div>" +
      '<div class="rc-col rc-steps"><div class="rc-col-head">steps</div><ol>' + steps + "</ol></div>" +
    "</div>" +
    (obj.notes ? '<div class="rc-notes">' + esc(String(obj.notes)) + "</div>" : "") +
  "</div>";
}

/* inline-only formatting, used inside table cells where the block passes don't run */
function inlineMd(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g, '$1<a href="$2">$2</a>');
}
/* split a GFM table row into trimmed cells, tolerating optional edge pipes */
function tableCells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}
/* find GFM tables (header row + |---|---| separator + body) and stash full HTML
   into `sink` (the fence array), returning a numeric placeholder for each */
function extractTables(src, sink) {
  const lines = src.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const sep = lines[i + 1];
    const looksTable =
      lines[i].includes("|") &&
      sep &&
      /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(sep) &&
      tableCells(sep).length > 1 &&
      tableCells(sep).every((c) => /^:?-+:?$/.test(c));
    if (!looksTable) { out.push(lines[i]); continue; }
    const head = tableCells(lines[i]);
    const aligns = tableCells(sep).map((c) => {
      const l = c.startsWith(":"), r = c.endsWith(":");
      return l && r ? "center" : r ? "right" : l ? "left" : "";
    });
    const cell = (tag, text, a) =>
      "<" + tag + (a ? ' style="text-align:' + a + '"' : "") + ">" + inlineMd(text || "") + "</" + tag + ">";
    let j = i + 2;
    let rows = "";
    while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
      const c = tableCells(lines[j]);
      rows += "<tr>" + head.map((_, k) => cell("td", c[k], aligns[k])).join("") + "</tr>";
      j++;
    }
    const thead = "<tr>" + head.map((h, k) => cell("th", h, aligns[k])).join("") + "</tr>";
    // Copy hands back the ORIGINAL markdown rows, not the rendered cells, so a
    // paste into Obsidian/GitHub is the table again rather than mashed text.
    const mdSrc = lines.slice(i, j).join("\n");
    sink.push('<div class="tableblock">' +
      '<button class="copy-btn" type="button" aria-label="Copy table" data-md="' +
        esc(mdSrc) + '">Copy</button>' +
      '<table class="md-table"><thead>' + thead + "</thead><tbody>" + rows +
      "</tbody></table></div>");
    out.push("\0" + (sink.length - 1) + "\0");
    i = j - 1;
  }
  return out.join("\n");
}
function md(src, at) {
  const prev = EMBED_AT;
  EMBED_AT = at ? Number(at) : 0;
  try { return _md(src); } finally { EMBED_AT = prev; }
}
function _md(src) {
  const fences = [];
  src = src.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    let html = null;
    if (lang === "recipe") {
      // A structured recipe renders as an interactive card. A parse failure
      // (malformed JSON) falls through to a plain code block so nothing is lost.
      try { html = recipeCardHTML(JSON.parse(code)); } catch (_) { html = null; }
    }
    fences.push(html ||
      '<div class="codeblock"><button class="copy-btn" type="button" aria-label="Copy code">Copy</button>' +
      `<pre><code>${esc(code)}</code></pre></div>`
    );
    return `  ${fences.length - 1}  `;
  });
  // A recipe still streaming in (unterminated fence at the end) shows a small
  // stub instead of a screenful of raw JSON scrolling by.
  src = src.replace(/```recipe\n[\s\S]*$/, () => {
    fences.push('<div class="recipe-stub"><span class="msi">restaurant</span> plating the recipe\u2026</div>');
    return `  ${fences.length - 1}  `;
  });
  src = extractTables(src, fences);
  src = esc(src);
  src = src
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/^##### (.*)$/gm, "<h5>$1</h5>")
    .replace(/^#### (.*)$/gm, "<h4>$1</h4>")
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/^\s*[-*] (.*)$/gm, "<li>$1</li>")
    // ordered lists: keep the author's numbering via the value attribute
    .replace(/^\s*(\d+)\. (.*)$/gm, '<li class="oli" value="$1">$2</li>')
    // images first, so ![alt](path) isn't half-eaten by the link pass below.
    // Local paths route through /file; click opens a lightbox (see click handler).
    // [^)]+ (not [^)\s]+) so paths with spaces work, e.g. ".../Exobrain harness/...".
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, path) => {
      const src = imgSrc(path);
      if (!src) return m;
      // Corner download button saves the file directly (no lightbox needed).
      const DL = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path fill="currentColor" d="M11 3h2v8.2l3.1-3.1 1.4 1.4L12 15 6.5 9.5l1.4-1.4L11 11.2V3zM5 18h14v2H5z"/></svg>';
      // Generated audio (mist-music) embeds as an inline player + download button.
      // Reuses the .genimg-dl / data-dl contract so the delegated click handler
      // saves it to Downloads with no extra JS. No lightbox: audio has its own controls.
      if (/\.(mp3|wav|m4a|ogg|flac|aac)(\?|$)/i.test(path)) {
        return '<span class="genaudio-wrap">' +
                 '<audio class="genaudio" controls preload="metadata" src="' + src + '"></audio>' +
                 '<button class="genimg-dl genaudio-dl" type="button" data-dl="' + src + '" ' +
                   'title="Save to Downloads" aria-label="Save to Downloads">' + DL + '</button>' +
               '</span>';
      }
      // Video embeds as an inline player; WKWebView plays h264/aac natively.
      if (/\.(mp4|m4v|mov|webm)(\?|$)/i.test(path)) {
        return '<span class="genvideo-wrap">' +
                 '<video class="genvideo" controls preload="metadata" src="' + src + '"></video>' +
                 '<button class="genimg-dl genvideo-dl" type="button" data-dl="' + src + '" ' +
                   'title="Save to Downloads" aria-label="Save to Downloads">' + DL + '</button>' +
               '</span>';
      }
      // Images: local files by extension, plus any http(s) URL (type unknown;
      // <img> was always the behavior for remote embeds).
      if (/\.(png|jpe?g|webp|gif)(\?|$)/i.test(path) || /^https?:/i.test(String(path).trim())) {
        return '<span class="genimg-wrap">' +
                 '<a class="imglink" href="' + src + '" data-full="' + src + '">' +
                   '<img class="genimg" src="' + src + '" alt="' + alt + '" loading="lazy"></a>' +
                 '<button class="genimg-dl" type="button" data-dl="' + src + '" ' +
                   'title="Save to Downloads" aria-label="Save to Downloads">' + DL + '</button>' +
               '</span>';
      }
      // Any other local file: an attachment card. The whole card is the button;
      // click saves to Downloads via the same data-dl contract.
      return '<span class="genfile" role="button" tabindex="0" data-dl="' + src + '" ' +
               'title="Save to Downloads">' +
               '<span class="msi genfile-icon" aria-hidden="true">draft</span>' +
               '<span class="genfile-name">' + esc(fileBaseName(path)) + '</span>' +
               '<span class="genfile-glyph" aria-hidden="true">' + DL + '</span>' +
             '</span>';
    })
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>')
    // blockquotes: each `> line` (the `>` is already escaped to &gt; by now)
    // becomes a one-line <blockquote>; adjacent ones get folded together below
    .replace(/^[ \t]*&gt; ?(.*)$/gm, "<blockquote>$1</blockquote>");
  // autolink bare URLs (those not already inside an href="" or anchor text)
  src = src.replace(
    /(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g,
    '$1<a href="$2">$2</a>'
  );
  src = src.replace(/(<li class="oli"[\s\S]*?<\/li>)/g, "<ol>$1</ol>").replace(/<\/ol>\s*<ol>/g, "");
  src = src.replace(/(<li>[\s\S]*?<\/li>)/g, "<ul>$1</ul>").replace(/<\/ul>\s*<ul>/g, "");
  // fold adjacent blockquote lines into one <blockquote>; a blank `>` line lands
  // as an empty block between two, collapsing to a <br><br> paragraph gap
  src = src.replace(/<\/blockquote>\s*<blockquote>/g, "<br>");
  src = src
    .split(/\n{2,}/)
    .map((p) =>
      /^\s*<(h\d|ul|pre|blockquote)/.test(p) || /^(?:\s*\x00\d+\x00)+\s*$/.test(p)
        ? p
        : `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
  src = src.replace(/ (\d+) /g, (_, i) => fences[+i]);
  return src;
}

function toolSummary(name, input) {
  if (!input || typeof input !== "object") return "";
  if (input.file_path) return input.file_path.split("/").pop();
  if (input.command) return String(input.command).split("\n")[0].slice(0, 70);
  if (input.path) return String(input.path).split("/").pop();
  if (input.pattern) return String(input.pattern);
  if (input.query) return String(input.query).slice(0, 60);
  if (input.url) return String(input.url);
  if (input.todos) return input.todos.length + " item" + (input.todos.length === 1 ? "" : "s");
  try { const s = JSON.stringify(input); return s.length > 70 ? s.slice(0, 70) + "…" : s; }
  catch (_) { return ""; }
}

/* ---------- rich tool-input rendering (diffs, todo lists) ----------
   Matches the TUI: Edit/Write/MultiEdit show a red/green unified diff, TodoWrite
   shows a checklist. Anything else falls back to pretty JSON. */
const DIFF_MAX_LINES = 500;
function diffRowsHTML(oldStr, newStr) {
  const o = String(oldStr == null ? "" : oldStr).split("\n");
  const n = String(newStr == null ? "" : newStr).split("\n");
  // Trim identical leading/trailing lines so only the real change shows.
  let s = 0;
  while (s < o.length && s < n.length && o[s] === n[s]) s++;
  let e = 0;
  while (e < o.length - s && e < n.length - s
         && o[o.length - 1 - e] === n[n.length - 1 - e]) e++;
  const rows = [];
  const ctx = (i, arr) => rows.push(['ctx', ' ', arr[i]]);
  for (let i = Math.max(0, s - 2); i < s; i++) ctx(i, o);            // up to 2 context lines
  for (let i = s; i < o.length - e; i++) rows.push(['del', '-', o[i]]);
  for (let i = s; i < n.length - e; i++) rows.push(['add', '+', n[i]]);
  for (let i = o.length - e; i < Math.min(o.length, o.length - e + 2); i++) ctx(i, o);
  let html = "";
  const shown = rows.slice(0, DIFF_MAX_LINES);
  for (const [cls, sign, text] of shown)
    html += '<div class="dl ' + cls + '"><span class="dg">' + sign + '</span>'
          + esc(text == null ? "" : text) + '</div>';
  if (rows.length > DIFF_MAX_LINES)
    html += '<div class="dl ctx">… ' + (rows.length - DIFF_MAX_LINES) + ' more lines</div>';
  return html;
}
function diffHTMLForTool(name, input) {
  const fp = input.file_path ? '<div class="difffile">' + esc(input.file_path.split("/").pop()) + '</div>' : "";
  if (name === "Write") return fp + '<div class="diff">' + diffRowsHTML("", input.content) + '</div>';
  if (name === "MultiEdit" && Array.isArray(input.edits))
    return fp + input.edits.map((ed) =>
      '<div class="diff">' + diffRowsHTML(ed.old_string, ed.new_string) + '</div>').join("");
  // Edit / NotebookEdit
  return fp + '<div class="diff">'
       + diffRowsHTML(input.old_string, input.new_string != null ? input.new_string : input.new_source) + '</div>';
}
const TODO_GLYPH = {
  completed: '<span class="msi">check_box</span>',
  in_progress: '<span class="msi">play_arrow</span>',
  pending: '<span class="msi">check_box_outline_blank</span>',
};
function todoHTML(todos) {
  return '<div class="todos">' + (todos || []).map((t) => {
    const st = t.status || "pending";
    const g = TODO_GLYPH[st] || TODO_GLYPH.pending;
    return '<div class="todo ' + esc(st) + '"><span class="tg">' + g + '</span>'
         + esc(t.content || t.activeForm || "") + '</div>';
  }).join("") + '</div>';
}
/* Body of a permission card: show what the tool wants to do, richly. */
function permPreview(name, input) {
  try {
    if (name === "ExitPlanMode" && input.plan) return '<div class="md perm-plan">' + md(input.plan) + '</div>';
    if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit")
      return diffHTMLForTool(name, input);
    if (name === "TodoWrite" && Array.isArray(input.todos)) return todoHTML(input.todos);
    if (name === "Bash" && input.command) return '<pre class="perm-cmd">' + esc(input.command) + '</pre>';
  } catch (_) {}
  const sum = toolSummary(name, input);
  return sum ? '<div class="perm-sum">' + esc(sum) + '</div>' : "";
}
/* Fill a live tool card's body with the best rendering for its finalized input. */
function fillToolBody(block, name, input) {
  if (!block || !block.pre || !input || typeof input !== "object") return false;
  try {
    if (name === "TodoWrite" && Array.isArray(input.todos)) {
      block.pre.className = "toolrich"; block.pre.innerHTML = todoHTML(input.todos); return true;
    }
    if ((name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit")
        && (input.content != null || input.old_string != null || input.new_string != null
            || input.new_source != null || Array.isArray(input.edits))) {
      block.pre.className = "toolrich"; block.pre.innerHTML = diffHTMLForTool(name, input); return true;
    }
  } catch (_) {}
  return false;
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

/* A literal, flat pushpin (Material "push_pin", the same icon the Inbox app uses).
   Inline SVG so it needs no icon font; fill:currentColor lets each theme's
   .tpin / .tpin.on color rules tint it. */
const PIN_ICON = '<svg class="pin-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"/></svg>';

/* MIST's mark: the elongated rhombus from the logo. Inline SVG so it needs no
   icon font and `fill:currentColor` lets each context (and theme) tint it. Used
   wherever the app needs to say "this is MIST working" — the thinking spinner
   above all. The rail's status markers get the same silhouette from CSS
   (clip-path), where a background-color already carried the state. */
const MIST_MARK = '<svg class="mist-ico" viewBox="0 0 12 22" aria-hidden="true"><path d="M6 0 12 11 6 22 0 11Z"/></svg>';

/* ---------- MIST's crystal ----------
   The animated crystal (the mist-anims pack, served from static/anims/<look>/<anim>.webp,
   see static/anims/README.md) stands in for the flat rhombus wherever the Console shows
   MIST herself. The header mark reflects the ACTIVE chat: what it is doing (thinking,
   running tools, waiting on a permission card, erroring), what you are doing (typing,
   playing one of her audio replies), and how her last reply felt, read off the kaomoji
   every reply opens with. The spinner glyph and the rail markers reflect each chat's own
   state. The pack is optional: when the files are missing everything keeps the old marks. */
const CRYSTAL_LOOKS = { classic: "Classic", midnight: "Midnight", prism: "Prism", frost: "Frost", ember: "Ember", gold: "Gold", holo: "Hologram" };
const CRYSTAL_ONESHOT_MS = { appear: 1700 };
const EMOTION_HOLD_MS = 10000, TYPING_HOLD_MS = 2500, SLEEP_AFTER_MS = 10 * 60 * 1000;
// kaomoji -> animation, from the faces MIST's persona uses (CLAUDE.md, Tone)
const KAOMOJI = [
  ["happy", ["(◠▽◠)", "(ˆωˆ)", "(>‿<)", "(◠‿O)", "(ᵔwᵔ)", "(´‿`)"]],
  ["curious", ["(o.o)", "(○ ○)", "(・_・)"]],
  ["alert", ["(⊙o⊙)", "(´o`)"]],
  ["confused", ["(ə_e)", "(－_－)", "(￢_￢)"]],
  ["proud", ["(¬‿¬)", "(→_→)"]],
  ["angry", ["(¬_¬)", "(눈_눈)", "(⇀‸↼)", "(>ᴗ<)", "(>_<)", "(`_´)", "(`Д´)", "(＃`皿´)"]],
  ["scared", ["(ó﹏ò)", "(ó︵ò)"]],
  ["sad", ["(´‸`)", "(◞‸◟)", "(;﹏;)", "(T▽T)", "(>×<)"]],
  ["sleeping", ["(－ω－)", "(－o－)"]],
];
const crystal = { look: "classic", on: true, avail: false, header: null, cur: "",
                  emotion: null, emotionAt: 0, typingAt: 0, audioPlaying: 0, lastActivity: Date.now() };
try {
  crystal.look = CRYSTAL_LOOKS[localStorage.getItem("crystalLook")] ? localStorage.getItem("crystalLook") : "classic";
  crystal.on = localStorage.getItem("crystalAnim") !== "0";
} catch (_) {}
const crystalSrc = (anim, look) => "anims/" + (look || crystal.look) + "/" + anim + ".webp";
function crystalEmotionFrom(text) {
  const head = (text || "").trimStart().slice(0, 24);
  for (const [anim, faces] of KAOMOJI) for (const f of faces) if (head.startsWith(f)) return anim;
  if (/^[^\n]{0,12}[♥❤💙💜]/.test(head)) return "love";
  return null;
}
// What the header crystal should be doing right now, in priority order.
function crystalResolve() {
  const s = sessions.get(activeId), now = Date.now();
  if (!s) return { anim: "idle" };
  if (s.permCards && s.permCards.size) return { anim: "alert" };
  if (s.statusState === "error") return { anim: "error", look: "ember" };
  if (s.statusState === "thinking") return { anim: "thinking" };
  if (s.statusState === "working" || s.bgActiveCount() > 0) return { anim: "loading" };
  if (crystal.audioPlaying > 0) return { anim: "speaking" };
  if (now - crystal.typingAt < TYPING_HOLD_MS) return { anim: "listening" };
  if (crystal.emotion && now - crystal.emotionAt < EMOTION_HOLD_MS) return { anim: crystal.emotion };
  if (now - crystal.lastActivity > SLEEP_AFTER_MS) return { anim: "sleeping" };
  return { anim: "idle" };
}
function crystalRefresh() {
  const img = crystal.header, logo = $("#logoImg");
  if (!img) return;
  const show = crystal.avail && crystal.on;
  // style, not the hidden attribute: both marks carry an author display:block that would beat it
  img.style.display = show ? "" : "none"; if (logo) logo.style.display = show ? "none" : "";
  if (!show || crystal._oneshotUntil > Date.now()) return;
  const r = crystalResolve(), src = crystalSrc(r.anim, r.look);
  if (crystal.cur !== src) { crystal.cur = src; img.src = src; img.title = "MIST · " + r.anim; }
}
// Play a one-shot (appear) on the header, then fall back to whatever the state says.
function crystalOneshot(anim) {
  const img = crystal.header;
  if (!img || !crystal.avail || !crystal.on) return;
  crystal.cur = crystalSrc(anim); img.src = crystal.cur; img.title = "MIST";
  crystal._oneshotUntil = Date.now() + (CRYSTAL_ONESHOT_MS[anim] || 2000);
  setTimeout(() => { crystal._oneshotUntil = 0; crystalRefresh(); }, CRYSTAL_ONESHOT_MS[anim] || 2000);
}
// A rail marker (or the phone chip's) for a chat in `state`: the flat rhombus for idle
// chats (there can be a thousand of them), the animated crystal for the few that are live.
function crystalDot(dot, state) {
  const live = crystal.avail && crystal.on && (state === "thinking" || state === "working" || state === "bg" || state === "error");
  let img = dot.querySelector("img");
  if (!live) { if (img) img.remove(); dot.classList.remove("live"); return; }
  const anim = state === "error" ? "error" : state === "thinking" ? "thinking" : "loading";
  const src = crystalSrc(anim, state === "error" ? "ember" : crystal.look);
  if (!img) { img = el("img"); img.alt = ""; img.draggable = false; dot.appendChild(img); }
  dot.classList.add("live");   // every time: setStatus rewrites className around this call
  if (img.getAttribute("src") !== src) img.src = src;
}
function crystalGlyph(state) {
  if (!crystal.avail || !crystal.on) return MIST_MARK;
  return '<img class="crystal-sp" alt="" draggable="false" src="' + crystalSrc(state === "working" ? "loading" : "thinking") + '">';
}
function setCrystalLook(look, on) {
  if (look) crystal.look = CRYSTAL_LOOKS[look] ? look : "classic";
  if (on != null) crystal.on = !!on;
  try { localStorage.setItem("crystalLook", crystal.look); localStorage.setItem("crystalAnim", crystal.on ? "1" : "0"); } catch (_) {}
  crystal.cur = ""; crystalRefresh();
  document.querySelectorAll(".tab .dot, #phoneStatus .ps-dot").forEach((d) => {
    const st = d.classList.contains("bg") ? "bg" : d.classList.contains("thinking") ? "thinking"
      : d.classList.contains("working") ? "working" : d.classList.contains("error") ? "error" : "idle";
    crystalDot(d, st);
  });
  document.querySelectorAll(".spinner .sv-glyph").forEach((g) => { g.innerHTML = crystalGlyph("thinking"); });
  if (typeof renderCrystalList === "function") renderCrystalList();
}
/* ---------- timestamps ---------- */
/* Every message shows the wall-clock time it was sent. ts is epoch ms; live
   messages stamp Date.now(), replayed ones use the server `ts` carried on each
   recorded event. Old pre-feature history has no ts and simply shows no time. */
function fmtClock(ms) {
  const d = new Date(ms);
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return h + ":" + (m < 10 ? "0" + m : m) + " " + ap;
}
// Server events carry `ts` in epoch SECONDS; convert to ms (undefined stays undefined).
function tsMs(sec) { return (sec != null) ? sec * 1000 : undefined; }
function makeTs(ts) {
  const span = el("span", "ts");
  if (ts) {
    span.textContent = fmtClock(ts);
    span.title = new Date(ts).toLocaleString();
  }
  return span;
}

/* ---------- session registry ---------- */
const sessions = new Map();
let activeId = null;
let SPINNER_VERBS = ["Thinking it through, properly"];
let MODELS = [];
let spinnerIdx = 0;
let lastInit = null;
try { lastInit = JSON.parse(localStorage.getItem("lastInit") || "null"); } catch (_) {}

class Session {
  constructor(id, title, info) {
    info = info || {};
    this.id = id;
    this.title = title || "New chat";
    this.pinned = !!info.pinned;
    this.pinOrder = info.pin_order || 0;
    this.model = info.model || "";
    this.permMode = info.permission_mode || "";
    this.effort = info.effort || "";
    this.archived = !!info.archived;   // condensed transcript; the rail folds it
    this.lastActivity = info.last_activity ? info.last_activity * 1000 : Date.now();
    this.logEl = el("div", "session-log");
    this.logEl.hidden = true;
    // Follow the live bottom until the user scrolls up. Once they scroll away
    // from the bottom we stop auto-scrolling and reveal "jump to present";
    // scrolling back to the bottom re-arms following.
    this.stick = true;
    this.logEl.addEventListener("scroll", () => {
      this.stick = this.atBottom();
      if (this.active) { updateJumpBtn(); renderProgDock(); }
    });
    logs.appendChild(this.logEl);
    this.current = null;
    this.blocks = {};
    this.toolInputs = {};
    // FIFO of user-message elements (.msg) awaiting their reply. Each assistant
    // turn slots in right after the oldest unanswered one, so a reply to an
    // earlier message can't land below a message you sent while it was working.
    this.unansweredUsers = [];
    // Set when you interject mid-turn. The CLI often absorbs the interjection
    // into the running turn (one result, more tool calls) instead of starting a
    // new turn; this seals the current bubble so continued output opens a fresh
    // bubble BELOW your message rather than piling above it.
    this.splitPending = false;
    this.init = null;
    this.ctxPct = null;
    this.statusState = "idle";
    this.statusLabel = "idle";
    // Background-task monitor. task_id -> {desc, liveDesc, subagent, lastTool,
    // tokens, toolUses, durationMs, startedAt, status}. Fed by the `system`
    // task_started/task_progress/task_notification/task_updated events the
    // headless stream emits while background agents + `run_in_background` shells
    // run — the data was always in the stream, we just render it now.
    this.bgTasks = new Map();
    // In-place progress bars. bar id -> {el, refs…, data}. Fed by `progress`
    // events (POST /progress/<sid>, usually via the mist-progress CLI). The
    // element is created once per id and MUTATED from then on, so a download
    // that reports 400 times is one line that fills, not 400 lines of log.
    this.progressBars = new Map();
    // tool_use_id -> explicit model override from an Agent tool call's input.
    // task_* events don't carry the model, but they carry the originating
    // tool_use_id — this map joins the two so the monitor can show which
    // model a background agent runs on. No entry = inherited session model.
    this.agentModels = new Map();
    // True while /stream is replaying recorded history. Historical task events
    // resolve to nothing outstanding, so we skip live repaint/flash until the
    // replay_done sentinel, then reconcile once.
    this._replaying = true;
    this.lastUsage = "";
    this.spinnerEl = null;
    this.es = null;
    this.connected = false;
    // NOTE: do NOT connect here. Connecting opens /stream/<id>, which replays
    // this conversation's full transcript into the DOM. At boot we build a
    // Session for every saved chat, so eager-connecting replayed EVERY
    // transcript at once — a synchronous DOM + markdown storm that froze
    // launch. We now connect lazily on first switchTo (see below), so only the
    // chat you're actually looking at gets rendered.
  }

  connect() {
    if (this.connected) return;   // idempotent — first view wins
    this.connected = true;
    if (this.es) this.es.close();
    this.es = new EventSource("/stream/" + this.id);
    this._openCount = 0;
    this.es.onopen = () => {
      // EventSource auto-reconnected (sleep/wake, a network hop, the phone back
      // from the background). The browser sent Last-Event-ID, so the server
      // either resumes (first event "resumed": keep the transcript, the missed
      // events follow as live ones) or replays everything (wipe first). The
      // decision waits for that first event.
      if (this._openCount++) this._pendingReconnect = true;
      // a successful (re)connect clears the sticky "disconnected" badge
      if (this.statusState === "error" && this.statusLabel === "disconnected")
        this.setStatus("idle", "idle");
      if (this.active) shellStream("up");
    };
    this.es.onmessage = (m) => {
      let ev;
      try { ev = JSON.parse(m.data); } catch (_) { return; }
      if (this._pendingReconnect) {
        this._pendingReconnect = false;
        if (ev.type === "resumed") return;   // nothing lost; what was missed streams in next
        this.wipeForReplay();
      }
      try { this.onEvent(ev); } catch (_) {}
    };
    this.es.onerror = () => {
      this.setStatus("error", "disconnected");
      if (this.active) shellStream("down");   // the shell may need to move to another address
    };
  }
  // The transcript is about to be replayed in full: clear everything that
  // lived in the log (a replayed permission/task event must not act as live).
  wipeForReplay() {
    this.logEl.innerHTML = "";
    this.current = null; this.blocks = {}; this.toolInputs = {};
    this.unansweredUsers = []; this.splitPending = false;
    this.spinnerEl = null;               // it lived inside logEl; gone now
    this.bgTasks.clear();
    this.progressBars.clear();   // their elements went with the wiped log
    this.agentModels.clear();    // ditto; entries repopulate from the replay
    if (this.permCards) this.permCards.clear();
    this._replaying = true;
  }
  // Drop the stream and replay the transcript from scratch. Used after a rewind
  // changed what is on disk; the same wipe an auto-reconnect does.
  reload() {
    if (this.es) { this.es.close(); this.es = null; }
    this.connected = false;
    this.logEl.innerHTML = "";
    this.current = null; this.blocks = {}; this.toolInputs = {};
    this.unansweredUsers = []; this.splitPending = false;
    this.spinnerEl = null;
    this.bgTasks.clear(); this.progressBars.clear(); this.agentModels.clear();
    if (this.permCards) this.permCards.clear();
    this._replaying = true;
    this.connect();
  }

  get active() { return this.id === activeId; }

  /* ---- dom helpers (scoped to this tab) ---- */
  atBottom() { return this.logEl.scrollHeight - this.logEl.scrollTop - this.logEl.clientHeight < 60; }
  // Only auto-scroll when we're following the bottom. Pass force=true (user send,
  // tab switch, "jump to present") to re-arm following and snap down regardless.
  scroll(force) {
    if (force) this.stick = true;
    if (this.active && this.stick) this.logEl.scrollTop = this.logEl.scrollHeight;
    if (this.active) updateJumpBtn();
  }
  // ts is epoch ms. Omit it only for old pre-feature history (no recorded time);
  // every live/replayed event now carries one, so those always show a time.
  // afterEl: insert the new message right after this .msg element (used to slot a
  // reply in beside the message it answers). Omitted -> append at the bottom.
  addMsg(role, who, ts, afterEl) {
    const wrap = el("div", "msg " + role);
    const whoEl = el("div", "who");
    whoEl.appendChild(el("span", "whoname", esc(who)));
    whoEl.appendChild(makeTs(ts));
    whoEl.appendChild(this.msgActions(wrap, role));
    wrap.appendChild(whoEl);
    const body = el("div", "body");
    wrap.appendChild(body);
    if (afterEl && afterEl.parentNode === this.logEl) {
      this.logEl.insertBefore(wrap, afterEl.nextSibling);
    } else {
      this.logEl.appendChild(wrap);
    }
    if (this.spinnerEl) this.logEl.appendChild(this.spinnerEl);  // keep spinner last
    this.scroll();
    return body;
  }
  showSpinner() {
    if (!this.spinnerEl) {
      this.spinnerEl = el("div", "spinner",
        '<span class="sv-glyph">' + crystalGlyph(this.statusState) + '</span> <span class="sv"></span>');
    }
    const g = this.spinnerEl.querySelector(".crystal-sp");
    if (g) { const want = crystalSrc(this.statusState === "working" ? "loading" : "thinking"); if (g.getAttribute("src") !== want) g.src = want; }
    this.spinnerEl.querySelector(".sv").textContent =
      (SPINNER_VERBS[spinnerIdx % SPINNER_VERBS.length] || "Thinking") + "…";
    this.logEl.appendChild(this.spinnerEl);   // move to bottom
    this.scroll();
  }
  hideSpinner() {
    if (this.spinnerEl) { this.spinnerEl.remove(); this.spinnerEl = null; }
  }
  notice(text, isErr) {
    this.logEl.appendChild(el("div", "notice" + (isErr ? " err" : ""), esc(text)));
    this.scroll();
  }
  interrupt() {
    // Stop the in-flight turn without killing the process (the TUI's Esc). Safe to
    // call when idle — the backend 409s and nothing changes.
    if (this.statusState !== "thinking" && this.statusState !== "working") return;
    this.setStatus("thinking", "stopping…");
    // Cards are cleared only after the interrupt actually lands: clearing first
    // and then failing left the CLI blocked on a permission request with no UI
    // remaining to answer it.
    fetch("/sessions/" + this.id + "/interrupt", { method: "POST" })
      .then(() => this.clearPermCards())
      .catch(() => {
        // The POST never reached the backend — don't leave "stopping…" stuck.
        if (this.statusLabel === "stopping…") this.setStatus("error", "couldn't stop");
      });
  }
  // Graceful pause: a mid-turn message asks MIST to finish the tool call in
  // flight, write a checkpoint and end the turn (bridge.PAUSE_PROMPT). Unlike
  // interrupt() nothing is cut off, so it lands at the model's next step; if
  // that takes a while, stop is still right there.
  pause() {
    if (this.statusState !== "thinking" && this.statusState !== "working") return;
    if (this.statusLabel === "pausing…") return;
    this.setStatus("working", "pausing…");
    clearTimeout(this._pauseNudge);
    this._pauseNudge = setTimeout(() => {
      if (this.statusLabel === "pausing…")
        this.notice("Still working a minute after the pause request. Stop (Esc) interrupts right away.");
    }, 60000);
    fetch("/sessions/" + this.id + "/pause", { method: "POST" })
      .then((r) => r.json())
      .then((j) => {
        if (j.state === "idle") this.setStatus(this.paused ? "paused" : "idle", this.paused ? "paused" : "idle");
        else if (!j.ok) this.setStatus("error", "couldn't pause");
      })
      .catch(() => { if (this.statusLabel === "pausing…") this.setStatus("error", "couldn't pause"); });
  }
  resume() {
    this.paused = false;
    this.setStatus("thinking", "resuming");
    fetch("/sessions/" + this.id + "/resume", { method: "POST" })
      .then((r) => r.json())
      .then((j) => { if (!j.ok) this.setStatus("error", "couldn't resume"); })
      .catch(() => this.setStatus("error", "couldn't resume"));
  }
  /* ---- per-message actions (claude.ai style) ----
     Hover a message for edit / regenerate / branch / copy. Edit and regenerate
     rewind THIS chat in place (the tail is discarded, after a confirm); branch
     opens a new chat holding the conversation up to that point and leaves this
     one alone. All three ride the CLI's truncating resume (see bridge.rewind). */
  msgActions(wrap, role) {
    const box = el("span", "msg-actions");
    const add = (icon, title, run) => {
      const b = el("button", null, '<span class="msi">' + icon + "</span>");
      b.type = "button";
      b.title = title;
      b.setAttribute("aria-label", title);
      b.addEventListener("click", (e) => { e.stopPropagation(); run(); });
      box.appendChild(b);
    };
    if (role === "user") add("edit", "Edit & resend", () => this.startEdit(wrap));
    add("refresh", role === "user" ? "Resend (regenerate the reply)" : "Regenerate this reply",
        () => this.regenerate(wrap));
    add("call_split", "Branch from here (new chat, this one untouched)", () => this.branchAt(wrap));
    add("content_copy", "Copy message", () => copyText(messageSource(wrap)));
    return box;
  }
  isUserMsg(n) { return !!(n && n.classList && n.classList.contains("msg") && n.classList.contains("user")); }
  userMsgBefore(msg) {
    let n = msg.previousElementSibling;
    while (n && !this.isUserMsg(n)) n = n.previousElementSibling;
    return n;
  }
  // The cut point for a message: a user message's own seq (it and everything
  // after it go); for a MIST reply, the NEXT user message's seq so the reply
  // itself is kept, or Infinity when nothing follows (the whole chat).
  cutSeqFor(msg) {
    if (this.isUserMsg(msg)) {
      const v = parseInt(msg.dataset.seq, 10);
      return Number.isFinite(v) ? v : null;
    }
    let n = msg.nextElementSibling;
    while (n && !this.isUserMsg(n)) n = n.nextElementSibling;
    if (!n) return Infinity;
    const v = parseInt(n.dataset.seq, 10);
    return Number.isFinite(v) ? v : null;
  }
  msgsAfter(msg) {
    let n = msg.nextElementSibling, c = 0;
    while (n) { if (n.classList && n.classList.contains("msg")) c++; n = n.nextElementSibling; }
    return c;
  }
  busy() { return this.statusState === "thinking" || this.statusState === "working"; }
  // Inline yes/no strip under a message, for the one destructive action here.
  confirmOn(msg, text, go) {
    if (msg._confirm) msg._confirm.remove();
    const bar = el("div", "msg-confirm", esc(text));
    const yes = el("button", "perm-btn deny", "Discard & continue");
    const no = el("button", "perm-btn", "Keep");
    const done = () => { bar.remove(); msg._confirm = null; };
    yes.addEventListener("click", () => { done(); go(); });
    no.addEventListener("click", done);
    bar.appendChild(yes); bar.appendChild(no);
    msg.appendChild(bar);
    msg._confirm = bar;
    yes.focus();
  }
  startEdit(msg) {
    if (msg._editing) return;
    if (this.busy()) { this.notice("Stop the running turn first (Esc), then edit."); return; }
    const body = msg.querySelector(".body");
    const orig = msg._utext != null ? msg._utext : (body ? body.innerText : "");
    msg._editing = true;
    const box = el("div", "msg-edit");
    const ta = el("textarea");
    ta.value = orig;
    ta.rows = Math.min(12, Math.max(2, orig.split("\n").length + 1));
    const row = el("div", "perm-actions");
    const save = el("button", "perm-btn allow", "Resend");
    const cancel = el("button", "perm-btn", "Cancel");
    const done = () => { msg._editing = false; box.remove(); if (body) body.hidden = false; };
    cancel.addEventListener("click", done);
    save.addEventListener("click", () => {
      const t = ta.value.trim();
      if (!t) return;
      done();
      this.rewindAt(msg, t);
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(); }
      else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); save.click(); }
    });
    row.appendChild(save); row.appendChild(cancel);
    box.appendChild(ta); box.appendChild(row);
    if (body) body.hidden = true;
    msg.appendChild(box);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
  regenerate(msg) {
    const target = this.isUserMsg(msg) ? msg : this.userMsgBefore(msg);
    if (!target) { this.notice("Nothing to regenerate: there is no message before this one."); return; }
    const body = target.querySelector(".body");
    const text = target._utext != null ? target._utext : (body ? body.innerText.trim() : "");
    if (!text) { this.notice("That message has no text to resend (image-only messages can't be regenerated)."); return; }
    this.rewindAt(target, text);
  }
  async rewindAt(userMsg, text) {
    const seq = this.cutSeqFor(userMsg);
    if (seq == null) { this.notice("This message has no position on disk yet, so it can't be rewound.", true); return; }
    if (this.busy()) { this.notice("Stop the running turn first (Esc), then try again."); return; }
    const post = (body) => fetch("/sessions/" + this.id + "/rewind", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then((r) => r.json());
    let plan;
    try {
      const j = await post({ seq, dry_run: true });
      if (!j.ok) { this.notice("Can't rewind here: " + (j.error || "unknown reason") + ".", true); return; }
      plan = j.plan || {};
    } catch (e) { this.notice("Rewind failed: " + e, true); return; }
    const go = async () => {
      this.setStatus("thinking", "rewinding…");
      try {
        const j = await post({ seq, text });
        if (!j.ok) { this.setStatus("idle", "idle"); this.notice("Rewind failed: " + (j.error || "unknown") + ".", true); return; }
        if (j.title && this.title === "New chat") { this.title = j.title; renderTabs(); }
        this.reload();
        this.setStatus("thinking", "thinking");
      } catch (e) { this.setStatus("idle", "idle"); this.notice("Rewind failed: " + e, true); }
    };
    const later = this.msgsAfter(userMsg);
    if (later > 0) {
      this.confirmOn(userMsg, "This rewinds the chat here: " + later + " later message"
        + (later === 1 ? "" : "s") + " (" + (plan.dropped || 0) + " events) will be discarded "
        + "and MIST forgets them too. Branch first if you want to keep them.", go);
    } else {
      go();
    }
  }
  async branchAt(msg) {
    let seq = this.cutSeqFor(msg);
    if (seq === Infinity) seq = null;              // nothing after it: the whole chat
    if (seq == null && this.isUserMsg(msg)) { this.notice("This message has no position on disk yet, so it can't be branched from.", true); return; }
    try {
      const r = await fetch("/sessions/" + this.id + "/branch", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seq }),
      });
      const j = await r.json();
      if (!j.ok) { this.notice("Can't branch here: " + (j.error || "unknown reason") + ".", true); return; }
      const s = new Session(j.id, j.title, j);
      sessions.set(j.id, s);
      if (this.isUserMsg(msg)) s.draft = msg._utext != null ? msg._utext : "";
      switchTo(j.id);
      s.notice("Branched from “" + this.title + "”. Everything up to that point carries over; the original chat is untouched."
        + (s.draft ? " Your message is in the composer, ready to edit." : ""));
    } catch (e) { this.notice("Branch failed: " + e, true); }
  }
  /* ---- context cost: compaction ---- */
  ctxNotice(text, actions) {
    const n = el("div", "notice", esc(text));
    if (actions && actions.length) {
      const row = el("div", "notice-actions");
      if (actions.includes("compact")) {
        const b = el("button", "perm-btn always", "Compact now");
        b.addEventListener("click", () => { b.disabled = true; this.compact(); });
        row.appendChild(b);
      }
      if (actions.includes("new")) {
        const b = el("button", "perm-btn", "New chat");
        b.addEventListener("click", () => createSession());
        row.appendChild(b);
      }
      n.appendChild(row);
    }
    this.logEl.appendChild(n);
    this.scroll();
  }
  async compact() {
    if (this.busy()) { this.notice("Wait for the current turn to finish, then compact."); return; }
    this.setStatus("thinking", "compacting…");
    try {
      const r = await fetch("/sessions/" + this.id + "/compact", { method: "POST" });
      const j = await r.json();
      if (!j.ok) { this.setStatus("idle", "idle"); this.notice("Couldn't compact: " + (j.error || "unknown") + ".", true); }
    } catch (e) { this.setStatus("idle", "idle"); this.notice("Couldn't compact: " + e, true); }
  }
  renderCompactBoundary(o) {
    const m = o.compact_metadata || {};
    const fmt = (n) => n == null ? "?" : (n >= 1000 ? Math.round(n / 1000) + "k" : String(n));
    let text = "context compacted";
    if (m.trigger) text += " · " + esc(String(m.trigger));
    if (m.pre_tokens != null) text += " · " + fmt(m.pre_tokens) + " → " + fmt(m.post_tokens) + " tokens";
    this.logEl.appendChild(el("div", "compact-divider", text));
    this.scroll();
  }
  /* ---- MCP elicitation: a server asking the user for input ---- */
  renderElicitation(o) {
    if (!this.permCards) this.permCards = new Map();
    if (this.permCards.has(o.request_id)) return;
    const card = el("div", "perm-card elicit");
    const head = el("div", "perm-head");
    head.innerHTML = '<span class="perm-icon msi">contact_support</span> <b>'
      + esc(o.server || "An MCP server") + "</b> needs your input";
    card.appendChild(head);
    const body = el("div", "perm-body q-body");
    if (o.title) body.appendChild(el("div", "q-text", esc(o.title)));
    if (o.message) body.appendChild(el("div", "e-desc", esc(o.message)));
    const fields = [];
    const urlMode = o.mode === "url" && o.url;
    if (urlMode) {
      const f = el("div", "e-field");
      const a = el("a", null, esc(o.url));
      a.href = o.url;
      f.appendChild(a);
      body.appendChild(f);
    } else {
      const props = (o.schema && o.schema.properties) || {};
      const req = new Set((o.schema && o.schema.required) || []);
      Object.keys(props).forEach((k) => fields.push(this._elicitField(k, props[k] || {}, req.has(k), body)));
    }
    card.appendChild(body);
    const row = el("div", "perm-actions");
    const ok = el("button", "perm-btn allow", urlMode ? "Done" : "Submit");
    const decline = el("button", "perm-btn", "Decline");
    const cancel = el("button", "perm-btn deny", "Cancel");
    const finish = (verdict, action, content) => {
      if (card._answered) return;
      card._answered = true;
      card.classList.add("answered");
      row.remove();
      fields.forEach((f) => f.freeze());
      head.appendChild(el("span", "perm-verdict", verdict));
      if (this.permCards) { this.permCards.delete(o.request_id); crystalRefresh(); }
      fetch("/sessions/" + this.id + "/elicitation-response", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: o.request_id, action, content }),
      }).catch(() => {});
    };
    ok.addEventListener("click", () => {
      const content = {};
      for (const f of fields) {
        const v = f.value();
        if (v === "" || v == null) {
          if (f.required) { f.flag(); return; }
          continue;
        }
        content[f.name] = v;
      }
      finish("submitted", "accept", content);
    });
    decline.addEventListener("click", () => finish("declined", "decline"));
    cancel.addEventListener("click", () => finish("cancelled", "cancel"));
    row.appendChild(ok); row.appendChild(decline); row.appendChild(cancel);
    card.appendChild(row);
    (this.current && this.current.body ? this.current.body : this.logEl).appendChild(card);
    this.permCards.set(o.request_id, card); crystalRefresh();
    this.scroll();
  }
  _elicitField(name, schema, required, body) {
    const wrap = el("div", "e-field");
    wrap.appendChild(el("label", null, esc(schema.title || name) + (required ? " *" : "")));
    if (schema.description) wrap.appendChild(el("div", "e-desc", esc(schema.description)));
    const type = schema.type;
    let input;
    if (Array.isArray(schema.enum)) {
      input = el("select");
      if (!required) input.appendChild(el("option", null, ""));
      const names = Array.isArray(schema.enumNames) ? schema.enumNames : null;
      schema.enum.forEach((v, i) => {
        const opt = el("option", null, esc(names && names[i] != null ? String(names[i]) : String(v)));
        opt.value = String(v);
        input.appendChild(opt);
      });
    } else if (type === "boolean") {
      input = el("input"); input.type = "checkbox";
      wrap.classList.add("e-check");
    } else if (type === "number" || type === "integer") {
      input = el("input"); input.type = "number";
      if (type === "integer") input.step = "1";
      if (schema.minimum != null) input.min = schema.minimum;
      if (schema.maximum != null) input.max = schema.maximum;
    } else {
      const long = (schema.maxLength || 0) > 120 || schema.format === "textarea";
      input = el(long ? "textarea" : "input");
      if (!long) input.type = "text";
      else input.rows = 3;
    }
    if (schema.default != null) {
      if (input.type === "checkbox") input.checked = !!schema.default;
      else input.value = String(schema.default);
    }
    wrap.appendChild(input);
    body.appendChild(wrap);
    return {
      name, required,
      value() {
        if (input.type === "checkbox") return input.checked;
        const raw = String(input.value == null ? "" : input.value).trim();
        if (raw === "") return "";
        if (type === "integer") return parseInt(raw, 10);
        if (type === "number") return parseFloat(raw);
        return raw;
      },
      flag() { input.focus(); wrap.classList.add("e-missing"); setTimeout(() => wrap.classList.remove("e-missing"), 1200); },
      freeze() { input.disabled = true; },
    };
  }
  renderPermission(o) {
    if (!this.permCards) this.permCards = new Map();
    if (this.permCards.has(o.request_id)) return;   // dedupe on replay
    const isPlan = o.tool_name === "ExitPlanMode";
    const card = el("div", "perm-card" + (isPlan ? " plan" : ""));
    const head = el("div", "perm-head");
    head.innerHTML = isPlan
      ? '<span class="perm-icon msi">checklist</span> MIST has a plan ready'
      : '<span class="perm-icon msi">gpp_maybe</span> Allow <b>' + esc(o.tool_name || "tool") + '</b>?';
    card.appendChild(head);
    const preview = permPreview(o.tool_name, o.input || {});
    if (preview) { const p = el("div", "perm-body"); p.innerHTML = preview; card.appendChild(p); }
    const row = el("div", "perm-actions");
    const allow = el("button", "perm-btn allow", isPlan ? "Approve & proceed" : "Allow once");
    const always = el("button", "perm-btn always", isPlan ? "Auto-accept edits" : "Allow, don't ask again");
    const deny = el("button", "perm-btn deny", isPlan ? "Keep planning" : "Deny");
    const answer = (decision, remember) => {
      if (card._answered) return;
      card._answered = true;
      card.classList.add("answered");
      row.remove();
      head.appendChild(el("span", "perm-verdict",
        decision === "allow" ? (remember ? "allowed · session" : "allowed") : "denied"));
      if (this.permCards) { this.permCards.delete(o.request_id); crystalRefresh(); }
      fetch("/sessions/" + this.id + "/permission-response", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: o.request_id, decision, remember: !!remember }),
      }).catch(() => {});
    };
    allow.addEventListener("click", () => answer("allow", false));
    always.addEventListener("click", () => answer("allow", true));
    deny.addEventListener("click", () => answer("deny", false));
    row.appendChild(allow);
    if ((o.suggestions || []).length) row.appendChild(always);
    row.appendChild(deny);
    card.appendChild(row);
    (this.current && this.current.body ? this.current.body : this.logEl).appendChild(card);
    this.permCards.set(o.request_id, card); crystalRefresh();
    this.scroll();
    // Focus Allow for keyboard users — but never steal focus from the composer
    // (an invisible focus move made the next Enter answer the card instead of
    // sending the typed message), and never during a history replay.
    setTimeout(() => {
      if (this._replaying || document.activeElement === input) return;
      try { allow.focus(); } catch (_) {}
    }, 0);
  }
  /* AskUserQuestion card: one block per question, "Send answers" / "Dismiss".
     Shares permCards with the permission cards so interrupt / replay treat
     both the same way. */
  renderQuestion(o) {
    if (!this.permCards) this.permCards = new Map();
    if (this.permCards.has(o.request_id)) return;   // dedupe on replay
    const qs = Array.isArray(o.questions) ? o.questions : [];
    const card = el("div", "perm-card question");
    const head = el("div", "perm-head");
    head.innerHTML = '<span class="perm-icon msi">help</span> MIST has '
      + (qs.length === 1 ? "a question" : qs.length + " questions");
    card.appendChild(head);
    const body = el("div", "perm-body q-body");
    const blocks = qs.map((q, i) => this._questionBlock(q, i));
    blocks.forEach((b) => body.appendChild(b.node));
    card.appendChild(body);
    const row = el("div", "perm-actions");
    const send = el("button", "perm-btn allow", "Send answers");
    const dismiss = el("button", "perm-btn deny", "Dismiss");
    const finish = (verdict, payload) => {
      if (card._answered) return;
      card._answered = true;
      card.classList.add("answered");
      row.remove();
      blocks.forEach((b) => b.freeze());
      head.appendChild(el("span", "perm-verdict", verdict));
      if (this.permCards) { this.permCards.delete(o.request_id); crystalRefresh(); }
      fetch("/sessions/" + this.id + "/permission-response", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ request_id: o.request_id }, payload)),
      }).catch(() => {});
    };
    const submit = () => {
      const answers = {};
      blocks.forEach((b) => { const a = b.answer(); if (a) answers[b.question] = a; });
      finish(Object.keys(answers).length ? "answered" : "sent blank",
             { decision: "allow", answers });
    };
    send.addEventListener("click", submit);
    dismiss.addEventListener("click", () => finish("dismissed", { decision: "deny" }));
    // Enter in a one-line field submits; textareas keep Enter for newlines.
    body.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target && e.target.tagName === "INPUT") {
        e.preventDefault();
        submit();
      }
    });
    row.appendChild(send);
    row.appendChild(dismiss);
    card.appendChild(row);
    (this.current && this.current.body ? this.current.body : this.logEl).appendChild(card);
    this.permCards.set(o.request_id, card); crystalRefresh();
    this.scroll();
  }
  /* One question inside a question card. Choice questions get option buttons
     (radio or checkbox semantics per multiSelect) plus an "Other" box so the
     user can type their own answer; kind:"text" gets a textarea; kind:"number"
     a number field honouring min/max/step/defaultValue/unit. answer() returns
     the chosen labels joined with ", ", or the typed text (typed text wins),
     or "" when unanswered. */
  _questionBlock(q, idx) {
    const node = el("div", "q-block");
    const title = el("div", "q-title");
    if (q.header) title.appendChild(el("span", "q-chip", esc(q.header)));
    title.appendChild(el("span", "q-text", esc(q.question || "")));
    node.appendChild(title);
    const hasOpts = Array.isArray(q.options) && q.options.length > 0;
    const kind = q.kind || (hasOpts ? "choice" : "text");
    const multi = !!q.multiSelect;
    const chosen = new Set();
    const opts = [];
    let field = null;
    const paint = () => {
      opts.forEach((o) => {
        const on = chosen.has(o.label);
        o.btn.classList.toggle("on", on);
        o.btn.querySelector(".q-mark").textContent = multi
          ? (on ? "check_box" : "check_box_outline_blank")
          : (on ? "radio_button_checked" : "radio_button_unchecked");
      });
    };
    if (kind === "choice" && hasOpts) {
      const list = el("div", "q-opts");
      q.options.forEach((opt) => {
        const label = typeof opt === "string" ? opt : String(opt.label || "");
        const desc = typeof opt === "string" ? "" : String(opt.description || "");
        const b = el("button", "q-opt");
        b.type = "button";
        b.innerHTML = '<span class="q-mark msi">'
          + (multi ? "check_box_outline_blank" : "radio_button_unchecked") + '</span>'
          + '<span class="q-lab">' + esc(label)
          + (desc ? '<span class="q-desc">' + esc(desc) + '</span>' : "") + '</span>';
        b.addEventListener("click", () => {
          if (node._frozen) return;
          if (multi) { if (chosen.has(label)) chosen.delete(label); else chosen.add(label); }
          else { chosen.clear(); chosen.add(label); }
          if (field) field.value = "";   // a click supersedes typed text
          paint();
        });
        opts.push({ label, btn: b });
        list.appendChild(b);
      });
      node.appendChild(list);
      field = el("input", "q-other");
      field.type = "text";
      field.placeholder = "Other…";
      field.addEventListener("input", () => {
        if (!field.value) return;
        chosen.clear();
        paint();
      });
      node.appendChild(field);
    } else if (kind === "number") {
      field = el("input", "q-num");
      field.type = "number";
      if (q.min != null) field.min = q.min;
      if (q.max != null) field.max = q.max;
      if (q.step != null) field.step = q.step;
      if (q.defaultValue != null) field.value = q.defaultValue;
      const range = [q.min, q.max].filter((v) => v != null);
      if (range.length) field.placeholder = range.join(" to ");
      const wrap = el("div", "q-numwrap");
      wrap.appendChild(field);
      if (q.unit) wrap.appendChild(el("span", "q-unit", esc(String(q.unit))));
      node.appendChild(wrap);
    } else {
      field = el("textarea", "q-textarea");
      field.rows = 2;
      field.placeholder = "Type your answer…";
      node.appendChild(field);
    }
    return {
      node,
      question: q.question || ("Question " + (idx + 1)),
      answer() {
        const typed = field ? String(field.value || "").trim() : "";
        if (typed) return typed;
        return chosen.size ? Array.from(chosen).join(", ") : "";
      },
      freeze() {
        node._frozen = true;
        if (field) field.disabled = true;
        opts.forEach((o) => { o.btn.disabled = true; });
      },
    };
  }
  clearPermCards() {
    if (!this.permCards) return;
    this.permCards.forEach((card) => {
      if (!card._answered) {
        card._answered = true;
        card.classList.add("answered", "stale");
        const row = card.querySelector(".perm-actions");
        if (row) row.remove();
      }
    });
    this.permCards.clear();
    crystalRefresh();
  }
  setStatus(state, label) {
    const busy = state === "thinking" || state === "working";
    if (busy && this.statusState !== state && SPINNER_VERBS.length) {
      spinnerIdx = Math.floor(Math.random() * SPINNER_VERBS.length);  // fresh verb per turn
    }
    this.statusState = state;
    this.statusLabel = label || state;
    if (busy) this.showSpinner(); else this.hideSpinner();
    // the rail rebuilds on its own 1.5 s tick; move this chat's marker now so the state reads at once
    const d = document.querySelector('.tab[data-sid="' + this.id + '"] .dot');
    if (d) { const bg = this.bgActiveCount() > 0; d.className = "dot " + (bg ? "working bg" : state); crystalDot(d, bg ? "bg" : state); }
    if (this.active) applyStatus(this);
  }

  /* ---- background-task monitor ---- */
  bgActiveCount() {
    let n = 0;
    this.bgTasks.forEach((t) => { if (t.status === "running" || t.status === "killing") n++; });
    return n;
  }
  // Handle the `system` task_* subtypes. Returns true if it consumed the event.
  handleBgSystem(o) {
    const sub = o.subtype;
    if (sub === "task_started") {
      this.bgTasks.set(o.task_id, {
        id: o.task_id,
        desc: o.description || "background task",
        liveDesc: o.description || "",
        subagent: o.subagent_type || o.task_type || "",
        lastTool: "", tokens: 0, toolUses: 0, durationMs: 0,
        startedAt: o.ts ? o.ts * 1000 : Date.now(),
        status: "running",
        toolUse: o.tool_use_id || "", isAgent: !!o.subagent_type,
        trail: [], expanded: false, killArm: 0,
      });
      this.bgCountChanged();
      return true;
    }
    if (sub === "task_progress") {
      let t = this.bgTasks.get(o.task_id);
      if (!t) {
        // Reconnecting mid-run: the task_started aged out of / preceded the
        // replay, but the agent is still going. Recreate from this progress tick.
        t = {
          id: o.task_id, desc: o.description || "background task",
          liveDesc: o.description || "", subagent: o.subagent_type || "",
          lastTool: "", tokens: 0, toolUses: 0, durationMs: 0,
          startedAt: o.ts ? o.ts * 1000 : Date.now(), status: "running",
          toolUse: o.tool_use_id || "", isAgent: !!o.subagent_type,
          trail: [], expanded: false, killArm: 0,
        };
        this.bgTasks.set(o.task_id, t);
        this.bgCountChanged();
      }
      if (o.description) {
        t.liveDesc = o.description;
        // Keep a short activity trail for the expanded row view: each distinct
        // step description the agent reports, most recent last.
        if (o.description !== t.desc && o.description !== t.trail[t.trail.length - 1]) {
          t.trail.push(o.description);
          if (t.trail.length > 12) t.trail.shift();
        }
      }
      if (o.last_tool_name) t.lastTool = o.last_tool_name;
      const u = o.usage || {};
      if (u.total_tokens != null) t.tokens = u.total_tokens;
      if (u.tool_uses != null) t.toolUses = u.tool_uses;
      if (u.duration_ms != null) t.durationMs = u.duration_ms;
      if (!this._replaying && this.active) renderBgMonitor();
      return true;
    }
    if (sub === "task_stop_failed") {
      // Our stop_task control request errored (bridge synthesizes this from the
      // control_response). Un-stick the row and say why.
      const t = this.bgTasks.get(o.task_id);
      if (t && t.status === "killing") { t.status = "running"; this.bgCountChanged(); }
      if (!this._replaying) this.notice("Couldn't stop background task: " + (o.error || "unknown error"), true);
      return true;
    }
    if (sub === "task_notification" || sub === "task_updated") {
      const patch = o.patch || {};
      let status = o.status || patch.status;   // "completed" | "failed" | "killed" | "stopped"
      if (status === "stopped") status = "killed";
      const t = this.bgTasks.get(o.task_id);
      if (t && (t.status === "running" || t.status === "killing")
          && (status === "completed" || status === "failed" || status === "killed")) {
        t.status = status;
        if (o.summary) t.summary = o.summary;
        const u = o.usage || {};
        if (u.duration_ms != null) t.durationMs = u.duration_ms;
        if (this._replaying) {
          this.bgTasks.delete(o.task_id);
        } else {
          // Flash the ✓/✗ briefly, then prune so the panel settles back to idle.
          // An expanded row is being read — hold it until it's collapsed.
          this.bgCountChanged();
          const prune = () => {
            const cur = this.bgTasks.get(o.task_id);
            if (cur && cur.expanded) { setTimeout(prune, 6000); return; }
            this.bgTasks.delete(o.task_id); this.bgCountChanged();
          };
          setTimeout(prune, 6000);
        }
      }
      return true;
    }
    return false;
  }
  /* ---- in-place progress bars ---- */
  // One `progress` event = one update to ONE element. The element is created on
  // the first event for an id and only mutated after that, which is the whole
  // point: a long transfer reads as a bar that moves, never as a scroll of ticks
  // and never as a silent wait.
  handleProgress(o) {
    if (!o.id) return;
    let p = this.progressBars.get(o.id);
    if (!p) {
      p = this.makeProgressBar(o);
      this.progressBars.set(o.id, p);
    }
    const d = p.data;
    // Merge, don't replace: a sender that reports `total` once and percentages
    // thereafter shouldn't make the bar forget how big the job is.
    PROG_FIELDS.forEach((k) => { if (o[k] != null) d[k] = o[k]; });
    d.lastTs = tsMs(o.ts) || Date.now();   // for freezing a stale bar's clock
    if (isProgTerminal(d.status)) {
      d.endedAt = d.endedAt || d.lastTs;
      if (d.status === "done") d.pct = 100;
      // The element lives on in the transcript; the MAP entry only exists to
      // route future updates. Once settled (and given a straggler grace), drop
      // it so a long session's map doesn't hold every bar ever shown.
      setTimeout(() => {
        const cur = this.progressBars.get(o.id);
        if (cur === p && isProgTerminal(cur.data.status)) this.progressBars.delete(o.id);
      }, 60000);
    } else {
      d.endedAt = null;      // a "stale" bar that starts moving again is live
    }
    this.paintProgress(p);
    if (this.active && !this._replaying) renderProgDock();
  }
  makeProgressBar(o) {
    const card = el("div", "prog running");
    const head = el("div", "prog-head");
    const glyph = el("span", "prog-glyph msi", "progress_activity");
    const label = el("span", "prog-label");
    const pct = el("span", "prog-pct");
    head.appendChild(glyph); head.appendChild(label); head.appendChild(pct);
    const track = el("div", "prog-track");
    const fill = el("div", "prog-fill");
    track.appendChild(fill);
    const sub = el("div", "prog-sub");
    card.appendChild(head); card.appendChild(track); card.appendChild(sub);
    // Anchor the bar where the work was started: inside the reply that's running
    // when there is one, else at the bottom of the transcript (a bar can also
    // come from a background job with no turn in flight).
    if (this.current && this.current.body) {
      this.current.body.appendChild(card);
    } else {
      this.logEl.appendChild(card);
      if (this.spinnerEl) this.logEl.appendChild(this.spinnerEl);   // spinner stays last
    }
    this.scroll();
    return { el: card, glyph, label, pct, track, fill, sub,
             data: { id: o.id, status: "running", startedAt: tsMs(o.ts) || Date.now(),
                     endedAt: null } };
  }
  paintProgress(p) {
    const d = p.data;
    const live = d.status === "running";
    const indet = live && d.pct == null;
    p.el.className = "prog " + d.status + (indet ? " indet" : "");
    p.glyph.textContent = PROG_GLYPH[d.status] || "progress_activity";
    p.label.textContent = d.label || "working";
    p.pct.textContent = d.pct != null ? Math.round(d.pct) + "%" : "";
    // An indeterminate bar still fills its track — the motion (or, under reduced
    // motion, the hatching) is what carries "alive", not the width.
    p.fill.style.width = (indet ? 100 : clampPct(d.pct)) + "%";
    p.sub.textContent = progSubline(d);
  }
  // Replay finished and this bar never reached a terminal state — the app was
  // closed or the process died mid-transfer, so its end was never recorded.
  // Say that plainly instead of leaving a bar that looks like it's still running.
  markStaleProgress() {
    this.progressBars.forEach((p) => {
      if (p.data.status === "running") {
        p.data.status = "stale";
        // Freeze the clock at the last event we actually saw. Leaving endedAt
        // null let progSubline fall through to Date.now(), so a bar interrupted
        // yesterday replayed as "15h elapsed" — wall-clock since it started,
        // app-closed time included, on a bar that ran for seconds.
        p.data.endedAt = p.data.lastTs || p.data.startedAt;
        this.paintProgress(p);
      }
    });
  }
  // A task appeared or reached a terminal state: repaint everything that counts
  // background tasks (the monitor panel, the status badge, the tab dots).
  bgCountChanged() {
    if (this._replaying) return;
    if (this.active) { renderBgMonitor(); applyStatus(this); }
    renderTabs();
  }

  /* ---- assistant turn ---- */
  // Where a reply slots in. Everything still unanswered when a turn BEGINS is
  // answered by that one turn — the CLI coalesces messages sent back to back
  // before it starts working — so the reply belongs after the LAST of them, and
  // the whole queue is spent. Anchoring on the oldest instead (which this did)
  // inserted the reply between two messages sent in quick succession, leaving
  // the second one stranded below it at the bottom of the transcript.
  // Messages sent *during* a turn never reach this queue; they take the
  // interjection path in the user_text handler.
  takeAnchor() {
    const anchor = this.unansweredUsers.length
      ? this.unansweredUsers[this.unansweredUsers.length - 1] : null;
    this.unansweredUsers = [];
    return anchor;
  }
  beginAssistant(ts) {
    this.current = { body: this.addMsg("mist", "MIST", tsMs(ts), this.takeAnchor()) };
    this.blocks = {};
    this.toolInputs = {};
  }
  // Called at each new content block. If you interjected mid-turn, seal the
  // current bubble and open a fresh one at the bottom so this turn's remaining
  // output lands below your message instead of above it. The pending
  // interjections are now visually answered by the continuation, so clear the
  // anchor queue (an absorbed interjection gets no separate turn of its own).
  maybeSplit(ts) {
    if (!this.splitPending || !this.current) return;
    this.splitPending = false;
    this.unansweredUsers = [];
    this.current = { body: this.addMsg("mist", "MIST", tsMs(ts)) };
    this.blocks = {};
    this.toolInputs = {};
  }
  makeToolCard(name) {
    const card = el("details", "tool");     // collapsed by default; click to expand
    const head = el("summary", "tool-head");
    head.appendChild(el("span", "tname", esc(name || "tool")));
    const summary = el("span", "tsummary", "");
    head.appendChild(summary);
    const st = el("span", "tstate", "running…");
    head.appendChild(st);
    card.appendChild(head);
    const pre = el("pre");
    card.appendChild(pre);
    this.current.body.appendChild(card);
    return { type: "tool", el: card, pre, state: st, summary, name };
  }
  finalizeToolInputs(message) {
    (message.content || []).forEach((c, i) => {
      if (c.type !== "tool_use") return;
      if ((c.name === "Agent" || c.name === "Task") && c.input && c.input.model) {
        this.agentModels.set(c.id, c.input.model);   // for the bg-task monitor
      }
      // A block's stream index IS its position in the finalized content array,
      // so this is an exact join. The old approach scanned by NAME and filled
      // every not-done match: two parallel calls to the same tool (two Bash
      // reads side by side — routine) both ended up showing the second call's
      // input and carrying its id, which also dropped the first call's result.
      let b = this.blocks[i];
      if (!(b && b.type === "tool" && b.name === c.name && b.pre && !b.done)) {
        // Defensive fallback if indexes ever misalign: first unclaimed match
        // by name, and only that one.
        b = null;
        for (const idx in this.blocks) {
          const cand = this.blocks[idx];
          if (cand.type === "tool" && cand.name === c.name && cand.pre
              && !cand.done && !cand.id) { b = cand; break; }
        }
        if (!b) return;
      }
      // Diff for Edit/Write/MultiEdit, checklist for TodoWrite, else pretty JSON.
      if (!fillToolBody(b, c.name, c.input)) {
        b.pre.className = "";
        try { b.pre.textContent = JSON.stringify(c.input, null, 2); } catch (_) {}
      }
      if (b.summary) b.summary.textContent = toolSummary(c.name, c.input);
      b.id = c.id;
    });
  }
  applyToolResults(message) {
    (message.content || []).forEach((c) => {
      if (c.type !== "tool_result") return;
      for (const idx in this.blocks) {
        const b = this.blocks[idx];
        if (b.type === "tool" && b.id === c.tool_use_id && !b.done) {
          b.done = true;
          b.state.textContent = c.is_error ? "error" : "done";
          if (c.is_error) b.state.style.color = "var(--err)";
          let txt = c.content;
          if (Array.isArray(txt)) txt = txt.map((p) => p.text || "").join("");
          b.el.appendChild(el("pre", "tool-result", esc(String(txt || "").slice(0, 6000))));
        }
      }
    });
  }
  handleStreamEvent(ev) {
    const e = ev.event;
    if (!e) return;
    if (e.type === "message_start") {
      if (!this.current) this.beginAssistant(ev.ts);
    } else if (e.type === "content_block_start") {
      this.maybeSplit(ev.ts);
      const idx = e.index, cb = e.content_block || {};
      if (cb.type === "thinking") {
        const d = el("details", "think");
        d.appendChild(el("summary", null, "thinking"));
        const tb = el("div", "think-body");
        d.appendChild(tb);
        this.current.body.appendChild(d);
        this.blocks[idx] = { type: "thinking", el: tb };
      } else if (cb.type === "text") {
        // Each text block gets its own div, appended at its real stream
        // position, so text interleaves correctly with tool/thinking cards
        // and the final summary lands last instead of buried up top.
        const te = el("div", "md");
        this.current.body.appendChild(te);
        this.blocks[idx] = { type: "text", el: te, text: "", ts: ev.ts };
      } else if (cb.type === "tool_use") {
        this.blocks[idx] = this.makeToolCard(cb.name);
        this.toolInputs[idx] = "";
      }
    } else if (e.type === "content_block_delta") {
      const b = this.blocks[e.index], d = e.delta || {};
      if (!b) return;
      if (d.type === "thinking_delta") b.el.textContent += d.thinking || "";
      else if (d.type === "text_delta") {
        b.text += d.text || "";
        // Throttle: md() over the WHOLE accumulated text on every few-char delta
        // is quadratic and was the WebContent memory balloon (2026-08-14, 34GB).
        // Coalesce to one re-render per 150ms; content_block_stop still does the
        // final exact render.
        if (!b._mdTimer) {
          b._mdTimer = setTimeout(() => {
            b._mdTimer = null;
            b.el.innerHTML = md(b.text, b.ts) + '<span class="cursor">&nbsp;</span>';
            b.el._mdsrc = b.text;
            this.scroll();
          }, 150);
        }
      } else if (d.type === "input_json_delta") {
        this.toolInputs[e.index] += d.partial_json || "";
        b.pre.textContent = this.toolInputs[e.index];
      }
    } else if (e.type === "content_block_stop") {
      const b = this.blocks[e.index];
      if (b && b.type === "text") {
        if (b._mdTimer) { clearTimeout(b._mdTimer); b._mdTimer = null; }
        b.el.innerHTML = md(b.text || "", b.ts); b.el._mdsrc = b.text || "";
        if (!this._replaying) { const em = crystalEmotionFrom(b.text); if (em) this.emotion = em; }
      } else if (b && b.type === "thinking" && !b.el.textContent.trim()) {
        // Thinking arrived with empty text (display "omitted" — the model
        // default before we opted into "summarized", still replayed from old
        // chats). A hollow THINKING card is noise; drop it.
        const card = b.el.closest("details.think");
        if (card) card.remove();
      }
    }
    this.scroll();
  }

  /* render a complete (imported) MIST message from normalized blocks */
  renderHistMsg(blocks, ts) {
    const body = this.addMsg("mist", "MIST", tsMs(ts), this.takeAnchor());
    blocks.forEach((b) => {
      if (b.kind === "text") {
        const tdiv = el("div", "md", md(b.text, ts));
        tdiv._mdsrc = b.text || "";   // raw source for "copy message", kept off the DOM
        body.appendChild(tdiv);
      } else if (b.kind === "thinking") {
        const d = el("details", "think");
        d.appendChild(el("summary", null, "thinking"));
        const tb = el("div", "think-body");
        tb.textContent = b.text;
        d.appendChild(tb);
        body.appendChild(d);
      } else if (b.kind === "tool") {
        const card = el("details", "tool");
        const head = el("summary", "tool-head");
        head.appendChild(el("span", "tname", esc(b.name || "tool")));
        head.appendChild(el("span", "tsummary", esc(toolSummary(b.name, b.input))));
        head.appendChild(el("span", "tstate", b.result ? "done" : ""));
        card.appendChild(head);
        const pre = el("pre");
        try { pre.textContent = JSON.stringify(b.input, null, 2); }
        catch (_) { pre.textContent = String(b.input); }
        card.appendChild(pre);
        if (b.result) card.appendChild(el("pre", "tool-result", esc(String(b.result).slice(0, 6000))));
        body.appendChild(card);
      }
    });
    this.scroll();
  }

  onEvent(o) {
    switch (o.type) {
      case "user_text": {
        // Always render immediately so a message can never get swallowed.
        const ubody = this.addMsg("user", "Alex", tsMs(o.ts));
        ubody.textContent = o.text;
        if (o.kind) ubody.parentNode.classList.add("ctl", "ctl-" + o.kind);   // pause / resume chip
        if (o.kind !== "pause") this.paused = false;
        // Position + raw text, for edit / regenerate / branch (see msgActions).
        if (o.seq != null) ubody.parentNode.dataset.seq = o.seq;
        ubody.parentNode._utext = o.text || "";
        if (o.image) {
          const html = imageThumbHTML(o.image, "pasted image");
          if (html) {
            const wrap = el("div", "user-img");
            wrap.innerHTML = html;
            ubody.appendChild(wrap);
          }
        }
        if (this.current) {
          // Mid-turn interjection. Put the turn's *continued* output BELOW this
          // message so the transcript reads in the order things happened, rather
          // than letting the running bubble keep growing above the interjection.
          let live = null;   // a text block streaming right this instant (still shows the cursor)
          for (const i in this.blocks) {
            const b = this.blocks[i];
            if (b && b.type === "text" && b.el.querySelector(".cursor")) { live = b; break; }
          }
          if (live) {
            // Interjected mid-paragraph: freeze the text written so far in place
            // (it stays above the message), then continue this same text block in a
            // fresh bubble below the message with a clean buffer.
            live.el.innerHTML = md(live.text || "", live.ts);
            live.el._mdsrc = live.text || "";
            this.current = { body: this.addMsg("mist", "MIST", tsMs(o.ts)) };
            const te = el("div", "md");
            this.current.body.appendChild(te);
            live.el = te; live.text = "";
            this.splitPending = false;
          } else {
            // Interjected between blocks: let the next content block open the new
            // bubble (lazy, so the turn ending right here can't leave a stray empty
            // bubble). The user message is already at the bottom; the continuation
            // lands beneath it. See maybeSplit.
            this.splitPending = true;
          }
        } else {
          // Sent while idle: record it as awaiting a reply so the reply slots in
          // right after it (beginAssistant uses this as its anchor).
          this.unansweredUsers.push(ubody.parentNode);
        }
        break;
      }
      case "mist_msg":
        this.renderHistMsg(o.blocks || [], o.ts);
        break;
      case "system":
        if (o.subtype === "init") {
          this.init = o;
          // The init event reports the mode the process actually launched with —
          // authoritative, so sync our tracked value to it.
          if (o.permissionMode) this.permMode = o.permissionMode;
          // Only a LIVE init updates the global capability snapshot (slash menu,
          // settings panel). Replayed inits are historical — opening a dormant
          // chat used to overwrite lastInit (and persist it) with a weeks-old
          // tool/command list from whatever cwd that chat ran in.
          if (!this._replaying) {
            lastInit = {
              model: o.model, permissionMode: o.permissionMode, tools: o.tools,
              mcp_servers: o.mcp_servers, skills: o.skills, slash_commands: o.slash_commands,
            };
            try { localStorage.setItem("lastInit", JSON.stringify(lastInit)); } catch (_) {}
          }
          if (this.active) fillCaps(o, this);
          if (!this.current) this.setStatus("idle", "idle");
        }
        else if (o.subtype === "status" && o.status === "requesting") this.setStatus("thinking", "thinking");
        else if (o.subtype === "status" && o.status === "compacting") this.setStatus("thinking", "compacting…");
        else if (o.subtype === "compact_boundary") this.renderCompactBoundary(o);
        else this.handleBgSystem(o);   // task_started / task_progress / task_notification / task_updated
        break;
      case "replay_done":
        // History fully replayed; go live. Any task still "running" now is stale
        // (its completion was never recorded — e.g. the app closed mid-run, or the
        // backend is dormant), so drop it. A genuinely-live task re-appears from
        // its next task_progress tick (handleBgSystem recreates on unknown id).
        this._replaying = false;
        this.bgTasks.forEach((t, id) => { if (t.status === "running" || t.status === "killing") this.bgTasks.delete(id); });
        this.markStaleProgress();
        if (this.active) { renderBgMonitor(); applyStatus(this); renderProgDock(); }
        renderTabs();
        // a boot greeting parked during the replay lands at the real bottom
        if (this._pendingGreeting) {
          const txt = this._pendingGreeting;
          this._pendingGreeting = null;
          const body = this.addMsg("mist", "MIST", Date.now());
          body.innerHTML = '<em class="greet">' + esc(txt) + "</em>";
        }
        break;
      case "stream_event":
        if (o.event && o.event.type === "message_start") this.setStatus("working", "responding");
        this.handleStreamEvent(o);
        break;
      case "assistant":
        if (!this.current) this.beginAssistant(o.ts);
        this.finalizeToolInputs(o.message || {});
        break;
      case "user":
        this.applyToolResults(o.message || {});
        break;
      case "context":
        this.ctxPct = o.pct;
        this.ctxUsed = o.used;
        this.ctxWindow = o.window;
        if (this.active) setCtxBadge(o.pct, o.used, o.window);
        break;
      case "context_warning":
        // Cost cap (bridge.py): conversation large enough that re-billing the
        // whole window each turn is wasteful. Inline notice with the fixes
        // (compact here, or a new chat) as buttons; a replayed one is history,
        // so no buttons then.
        this.ctxNotice(o.text, this._replaying ? null : o.actions);
        break;
      case "elicitation_request":
        // An MCP server asking the user for input: a schema-driven form card.
        this.renderElicitation(o);
        break;
      case "notice":
        // Out-of-band message from the backend (e.g. /login auth flow progress).
        this.notice(o.text, !!o.err);
        break;
      case "permission_request":
        // The CLI is asking to run a tool in a non-bypass mode: render an
        // Allow / Allow-for-session / Deny card the user answers.
        this.renderPermission(o);
        break;
      case "question_request":
        // AskUserQuestion in a non-bypass mode: a form card whose answers go
        // back to the CLI inside the same permission-response channel.
        this.renderQuestion(o);
        break;
      case "progress":
        // A download/upload/install reporting itself. Same id = same element.
        this.handleProgress(o);
        break;
      case "status_idle":
        // An out-of-band action (auth flow) finished; clear the thinking spinner.
        this.setStatus("idle", "idle");
        break;
      case "paused":
        // The turn ended on a pause request; the composer offers resume.
        this.paused = true;
        clearTimeout(this._pauseNudge);
        this.setStatus("paused", "paused");
        break;
      case "rate_limit_event":
        // account-wide live 5h/7d reset + status — update the badges regardless
        // of which session it arrived on
        applyRateEvent(o.rate_limit_info);
        break;
      case "result":
        this.current = null;
        if (!this._replaying && this.emotion) {   // how the reply felt: the header crystal acts it out for a moment
          if (this.active) { crystal.emotion = this.emotion; crystal.emotionAt = Date.now(); }
          this.emotion = null;
        }
        crystal.lastActivity = Date.now();
        this.splitPending = false;   // turn over; any unanswered interjection gets its own turn
        this.clearPermCards();       // any unanswered permission cards are moot now
        clearTimeout(this._pauseNudge);
        this.lastUsage = usageText(o);
        if (this.active) $("#usage").textContent = this.lastUsage;
        // A turn just finished, so the usage may have moved — refresh the 5h/7d
        // badges right away instead of waiting for the next poll tick. Live only:
        // replaying a long chat used to fire one fetch per historical turn, and a
        // wake-up reconnect replays EVERY viewed tab at once.
        if (!this._replaying && typeof pollUsage === "function") pollUsage();
        // Surface usage/session-limit and other error results (is_error) the way
        // the CLI does, instead of ending the turn with a blank message.
        if (o.is_error) {
          this.setStatus("error", "error");
          const msg = o.result || "Claude ended the turn with an error.";
          this.notice(msg, true);
          // If the failure looks like an expired/missing session, point the user
          // at /login (which the Console now handles out of band).
          if (/log ?in|sign ?in|\bauth|credential|401|unauthor|expired|api key/i.test(msg))
            this.notice("It looks like MIST needs to sign in. Type /login to authenticate.");
        } else if (this.paused) {
          this.setStatus("paused", "paused");
        } else {
          this.setStatus("idle", "idle");
        }
        break;
      case "stderr":
        if (/error|fatal|exception/i.test(o.text)) this.notice("stderr: " + o.text, true);
        break;
      case "process_exit":
        this.setStatus("error", "exited");
        this.clearPermCards();
        this.notice("Claude process exited (code " + o.code + ").", true);
        break;
    }
  }

  // Put an undelivered draft back where the user can see it: the live composer
  // if this chat is still active, else this chat's saved draft (so switching
  // chats mid-flight can't clobber the other chat's composer).
  restoreDraft(text, image) {
    if (this.active) {
      // Never clobber typing that happened after the send: a held/failed send
      // restoring "over" the next message in progress silently destroyed it.
      // If the composer has newer text, put the failed message back in front.
      const cur = input.value;
      input.value = cur && cur !== text ? (text || "") + (text ? "\n" : "") + cur
                                        : (text || "");
      if (image) setPendingImage(image);
      input.dispatchEvent(new Event("input"));   // re-grow the textarea
    } else {
      this.draft = this.draft && this.draft !== text
        ? (text || "") + (text ? "\n" : "") + this.draft : (text || "");
      if (image) this.draftImage = image;
    }
  }
  async send(text, image, restoreOnFail = true) {
    // The user bubble is rendered from the broadcast user_text event (so it
    // also appears on replay); don't add it optimistically here.
    this.stick = true;   // sending always returns us to the live bottom
    this.setStatus("thinking", "thinking");
    this.lastActivity = Date.now();
    renderTabs();
    try {
      const r = await fetch("/send/" + this.id, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, image: image || undefined }),
      });
      const j = await r.json();
      if (j.held) {
        // Context-cost cap held this send. Restore the user's text + attachment
        // (both cleared optimistically) so nothing is lost, drop back to idle, and
        // explain. The next send overrides the cap on the backend.
        this.restoreDraft(text, image);
        this.setStatus("idle", "idle");
        this.ctxNotice(j.reason, ["compact", "new"]);
        return false;
      }
      if (!j.ok) {
        this.notice("Could not deliver message to Claude.", true);
        if (restoreOnFail) this.restoreDraft(text, image);
      }
      if (j.title && this.title === "New chat") { this.title = j.title; renderTabs(); }
      return !!j.ok;
    } catch (err) {
      // Backend unreachable: nothing was queued and no user_text event will ever
      // render this message — put the draft back instead of silently eating it.
      this.notice("Send failed: " + err, true);
      if (restoreOnFail) this.restoreDraft(text, image);
      this.setStatus("idle", "idle");
      return false;
    }
  }

  destroy() {
    if (this.es) this.es.close();
    this.logEl.remove();
  }
}

/* ---------- top-bar reflectors (active session) ---------- */
function applyStatus(s) {
  const n = s.bgActiveCount();
  if (n > 0) {
    // Keep the badge lit while background work runs, even when the foreground
    // turn has ended — this is the "chat looks idle but agents are running" fix.
    statusEl.dataset.state = "working";
    const fg = (s.statusState === "thinking" || s.statusState === "working")
      ? s.statusLabel + " · " : "";
    statusEl.textContent = fg + "⚙ " + n + " running";
  } else {
    statusEl.dataset.state = s.statusState;
    statusEl.textContent = s.statusLabel;
  }
  if (s.statusState === "thinking" || s.statusState === "working" || n > 0) crystal.lastActivity = Date.now();
  crystalRefresh();
  if (typeof reflectSend === "function") reflectSend();
}

/* ---------- in-place progress bars ----------
   The element that answers "is this alive, and how far along?" for downloads,
   uploads, installs, and any other wait a script reports. Backed by
   POST /progress/<sid> (see app.py) — usually driven by bin/mist-progress. */
const PROG_FIELDS = ["label", "detail", "rate", "unit", "pct", "current", "total",
                     "eta", "status"];
const PROG_GLYPH = { running: "progress_activity", done: "check", error: "close",
                     canceled: "block", stale: "pause" };
function isProgTerminal(s) { return s === "done" || s === "error" || s === "canceled"; }
function clampPct(v) { return Math.max(0, Math.min(100, v == null ? 0 : v)); }
function fmtBytes(n) {
  if (n == null) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return (i === 0 ? Math.round(n) : n.toFixed(n < 10 ? 1 : 0)) + " " + u[i];
}
function fmtCount(n) {
  if (n == null) return "";
  return n >= 1000 ? Math.round(n).toLocaleString() : String(Math.round(n * 100) / 100);
}
// The line under the bar: how much of what, how fast, how long left, how long
// it's been. Everything here is optional — a sender that knows only a label
// still gets an honest "elapsed" clock rather than a blank.
function progSubline(d) {
  const bits = [];
  if (d.total != null && d.current != null) {
    bits.push(d.unit === "bytes"
      ? fmtBytes(d.current) + " / " + fmtBytes(d.total)
      : fmtCount(d.current) + " / " + fmtCount(d.total));
  }
  if (d.rate && d.status === "running") bits.push(d.rate);
  if (d.eta != null && d.status === "running") bits.push("~" + fmtBgDur(d.eta) + " left");
  const end = d.endedAt || Date.now();
  bits.push(fmtBgDur((end - d.startedAt) / 1000) + (d.status === "running" ? " elapsed" : ""));
  if (d.status === "error") bits.push("failed");
  if (d.status === "canceled") bits.push("canceled");
  if (d.status === "stale") bits.push("interrupted — never finished");
  if (d.detail) bits.push(d.detail);
  return bits.join(" · ");
}
// Repaint live bars so their elapsed clock (and indeterminate motion) stay true
// even when no update has arrived for a while — a stalled transfer should look
// stalled, not frozen at a stale number.
setInterval(() => {
  const s = activeId && sessions.get(activeId);
  if (!s || !s.progressBars.size) return;
  let live = false;
  s.progressBars.forEach((p) => {
    if (p.data.status === "running") { s.paintProgress(p); live = true; }
  });
  if (live) renderProgDock();
}, 1000);

// The dock: a compact echo of any RUNNING bar whose real element is scrolled out
// of view. Scroll up to read something mid-download and the bar follows you as a
// one-liner above the composer instead of vanishing. Nothing shows while the
// real bar is on screen — no double-reporting.
function progVisible(el, scroller) {
  const a = el.getBoundingClientRect(), b = scroller.getBoundingClientRect();
  return a.bottom > b.top + 4 && a.top < b.bottom - 4;
}
function renderProgDock() {
  const dock = $("#progDock");
  if (!dock) return;
  const s = activeId && sessions.get(activeId);
  const rows = [];
  if (s) {
    s.progressBars.forEach((p) => {
      if (p.data.status !== "running") return;
      if (p.el.isConnected && progVisible(p.el, s.logEl)) return;
      rows.push(p);
    });
  }
  if (!rows.length) { dock.hidden = true; dock.innerHTML = ""; return; }
  dock.innerHTML = "";
  rows.slice(0, 3).forEach((p) => {
    const d = p.data;
    const row = el("div", "pd-row" + (d.pct == null ? " indet" : ""));
    row.appendChild(el("span", "pd-glyph msi", "progress_activity"));
    const main = el("div", "pd-main");
    const top = el("div", "pd-top");
    top.appendChild(el("span", "pd-label", esc(d.label || "working")));
    top.appendChild(el("span", "pd-pct", d.pct != null ? Math.round(d.pct) + "%" : ""));
    main.appendChild(top);
    const track = el("div", "pd-track");
    const fill = el("div", "pd-fill");
    fill.style.width = (d.pct == null ? 100 : clampPct(d.pct)) + "%";
    track.appendChild(fill);
    main.appendChild(track);
    row.appendChild(main);
    row.title = "Jump to this progress bar";
    row.addEventListener("click", () => {
      p.el.scrollIntoView({ block: "center",
                            behavior: reduceMotion() ? "auto" : "smooth" });
      renderProgDock();
    });
    dock.appendChild(row);
  });
  if (rows.length > 3) dock.appendChild(el("div", "pd-more", "+" + (rows.length - 3) + " more"));
  dock.hidden = false;
}
// Alex runs macOS Reduce Motion, so treat "animate it" as the exception, not the
// default: the CSS drops the sweep for an indeterminate bar and this drops the
// smooth scroll.
function reduceMotion() {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
  catch (_) { return false; }
}

/* ---------- background-task monitor panel ---------- */
function fmtBgDur(secs) {
  secs = Math.max(0, Math.round(secs));
  if (secs < 60) return secs + "s";
  const m = Math.floor(secs / 60), s = secs % 60;
  if (m < 60) return m + "m" + String(s).padStart(2, "0") + "s";
  const h = Math.floor(m / 60);
  return h + "h" + String(m % 60).padStart(2, "0") + "m";
}
function fmtBgTokens(t) {
  if (!t) return "";
  return t >= 1000 ? (t / 1000).toFixed(t >= 10000 ? 0 : 1) + "k tok" : t + " tok";
}
// Which model a background agent runs on: the Agent call's explicit override
// when there was one, else the session model it inherited (per the init
// event, which reports what the process actually launched with).
function bgTaskModel(s, t) {
  if (!t.isAgent) return "";
  const m = s.agentModels.get(t.toolUse)
    || (s.init && s.init.model) || s.model || "";
  return String(m).replace(/^claude-/, "");
}
// Collapsed-to-the-right state for the background-task panel. Mirrors the tab
// rail's collapse: persisted in localStorage so it survives reloads, and left
// alone when new tasks arrive (respect the user's tuck, don't pop back open).
let bgCollapsed = false;
try { bgCollapsed = localStorage.getItem("bgCollapsed") === "1"; } catch (_) {}
function setBgCollapsed(v) {
  bgCollapsed = v;
  try { localStorage.setItem("bgCollapsed", v ? "1" : "0"); } catch (_) {}
  renderBgMonitor();
}
function renderBgMonitor() {
  const panel = $("#bgMonitor");
  if (!panel) return;
  const s = activeId && sessions.get(activeId);
  const tasks = s ? [...s.bgTasks.values()] : [];
  if (!tasks.length) { panel.hidden = true; panel.innerHTML = ""; panel.classList.remove("collapsed"); return; }
  const isLive = (t) => t.status === "running" || t.status === "killing";
  // Running first (oldest-started first), finished ones sink to the bottom.
  tasks.sort((a, b) =>
    (isLive(a) ? 0 : 1) - (isLive(b) ? 0 : 1)
    || a.startedAt - b.startedAt);
  const running = tasks.filter(isLive).length;
  const keepScroll = panel.scrollTop;   // the 1s repaint must not yank the panel back to the top
  panel.innerHTML = "";
  panel.classList.toggle("collapsed", bgCollapsed);
  // Collapsed: tuck to the right edge as a small clickable pill showing the
  // running count (or total, if all done). Click reopens the full panel.
  if (bgCollapsed) {
    const pill = el("button", "bgm-pill" + (running ? " running" : ""));
    pill.appendChild(el("span", "bgm-pill-glyph msi", "manufacturing"));
    pill.appendChild(el("span", "bgm-pill-count", String(running || tasks.length)));
    pill.title = "Show background tasks";
    pill.addEventListener("click", () => setBgCollapsed(false));
    panel.appendChild(pill);
    panel.hidden = false;
    return;
  }
  const head = el("div", "bgm-head");
  head.appendChild(el("span", "bgm-title",
    running ? ("⚙ " + running + " running in background")
            : "background tasks"));
  const collapseBtn = el("button", "bgm-collapse", '<span class="msi">right_panel_close</span>');
  collapseBtn.title = "Collapse to the right";
  collapseBtn.addEventListener("click", (e) => { e.stopPropagation(); setBgCollapsed(true); });
  head.appendChild(collapseBtn);
  panel.appendChild(head);
  const now = Date.now();
  tasks.forEach((t) => {
    const row = el("div", "bgm-row " + t.status + (t.expanded ? " expanded" : ""));
    const glyph = t.status === "failed" ? "close"
      : t.status === "completed" ? "check"
      : t.status === "killed" ? "block" : "progress_activity";
    row.appendChild(el("span", "bgm-glyph msi", glyph));
    const main = el("div", "bgm-main");
    main.appendChild(el("div", "bgm-desc", esc(t.desc)));
    // Live step line: the agent's current activity while running, its result
    // summary once finished.
    let live = "";
    if (isLive(t) && t.liveDesc && t.liveDesc !== t.desc) live = t.liveDesc;
    else if (!isLive(t) && t.summary) live = t.summary;
    const meta = [];
    if (t.status === "killing") meta.push("stopping…");
    if (t.status === "killed") meta.push("killed");
    if (t.subagent) meta.push(t.subagent);
    const model = bgTaskModel(s, t);
    if (model) meta.push(model);
    if (isLive(t) && t.lastTool) meta.push(t.lastTool);
    // Elapsed ticks off wall-clock while running; freezes at the agent-reported
    // duration once done.
    const secs = isLive(t)
      ? (now - t.startedAt) / 1000
      : (t.durationMs ? t.durationMs / 1000 : (now - t.startedAt) / 1000);
    meta.push(fmtBgDur(secs));
    if (t.toolUses) meta.push(t.toolUses + " tools");
    const tok = fmtBgTokens(t.tokens);
    if (tok) meta.push(tok);
    const sub = el("div", "bgm-sub");
    if (live) sub.appendChild(el("span", "bgm-live", esc(live)));
    sub.appendChild(el("span", "bgm-meta", (live ? " · " : "") + esc(meta.join(" · "))));
    main.appendChild(sub);
    // Expanded detail: the recent-activity trail plus the task id, unclamped.
    if (t.expanded) {
      const det = el("div", "bgm-detail");
      if (t.trail && t.trail.length) {
        const trail = el("div", "bgm-trail");
        t.trail.forEach((line) => trail.appendChild(el("div", "bgm-trail-line", esc(line))));
        det.appendChild(trail);
        // Follow the newest line only while the user is following it. The panel
        // rebuilds every second, and unconditionally snapping made the trail
        // unscrollable while its task ran. trailStick persists on the task
        // object because this DOM is rebuilt out from under the listener.
        if (t.trailStick !== false) trail.scrollTop = trail.scrollHeight;
        else trail.scrollTop = t.trailScroll || 0;
        trail.addEventListener("scroll", () => {
          t.trailStick = trail.scrollHeight - trail.scrollTop - trail.clientHeight < 12;
          t.trailScroll = trail.scrollTop;
        });
      }
      det.appendChild(el("div", "bgm-id", "task " + esc(t.id)));
      main.appendChild(det);
    }
    row.appendChild(main);
    // Click a row to expand/collapse its detail view.
    row.addEventListener("click", () => { t.expanded = !t.expanded; renderBgMonitor(); });
    // Kill button on live rows. Two-step to survive the 1s repaint without a
    // confirm dialog: first click arms ("sure?"), second click within 4s kills.
    // The arm state lives on the task object because this panel is rebuilt
    // every tick; the tick also naturally disarms it after the window passes.
    if (isLive(t)) {
      const armed = t.killArm && now - t.killArm < 4000;
      const kill = el("button", "bgm-kill" + (armed ? " armed" : ""),
        t.status === "killing" ? "…" : armed ? "sure?" : '<span class="msi">close</span>');
      kill.title = "Kill this background task";
      kill.disabled = t.status === "killing";
      kill.addEventListener("click", (e) => {
        e.stopPropagation();
        if (t.status === "killing") return;
        if (!t.killArm || Date.now() - t.killArm >= 4000) {
          t.killArm = Date.now();
          renderBgMonitor();
          return;
        }
        t.killArm = 0;
        t.status = "killing";
        renderBgMonitor();
        fetch("/sessions/" + s.id + "/tasks/" + encodeURIComponent(t.id) + "/stop",
              { method: "POST" })
          .then((r) => r.json())
          .then((j) => {
            if (!j.ok) {
              t.status = "running";
              s.notice("Couldn't stop background task: " + (j.error || "unknown error"), true);
              renderBgMonitor();
            }
            // On ok the resolution arrives over the stream as
            // task_updated(status=killed) — nothing more to do here.
          })
          .catch(() => { t.status = "running"; renderBgMonitor(); });
      });
      row.appendChild(kill);
    }
    panel.appendChild(row);
  });
  panel.hidden = false;
  panel.scrollTop = keepScroll;
}
// Tick the elapsed clocks while any background task on the active chat runs.
setInterval(() => {
  const s = activeId && sessions.get(activeId);
  if (s && s.bgActiveCount() > 0) renderBgMonitor();
}, 1000);
/* cycle MIST's spinner verbs in any working session's chat spinner (slow) */
setInterval(() => {
  if (!SPINNER_VERBS.length) return;
  spinnerIdx = (spinnerIdx + 1) % SPINNER_VERBS.length;
  const verb = SPINNER_VERBS[spinnerIdx] + "…";
  sessions.forEach((s) => {
    if (s.spinnerEl) {
      const sv = s.spinnerEl.querySelector(".sv");
      if (sv) sv.textContent = verb;
    }
  });
}, 5000);

/* ---------- model switcher card ---------- */
function renderModelCard() {
  const list = $("#modelList");
  list.innerHTML = "";
  const cur = (activeId && sessions.get(activeId) && sessions.get(activeId).model) || "";
  MODELS.forEach((m) => {
    const row = el("div", "modelrow" + (m.id === cur ? " sel" : ""), esc(m.label));
    row.addEventListener("click", () => selectModel(m));
    list.appendChild(row);
  });
}
async function selectModel(m) {
  $("#modelCard").hidden = true;
  if (!activeId) return;
  const s = sessions.get(activeId);
  s.model = m.id;
  $("#model").textContent = m.id ? m.id : "model: default";
  try {
    const r = await fetch("/sessions/" + activeId + "/model", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: m.id }),
    });
    const j = await r.json();
    // Live = switched over the control channel, no restart, context kept warm.
    s.notice("Model set to " + m.label + (j.live ? "." : ". Applies to your next message."));
  } catch (_) { s.notice("Model set to " + m.label + ". Applies to your next message."); }
}

/* ---------- permission-mode switcher card ---------- */
const PERM_MODES = [
  { id: "bypassPermissions", label: "bypass · run everything, no prompts" },
  { id: "default",           label: "default · ask before risky actions" },
  { id: "acceptEdits",       label: "accept edits · auto-approve file edits" },
  { id: "plan",              label: "plan · read-only, propose a plan first" },
];
function curPerm() {
  const s = activeId && sessions.get(activeId);
  return (s && (s.permMode || (s.init && s.init.permissionMode))) || "";
}
function renderPermCard() {
  const list = $("#permList");
  list.innerHTML = "";
  const cur = curPerm();
  PERM_MODES.forEach((p) => {
    const row = el("div", "modelrow" + (p.id === cur ? " sel" : ""), esc(p.label));
    row.addEventListener("click", () => selectPerm(p));
    list.appendChild(row);
  });
}
async function selectPerm(p) {
  $("#permCard").hidden = true;
  if (!activeId) return;
  const s = sessions.get(activeId);
  s.permMode = p.id;
  $("#perm").textContent = "perm: " + p.id;
  try {
    const r = await fetch("/sessions/" + activeId + "/permission", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: p.id }),
    });
    const j = await r.json();
    // Live between the asking modes; any switch through bypass restarts the
    // backend on the next message (bridge.set_permission explains why).
    s.notice("Permission mode set to " + p.id + (j.live ? "." : ". Applies to your next message."));
  } catch (_) { s.notice("Permission mode set to " + p.id + ". Applies to your next message."); }
}
/* ---------- thinking-depth switcher card ----------
   `claude --effort <level>`. "" means don't pass the flag at all and let the CLI
   use its own default, which is why it's a listed choice rather than an absence. */
const EFFORTS = [
  { id: "",       label: "default · whatever the CLI picks" },
  { id: "low",    label: "low · fastest, barely thinks" },
  { id: "medium", label: "medium · brief reasoning" },
  { id: "high",   label: "high · thorough" },
  { id: "xhigh",  label: "xhigh · very thorough, slower" },
  { id: "max",    label: "max · think as long as it takes" },
];
function curEffort() {
  const s = activeId && sessions.get(activeId);
  return (s && s.effort) || "";
}
function effortLabel(id) { return id || "default"; }
function renderThinkCard() {
  const list = $("#thinkList");
  list.innerHTML = "";
  const cur = curEffort();
  EFFORTS.forEach((e) => {
    const row = el("div", "modelrow" + (e.id === cur ? " sel" : ""), esc(e.label));
    row.addEventListener("click", () => selectEffort(e));
    list.appendChild(row);
  });
}
async function selectEffort(e) {
  $("#thinkCard").hidden = true;
  if (!activeId) return;
  const s = sessions.get(activeId);
  s.effort = e.id;
  $("#think").textContent = "think: " + effortLabel(e.id);
  s.notice("Thinking depth set to " + effortLabel(e.id) + ". Applies to your next message.");
  try {
    await fetch("/sessions/" + activeId + "/effort", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ effort: e.id }),
    });
  } catch (_) {}
}

// Color a usage badge green → yellow → red as it nears its limit.
function setUsageLevel(elem, pct) {
  if (!elem) return;
  elem.classList.remove("lvl-ok", "lvl-warn", "lvl-crit");
  if (pct == null) return;                      // unknown → neutral default
  const lvl = pct >= 80 ? "lvl-crit" : pct >= 60 ? "lvl-warn" : "lvl-ok";
  elem.classList.add(lvl);
}
function setCtxBadge(pct, used, window) {
  const e = $("#ctx");
  e.textContent = pct == null ? "ctx —" : "ctx " + pct + "%";
  // Surface the exact token math so the % is verifiable (the bulk is the fixed
  // harness overhead: CLAUDE.md + memory + MCP tool defs + skills).
  if (used != null && window != null) {
    e.title = "Context: " + used.toLocaleString() + " / " + window.toLocaleString()
      + " tokens used (incl. system prompt, CLAUDE.md, tools, history)";
  } else {
    e.title = "Context window used";
  }
  setUsageLevel(e, pct);
}
function setCount(id, arr) {
  const e = $(id);
  if (e) e.textContent = "(" + ((arr && arr.length) || 0) + ")";
}
function fillSettings(c) {
  if (!$("#capPanel").hidden) loadMcpPanel();   // live states, not init's snapshot
  chips("#capTools", c.tools);
  chips("#capSkills", c.skills);
  chips("#capSlash", c.slash_commands);
  setCount("#nMcp", c.mcp_servers);
  setCount("#nTools", c.tools);
  setCount("#nSkills", c.skills);
  setCount("#nSlash", c.slash_commands);
}
function fillCaps(init, s) {
  // The badges show the chat's own selection first — the init event only says
  // what the last process launched with, which goes stale the moment you pick
  // a new model/mode (both apply at the next revive). Falling back to init
  // here is what made a selection look like it "reset" after a tab switch.
  $("#model").textContent = (s && s.model) || init.model || "model —";
  $("#perm").textContent = "perm: " + ((s && s.permMode) || init.permissionMode || "—");
  // init carries no effort field, so the chat's own selection is the only source.
  $("#think").textContent = "think: " + effortLabel(s && s.effort);
  fillSettings(init);
}
function chips(id, items) {
  const c = $(id);
  if (!c) return;
  c.innerHTML = "";
  (items || []).forEach((it) => {
    const name = typeof it === "string" ? it : it.name;
    const span = el("span", null, esc(name));
    if (typeof it === "object" && it.status && it.status !== "connected") span.classList.add("pending");
    c.appendChild(span);
  });
}
function usageText(r) {
  const u = r.usage || {};
  const cost = r.total_cost_usd != null ? "$" + r.total_cost_usd.toFixed(4) : "";
  const tok = u.output_tokens != null ? u.output_tokens + " out" : "";
  const ms = r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + "s" : "";
  return [tok, ms, cost].filter(Boolean).join("  ·  ");
}

/* ---------- tab rail ---------- */
function sortedSessions() {
  return [...sessions.values()].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;          // pinned first
    if (a.pinned) return (a.pinOrder - b.pinOrder)               // pinned: manual order
      || (b.lastActivity - a.lastActivity);                      //   tie-break newest
    // A brand-new, unsent chat (still titled "New chat") floats to the top of the
    // recents so it stays put right under the pins. Otherwise it sorts by its
    // creation time and, the instant you tab away and touch any other chat, that
    // chat's fresher lastActivity sorts above it — with pinned chats filling the
    // rail, the new one sinks below the fold into 500+ recents and reads as gone.
    // It rejoins normal newest-first order the moment its first message titles it.
    const an = a.title === "New chat", bn = b.title === "New chat";
    if (an !== bn) return an ? -1 : 1;
    if (a.archived !== b.archived) return a.archived ? 1 : -1;   // condensed old chats last
    return b.lastActivity - a.lastActivity;                       // unpinned: newest first
  });
}
let renaming = false;   // true while a tab rename is in progress — don't rebuild the rail
let _tabsSig = "";      // last-rendered rail signature — skip identical rebuilds
// Date buckets for the unpinned rail. The label doubles as the collapse key, so
// "yesterday" stays collapsed as chats age into and out of it.
function railBucket(ts, today) {
  const d = new Date(ts), now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round(((today == null ? day(now) : today) - day(d)) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return "this week";
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return "this month";
  return d.toLocaleString(undefined, { month: "long", year: "numeric" }).toLowerCase();
}
function todayKey() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
}
// Bucket memoized on the session. toLocaleString is the slow part, and the rail
// asked for it three times per chat per rebuild (signature, counts, rows): over
// a thousand chats that was ~30ms of date formatting on every switch.
function railKey(s, today) {
  if (s.pinned) return "pinned";
  if (s.archived) return "archive";
  if (s._bucketTs !== s.lastActivity || s._bucketDay !== today) {
    s._bucketTs = s.lastActivity;
    s._bucketDay = today;
    s._bucket = railBucket(s.lastActivity, today);
  }
  return s._bucket;
}
// The rail renders the newest RAIL_PAGE unpinned chats and folds the rest behind
// one "older chats" row. Every row costs layout on every rebuild, and with 1200+
// chats a full rebuild (new chat, retitle) took a third of a second in Chromium
// and longer in WebKit. The last couple hundred is what the window ever scrolls
// to; search covers the tail. Clicking the row pages more in, and the active
// chat is always rendered wherever it sorts.
const RAIL_PAGE = 200;
let _railLimit = RAIL_PAGE;
let _tabsActive = null;   // the active id the rail was last rendered for
const COLLAPSED_LS = "mist.railCollapsed";
// The archive section (condensed chats 90+ days old, see archive.py) starts
// collapsed; everything else starts open.
let collapsedSections = new Set(JSON.parse(localStorage.getItem(COLLAPSED_LS) || '["archive"]'));
function toggleSection(label) {
  if (!collapsedSections.delete(label)) collapsedSections.add(label);
  localStorage.setItem(COLLAPSED_LS, JSON.stringify([...collapsedSections]));
  _tabsSig = "";
  renderTabs();
}
function renderTabs() {
  syncPhoneTitle();   // cheap, and titles change through several paths that all end here
  if (renaming || _draggingPins) return;   // the 1.5s refresh must not clobber an edit box or an in-progress drag
  const list = sortedSessions();
  const today = todayKey();
  // Structural signature: everything the rail shows EXCEPT which tab is active.
  // Rebuilding tears down every node (hover states flicker, clicks that straddle
  // a rebuild die, and hundreds of tabs churn every 1.5s), so it only happens
  // when something structural changed. The bucket is in the signature so the
  // day rollover (and a collapse toggle) forces a rebuild. The active tab used
  // to be in it too, so every chat switch rebuilt every row; a plain switch now
  // just moves the .active class.
  const sig = list.map((s) =>
    s.id + "|" + s.title + "|" + railKey(s, today)
    + "|" + (s.bgActiveCount() > 0 ? "bg" : s.statusState)).join("\n")
    + "\n#" + [...collapsedSections].join(",") + "#" + _railLimit;
  if (sig === _tabsSig) {
    if (activeId === _tabsActive) return;
    // Fast path: only the active chat changed. Both tabs must be ordinary rows.
    // A row that is rendered ONLY because it is active (inside a collapsed
    // section, or past the page limit) has to appear or vanish, and a target
    // that is not in the DOM at all has to be built, so those take the rebuild.
    const cur = tabsEl.querySelector('.tab[data-sid="' + CSS.escape(activeId) + '"]');
    const prev = _tabsActive && tabsEl.querySelector('.tab[data-sid="' + CSS.escape(_tabsActive) + '"]');
    if (cur && !cur.dataset.onlyActive && !(prev && prev.dataset.onlyActive)) {
      if (prev) { prev.classList.remove("active"); prev.setAttribute("aria-selected", "false"); }
      cur.classList.add("active");
      cur.setAttribute("aria-selected", "true");
      _tabsActive = activeId;
      return;
    }
  }
  _tabsSig = sig;
  _tabsActive = activeId;
  const counts = {};   // chats per section, shown on collapsed headers
  list.forEach((s) => {
    const k = railKey(s, today);
    counts[k] = (counts[k] || 0) + 1;
  });
  const frag = document.createDocumentFragment();   // one insert, one layout
  let section = null;   // which header we've emitted so far
  let shown = 0;        // unpinned rows rendered so far (the page limit counts these)
  let folded = 0;       // unpinned chats past the limit, summed into the "older" row
  list.forEach((s) => {
    const want = railKey(s, today);
    const isActive = s.id === activeId;
    const closed = collapsedSections.has(want);
    const past = !s.pinned && shown >= _railLimit;
    if (past && !isActive) { folded++; return; }
    if (want !== section && !past) {
      const h = el("div", "tabsection collapsible" + (s.pinned ? " pinned" : "") + (closed ? " collapsed" : ""),
        '<span class="msi sec-chev">expand_more</span>'
        + (s.pinned ? (PIN_ICON + " pinned") : esc(want))
        + (closed ? '<span class="sec-count">' + counts[want] + "</span>" : ""));
      h.tabIndex = 0;
      h.setAttribute("role", "button");
      h.setAttribute("aria-expanded", closed ? "false" : "true");
      h.setAttribute("aria-label", (closed ? "Expand " : "Collapse ") + want + " section");
      h.addEventListener("click", () => toggleSection(want));
      h.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggleSection(want); }
      });
      frag.appendChild(h);
      section = want;
    }
    // A collapsed section hides its chats, except the one you're looking at:
    // the active tab stays visible so the rail never loses your place.
    if (closed && !isActive) return;
    if (!s.pinned && !past) shown++;
    const t = el("div", "tab" + (isActive ? " active" : "") + (s.pinned ? " pinned" : ""));
    t.dataset.sid = s.id;
    if (isActive && (past || closed)) t.dataset.onlyActive = "1";   // see the fast path above
    // keyboard access: tabs are focusable and Enter/Space switches to them
    t.tabIndex = 0;
    t.setAttribute("role", "tab");
    t.setAttribute("aria-selected", isActive ? "true" : "false");
    t.setAttribute("aria-label", s.title);
    t.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); switchTo(s.id); }
    });
    const bg = s.bgActiveCount();
    const dot = el("span", "dot " + (bg > 0 ? "working bg" : s.statusState));
    crystalDot(dot, bg > 0 ? "bg" : s.statusState);
    if (bg > 0) dot.title = bg + " running in background";
    t.appendChild(dot);
    t.appendChild(el("span", "ttitle", esc(s.title)));
    const pin = el("span", "tpin" + (s.pinned ? " on" : ""), PIN_ICON);
    pin.title = s.pinned ? "Unpin" : "Pin";
    pin.setAttribute("aria-label", s.pinned ? "Unpin chat" : "Pin chat");
    pin.addEventListener("click", (ev) => { ev.stopPropagation(); togglePin(s.id); });
    t.appendChild(pin);
    const x = el("span", "tclose", '<span class="msi">close</span>');
    x.title = "Close";
    x.setAttribute("aria-label", "Close chat");
    x.addEventListener("click", (ev) => { ev.stopPropagation(); closeSession(s.id); });
    t.appendChild(x);
    t.addEventListener("click", () => {
      if (_suppressTabClick) { _suppressTabClick = false; return; }   // it was a drag, not a click
      switchTo(s.id);
    });
    t.addEventListener("contextmenu", (ev) => { ev.preventDefault(); startRename(s, t); });
    t.addEventListener("dblclick", (ev) => { ev.preventDefault(); startRename(s, t); });
    if (s.pinned) wirePinDrag(t, s.id);   // pinned chats are drag-sortable
    frag.appendChild(t);
  });
  if (folded) {
    const more = el("div", "tab tabmore",
      '<span class="msi">expand_more</span><span class="ttitle">'
      + folded + " older chat" + (folded === 1 ? "" : "s") + "</span>");
    more.tabIndex = 0;
    more.setAttribute("role", "button");
    more.setAttribute("aria-label", "Show " + folded + " older chats");
    const page = () => { _railLimit += RAIL_PAGE; _tabsSig = ""; renderTabs(); };
    more.addEventListener("click", page);
    more.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); page(); }
    });
    frag.appendChild(more);
  }
  tabsEl.innerHTML = "";
  tabsEl.appendChild(frag);
}
let _suppressTabClick = false;   // set after a drag so the trailing click doesn't switch tabs
let _draggingPins = false;       // true mid-drag so the periodic refresh won't rebuild the rail
// Pointer-based drag (HTML5 drag-and-drop doesn't fire in WKWebView). Smooth
// reorder: the grabbed tab lifts and tracks the pointer 1:1 while the other pinned
// tabs slide out of the way to open a gap; the new order commits on drop. Pinned
// tabs are uniform height, so one `step` (top-to-top distance) drives the math.
function wirePinDrag(t, id) {
  t.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".tpin, .tclose, .trename")) return;
    const pins = [...tabsEl.querySelectorAll(".tab.pinned")];
    const from = pins.indexOf(t);
    if (from < 0 || pins.length < 2) return;   // nothing to reorder
    const rects = pins.map((p) => p.getBoundingClientRect());
    const step = rects[1].top - rects[0].top;  // tab height + vertical gap
    const sy = e.clientY;
    let dragging = false, to = from;

    // open a one-slot gap at index `to` by sliding the in-between tabs over it
    const slide = () => {
      pins.forEach((p, i) => {
        if (i === from) return;
        let shift = 0;
        if (from < to && i > from && i <= to) shift = -step;       // dragging down
        else if (from > to && i >= to && i < from) shift = step;   // dragging up
        p.style.transition = "transform .16s cubic-bezier(.2,.7,.3,1)";
        p.style.transform = "translateY(" + shift + "px)";
      });
    };
    const onMove = (ev) => {
      const dy = ev.clientY - sy;
      if (!dragging) {
        if (Math.abs(dy) < 5) return;          // movement threshold vs a plain click
        dragging = true; _draggingPins = true;
        t.classList.add("dragging");
        document.body.classList.add("tab-dragging");
        t.style.transition = "none";           // the lifted tab stays glued to the pointer
      }
      t.style.transform = "translateY(" + dy + "px)";
      const want = Math.max(0, Math.min(pins.length - 1, from + Math.round(dy / step)));
      if (want !== to) { to = want; slide(); }
    };
    const reset = () => {
      pins.forEach((p) => { p.style.transition = ""; p.style.transform = ""; });
      t.classList.remove("dragging");
      document.body.classList.remove("tab-dragging");
      _draggingPins = false;
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      if (!dragging) { reset(); return; }
      _suppressTabClick = true;
      setTimeout(() => { _suppressTabClick = false; }, 90);   // backstop if no click fires
      // glide the lifted tab into its target slot, then commit + re-render
      t.style.transition = "transform .16s cubic-bezier(.2,.7,.3,1)";
      t.style.transform = "translateY(" + ((to - from) * step) + "px)";
      setTimeout(() => { reset(); if (to !== from) commitPinOrder(id, to); }, 165);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  });
}
function commitPinOrder(srcId, toIndex) {
  const src = sessions.get(srcId);
  if (!src || !src.pinned) { renderTabs(); return; }
  const order = sortedSessions().filter((s) => s.pinned).map((s) => s.id);
  const from = order.indexOf(srcId);
  if (from < 0 || toIndex === from) { renderTabs(); return; }
  order.splice(from, 1);
  order.splice(toIndex, 0, srcId);
  order.forEach((sid, i) => { const s = sessions.get(sid); if (s) s.pinOrder = i; });
  renderTabs();
  fetch("/sessions/pin-order", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: order }),
  }).catch(() => {});
}
function startRename(s, t) {
  const span = t.querySelector(".ttitle");
  if (!span || t.querySelector(".trename")) return;   // already editing
  renaming = true;
  const inp = el("input", "trename");
  inp.value = s.title || "";
  span.replaceWith(inp);
  inp.focus();
  inp.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const v = inp.value.trim();
    if (save && v && v !== s.title) {
      s.title = v;
      try {
        await fetch("/sessions/" + s.id + "/title", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: v }),
        });
      } catch (_) {}
    }
    renaming = false;
    _tabsSig = "";   // force a rebuild even if the title didn't change — the edit box must go
    renderTabs();
  };
  inp.addEventListener("click", (e) => e.stopPropagation());
  inp.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  inp.addEventListener("blur", () => finish(true));
}
async function togglePin(id) {
  const s = sessions.get(id);
  if (!s) return;
  s.pinned = !s.pinned;
  if (s.pinned) {   // newly pinned -> bottom of the pinned list (matches backend)
    s.pinOrder = Math.max(-1, ...[...sessions.values()].filter((x) => x.pinned && x !== s).map((x) => x.pinOrder)) + 1;
  }
  renderTabs();
  try { await fetch("/sessions/" + id + "/pin", { method: "POST" }); } catch (_) {}
}
function switchTo(id) {
  crystal.emotion = null; crystal.lastActivity = Date.now();
  const s = sessions.get(id);
  if (!s) return;
  activeId = id;
  closeRailDrawer();   // phone: picking a chat closes the drawer over it
  syncPhoneTitle();
  s.connect();   // lazy: open the stream + replay this transcript on first view
  sessions.forEach((x) => { x.logEl.hidden = x.id !== id; });
  // reflect this session into the top bar
  if (s.init) fillCaps(s.init, s);
  else {   // dormant chat, no init yet — still show its own selections
    $("#model").textContent = s.model || "model —";
    $("#perm").textContent = "perm: " + (s.permMode || "—");
    $("#think").textContent = "think: " + effortLabel(s.effort);
  }
  applyStatus(s);
  renderBgMonitor();   // repaint the background-task panel for THIS chat
  renderProgDock();    // …and this chat's own progress bars
  setCtxBadge(s.ctxPct, s.ctxUsed, s.ctxWindow);
  $("#usage").textContent = s.lastUsage || "";
  refreshRepo();   // repaint the repo badge for THIS chat's cwd
  renderTabs();
  // Keep the chat you just entered on screen: with a long pinned section the tab
  // rail can be scrolled such that the active tab sits below the fold, so a new or
  // switched-to chat would otherwise be invisible until you hunt for it.
  const at = tabsEl.querySelector(".tab.active");
  if (at) at.scrollIntoView({ block: "nearest" });
  s.scroll(true);   // entering a chat lands on its latest message
  updateJumpBtn();
  // restore this chat's own draft + image attachment (neither bleeds across chats)
  input.value = s.draft || "";
  setPendingImage(s.draftImage || null);
  growInput();
  hideSlash();
  if (!isTouch()) input.focus();   // on a phone this would raise the keyboard on every switch
  reportActiveChat();   // AirDropped photos follow the chat you switch to
}
async function createSession() {
  const r = await fetch("/sessions", { method: "POST" });
  const j = await r.json();
  const s = new Session(j.id, j.title, j);   // j carries the inherited model + perm mode
  sessions.set(j.id, s);
  switchTo(j.id);
  return s;
}
async function closeSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  await fetch("/sessions/" + id, { method: "DELETE" }).catch(() => {});
  s.destroy();
  sessions.delete(id);
  // Notes are app-wide and persistent now — closing a chat must NOT touch them.
  if (activeId === id) {
    const next = sortedSessions()[0];
    if (next) switchTo(next.id);
    else { activeId = null; createSession(); }
  } else {
    renderTabs();
  }
}

/* ---------- notes (app-wide persistent scratchpad) ----------
   The source of truth is the BACKEND (data/notes.json, written atomically), so
   notes survive restart, app close, force-quit, and updates. Notes are global,
   not per-chat. A note is removed ONLY when you send it to a chat or delete it.
   We keep a local mirror (`notes`) for rendering and never blank it out on a
   transient fetch error. */
let notes = [];

function updateNotesBadge() {
  const n = notes.length;
  const b = $("#scratchBtn");
  // scratchBtn is an md-icon-button now — writing textContent would destroy its
  // md-icon child, so the count rides a data attribute (CSS renders the badge).
  if (b) { b.dataset.count = String(n); b.classList.toggle("has", n > 0); }
  setCount("#nNotes", notes);
}
async function loadNotes() {
  try {
    const j = await (await fetch("/notes")).json();
    if (j && Array.isArray(j.notes)) notes = j.notes;
  } catch (_) { /* keep the last-known list; a blip must never hide notes */ }
  renderNotes();
}
function renderNotes() {
  const list = $("#notesList");
  // Only rebuild the DOM list when the panel is open (so a badge refresh can't
  // clobber an in-progress inline edit); the badge always updates.
  if (list && !$("#notesPanel").hidden) {
    list.innerHTML = "";
    if (!notes.length) {
      list.appendChild(el("div", "scratch-empty",
        "No notes yet. Jot one below — it's saved to disk until you send or delete it."));
    } else {
      notes.forEach((note) => list.appendChild(noteRow(note)));
    }
  }
  updateNotesBadge();
}
function noteRow(note) {
  const row = el("div", "scratch-item");
  const txt = el("div", "scratch-text");
  txt.textContent = note.text;                       // textContent — no HTML injection
  txt.title = "Double-click to edit";
  txt.addEventListener("dblclick", () => startNoteEdit(note, row));
  row.appendChild(txt);
  const edit = el("button", "scratch-edit-btn", "edit");
  edit.title = "Edit this note";
  edit.addEventListener("click", () => startNoteEdit(note, row));
  const send = el("button", "scratch-send", "send");
  send.title = "Send this note to the active chat now";
  send.addEventListener("click", () => sendNote(note));
  const del = el("button", "scratch-del", '<span class="msi">close</span>');
  del.title = "Delete this note";
  del.setAttribute("aria-label", "Delete this note");
  del.addEventListener("click", () => deleteNote(note));
  row.appendChild(edit);
  row.appendChild(send);
  row.appendChild(del);
  return row;
}
function startNoteEdit(note, row) {
  const span = row.querySelector(".scratch-text");
  if (!span || row.querySelector(".scratch-edit")) return;   // already editing
  const ta = el("textarea", "scratch-edit");
  ta.value = note.text || "";
  span.replaceWith(ta);
  const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 240) + "px"; };
  ta.focus(); ta.select(); grow();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    if (save) {
      const v = ta.value.trim();
      if (v && v !== note.text) await updateNote(note, v);
      else if (!v) await deleteNote(note);   // cleared note = delete
    }
    renderNotes();
  };
  ta.addEventListener("input", grow);
  ta.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  ta.addEventListener("blur", () => finish(true));
}
async function addNote() {
  const ta = $("#notesInput");
  const t = ta.value.trim();
  if (!t) return;
  ta.value = ""; ta.style.height = "auto";
  try {
    const j = await (await fetch("/notes", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: t }),
    })).json();
    if (j && j.ok && j.note) notes.push(j.note);
    else ta.value = t;                       // server rejected — keep the text
  } catch (_) {
    ta.value = t;                            // failed to save — never silently drop it
  }
  renderNotes();
  ta.focus();
}
async function updateNote(note, text) {
  try {
    const j = await (await fetch("/notes/" + note.id, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    })).json();
    if (j && j.ok) note.text = text;
  } catch (_) { /* leave the note as-is on failure */ }
}
async function deleteNote(note) {
  try { await fetch("/notes/" + note.id, { method: "DELETE" }); } catch (_) {}
  notes = notes.filter((n) => n.id !== note.id);
  renderNotes();
}
async function sendNote(note) {
  // Route the note into the active chat (or a fresh one if none). CRUCIAL: only
  // remove the note AFTER the send is confirmed delivered, so a failed send can
  // never lose it.
  let target = activeId && sessions.get(activeId);
  if (!target) target = await createSession();
  if (!target) return;
  const ok = await target.send(note.text, undefined, false);   // note stays in the panel on failure — don't also copy it into the composer
  if (ok) await deleteNote(note);
  else renderNotes();   // delivery failed: the note stays put
}
function openNotes() {
  $("#capPanel").hidden = true;
  closeAnchoredCards();
  $("#notesPanel").hidden = false;
  loadNotes();                               // re-read from disk every time it opens
  $("#notesInput").focus();
}
function toggleNotes() {
  const p = $("#notesPanel");
  if (p.hidden) openNotes(); else p.hidden = true;
}
$("#scratchBtn").addEventListener("click", toggleNotes);
$("#notesClose").addEventListener("click", () => { $("#notesPanel").hidden = true; });
$("#notesAdd").addEventListener("click", addNote);
$("#notesInput").addEventListener("input", () => {
  const ta = $("#notesInput");
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
});
$("#notesInput").addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addNote(); }
});

/* ---------- notification history (settings section) ----------
   mist-notify appends every banner it sends to a history JSONL; /notifications
   serves the tail. The feed lives in the settings panel (the dedicated topbar
   bell was crowding the actions row); the unread tint rides the gear instead.
   A row re-fires its click target: console links switch chats right here,
   everything else goes to the backend. */
let notifs = [];
function fmtAgo(ts) {
  const d = Math.max(0, Date.now() / 1000 - ts);
  if (d < 60) return "now";
  if (d < 3600) return Math.floor(d / 60) + "m";
  if (d < 86400) return Math.floor(d / 3600) + "h";
  return Math.floor(d / 86400) + "d";
}
function notifDot() {
  const seen = parseFloat(localStorage.getItem("notifSeen") || "0");
  const newest = notifs.length ? notifs[0].ts || 0 : 0;
  $("#settingsBtn").classList.toggle("has-new", newest > seen);
}
async function loadNotifs() {
  try { notifs = await (await fetch("/notifications?limit=50")).json(); }
  catch (_) { notifs = []; }
  notifDot();
}
function renderNotifs() {
  const list = $("#notifList");
  $("#nNotifs").textContent = notifs.length ? String(notifs.length) : "";
  if (!notifs.length) {
    list.innerHTML = '<div class="scratch-empty">Nothing yet. When MIST pings you (briefings, watchers, errors), it lands here too.</div>';
    return;
  }
  list.innerHTML = notifs.map((n, i) => `
    <div class="notif-row" data-i="${i}" title="${esc(n.link || "console")}">
      <div class="notif-head">
        <span class="notif-title">${esc(n.title || "MIST")}</span>
        <span class="notif-time">${fmtAgo(n.ts || 0)}</span>
      </div>
      ${n.subtitle ? `<div class="notif-sub">${esc(n.subtitle)}</div>` : ""}
      <div class="notif-body">${esc(n.body || "")}</div>
    </div>`).join("");
  list.querySelectorAll(".notif-row").forEach((row) => {
    row.addEventListener("click", () => openNotifTarget(notifs[+row.dataset.i]));
  });
}
async function openNotifTarget(n) {
  const link = (n && n.link) || "";
  if (!link || link === "console") return;
  if (link.indexOf("console:") === 0) {
    const sid = link.slice(8);
    if (sessions.has(sid)) switchTo(sid);
    return;
  }
  try {
    await fetch("/notifications/open", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ link }),
    });
  } catch (_) {}
}
async function refreshNotifsSection() {
  await loadNotifs();
  renderNotifs();
  if (notifs.length) localStorage.setItem("notifSeen", String(notifs[0].ts || 0));
  notifDot();
}
loadNotifs();                                  // paint the unread dot on boot
setInterval(loadNotifs, 120000);               // keep it honest while open all day

/* One-time migration: pull legacy per-chat localStorage notes into the store. */
async function migrateLegacyNotes() {
  if (localStorage.getItem("notesMigrated") === "1") return;
  const keys = [];
  const texts = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf("mist-scratch:") === 0) {
        keys.push(k);
        try { (JSON.parse(localStorage.getItem(k)) || []).forEach((t) => { if (t) texts.push(t); }); }
        catch (_) {}
      }
    }
  } catch (_) { return; }
  if (texts.length) {
    try {
      const r = await fetch("/notes/import", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts }),
      });
      if (!r.ok) return;                     // retry next boot; don't clear the source
    } catch (_) { return; }
  }
  // Only now is it safe to drop the legacy keys and mark migration done.
  try {
    keys.forEach((k) => localStorage.removeItem(k));
    localStorage.setItem("notesMigrated", "1");
  } catch (_) {}
}

/* periodically refresh tab status dots */
setInterval(renderTabs, 1500);

/* ---------- usage badges (5h / 7d) ---------- */
// Relative countdown ("<1h", "2h", "3d") — kept for the hover title.
function fmtResetRel(ts) {
  if (!ts) return "";
  const diff = ts - Math.floor(Date.now() / 1000);
  if (diff <= 0) return "now";
  if (diff < 3600) return "<1h";
  if (diff < 86400) return Math.floor(diff / 3600) + "h";
  return Math.ceil(diff / 86400) + "d";
}
// Exact local clock time/date the window resets, shown on the badge itself.
//   today    -> "9:24 PM"
//   this week-> "Wed 9:24 PM"
//   later    -> "Jun 24, 9:24 PM"
function fmtResetExact(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const now = new Date();
  const time = fmtClock(d.getTime());
  if (d.toDateString() === now.toDateString()) return time;
  const diffDays = (d - now) / 86400000;
  const opts = diffDays < 6 ? { weekday: "short" } : { month: "short", day: "numeric" };
  return d.toLocaleDateString(undefined, opts) + " " + time;
}
// The usage badges merge two sources: the % comes from the CLI statusline cache
// (/usage, which can be stale — it's only refreshed by the interactive CLI), while
// the reset time + allowed/blocked status come LIVE from each turn's
// rate_limit_event in the claude stream. So the cards stay current as MIST is
// used, even when the cache file isn't moving.
// Each turn's rate_limit_event carries the REAL live numbers: `utilization` (0-1
// fraction used), `status`, and `resetsAt`. We drive the badges off that. The
// /usage cache (`used_percentage`) is only a fallback before the first live event,
// since it's refreshed solely by the interactive CLI and is often very stale.
let _usageCache = null;
const _liveRate = { five_hour: null, seven_day: null };  // {resetsAt, status, util}
// "allowed_warning" means you've crossed a usage threshold but are STILL allowed —
// it is not a block. Only a status outside this set is a real limit-reached.
const _ALLOWED_STATUS = { allowed: 1, allowed_warning: 1 };

function _renderRateBadge(sel, label, key, fullName) {
  const el = $(sel);
  // A cached % whose window has already reset belongs to an EXPIRED window —
  // showing it (the old "70% · resets now" forever bug) is worse than showing
  // nothing. Drop the whole cache entry once its resets_at passes.
  let cache = _usageCache ? _usageCache[key] : null;
  if (cache && cache.resets_at && cache.resets_at * 1000 < Date.now()) cache = null;
  // Same rule for the live SSE event: once ITS window has rolled it describes
  // a dead window. The CLI only emits seven_day events when a threshold is
  // crossed, so after a weekly roll no new event may arrive for days; holding
  // the old one pinned the 7d badge at the previous week's 90% (2026-09-17).
  let live = _liveRate[key];
  if (live && live.resetsAt && live.resetsAt * 1000 < Date.now()) live = _liveRate[key] = null;
  // Two live % sources: the SSE event (stamped when it arrived) and the backend
  // probe (stamped by its age). Neither is authoritative by kind; the NEWER one
  // wins, so a 60s-old probe beats an hours-old event and vice versa.
  const probeTs = (cache && cache.pct_source === "probe" && cache.used_percentage != null)
    ? Date.now() - (cache.pct_age_seconds || 0) * 1000 : null;
  const liveTs = (live && live.util != null) ? (live.ts || 0) : null;
  const useLive = liveTs != null && (probeTs == null || liveTs >= probeTs);
  const pct = useLive ? Math.round(live.util * 100)
            : (cache && cache.used_percentage != null) ? Math.round(cache.used_percentage)
            : null;
  const resetsAt = (live && live.resetsAt) || (cache && cache.resets_at) || null;
  // Blocked if EITHER the live SSE event or the persisted /usage status (which
  // survives reloads) reports a non-allowed state.
  const blocked = !!((live && live.status && !_ALLOWED_STATUS[live.status])
                  || (cache && cache.status && !_ALLOWED_STATUS[cache.status]));
  if (pct == null && !resetsAt && !blocked) {
    el.textContent = label + " —"; setUsageLevel(el, null); el.title = fullName; return;
  }
  if (blocked) {
    el.textContent = `${label} limit reached · resets ${fmtResetExact(resetsAt)}`;
    setUsageLevel(el, 100);
  } else {
    const bits = [];
    if (pct != null) bits.push(pct + "%");
    if (resetsAt) bits.push("resets " + fmtResetExact(resetsAt));
    el.textContent = `${label} ${bits.join(" · ")}`;
    setUsageLevel(el, pct);
  }
  // Attribute the % source HONESTLY, per window. The backend's /usage tags each
  // window with `pct_source`: "probe" = live utilization read from the
  // subscription's rate-limit headers just after a turn; "cache" = the (often
  // days-stale) interactive-CLI statusline cache; null = no % is being shown
  // (window rolled, % dropped) so we surface only the live reset countdown and
  // never tack on a phantom "% N old" note.
  const fmtAge = (s) => s == null ? "" : (s >= 3600 ? Math.round(s / 3600) + "h"
    : s >= 60 ? Math.round(s / 60) + "m" : Math.round(s) + "s");
  const src = pct == null ? null : useLive ? "probe" : (cache && cache.pct_source);
  const ageTxt = fmtAge(useLive ? (Date.now() - liveTs) / 1000 : (cache && cache.pct_age_seconds));
  const srcNote = src === "probe" ? ` · % live${ageTxt ? ", " + ageTxt + " old" : ""}`
    : src === "cache" ? ` · % from CLI cache, ${ageTxt} old`
    : (resetsAt ? " · reset time live" : "");
  const resetNote = resetsAt
    ? `\nresets ${new Date(resetsAt * 1000).toLocaleString()} (in ${fmtResetRel(resetsAt)})`
    : "";
  el.title = fullName + srcNote + resetNote;
}
function renderUsageBadges() {
  _renderRateBadge("#r5h", "5h", "five_hour", "5-hour limit");
  _renderRateBadge("#r7d", "7d", "seven_day", "Weekly (7-day) limit");
}
function applyRateEvent(info) {
  if (!info || !(info.rateLimitType in _liveRate)) return;
  // Ignore stale events whose window has already reset (e.g. old ones replayed on
  // reconnect) so they can't pin the badge to an outdated value.
  if (info.resetsAt && info.resetsAt * 1000 < Date.now()) return;
  const now = Date.now();
  _liveRate[info.rateLimitType] = {
    resetsAt: info.resetsAt,
    status: info.status,
    util: typeof info.utilization === "number" ? info.utilization : null,
    ts: now,
  };
  // A threshold event also carries `unifiedWindows`: the current utilization and
  // reset of BOTH windows. Free, fresh data for the other badge; take it, but
  // never let it overwrite that window's own status with a guess.
  const uw = info.unifiedWindows || {};
  for (const k of Object.keys(_liveRate)) {
    const w = uw[k];
    if (k === info.rateLimitType || !w || typeof w.utilization !== "number") continue;
    if (w.resetsAt && w.resetsAt * 1000 < now) continue;
    const prev = _liveRate[k] || {};
    _liveRate[k] = { resetsAt: w.resetsAt || prev.resetsAt || null, status: prev.status || null,
                     util: w.utilization, ts: now };
  }
  renderUsageBadges();
}
async function pollUsage() {
  try {
    const u = await (await fetch("/usage")).json();
    _usageCache = u && u.available ? u : null;
  } catch (_) { _usageCache = null; }
  renderUsageBadges();
}
setInterval(pollUsage, 20000);           // re-read the merged usage cache often
setInterval(renderUsageBadges, 15000);   // keep the reset times/countdowns fresh
window.addEventListener("focus", pollUsage);   // refresh the instant MIST is refocused
pollUsage();

// When a clickable notification (briefing/triage with a "console:<sid>" link)
// raises the app, the backend has stashed which chat to surface. Claim it and
// switch there. One-shot: the backend clears it as we read. Polled on the same
// 1.5s cadence as /pending-open, NOT only on window "focus": WKWebView doesn't
// reliably fire that event when the app is activated (and never fires it when
// the Console was already frontmost), which left clicks landing on the wrong
// chat. The focus listener stays as a fast path.
async function claimPendingFocus() {
  try {
    const j = await (await fetch("/focus/peek")).json();
    if (!j || !j.sid || j.sid === activeId) return;
    if (!sessions.has(j.sid)) {
      // A chat this front-end hasn't learned about yet (e.g. created after our
      // last /sessions load): fetch it the same way the quick-entry poll does.
      const list = await (await fetch("/sessions")).json();
      const info = list.find((x) => x.id === j.sid);
      if (!info) return;
      sessions.set(j.sid, new Session(j.sid, info.title, info));
    }
    switchTo(j.sid);
  } catch (_) {}
}
window.addEventListener("focus", claimPendingFocus);
setInterval(claimPendingFocus, 1500);
claimPendingFocus();

/* ---------- active-chat beacon ---------- */
/* Tell the backend which chat is on screen, so an AirDropped photo lands where
   you're actually looking. Reported on every tab switch (see switchTo) and on a
   heartbeat; the heartbeat also serves as liveness, since it stops when the
   Console quits and the watcher then treats the record as stale. */
function reportActiveChat() {
  if (!activeId) return;
  fetch("/active-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sid: activeId, focused: document.hasFocus() }),
  }).catch(() => {});
}
setInterval(reportActiveChat, 30000);
window.addEventListener("focus", reportActiveChat);
reportActiveChat();

/* ---------- repo indicator ---------- */
/* Always show which git repo the cwd points at (origin@branch). Refreshes on a
   timer and on window focus so an out-of-band `git remote set-url` shows up. */
async function refreshRepo() {
  const el = $("#repo");
  if (!el) return;
  try {
    // Scope to the active chat so the badge shows THAT chat's cwd, not the
    // global default (chats can point at different repos).
    const q = activeId ? "?session=" + encodeURIComponent(activeId) : "";
    const r = await (await fetch("/repo" + q)).json();
    if (r.origin) {
      el.textContent = r.short + (r.branch ? "@" + r.branch : "");
      el.dataset.state = "ok";
    } else if (r.short) {
      // a folder MIST is working in that has no git remote — still name it
      el.textContent = r.short + (r.branch ? "@" + r.branch : "");
      el.dataset.state = "warn";
    } else {
      el.textContent = "no remote";
      el.dataset.state = "warn";
    }
    el.title = (r.origin ? "origin: " + r.origin : "no git remote")
      + "\ncwd: " + r.cwd + "\nclick to change repo";
  } catch (_) {
    el.textContent = "repo —";
    el.dataset.state = "unknown";
  }
}
setInterval(refreshRepo, 30000);
window.addEventListener("focus", refreshRepo);
refreshRepo();

/* ---------- boot greeting ---------- */
function bootGreeting() {
  fetch("/greeting").then((r) => r.json()).then((g) => {
    if (g && g.text && activeId) {
      const s = sessions.get(activeId);
      // If this chat is still replaying its history, appending now would strand
      // the greeting mid-transcript (the rest of the replay streams in below
      // it). Park it; the replay_done handler renders it at the true bottom.
      if (s.connected && s._replaying) { s._pendingGreeting = g.text; return; }
      const body = s.addMsg("mist", "MIST", Date.now());
      body.innerHTML = '<em class="greet">' + esc(g.text) + "</em>";
    }
  }).catch(() => {});
}

/* ---------- composer + file picker ---------- */
function insertPaths(paths) {
  if (!paths || !paths.length) return;
  const q = paths.map((p) => (/\s/.test(p) ? '"' + p + '"' : p)).join(" ");
  const cur = input.value;
  input.value = cur + (cur && !cur.endsWith(" ") ? " " : "") + q + " ";
  input.dispatchEvent(new Event("input"));
  input.focus();
}
function sendActive() {
  const text = input.value.trim();
  const image = pendingImage;
  if ((!text && !image) || !activeId) return;
  // Slash commands are text-only; skip the local-command path when an image rides
  // along so an image attachment is never swallowed by a "/new"-style match.
  if (text && !image && handleLocalCommand(text)) return;
  input.value = ""; growInput();
  setPendingImage(null);
  const a = sessions.get(activeId);
  a.draft = "";
  a.send(text, image);
}

/* ---------- composer image attachment (paste / drag-drop) ----------
   pendingImage holds a data:image/... URL for the active composer; it's mirrored
   onto the active session (draftImage) so it survives chat switches like a draft. */
let pendingImage = null;
const attachPreview = $("#attachPreview");
function setPendingImage(dataUrl) {
  pendingImage = dataUrl || null;
  const a = activeId && sessions.get(activeId);
  if (a) a.draftImage = pendingImage;
  if (typeof reflectSend === "function") reflectSend();
  if (!attachPreview) return;
  attachPreview.innerHTML = "";
  if (!pendingImage) { attachPreview.hidden = true; return; }
  const thumb = el("img", "attach-thumb");
  thumb.src = pendingImage;
  const x = el("button", "attach-x", '<span class="msi">close</span>');
  x.type = "button";
  x.title = "Remove attachment";
  x.setAttribute("aria-label", "Remove attachment");
  x.addEventListener("click", () => { setPendingImage(null); input.focus(); });
  attachPreview.appendChild(thumb);
  attachPreview.appendChild(x);
  attachPreview.hidden = false;
}
function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
}
async function attachImageFile(file) {
  if (!file || !/^image\//.test(file.type || "")) return;
  try { setPendingImage(await fileToDataURL(file)); }
  catch (_) { if (activeId) sessions.get(activeId).notice("Couldn't read that image.", true); }
}
// Paste an image straight from the clipboard (screenshot, copied image, etc.).
input.addEventListener("paste", (e) => {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const it of items) {
    if (it.kind === "file" && (it.type || "").startsWith("image/")) {
      const f = it.getAsFile();
      if (f) { e.preventDefault(); attachImageFile(f); return; }
    }
  }
});
// Drag an image file onto the composer to attach it.
(function () {
  const composer = $("#composer");
  if (!composer) return;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  ["dragenter", "dragover"].forEach((ev) => composer.addEventListener(ev, (e) => {
    if (hasFiles(e)) { e.preventDefault(); composer.classList.add("drag"); }
  }));
  ["dragleave", "dragend"].forEach((ev) => composer.addEventListener(ev, () => composer.classList.remove("drag")));
  composer.addEventListener("drop", (e) => {
    composer.classList.remove("drag");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && (f.type || "").startsWith("image/")) { e.preventDefault(); attachImageFile(f); }
  });
})();

/* Commands handled by the Console itself, not forwarded to Claude.
   /new [text] opens a fresh chat (and optionally seeds the first message).
   /here [off] and /photos steer where AirDropped iPhone photos land (see the
   airdrop-to-console watcher). A claim lasts 5 minutes; absent one the watcher
   uses the chat on screen, then recency, then the dedicated photos chat. */
const LOCAL_COMMANDS = [
  { name: "new", desc: "Start a new chat" },
  { name: "here", desc: "Route AirDropped photos to this chat (/here off to cancel)" },
  { name: "photos", desc: "Route AirDropped photos to the 📷 iPhone Photos chat" },
];
function setAirdropClaim(target, note) {
  const a = activeId && sessions.get(activeId);
  input.value = ""; growInput();
  if (a) a.draft = "";
  hideSlash();
  fetch("/airdrop-claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target }),
  }).then(() => { if (a) a.notice(note); })
    .catch(() => { if (a) a.notice("Couldn't reach the AirDrop router.", true); });
}
function handleLocalCommand(text) {
  const mNew = /^\/new(?:\s+([\s\S]*))?$/i.exec(text);
  if (mNew) {
    const seed = (mNew[1] || "").trim();
    input.value = ""; growInput();
    const a = activeId && sessions.get(activeId);
    if (a) a.draft = "";
    hideSlash();
    createSession().then((s) => { if (seed && s) s.send(seed); });
    return true;
  }
  const mHere = /^\/here(?:\s+(off|stop))?$/i.exec(text);
  if (mHere) {
    if (mHere[1]) setAirdropClaim(null, "AirDrop routing back to automatic (recency).");
    else setAirdropClaim(activeId, "AirDropped photos will land in this chat for the next 5 minutes.");
    return true;
  }
  if (/^\/pause$/i.test(text)) {
    const a = activeId && sessions.get(activeId);
    input.value = ""; growInput(); hideSlash();
    if (a) a.pause();
    return true;
  }
  if (/^\/resume$/i.test(text)) {
    const a = activeId && sessions.get(activeId);
    input.value = ""; growInput(); hideSlash();
    if (a) a.resume();
    return true;
  }
  if (/^\/photos$/i.test(text)) {
    setAirdropClaim("dedicated", "AirDropped photos will land in the 📷 iPhone Photos chat for the next 5 minutes.");
    return true;
  }
  return false;
}
input.addEventListener("input", () => {
  growInput();
  const a = activeId && sessions.get(activeId);
  if (a) a.draft = input.value;   // drafts are per-chat, not shared
  updateSlash();
  reflectSend();
});
input.addEventListener("keydown", (e) => {
  if (slashOpen && slashItems.length) {
    if (e.key === "ArrowDown") { e.preventDefault(); slashIdx = (slashIdx + 1) % slashItems.length; paintSlashSel(); return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); slashIdx = (slashIdx - 1 + slashItems.length) % slashItems.length; paintSlashSel(); return; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); acceptSlash(slashIdx); return; }
    if (e.key === "Escape")    { e.preventDefault(); hideSlash(); return; }
  }
  if (e.key === "Escape") {
    // First close any open overlay — reaching for Esc to dismiss a picker must
    // never stop MIST mid-work. Only a bare Esc interrupts the turn.
    if (closeTopOverlay()) { e.preventDefault(); return; }
    // Esc interrupts the in-flight turn (the TUI's stop), when nothing else claimed it.
    const a = activeId && sessions.get(activeId);
    if (a && (a.statusState === "thinking" || a.statusState === "working")) {
      e.preventDefault();
      if (e.shiftKey) a.pause(); else a.interrupt();   // Shift+Esc: graceful pause
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    if (isTouch()) return;   // phone keyboards: return is a newline, the send button sends
    e.preventDefault(); sendActive();
  }
});
input.addEventListener("blur", () => setTimeout(hideSlash, 120));

/* ---------- inline slash-command autocomplete ---------- */
const slashMenu = $("#slashMenu");
let slashItems = [];   // currently filtered command names
let slashIdx = 0;
let slashOpen = false;
function slashAll() {
  const raw = (lastInit && lastInit.slash_commands) || [];
  const remote = raw.map((it) => (typeof it === "string" ? it : it.name)).filter(Boolean);
  const local = LOCAL_COMMANDS.map((c) => c.name);
  return [...local, ...remote.filter((n) => !local.includes(n))];   // local commands first, deduped
}
function updateSlash() {
  // Only trigger on a leading slash with no space yet: "/", "/de", "/news-b"…
  const m = /^\/([a-zA-Z0-9:_-]*)$/.exec(input.value);
  if (!m) return hideSlash();
  const q = m[1].toLowerCase();
  slashItems = slashAll()
    .filter((c) => c.toLowerCase().includes(q))
    .sort((a, b) => {
      const as = a.toLowerCase().startsWith(q), bs = b.toLowerCase().startsWith(q);
      if (as !== bs) return as ? -1 : 1;          // prefix matches first
      return a.localeCompare(b);
    })
    .slice(0, 8);
  if (!slashItems.length) return hideSlash();
  slashIdx = 0;
  renderSlash();
}
function renderSlash() {
  slashMenu.innerHTML = "";
  slashMenu.appendChild(el("div", "slash-head", "slash commands · ↑↓ to choose, ⏎ to insert"));
  slashItems.forEach((c, i) => {
    const row = el("div", "slash-item" + (i === slashIdx ? " sel" : ""));
    row.appendChild(el("span", "slash-name", "/" + esc(c)));
    row.addEventListener("mousedown", (e) => { e.preventDefault(); acceptSlash(i); });
    row.addEventListener("mouseenter", () => { slashIdx = i; paintSlashSel(); });
    slashMenu.appendChild(row);
  });
  slashMenu.hidden = false;
  slashOpen = true;
}
function paintSlashSel() {
  [...slashMenu.querySelectorAll(".slash-item")].forEach((c, i) => c.classList.toggle("sel", i === slashIdx));
}
function hideSlash() { slashMenu.hidden = true; slashOpen = false; slashItems = []; }
function acceptSlash(i) {
  const c = slashItems[i];
  if (!c) return;
  input.value = "/" + c + " ";
  hideSlash();
  input.focus();
  growInput();
}
// The send button doubles as a stop button while a turn is running and the
// composer is empty, so a mouse user gets the same interrupt Esc provides.
const sendBtn = $("#sendBtn");
function reflectSend() {
  const a = activeId && sessions.get(activeId);
  const busy = a && (a.statusState === "thinking" || a.statusState === "working");
  const empty = !input.value.trim() && !pendingImage;
  const stop = busy && empty;
  sendBtn.dataset.mode = stop ? "stop" : "send";
  const ic = $("#sendIcon");                       // md-filled-icon-button — swap the glyph, not textContent
  if (ic) ic.textContent = stop ? "stop" : "send";
  sendBtn.title = stop ? "Stop this turn" : "Send  (Enter)";
  const pb = $("#pauseBtn"), pi = $("#pauseIcon");
  if (pb) {
    const mode = busy ? (a.statusLabel === "pausing…" ? "pausing" : "pause")
               : (a && a.paused ? "resume" : "off");
    pb.dataset.mode = mode;
    pb.hidden = mode === "off";
    if (pi) pi.textContent = mode === "resume" ? "play_arrow" : "pause";
    pb.title = mode === "resume" ? "Resume from the checkpoint"
             : mode === "pausing" ? "Pausing: MIST finishes the current step, then stops"
             : "Pause gracefully  (Shift+Esc)";
    pb.setAttribute("aria-label", pb.title);
  }
}
$("#pauseBtn").addEventListener("click", () => {
  const a = activeId && sessions.get(activeId);
  if (!a) return;
  if ($("#pauseBtn").dataset.mode === "resume") a.resume(); else a.pause();
});
sendBtn.addEventListener("click", () => {
  if (sendBtn.dataset.mode === "stop") {
    const a = activeId && sessions.get(activeId);
    if (a) a.interrupt();
    return;
  }
  sendActive();
});
$("#newTab").addEventListener("click", createSession);
$("#settingsBtn").addEventListener("click", () => {
  if (!$("#capPanel").hidden) { $("#capPanel").hidden = true; return; }   // click again to dismiss
  if (lastInit) fillSettings(lastInit);   // last-known MCP servers + tools
  renderThemeList();                       // reflect the active theme
  renderFontList();                        // reflect the active font
  loadRoutines();                          // routines now live as a settings section
  loadMcpPanel();                          // MCP servers: live status + reconnect/toggle/auth
  loadWatchers();                          // watchers section (launchd watch jobs)
  loadRemote();                            // phone section: remote access + pairing
  $("#notesPanel").hidden = true;
  refreshNotifsSection();                  // notifications live as a settings section
  closeAnchoredCards();
  $("#capPanel").hidden = false;
});

/* ---------- theme switcher ----------
   The whole stylesheet IS the "Terminal" theme. New themes register here and
   override what they need under html[data-theme="<id>"] in style.css. The
   data-theme attribute is set pre-paint by an inline <head> script. */
const THEMES = [
  { id: "terminal", label: "Terminal", desc: "Flat, sharp terminal — the original MIST look." },
];
function applyTheme(id, persist) {
  const t = THEMES.find((x) => x.id === id) || THEMES[0];
  document.documentElement.dataset.theme = t.id;
  try { localStorage.setItem("theme", t.id); } catch (_) {}
  // Also persist server-side so the choice survives a full app close/reopen even
  // if the WebView's localStorage gets wiped. Only on real user changes.
  if (persist) {
    fetch("/theme", { method: "POST", headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ theme: t.id }) }).catch(() => {});
  }
}
function renderThemeList() {
  const list = $("#themeList");
  if (!list) return;
  list.innerHTML = "";
  const cur = document.documentElement.dataset.theme || "terminal";
  THEMES.forEach((t) => {
    const row = el("div", "modelrow" + (t.id === cur ? " sel" : ""), esc(t.label));
    row.title = t.desc || "";
    row.addEventListener("click", () => { applyTheme(t.id, true); renderThemeList(); });
    list.appendChild(row);
  });
}
// Reaffirm the saved theme on boot (the head script already set it pre-paint).
// Fall back to the server-injected data-theme (not "terminal") so a wiped
// localStorage doesn't clobber the server-persisted choice.
applyTheme(localStorage.getItem("theme") || document.documentElement.dataset.theme || "terminal");
renderThemeList();

/* ---------- crystal look (see the crystal block near MIST_MARK) ---------- */
function renderCrystalList() {
  const list = $("#crystalList");
  if (!list) return;
  list.innerHTML = "";
  if (!crystal.avail) { list.appendChild(el("div", "modelnote", "Animation pack not installed (static/anims/README.md).")); return; }
  Object.entries(CRYSTAL_LOOKS).forEach(([id, label]) => {
    const row = el("div", "modelrow crystalrow" + (id === crystal.look ? " sel" : ""),
      '<img alt="" draggable="false" src="' + crystalSrc("idle", id) + '"> ' + esc(label));
    row.addEventListener("click", () => setCrystalLook(id, null));
    list.appendChild(row);
  });
  const tog = el("div", "modelrow" + (crystal.on ? "" : " sel"), crystal.on ? "Animated · click for the still logo" : "Still logo · click to animate");
  tog.addEventListener("click", () => setCrystalLook(null, !crystal.on));
  list.appendChild(tog);
}
(function () {
  crystal.header = $("#crystalImg");
  const probe = new Image();
  probe.onload = () => {
    crystal.avail = true;
    renderCrystalList();
    crystalRefresh();
    crystalOneshot("appear");
    setInterval(crystalRefresh, 1000);   // moods and holds expire on their own clock
  };
  probe.onerror = () => { crystal.avail = false; renderCrystalList(); crystalRefresh(); };
  probe.src = crystalSrc("idle", "classic");
  // you typing = listening; one of MIST's audio replies playing = speaking
  const input = $("#input");
  if (input) input.addEventListener("input", () => { crystal.typingAt = Date.now(); crystalRefresh(); });
  const recount = () => {
    let n = 0;
    document.querySelectorAll("#logs audio").forEach((a) => { if (!a.paused && !a.ended) n++; });
    crystal.audioPlaying = n; crystalRefresh();
  };
  for (const evn of ["play", "playing", "pause", "ended", "emptied"]) document.addEventListener(evn, (e) => { if (e.target && e.target.tagName === "AUDIO") recount(); }, true);
})();

/* ---------- font switcher ----------
   One font for ALL text everywhere. Every rule in the sheet reads var(--mono)
   (body/chat/badges) or var(--head) (headings), so overriding both custom props
   inline on <html> re-fonts the entire UI in one move — and inline wins over any
   theme's own --mono/--head, so the choice holds across themes. "Default" clears
   the override and lets the active theme's own fonts show. Persisted to
   localStorage ("font" id + "fontStack" for the pre-paint <head> script) and
   server-side (font.json via /font) so it survives a localStorage wipe.
   Each stack is a fallback chain of fonts that ship with macOS. */
const FONTS = [
  { id: "default",   label: "Default (theme's own)", stack: "" },
  { id: "system",    label: "System (San Francisco)", stack: '-apple-system, system-ui, "Helvetica Neue", sans-serif' },
  { id: "sfmono",    label: "SF Mono",         stack: '"SF Mono", "JetBrains Mono", Menlo, Consolas, monospace' },
  { id: "menlo",     label: "Menlo",           stack: 'Menlo, Monaco, "SF Mono", monospace' },
  { id: "jetbrains", label: "JetBrains Mono",  stack: '"JetBrains Mono", "SF Mono", Menlo, monospace' },
  { id: "courier",   label: "Courier",         stack: '"Courier New", Courier, monospace' },
  { id: "helvetica", label: "Helvetica Neue",  stack: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { id: "avenir",    label: "Avenir Next",     stack: '"Avenir Next", Avenir, "Segoe UI", sans-serif' },
  { id: "optima",    label: "Optima",          stack: 'Optima, "Avenir Next", Candara, sans-serif' },
  { id: "verdana",   label: "Verdana",         stack: 'Verdana, Geneva, "DejaVu Sans", sans-serif' },
  { id: "georgia",   label: "Georgia",         stack: 'Georgia, "Times New Roman", serif' },
  { id: "palatino",  label: "Palatino",        stack: 'Palatino, "Palatino Linotype", "Book Antiqua", serif' },
  { id: "iowan",     label: "Iowan Old Style", stack: '"Iowan Old Style", Palatino, Georgia, serif' },
  { id: "charter",   label: "Charter",         stack: 'Charter, Georgia, "Times New Roman", serif' },
  { id: "times",     label: "Times New Roman", stack: '"Times New Roman", Times, serif' },
  { id: "comic",     label: "Comic Sans",      stack: '"Comic Sans MS", "Chalkboard SE", "Comic Neue", cursive' },
  // Vendored art-nouveau-era faces (static/fonts, OFL). They ship with the app,
  // so picking one needs no network. The three marked display set the WHOLE UI
  // including code — gorgeous, not readable for a diff.
  { id: "raleway",   label: "Raleway",         stack: 'Raleway, "Avenir Next", sans-serif' },
  { id: "poiret",    label: "Poiret One · nouveau", stack: '"Poiret One", Raleway, sans-serif' },
  { id: "italiana",  label: "Italiana · nouveau",   stack: 'Italiana, Marcellus, Georgia, serif' },
  { id: "marcellus", label: "Marcellus",       stack: 'Marcellus, Georgia, serif' },
  { id: "josefin",   label: "Josefin Sans",    stack: '"Josefin Sans", Raleway, sans-serif' },
  { id: "playfair",  label: "Playfair Display", stack: '"Playfair Display", Georgia, serif' },
  { id: "cormorant", label: "Cormorant Garamond", stack: '"Cormorant Garamond", Palatino, serif' },
  { id: "cinzel",    label: "Cinzel Decorative · display", stack: '"Cinzel Decorative", Marcellus, serif' },
  { id: "yeseva",    label: "Yeseva One · display", stack: '"Yeseva One", "Playfair Display", serif' },
  { id: "berkshire", label: "Berkshire Swash · display", stack: '"Berkshire Swash", "Yeseva One", cursive' },
];
function applyFont(id, persist) {
  const f = FONTS.find((x) => x.id === id) || FONTS[0];
  const root = document.documentElement;
  root.dataset.font = f.id;
  if (f.stack) {
    root.style.setProperty("--mono", f.stack);
    root.style.setProperty("--head", f.stack);
  } else {
    // "Default" — drop the inline override so the theme's own fonts resurface.
    root.style.removeProperty("--mono");
    root.style.removeProperty("--head");
  }
  try {
    localStorage.setItem("font", f.id);
    if (f.stack) localStorage.setItem("fontStack", f.stack);
    else localStorage.removeItem("fontStack");
  } catch (_) {}
  if (persist) {
    fetch("/font", { method: "POST", headers: { "Content-Type": "application/json" },
                     body: JSON.stringify({ id: f.id, stack: f.stack }) }).catch(() => {});
  }
}
function renderFontList() {
  const list = $("#fontList");
  if (!list) return;
  list.innerHTML = "";
  const cur = document.documentElement.dataset.font || "default";
  FONTS.forEach((f) => {
    const row = el("div", "modelrow" + (f.id === cur ? " sel" : ""), esc(f.label));
    if (f.stack) row.style.fontFamily = f.stack;   // preview each option in its own face
    row.addEventListener("click", () => { applyFont(f.id, true); renderFontList(); });
    list.appendChild(row);
  });
}
// Reaffirm the saved font on boot (the head script already applied it pre-paint).
applyFont(localStorage.getItem("font") || document.documentElement.dataset.font || "default");
renderFontList();

/* ---------- text size ----------
   Scales the WHOLE window, not just message text: the badges, the rail, the
   composer, the panels. Half-scaling would leave the chrome tiny around big
   text, which is worse than either. `zoom` on the root does that in one
   property, so none of the sheet's ~90 hardcoded px sizes need rewriting and
   every future one inherits the behavior for free.
   Persisted twice on purpose, exactly like the theme and font: localStorage for
   instant pre-paint, and the server (data/textsize.json) so a wiped WebView
   store still opens at the size you chose. */
const TSIZE_MIN = 70, TSIZE_MAX = 200, TSIZE_STEP = 5;
function currentTextSize() {
  const z = parseFloat(document.documentElement.style.zoom);
  return z ? Math.round(z * 100) : 100;
}
function applyTextSize(pct, persist) {
  pct = Math.max(TSIZE_MIN, Math.min(TSIZE_MAX, Math.round(pct)));
  const root = document.documentElement;
  if (pct === 100) root.style.removeProperty("zoom");
  else root.style.zoom = pct / 100;
  window.dispatchEvent(new Event("mist:zoom"));   // phone metrics derive from the zoom
  const val = $("#tsizeVal");
  if (val) val.textContent = pct + "%";
  try { localStorage.setItem("textSize", String(pct)); } catch (_) {}
  if (persist) {
    fetch("/textsize", { method: "POST", headers: { "Content-Type": "application/json" },
                         body: JSON.stringify({ pct }) }).catch(() => {});
  }
  // The panels that measure themselves in px (the composer's height, the topbar's)
  // are now a different number of CSS pixels tall.
  window.dispatchEvent(new Event("resize"));
  return pct;
}
function nudgeTextSize(delta) { applyTextSize(currentTextSize() + delta, true); }
(function () {
  const up = $("#tsizeUp"), down = $("#tsizeDown"), val = $("#tsizeVal");
  if (!up) return;
  up.addEventListener("click", () => nudgeTextSize(TSIZE_STEP));
  down.addEventListener("click", () => nudgeTextSize(-TSIZE_STEP));
  val.addEventListener("click", () => applyTextSize(100, true));
  // ⌘+ / ⌘− / ⌘0, the shortcuts every other app on the machine uses. This is a
  // WebView with no browser chrome, so if we don't bind them nothing does.
  window.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    // "=" is the unshifted key that carries "+", and the numpad sends "Add".
    if (e.key === "+" || e.key === "=" ) { e.preventDefault(); nudgeTextSize(TSIZE_STEP); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); nudgeTextSize(-TSIZE_STEP); }
    else if (e.key === "0") { e.preventDefault(); applyTextSize(100, true); }
  });
  applyTextSize(currentTextSize(), false);   // paint the readout with the boot value
})();

/* ---------- routines panel (edit details + set schedule) ---------- */
function cronHint(cron) {
  const c = (cron || "").trim();
  if (!c) return "no schedule — enable + set a cron to run it automatically";
  const f = c.split(/\s+/);
  if (f.length !== 5) return "cron needs 5 fields: minute hour day month weekday";
  return "cron: " + c;
}
function rtField(labelText, kind, value, placeholder) {
  const wrap = el("div", "rt-field");
  wrap.appendChild(el("label", null, labelText));
  const inp = el(kind);
  if (kind !== "textarea") inp.type = "text";
  inp.value = value || "";
  if (placeholder) inp.placeholder = placeholder;
  wrap.appendChild(inp);
  return { wrap, inp };
}
function buildRoutineForm(r, isNew) {
  let dir = r.dir || "";
  const d = el("details", "routine");
  if (isNew) d.open = true;
  const s = el("summary");
  s.appendChild(el("span", "rname", esc(r.name || "new routine")));
  s.appendChild(el("span", "rdot " + (r.enabled ? "on" : "off"), r.enabled ? "● scheduled" : "○ off"));
  if (r.description) s.appendChild(el("div", "rdesc", esc(r.description)));
  d.appendChild(s);

  const form = el("form");
  form.addEventListener("submit", (e) => e.preventDefault());
  const fName = rtField("name", "input", r.name || "", "Routine name");
  const fDesc = rtField("description", "input", r.description || "", "What it does");
  const fPrompt = rtField("prompt", "textarea", r.prompt || "", "Instructions for the routine…");
  const fCron = rtField("schedule — cron: min hour day month weekday", "input", r.cron || "",
    "e.g. 0 8 * * 1-5  (weekdays at 8am)");
  const hint = el("div", "rt-hint", cronHint(r.cron));
  fCron.inp.addEventListener("input", () => { hint.textContent = cronHint(fCron.inp.value); });

  const enWrap = el("label", "rt-enabled");
  const en = el("md-switch"); en.selected = !!r.enabled;   // Lit re-applies pre-upgrade props
  enWrap.appendChild(en);
  enWrap.appendChild(document.createTextNode(" enabled (schedule via launchd)"));

  const actions = el("div", "rt-actions");
  const save = el("button", null, "Save");
  const run = el("button", null, "Run now");
  const del = el("button", "rt-del", "Delete");
  [save, run, del].forEach((b) => { b.type = "button"; actions.appendChild(b); });
  const status = el("div", "rt-status", "");

  [fName, fDesc, fPrompt, fCron].forEach((f) => form.appendChild(f.wrap));
  form.appendChild(hint);
  form.appendChild(enWrap);
  form.appendChild(actions);
  form.appendChild(status);
  d.appendChild(form);

  save.addEventListener("click", async () => {
    status.className = "rt-status"; status.textContent = "saving…";
    try {
      const res = await (await fetch("/routines/save", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dir, name: fName.inp.value.trim(), description: fDesc.inp.value.trim(),
          prompt: fPrompt.inp.value, cron: fCron.inp.value.trim(), enabled: en.selected,
        }),
      })).json();
      if (!res.ok) { status.className = "rt-status err"; status.textContent = res.error || "save failed"; return; }
      dir = res.dir || dir;
      status.className = "rt-status ok";
      status.textContent = res.error ? ("saved · " + res.error) : "saved";
      setTimeout(loadRoutines, 800);
    } catch (e) { status.className = "rt-status err"; status.textContent = "save failed"; }
  });

  run.addEventListener("click", async () => {
    if (!dir) { status.className = "rt-status err"; status.textContent = "save first"; return; }
    status.className = "rt-status"; status.textContent = "running…";
    try {
      const res = await (await fetch("/routines/run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir }),
      })).json();
      status.className = res.ok ? "rt-status ok" : "rt-status err";
      status.textContent = res.ok ? "started — runs in the background" : (res.error || "failed");
    } catch (e) { status.className = "rt-status err"; status.textContent = "failed"; }
  });

  let armed = false;
  del.addEventListener("click", async () => {
    if (!dir) { d.remove(); return; }
    if (!armed) {
      armed = true; del.textContent = "Confirm delete"; del.classList.add("armed");
      setTimeout(() => { armed = false; del.textContent = "Delete"; del.classList.remove("armed"); }, 3000);
      return;
    }
    try {
      await fetch("/routines/delete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir }),
      });
      loadRoutines();
    } catch (e) {}
  });
  return d;
}
function renderRoutines(list) {
  const body = $("#routinesBody");
  body.innerHTML = "";
  setCount("#nRoutines", list);
  if (!list.length) {
    body.appendChild(el("div", "qa-note", "No routines yet. Use “+ new routine” below."));
  }
  list.forEach((r) => body.appendChild(buildRoutineForm(r, false)));
}
async function loadRoutines() {
  try {
    const u = await (await fetch("/routines")).json();
    renderRoutines(u.routines || []);
  } catch (_) { renderRoutines([]); }
}
$("#routineNew").addEventListener("click", () => {
  const card = buildRoutineForm({ name: "", description: "", prompt: "", cron: "", enabled: false, dir: "" }, true);
  $("#routinesBody").prepend(card);
});

/* ---------- watchers panel (harness watchers/: launchd "ping me when X" jobs) ---------- */
function buildWatcherCard(w) {
  const d = el("details", "routine");
  const s = el("summary");
  s.appendChild(el("span", "rname", esc(w.name)));
  const state = w.loaded ? "● watching" : (w.expired ? "○ expired" : "○ off");
  s.appendChild(el("span", "rdot " + (w.loaded ? "on" : "off"), state));
  const meta = [w.every ? "every " + w.every : "", w.expires ? "expires " + w.expires : "never expires"]
    .filter(Boolean).join(" · ");
  const line = [w.subject || w.description, meta].filter(Boolean).join("  ·  ");
  if (line) s.appendChild(el("div", "rdesc", esc(line)));
  d.appendChild(s);

  const form = el("form");
  form.addEventListener("submit", (e) => e.preventDefault());
  if (w.description && w.subject) form.appendChild(el("div", "rt-hint", esc(w.description)));
  form.appendChild(el("div", "wt-poll", esc(w.last_poll ? "last poll: " + w.last_poll : "never run")));

  const fExp = rtField("self-disarm date (UTC, blank = never)", "input", w.expires || "", "YYYY-MM-DD");
  form.appendChild(fExp.wrap);

  const actions = el("div", "rt-actions");
  const toggle = el("button", null, w.loaded ? "Disable" : "Enable");
  const run = el("button", null, "Poll now");
  const saveExp = el("button", null, "Save expiry");
  const log = el("button", null, "Log");
  const del = el("button", "rt-del", "Delete");
  [toggle, run, saveExp, log, del].forEach((b) => { b.type = "button"; actions.appendChild(b); });
  form.appendChild(actions);
  const status = el("div", "rt-status", "");
  form.appendChild(status);
  const logPre = el("pre", "wt-log");
  logPre.hidden = true;
  form.appendChild(logPre);
  d.appendChild(form);

  const post = async (url, body) => (await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })).json();
  const setStatus = (cls, text) => { status.className = "rt-status" + (cls ? " " + cls : ""); status.textContent = text; };

  toggle.addEventListener("click", async () => {
    setStatus("", w.loaded ? "disabling…" : "enabling…");
    try {
      const res = await post("/watchers/toggle", { name: w.name, enabled: !w.loaded });
      if (!res.ok) { setStatus("err", res.error || "failed"); return; }
      setStatus("ok", w.loaded ? "disabled" : "enabled");
      setTimeout(loadWatchers, 600);
    } catch (e) { setStatus("err", "failed"); }
  });

  run.addEventListener("click", async () => {
    setStatus("", "polling…");
    try {
      const res = await post("/watchers/run", { name: w.name });
      if (res.ok) setStatus("ok", "poll started, check the log in a moment");
      else setStatus("err", res.error || "failed");
    } catch (e) { setStatus("err", "failed"); }
  });

  saveExp.addEventListener("click", async () => {
    setStatus("", "saving…");
    try {
      const res = await post("/watchers/expiry", { name: w.name, expires: fExp.inp.value.trim() });
      if (!res.ok) { setStatus("err", res.error || "save failed"); return; }
      setStatus("ok", "saved");
      setTimeout(loadWatchers, 600);
    } catch (e) { setStatus("err", "save failed"); }
  });

  log.addEventListener("click", async () => {
    if (!logPre.hidden) { logPre.hidden = true; return; }
    logPre.textContent = "loading…"; logPre.hidden = false;
    try {
      const res = await (await fetch("/watchers/log/" + encodeURIComponent(w.name))).json();
      logPre.textContent = res.log || res.error || "(empty)";
    } catch (e) { logPre.textContent = "could not read the log"; }
    logPre.scrollTop = logPre.scrollHeight;
  });

  let armed = false;
  del.addEventListener("click", async () => {
    if (!armed) {
      armed = true; del.textContent = "Confirm delete"; del.classList.add("armed");
      setTimeout(() => { armed = false; del.textContent = "Delete"; del.classList.remove("armed"); }, 3000);
      return;
    }
    try {
      await post("/watchers/delete", { name: w.name });
      loadWatchers();
    } catch (e) {}
  });
  return d;
}
function renderWatchers(list) {
  const body = $("#watchersBody");
  body.innerHTML = "";
  setCount("#nWatchers", list);
  if (!list.length) {
    body.appendChild(el("div", "qa-note", "No watchers yet. Ask MIST in chat to build one."));
  }
  list.forEach((w) => body.appendChild(buildWatcherCard(w)));
}
async function loadWatchers() {
  try {
    const u = await (await fetch("/watchers")).json();
    renderWatchers(u.watchers || []);
  } catch (_) { renderWatchers([]); }
}

/* ---------- collapsible settings sections ---------- */
(function wireCollapsibleSettings() {
  document.querySelectorAll("#capPanel .capBody h4").forEach((h, i) => {
    // Key by the section's title text, not its index: inserting a new section
    // used to shift every saved collapse state one slot over.
    const key = "capCollapsed:" + ((h.childNodes[0] && h.childNodes[0].textContent.trim()) || i);
    if (localStorage.getItem(key) === "1") h.classList.add("collapsed");
    h.addEventListener("click", () => {
      const collapsed = h.classList.toggle("collapsed");
      try { localStorage.setItem(key, collapsed ? "1" : "0"); } catch (_) {}
    });
  });
})();

/* ---------- quick access (double-tap Option) ---------- */
async function loadQuickAccess() {
  try {
    const cfg = await (await fetch("/quick-access")).json();
    $("#qaEnabled").selected = !!cfg.enabled;   // md-switch: `selected`, not `checked`
    // Platform builds may report their own gesture (e.g. Ctrl+Alt+Space on
    // Windows); without these fields the macOS copy in index.html stands.
    if (cfg.gesture_label) {
      const g = document.querySelector(".qa-gesture");
      if (g) g.textContent = cfg.gesture_label;
    }
    if (cfg.note) {
      const n = document.querySelector(".qa-note");
      if (n) n.textContent = cfg.note;
    }
  } catch (_) {}
  refreshQaPerm();
}
async function refreshQaPerm() {
  try {
    const d = await (await fetch("/quick-access/diag")).json();
    $("#qaPermRow").hidden = d.ax_trusted === true;
  } catch (_) {}
}
$("#qaEnabled").addEventListener("change", (e) => {
  fetch("/quick-access", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: e.target.selected }),
  }).catch(() => {});
});
$("#qaGrant").addEventListener("click", async () => {
  try { await fetch("/quick-access/request-permission", { method: "POST" }); } catch (_) {}
  setTimeout(refreshQaPerm, 1500);
});
loadQuickAccess();
$("#capClose").addEventListener("click", () => { $("#capPanel").hidden = true; });
// Drop the menu directly under the element that opened it (the badge or button),
// so the selection UI belongs to its trigger instead of floating in the corner.
// Clamp to the viewport so a left-edge trigger can't push the menu off-screen.
// Every badge-anchored card in the top bar. One list so a new card can't be
// forgotten by an opener that hides its siblings one id at a time.
const ANCHORED_CARDS = [
  { card: "#modelCard", trigger: "#model" },
  { card: "#permCard",  trigger: "#perm"  },
  { card: "#thinkCard", trigger: "#think" },
  { card: "#ctxCard",   trigger: "#ctx"   },
  { card: "#shareCard", trigger: "#shareBtn" },
];
function closeAnchoredCards(except) {
  ANCHORED_CARDS.forEach(({ card }) => {
    if (card === except) return;
    const c = $(card);
    if (c) c.hidden = true;
  });
}
function anchorCard(card, trigger) {
  // getBoundingClientRect() and innerWidth are unzoomed viewport px; style.left
  // and offsetWidth are zoomed CSS px. They only agree at 100%, so at any other
  // text size (applyTextSize sets `zoom` on <html>) an uncorrected left/top puts
  // the card visibly off its badge. Clamp in viewport px, divide by the measured
  // zoom on the way out. Measured off the element so it degrades to 1 when unset.
  card.style.left = "0px";
  card.style.top = "0px";
  const cr = card.getBoundingClientRect();
  // Engines disagree on whether rects include the root's CSS zoom: Chromium and
  // upstream WebKit scale them (zr == the applied zoom), but Apple's SHIPPED
  // WKWebView reports unzoomed rects while still painting zoomed pixels (probed
  // on this machine 2026-08-23: a 330px fixed div at zoom 1.15 measures 330).
  // window.innerWidth is real pixels either way, so a clamp that mixes the two
  // spaces lets right-anchored cards hang past the window edge at any text size
  // other than 100%. Express the window edge in rect units before clamping:
  //   zr = rect px per CSS px (measured), ze = the zoom actually painted,
  //   vw = the window's right edge in the same units the rects use.
  const zr = (card.offsetWidth && cr.width / card.offsetWidth) || 1;
  const ze = parseFloat(document.documentElement.style.zoom) || 1;
  const vw = window.innerWidth * zr / ze;
  const r = trigger.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left, vw - cr.width - 8));
  card.style.left = (left - cr.left) / zr + "px";
  // Under the trigger by default. The share button lives in the composer at the
  // bottom of the window, where "under" is off-screen, so flip above it when the
  // card doesn't fit below and does fit above. Same rect-unit ruler as vw.
  const vh = window.innerHeight * zr / ze;
  const below = r.bottom + 4;
  const above = r.top - 4 - cr.height;
  const top = (below + cr.height > vh - 8 && above >= 8) ? above : below;
  card.style.top = (top - cr.top) / zr + "px";
  card.style.right = "auto";
  // Feedback pass against the same vw ruler: measure the RESULT and pull the
  // card back inside when the right edge still overflows.
  const after = card.getBoundingClientRect();
  const over = after.right - vw + 8;
  if (over > 0) card.style.left = Math.max(8, parseFloat(card.style.left) - over / zr) + "px";
}
function openModelCard(ev) {
  const card = $("#modelCard");
  if (!card.hidden) { card.hidden = true; return; }   // click the trigger again to dismiss
  closeAnchoredCards("#modelCard");
  renderModelCard();
  card.hidden = false;
  anchorCard(card, (ev && ev.currentTarget) || $("#model"));
}
$("#modelClose").addEventListener("click", () => { $("#modelCard").hidden = true; });
// The model info badge doubles as the switcher (the old dedicated toolbar button
// was redundant with this, so it's gone).
$("#model").addEventListener("click", openModelCard);

// The perm info badge opens the permission-mode picker.
function openPermCard(ev) {
  const card = $("#permCard");
  if (!card.hidden) { card.hidden = true; return; }   // click the trigger again to dismiss
  closeAnchoredCards("#permCard");
  renderPermCard();
  card.hidden = false;
  anchorCard(card, (ev && ev.currentTarget) || $("#perm"));
}
$("#perm").addEventListener("click", openPermCard);
$("#permClose").addEventListener("click", () => { $("#permCard").hidden = true; });

// The think badge opens the thinking-depth picker.
function openThinkCard(ev) {
  const card = $("#thinkCard");
  if (!card.hidden) { card.hidden = true; return; }   // click the trigger again to dismiss
  closeAnchoredCards("#thinkCard");
  renderThinkCard();
  card.hidden = false;
  anchorCard(card, (ev && ev.currentTarget) || $("#think"));
}
$("#think").addEventListener("click", openThinkCard);
$("#thinkClose").addEventListener("click", () => { $("#thinkCard").hidden = true; });

// The ctx badge opens the context breakdown (the CLI's own /context data) with
// a "compact now" button, instead of being a bare number.
function openCtxCard(ev) {
  const card = $("#ctxCard");
  if (!card.hidden) { card.hidden = true; return; }
  closeAnchoredCards("#ctxCard");
  renderCtxCard();
  card.hidden = false;
  anchorCard(card, (ev && ev.currentTarget) || $("#ctx"));
}
async function renderCtxCard() {
  const body = $("#ctxBody");
  const s = activeId && sessions.get(activeId);
  if (!s) { body.textContent = "no chat"; return; }
  const row = (k, v) => {
    const r = el("div", "ctx-row");
    r.appendChild(el("span", null, esc(k)));
    r.appendChild(el("span", "ctx-n", esc(v)));
    body.appendChild(r);
  };
  body.innerHTML = "";
  row("loading…", "");
  let j;
  try { j = await (await fetch("/sessions/" + s.id + "/context")).json(); }
  catch (e) { body.innerHTML = ""; row("unavailable", String(e)); return; }
  body.innerHTML = "";
  if (!j.ok) {
    row(j.dormant ? "backend dormant" : "unavailable",
        j.dormant ? "last known " + (s.ctxPct == null ? "—" : s.ctxPct + "%") : (j.error || ""));
    if (j.dormant) body.appendChild(el("div", "e-desc", "The breakdown needs a live backend; send a message (or compact) to wake it."));
    return;
  }
  const u = j.usage || {};
  const cats = Array.isArray(u.categories) ? u.categories : [];
  const used = cats.reduce((a, c) => a + ((c && c.kind !== "free" && c.tokens) || 0), 0);
  const win = u.contextWindow || u.context_window || u.maxTokens || s.ctxWindow || 0;
  if (win) {
    row("used", used.toLocaleString() + " / " + win.toLocaleString());
    const bar = el("div", "ctx-bar");
    const fill = el("i");
    fill.style.width = Math.min(100, used / win * 100).toFixed(1) + "%";
    bar.appendChild(fill);
    body.appendChild(bar);
  }
  cats.filter((c) => c && c.tokens).sort((a, b) => b.tokens - a.tokens)
    .forEach((c) => row(String(c.name || "?"), Number(c.tokens).toLocaleString()));
  Object.keys(u).forEach((k) => {
    if (k === "categories" || typeof u[k] !== "number" || /window|max/i.test(k)) return;
    row(k.replace(/([A-Z])/g, " $1").toLowerCase(), Number(u[k]).toLocaleString());
  });
  if (!cats.length) row("no breakdown", "the CLI returned nothing");
}
$("#ctx").addEventListener("click", openCtxCard);
$("#ctxClose").addEventListener("click", () => { $("#ctxCard").hidden = true; });
$("#ctxRefresh").addEventListener("click", () => renderCtxCard());
$("#ctxCompact").addEventListener("click", () => {
  $("#ctxCard").hidden = true;
  const s = activeId && sessions.get(activeId);
  if (s) s.compact();
});

/* ---------- MCP panel (settings) ----------
   The live server list from the active chat's backend (mcp_status), with the
   actions the TUI's /mcp screen has: reconnect, enable/disable, authenticate.
   A dormant chat shows its last init snapshot, flagged as such. */
async function loadMcpPanel() {
  const s = activeId && sessions.get(activeId);
  const body = $("#mcpBody");
  if (!s || !body) return;
  let j;
  try { j = await (await fetch("/sessions/" + s.id + "/mcp")).json(); }
  catch (_) { body.innerHTML = ""; body.appendChild(el("div", "mcp-stale", "couldn't reach the server")); return; }
  const list = Array.isArray(j.servers) ? j.servers : [];
  body.innerHTML = "";
  setCount("#nMcp", list);
  if (!j.live) {
    body.appendChild(el("div", "mcp-stale", list.length
      ? "backend dormant · states are from its last start; an action below wakes it"
      : "no backend yet · send a message to load the server list"));
  }
  list.forEach((sv) => {
    const name = typeof sv === "string" ? sv : String(sv.name || "");
    const st = (typeof sv === "object" && sv.status) ? String(sv.status) : "unknown";
    const row = el("div", "mcp-row");
    row.appendChild(el("span", "mcp-name", esc(name)));
    row.appendChild(el("span", "mcp-state " + st.toLowerCase().replace(/[^a-z-]/g, ""), esc(st)));
    const act = (label, action, extra) => {
      const b = el("button", null, label);
      b.type = "button";
      b.addEventListener("click", async () => {
        b.disabled = true; b.textContent = "…";
        try {
          const r = await fetch("/sessions/" + s.id + "/mcp/" + action, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(Object.assign({ server: name }, extra || {})),
          });
          const x = await r.json();
          if (!x.ok) s.notice("MCP " + action + " " + name + ": " + (x.error || "failed"), true);
          else if (x.response && x.response.url) openExternal(x.response.url);
        } catch (e) { s.notice("MCP " + action + " " + name + ": " + e, true); }
        loadMcpPanel();
      });
      row.appendChild(b);
    };
    if (/disabled/i.test(st)) act("enable", "toggle", { enabled: true });
    else { act("reconnect", "reconnect"); act("disable", "toggle", { enabled: false }); }
    if (/auth|failed/i.test(st)) act("auth", "authenticate");
    body.appendChild(row);
  });
}

/* ---------- overlay dismissal (Escape + outside click) ----------
   One ladder for every overlay: Esc closes the topmost open one (anchored cards
   first, then the side panels). The composer's own keydown calls this before
   its interrupt fallback; this document-level listener covers everywhere else. */
function closeTopOverlay() {
  if (closeRailDrawer()) return true;   // phone: the chat drawer sits over everything
  // #ctxMenu first: Esc should dismiss the right-click menu before any panel it
  // may be floating over.
  for (const id of ["#ctxMenu", "#modelCard", "#permCard", "#thinkCard", "#ctxCard", "#shareCard", "#capPanel", "#notesPanel"]) {
    const p = $(id);
    if (p && !p.hidden) { p.hidden = true; return true; }
  }
  return false;
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  if (e.target === input) return;   // the composer handler owns Esc there
  // field editors (rename, note edit, routine forms) handle their own Esc
  if (e.target.closest && e.target.closest("input, textarea, [contenteditable]")) return;
  if (closeTopOverlay()) e.preventDefault();
});
// The two anchored cards also dismiss on a click anywhere outside them.
document.addEventListener("pointerdown", (e) => {
  const t = e.target;
  ANCHORED_CARDS.forEach(({ card, trigger }) => {
    const c = $(card);
    if (c && !c.hidden && !(t.closest && t.closest(card + ", " + trigger))) c.hidden = true;
  });
});

// The repo badge lets you point MIST at a different repo/folder to work in.
$("#repo").addEventListener("click", async () => {
  let dir = "";
  try {
    if (window.pywebview && window.pywebview.api && window.pywebview.api.pick_folder) {
      dir = await window.pywebview.api.pick_folder();
    } else {
      dir = prompt("Full path to the repo/folder MIST should work in:", "") || "";
    }
  } catch (_) {}
  dir = (dir || "").trim();
  if (!dir) return;
  try {
    const r = await fetch("/workspace", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: dir, session: activeId }),
    });
    const j = await r.json();
    if (!j.ok) {
      if (activeId) sessions.get(activeId).notice("Couldn't switch repo: " + (j.error || "not a folder"), true);
      return;
    }
    refreshRepo();
    if (activeId) sessions.get(activeId).notice(
      "Now working in " + (j.short || dir) + ". This chat starts fresh there on your next message; new chats still open in the harness.");
  } catch (e) {
    if (activeId) sessions.get(activeId).notice("Repo switch failed: " + e, true);
  }
});

const hiddenFile = $("#hiddenFile");
$("#fileBtn").addEventListener("click", async () => {
  try {
    if (window.pywebview && window.pywebview.api && window.pywebview.api.pick_file) {
      insertPaths(await window.pywebview.api.pick_file());
    } else { hiddenFile.accept = isTouch() ? "image/*" : ""; hiddenFile.click(); }
  } catch (e) { if (activeId) sessions.get(activeId).notice("File picker error: " + e, true); }
});
hiddenFile.addEventListener("change", () => {
  const files = Array.from(hiddenFile.files);
  const img = files.find((f) => /^image\//.test(f.type || ""));
  // A phone has no paths MIST could read; a picked photo becomes the pending
  // image attachment instead, exactly like a pasted screenshot on the Mac.
  if (img && isTouch()) attachImageFile(img);
  else insertPaths(files.map((f) => f.name));
  hiddenFile.value = "";
});

/* ---------- jump to present ---------- */
if (jumpBtn) {
  jumpBtn.addEventListener("click", () => {
    const s = activeId && sessions.get(activeId);
    if (s) s.scroll(true);   // re-arm following and snap to the latest
  });
}

/* ---------- collapsible tab rail ---------- */
(function () {
  const toggle = $("#railToggle");
  if (!toggle) return;
  const mid = $("#mid");
  const apply = (collapsed) => {
    mid.classList.toggle("rail-collapsed", collapsed);
    // A chevron, not the panel glyph: the control is now an 11px nub on the
    // rail's edge, and it points the way the rail will move.
    toggle.innerHTML = '<span class="msi">' + (collapsed ? "chevron_right" : "chevron_left") + "</span>";
    toggle.title = collapsed ? "Show the chat list" : "Hide the chat list";
  };
  apply(localStorage.getItem("railCollapsed") === "1");
  toggle.addEventListener("click", () => {
    const collapsed = !mid.classList.contains("rail-collapsed");
    apply(collapsed);
    localStorage.setItem("railCollapsed", collapsed ? "1" : "0");
  });
})();

/* ---------- resizable tab rail ---------- */
(function () {
  const handle = $("#railResize");
  const root = document.documentElement;
  const DEFAULT = 196, MIN = 120, MAX = 560;
  const saved = parseInt(localStorage.getItem("railW") || "", 10);
  if (saved >= MIN && saved <= MAX) root.style.setProperty("--rail-w", saved + "px");
  let dragging = false;
  handle.addEventListener("mousedown", (e) => {
    dragging = true; handle.classList.add("dragging");
    document.body.classList.add("col-resizing"); e.preventDefault();
  });
  // Coalesce drag updates to one layout per animation frame. Without this, every
  // mousemove (dozens per frame) rewrote --rail-w and reflowed the whole
  // transcript synchronously, which is what made dragging the divider stutter.
  let pendingX = null, rafId = 0;
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    pendingX = e.clientX;
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      root.style.setProperty("--rail-w", Math.max(MIN, Math.min(MAX, pendingX)) + "px");
    });
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false; handle.classList.remove("dragging");
    document.body.classList.remove("col-resizing");
    const cur = parseInt(getComputedStyle(root).getPropertyValue("--rail-w"), 10);
    if (cur) localStorage.setItem("railW", cur);
  });
  handle.addEventListener("dblclick", () => {
    root.style.setProperty("--rail-w", DEFAULT + "px");
    localStorage.setItem("railW", DEFAULT);
  });
})();

/* ---------- quick-entry hand-off ---------- */
async function pollPending() {
  try {
    const j = await (await fetch("/pending-open")).json();
    if (!j.id) return;
    if (!sessions.has(j.id)) {
      const list = await (await fetch("/sessions")).json();
      const info = list.find((x) => x.id === j.id) || {};
      sessions.set(j.id, new Session(j.id, info.title, info));
    }
    switchTo(j.id);
  } catch (_) {}
}
window.__syncPending = pollPending;     // called when the main window is surfaced
setInterval(pollPending, 1500);

/* ---------- copy buttons + external links (event delegation) ---------- */
function openExternal(href) {
  try {
    if (window.pywebview && window.pywebview.api && window.pywebview.api.open_url) {
      window.pywebview.api.open_url(href);
      return;
    }
  } catch (_) {}
  window.open(href, "_blank", "noopener");
}
// Copy a gallery image into ~/Downloads server-side (no browser round-trip) and
// flash a confirmation on the button. `src` is the "/file?path=ENC" URL; the
// backend re-validates the path against its allowlist.
async function saveToDownloads(src, btn) {
  if (!src) return;
  const qs = new URLSearchParams(src.slice(src.indexOf("?") + 1));
  const path = qs.get("path");
  if (!path) return;
  const at = Number(qs.get("at")) || undefined;
  const isText = btn && btn.classList.contains("lightbox-btn");
  const orig = isText && btn ? btn.textContent : "";
  let ok = false;
  try {
    const r = await fetch("/save-to-downloads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, at }),
    });
    ok = r.ok;
  } catch (_) { ok = false; }
  if (!btn) return;
  if (isText) {
    btn.textContent = ok ? "Saved ✓" : "Failed";
    setTimeout(() => { btn.textContent = orig; }, 1500);
  } else {
    btn.classList.add(ok ? "saved" : "save-err");
    setTimeout(() => btn.classList.remove("saved", "save-err"), 1500);
  }
}
// Full-size preview overlay for generated images. Click image -> open here;
// Download copies the file into ~/Downloads (same as the corner button).
function openLightbox(src) {
  if (!src) return;
  const ov = el("div", "lightbox");
  const bar = el("div", "lightbox-bar");
  const dlBtn = el("button", "lightbox-btn", "Download");
  const closeBtn = el("button", "lightbox-btn", "Close");
  bar.appendChild(dlBtn); bar.appendChild(closeBtn);
  const img = el("img", "lightbox-img");
  img.src = src;
  ov.appendChild(bar); ov.appendChild(img);
  const shut = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (ev) => { if (ev.key === "Escape") shut(); };
  ov.addEventListener("click", (ev) => { if (ev.target === ov) shut(); });
  closeBtn.addEventListener("click", shut);
  dlBtn.addEventListener("click", (ev) => { ev.stopPropagation(); saveToDownloads(src, dlBtn); });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(ov);
}
/* ---------- recipe interactions ----------
   Clicks are delegated (transcript DOM is rebuilt on every stream delta) and
   handled for BOTH the transcript and the cooking overlay via handleRecipeClick.
   The 1s ticker advances running timers and rehydrates chips/checkboxes after
   any rebuild, so state never lives in the DOM. */
function toggleTimer(id, dur) {
  const t = timerState(id, dur);
  // Prime the audio context inside this click: WebKit only unlocks audio started
  // from a user gesture, and the chime itself fires later from a timer tick.
  try {
    const ctx = timerChime._ctx || (timerChime._ctx = new (window.AudioContext || window.webkitAudioContext)());
    if (ctx.state === "suspended") ctx.resume();
  } catch (_) {}
  if (t.state === "idle") { t.endAt = Date.now() + t.remaining * 1000; t.state = "running"; }
  else if (t.state === "running") {
    t.remaining = Math.max(0, (t.endAt - Date.now()) / 1000); t.state = "paused";
  } else if (t.state === "paused") { t.endAt = Date.now() + t.remaining * 1000; t.state = "running"; }
  else { t.state = "idle"; t.remaining = t.dur; t.endAt = null; }   // done -> reset
  paintTimers();
}
function resetTimer(id) {
  const t = recipeTimers.get(id);
  if (t) { t.state = "idle"; t.remaining = t.dur; t.endAt = null; paintTimers(); }
}
// A user-started timer finishing is asked-for sound: a short, quiet chime, not
// speech. WebAudio needs no asset and no permissions; failure is silent.
function timerChime() {
  try {
    const ctx = timerChime._ctx || (timerChime._ctx = new (window.AudioContext || window.webkitAudioContext)());
    [0, 0.22, 0.44].forEach((at, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = i === 2 ? 1318 : 988;   // B5 B5 E6
      o.connect(g); g.connect(ctx.destination);
      const t0 = ctx.currentTime + at;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + (i === 2 ? 0.5 : 0.16));
      o.start(t0); o.stop(t0 + 0.55);
    });
  } catch (_) {}
}
function paintTimers() {
  document.querySelectorAll("[data-rt]").forEach((chip) => {
    const t = recipeTimers.get(chip.getAttribute("data-rt"));
    if (!t) return;
    chip.className = "rt-chip " + t.state + (chip.classList.contains("rt-big") ? " rt-big" : "");
    const clock = chip.querySelector(".rt-clock");
    if (clock) clock.textContent = timerClockText(t);
    let reset = chip.querySelector(".rt-reset");
    if (t.state === "idle" && reset) reset.remove();
    if (t.state !== "idle" && !reset) {
      reset = el("span", "rt-reset msi", "close");
      reset.title = "Reset";
      chip.appendChild(reset);
    }
  });
}
function paintChecks() {
  document.querySelectorAll(".rc-ing[data-ing]").forEach((row) => {
    const on = recipeChecks.has(row.getAttribute("data-ing"));
    row.classList.toggle("checked", on);
    const box = row.querySelector(".rc-box");
    if (box) box.textContent = on ? "check_box" : "check_box_outline_blank";
  });
}
setInterval(() => {
  let anyDone = false;
  recipeTimers.forEach((t) => {
    if (t.state === "running" && t.endAt - Date.now() <= 0) { t.state = "done"; anyDone = true; }
  });
  if (anyDone) timerChime();
  if (document.querySelector("[data-rt], .rc-ing")) { paintTimers(); paintChecks(); }
}, 1000);
function handleRecipeClick(e) {
  const reset = e.target.closest(".rt-reset");
  if (reset) { e.stopPropagation(); resetTimer(reset.closest("[data-rt]").getAttribute("data-rt")); return true; }
  const chip = e.target.closest("[data-rt]");
  if (chip) { toggleTimer(chip.getAttribute("data-rt"), +chip.getAttribute("data-dur") || 60); return true; }
  const ing = e.target.closest(".rc-ing[data-ing]");
  if (ing) {
    const key = ing.getAttribute("data-ing");
    recipeChecks.has(key) ? recipeChecks.delete(key) : recipeChecks.add(key);
    paintChecks(); return true;
  }
  const cook = e.target.closest("[data-cook]");
  if (cook) { openCookMode(cook.getAttribute("data-cook")); return true; }
  return false;
}

/* ---------- cooking mode ----------
   One step at a time, big type, its timer front and center, ingredient drawer.
   Chips share ids with the transcript card, so a timer started in the card is
   already ticking here and vice versa. Esc closes (captured before the
   composer's interrupt Esc); ←/→ or space step; the screen stays awake where
   the WebView allows it. */
let _cook = null;   // {rid, idx, wakeLock}
function openCookMode(rid, idx) {
  const r = recipeData.get(rid);
  if (!r) return;
  if (!_cook) {
    document.body.appendChild(el("div", null, "")).id = "cookMode";
    document.addEventListener("keydown", cookKeys, true);
  }
  _cook = { rid, idx: idx || 0, wakeLock: null, showIngs: false };
  try {   // best-effort: not every WebView grants it, and that's fine
    navigator.wakeLock && navigator.wakeLock.request("screen")
      .then((wl) => { if (_cook) _cook.wakeLock = wl; }).catch(() => {});
  } catch (_) {}
  renderCookMode();
}
function closeCookMode() {
  const o = $("#cookMode");
  if (o) o.remove();
  document.removeEventListener("keydown", cookKeys, true);
  try { _cook && _cook.wakeLock && _cook.wakeLock.release(); } catch (_) {}
  _cook = null;
}
function cookKeys(e) {
  if (!_cook) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeCookMode(); }
  else if (e.key === "ArrowRight" || e.key === " ") { e.preventDefault(); cookStep(1); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); cookStep(-1); }
}
function cookStep(d) {
  const r = _cook && recipeData.get(_cook.rid);
  if (!r) return;
  _cook.idx = Math.max(0, Math.min((r.steps || []).length - 1, _cook.idx + d));
  renderCookMode();
}
function renderCookMode() {
  const o = $("#cookMode");
  const r = _cook && recipeData.get(_cook.rid);
  if (!o || !r) return;
  const steps = r.steps || [];
  const i = _cook.idx, last = steps.length - 1;
  const dots = steps.map((_, n) =>
    '<span class="ck-dot' + (n === i ? " on" : n < i ? " past" : "") + '" data-ckgo="' + n + '"></span>').join("");
  o.innerHTML =
    '<div class="ck-head">' +
      '<span class="rc-glyph msi">skillet</span>' +
      '<div class="ck-title">' + esc(r.title || "Recipe") + "</div>" +
      '<button type="button" class="ck-ings-btn' + (_cook.showIngs ? " on" : "") + '" data-ckings="1">' +
        '<span class="msi">grocery</span> ingredients</button>' +
      '<button type="button" class="ck-close" data-ckclose="1" title="Exit cooking mode (Esc)">' +
        '<span class="msi">close</span></button>' +
    "</div>" +
    (_cook.showIngs
      ? '<div class="ck-ings"><ul>' + ingredientRows(_cook.rid, r.ingredients) + "</ul></div>" : "") +
    '<div class="ck-body">' +
      '<div class="ck-count">step ' + (i + 1) + " of " + steps.length + "</div>" +
      '<div class="ck-step">' + stepHTML(_cook.rid, i, steps[i]) + "</div>" +
    "</div>" +
    '<div class="ck-foot">' +
      '<button type="button" class="ck-nav" data-cknav="-1"' + (i === 0 ? " disabled" : "") + ">" +
        '<span class="msi">arrow_back</span> back</button>' +
      '<div class="ck-dots">' + dots + "</div>" +
      '<button type="button" class="ck-nav ck-next" data-cknav="1"' + (i === last ? " disabled" : "") + ">" +
        (i === last ? "enjoy!" : 'next <span class="msi">arrow_forward</span>') + "</button>" +
    "</div>";
  paintTimers(); paintChecks();
}
document.addEventListener("click", (e) => {
  if (!_cook || !e.target.closest("#cookMode")) return;
  if (e.target.closest("[data-ckclose]")) { closeCookMode(); return; }
  if (e.target.closest("[data-ckings]")) { _cook.showIngs = !_cook.showIngs; renderCookMode(); return; }
  const nav = e.target.closest("[data-cknav]");
  if (nav && !nav.disabled) { cookStep(+nav.getAttribute("data-cknav")); return; }
  const dot = e.target.closest("[data-ckgo]");
  if (dot) { _cook.idx = +dot.getAttribute("data-ckgo"); renderCookMode(); return; }
  handleRecipeClick(e);
});

/* Clipboard write with a fallback. 127.0.0.1 counts as a trustworthy origin in
   WebKit so the async API is the path that normally runs, but it still refuses
   without a user gesture, hence the hidden-textarea + execCommand backstop. */
async function copyText(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    const ta = el("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (_) {}
    ta.remove();
    return ok;
  }
}

logs.addEventListener("click", async (e) => {
  if (handleRecipeClick(e)) return;
  const btn = e.target.closest(".copy-btn");
  if (btn) {
    // Tables carry their markdown source on the button; code blocks copy the <pre>.
    const md = btn.getAttribute("data-md");
    const pre = btn.parentElement.querySelector("pre");
    await copyText(md != null ? md : pre ? pre.textContent : "");
    btn.classList.add("copied");
    btn.textContent = "Copied";
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.classList.remove("copied"); btn.textContent = "Copy"; }, 1400);
    return;
  }
  const dlBtn = e.target.closest(".genimg-dl");
  if (dlBtn) {
    e.preventDefault();
    saveToDownloads(dlBtn.getAttribute("data-dl"), dlBtn);
    return;
  }
  const fileCard = e.target.closest(".genfile");
  if (fileCard) {
    e.preventDefault();
    saveToDownloads(fileCard.getAttribute("data-dl"), fileCard);
    return;
  }
  const imgLink = e.target.closest(".imglink");
  if (imgLink) {
    e.preventDefault();
    openLightbox(imgLink.getAttribute("data-full") || imgLink.getAttribute("href"));
    return;
  }
  const link = e.target.closest("a[href]");
  if (link) {
    const href = link.getAttribute("href");
    if (/^https?:/i.test(href)) { e.preventDefault(); openExternal(href); }
  }
});

/* ---------- transcript right-click menu ----------
   WebKit's own menu only ever offers the rendered text. In a chat the thing you
   usually want is the raw markdown of a reply, so we intercept the plain
   right-click and offer that alongside the ordinary Copy. Shift+right-click
   falls through to the native menu (Look Up, Speech, Services, Translate). */
const ctxMenu = $("#ctxMenu");

function hideCtxMenu() {
  if (ctxMenu && !ctxMenu.hidden) { ctxMenu.hidden = true; ctxMenu.innerHTML = ""; return true; }
  return false;
}

/* The markdown source of a whole message. Each rendered `.md` block carries its
   own source on `_mdsrc` (a JS property, not a data- attribute: a transcript runs
   to thousands of nodes and we're not paying DOM weight for it). User messages
   are plain textContent, so innerText round-trips them exactly. */
function messageSource(msg) {
  const blocks = [...msg.querySelectorAll(".body .md")];
  if (blocks.length && blocks.some((b) => typeof b._mdsrc === "string")) {
    return blocks.map((b) => (typeof b._mdsrc === "string" ? b._mdsrc : b.innerText)).join("\n\n").trim();
  }
  const body = msg.querySelector(".body");
  return body ? body.innerText.trim() : "";
}

function selectionInLogs() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const anchor = sel.anchorNode;
  const node = anchor && anchor.nodeType === 3 ? anchor.parentElement : anchor;
  if (!node || !node.closest || !node.closest("#logs")) return null;
  const text = sel.toString();
  return text ? text : null;
}

function openCtxMenu(x, y, items) {
  ctxMenu.innerHTML = "";
  items.forEach((it) => {
    if (it === "-") { ctxMenu.appendChild(el("div", "ctx-sep")); return; }
    const b = el("button", "ctx-item");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.appendChild(el("span", "msi", it.icon));
    b.appendChild(el("span", null, it.label));
    b.addEventListener("click", () => { hideCtxMenu(); it.run(); });
    ctxMenu.appendChild(b);
  });
  // Two rulers are in play and they disagree whenever the text-size control is
  // off 100%, because applyTextSize sets `zoom` on <html>. Event clientX/clientY,
  // getBoundingClientRect() and innerWidth are all unzoomed viewport px; style.left
  // and offsetWidth are zoomed CSS px. So: clamp in viewport px, then divide by
  // the zoom on the way back out. Measuring the ratio off the element beats
  // reading the zoom value, since it degrades to 1 when the property is unset.
  // Reveal only after placing, or the menu flashes at the pre-clamp spot.
  ctxMenu.style.visibility = "hidden";
  ctxMenu.style.left = "0px";
  ctxMenu.style.top = "0px";
  ctxMenu.hidden = false;
  const r = ctxMenu.getBoundingClientRect();
  const z = (ctxMenu.offsetWidth && r.width / ctxMenu.offsetWidth) || 1;
  const left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
  ctxMenu.style.left = (left - r.left) / z + "px";
  ctxMenu.style.top = (top - r.top) / z + "px";
  ctxMenu.style.visibility = "";
}

logs.addEventListener("contextmenu", (e) => {
  if (e.shiftKey) return;            // escape hatch to the native WebKit menu
  const msg = e.target.closest(".msg");
  if (!msg) return;
  e.preventDefault();

  const items = [];
  const selText = selectionInLogs();
  if (selText) items.push({ icon: "content_copy", label: "Copy", run: () => copyText(selText) });

  const pre = e.target.closest(".codeblock, pre");
  if (pre) {
    const code = pre.matches("pre") ? pre : pre.querySelector("pre");
    if (code) items.push({ icon: "code", label: "Copy code block", run: () => copyText(code.textContent) });
  }

  const tbl = e.target.closest(".tableblock");
  const tblBtn = tbl && tbl.querySelector(".copy-btn[data-md]");
  if (tblBtn) {
    items.push({ icon: "table", label: "Copy table",
                 run: () => copyText(tblBtn.getAttribute("data-md")) });
  }

  items.push({ icon: "notes", label: "Copy message", run: () => copyText(messageSource(msg)) });
  const sess = sessions.get(activeId);
  if (sess && msg.parentNode === sess.logEl) {
    items.push("-");
    if (msg.classList.contains("user"))
      items.push({ icon: "edit", label: "Edit & resend", run: () => sess.startEdit(msg) });
    items.push({ icon: "refresh", label: msg.classList.contains("user") ? "Resend (regenerate reply)" : "Regenerate this reply",
                 run: () => sess.regenerate(msg) });
    items.push({ icon: "call_split", label: "Branch from here", run: () => sess.branchAt(msg) });
    items.push("-");
  }
  items.push({
    icon: "select_all", label: "Select message",
    run: () => {
      const body = msg.querySelector(".body") || msg;
      const range = document.createRange();
      range.selectNodeContents(body);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    },
  });

  const link = e.target.closest("a[href]");
  const href = link && link.getAttribute("href");
  if (href && /^https?:/i.test(href)) {
    items.push("-");
    items.push({ icon: "open_in_new", label: "Open link", run: () => openExternal(href) });
    items.push({ icon: "link", label: "Copy link", run: () => copyText(href) });
  }

  // Images and file cards already know how to save themselves; reuse that path.
  // On media the data-dl lives on the corner button, which is a sibling of the
  // <img>/<audio>, so closest() alone misses it when you right-click the media.
  const dlHost = e.target.closest("[data-dl], .genimg-wrap, .genaudio-wrap, .genvideo-wrap");
  const dl = dlHost && (dlHost.matches("[data-dl]") ? dlHost : dlHost.querySelector("[data-dl]"));
  if (dl) {
    const src = dl.getAttribute("data-dl");
    const path = new URLSearchParams(src.slice(src.indexOf("?") + 1)).get("path");
    items.push("-");
    items.push({ icon: "download", label: "Save to Downloads", run: () => saveToDownloads(src, dl) });
    if (path) items.push({ icon: "content_paste", label: "Copy file path", run: () => copyText(path) });
  }

  openCtxMenu(e.clientX, e.clientY, items);
});

// Dismissal: outside click, scroll, window blur. Escape is handled by
// closeTopOverlay, which lists #ctxMenu first so it closes before other panels.
document.addEventListener("pointerdown", (e) => {
  if (!ctxMenu.hidden && !(e.target.closest && e.target.closest("#ctxMenu"))) hideCtxMenu();
}, true);
logs.addEventListener("scroll", hideCtxMenu, true);
window.addEventListener("blur", hideCtxMenu);

/* ---------- boot ---------- */
// Which chat the window opens on. Pinned chats are the ones Alex actually lives
// in, so the app lands on the pinned chat with the freshest activity rather than
// whatever sits at the top of the manual pin order. No pins: fall back to the
// rail's own first row (newest unpinned chat).
function bootChat() {
  const pins = [...sessions.values()].filter((s) => s.pinned);
  if (pins.length) {
    return pins.reduce((best, s) => (s.lastActivity > best.lastActivity ? s : best));
  }
  return sortedSessions()[0];
}
async function boot() {
  try {
    const cfg = await (await fetch("/config")).json();
    if (cfg.spinner_verbs && cfg.spinner_verbs.length) SPINNER_VERBS = cfg.spinner_verbs;
    MODELS = cfg.models || [];
  } catch (_) {}
  const bootList = await fetch("/sessions");
  const existing = await bootList.json();
  _syncSince = parseFloat(bootList.headers.get("X-Now")) || Date.now() / 1000;   // server clock, for syncSessions
  if (existing.length) {
    existing.forEach((info) => sessions.set(info.id, new Session(info.id, info.title, info)));
    switchTo(bootChat().id);
  } else {
    await createSession();
  }
  bootGreeting();
  await migrateLegacyNotes();   // absorb any legacy per-chat notes, once
  await loadNotes();            // hydrate the global notes + badge from disk
  if (!isTouch()) input.focus();   // a phone would open with the keyboard up
}
boot();

/* ---------- keep the rail in step with the other clients ----------
   The phone, quick entry, notification replies and the Mac window all create
   and rename chats on the same server; each page only knew the ones it made
   itself. Every few seconds ask for what changed since the last sync (server
   clock, so phone and Mac clocks never matter) and adopt, update, or drop. */
let _syncSince = null;
let _syncBusy = false;
// One pushed or fetched registry entry -> the local Session. True if the rail changed.
function applySessionMeta(meta) {
  let s = sessions.get(meta.id);
  if (!s) {
    sessions.set(meta.id, new Session(meta.id, meta.title, meta));
    return true;
  }
  let changed = false;
  if (meta.title && s.title !== meta.title) { s.title = meta.title; changed = true; }
  if (s.pinned !== !!meta.pinned) { s.pinned = !!meta.pinned; changed = true; }
  if ((s.pinOrder || 0) !== (meta.pin_order || 0)) { s.pinOrder = meta.pin_order || 0; changed = true; }
  if (s.archived !== !!meta.archived) { s.archived = !!meta.archived; changed = true; }
  const la = (meta.last_activity || 0) * 1000;
  if (la > (s.lastActivity || 0)) { s.lastActivity = la; changed = true; }
  if (!s.init) {   // a dormant chat's badges come from its meta until it speaks
    if (meta.model && s.model !== meta.model) s.model = meta.model;
    if (meta.permission_mode && s.permMode !== meta.permission_mode) s.permMode = meta.permission_mode;
    if (meta.effort !== undefined && s.effort !== (meta.effort || "")) s.effort = meta.effort || "";
  }
  return changed;
}
function dropSession(id) {
  const s = sessions.get(id);
  if (!s) return false;
  s.destroy();
  sessions.delete(id);
  if (activeId === id) {
    const next = sortedSessions()[0];
    if (next) switchTo(next.id);
    else { activeId = null; createSession(); }
  }
  return true;
}
// Catch-up: everything changed since the last sync or pushed event.
async function syncSessions() {
  if (_syncSince == null || _syncBusy) return;
  _syncBusy = true;
  try {
    const r = await fetch("/sessions?since=" + encodeURIComponent(_syncSince));
    if (!r.ok) return;
    const j = await r.json();
    let changed = false;
    for (const meta of (j.sessions || [])) changed = applySessionMeta(meta) || changed;
    for (const id of (j.deleted || [])) changed = dropSession(id) || changed;
    if (typeof j.now === "number") _syncSince = j.now;
    if (changed) renderTabs();
  } catch (_) {
  } finally {
    _syncBusy = false;
  }
}
// The live feed: instant. The server pushes every registry change as it
// happens (whichever client made it). A reconnect runs one catch-up so the
// gap is filled; the 30s poll is the safety net if the feed itself is down.
(function () {
  let es = null, opens = 0;
  const connect = () => {
    if (es) es.close();
    es = new EventSource("/events");
    es.onopen = () => { if (opens++) syncSessions(); };
    es.onmessage = (m) => {
      let ev;
      try { ev = JSON.parse(m.data); } catch (_) { return; }
      let changed = false;
      if (ev.type === "session_created" || ev.type === "session_updated") changed = applySessionMeta(ev.session);
      else if (ev.type === "session_deleted") changed = dropSession(ev.id);
      if (typeof ev.now === "number" && ev.now > (_syncSince || 0)) _syncSince = ev.now;
      if (changed) renderTabs();
    };
  };
  connect();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) syncSessions(); });
})();
setInterval(syncSessions, 30000);

/* ---------- chat search ----------
   Full-text search over every chat's log (server-side FTS index). While a
   query is live the results panel replaces the tab list; clicking a result
   opens that chat. */
const searchBox = $("#chatSearch");
const searchClearBtn = $("#chatSearchClear");
const searchResultsEl = $("#searchResults");
let _searchTimer = null;
let _searchSeq = 0;   // drop stale responses that resolve out of order

// The server wraps matches in \x01…\x02 (chars that can't occur in chat text);
// escape the snippet FIRST, then swap the markers for real <mark> tags.
function markSnippet(s) {
  return esc(s).replace(/\x01/g, "<mark>").replace(/\x02/g, "</mark>");
}

function clearChatSearch(refocus) {
  clearTimeout(_searchTimer);
  _searchSeq++;
  searchBox.value = "";
  searchClearBtn.hidden = true;
  searchResultsEl.hidden = true;
  searchResultsEl.innerHTML = "";
  tabsEl.hidden = false;
  if (refocus) searchBox.focus();
}

function renderSearchResults(groups) {
  searchResultsEl.innerHTML = "";
  if (!groups.length) {
    searchResultsEl.appendChild(el("div", "srEmpty", "no matches"));
    return;
  }
  const thisYear = new Date().getFullYear();
  groups.forEach((g) => {
    const item = el("div", "srItem");
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    const d = new Date(g.last_activity * 1000);
    const date = d.toLocaleDateString([], d.getFullYear() === thisYear
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" });
    item.appendChild(el("div", "srTitle",
      '<span class="srName">' + esc(g.title) + '</span><span class="srDate">' + date + "</span>"));
    g.hits.forEach((h) => {
      item.appendChild(el("div", "srSnip",
        '<span class="srRole">' + (h.role === "user" ? "you" : "mist") + "</span>" + markSnippet(h.snippet)));
    });
    const open = () => { const sid = g.sid; clearChatSearch(false); switchTo(sid); };
    item.addEventListener("click", open);
    item.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); }
    });
    searchResultsEl.appendChild(item);
  });
}

async function runChatSearch() {
  const q = searchBox.value.trim();
  searchClearBtn.hidden = !searchBox.value;
  if (q.length < 2) {
    searchResultsEl.hidden = true;
    searchResultsEl.innerHTML = "";
    tabsEl.hidden = false;
    return;
  }
  const seq = ++_searchSeq;
  try {
    const r = await fetch("/search?q=" + encodeURIComponent(q));
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    if (seq !== _searchSeq) return;   // a newer query is already in flight
    tabsEl.hidden = true;
    searchResultsEl.hidden = false;
    renderSearchResults(data.groups || []);
  } catch (err) {
    // Never fail silently: a 404 here means the detached :5014 server predates
    // the /search route and needs a real restart, not just a window relaunch.
    if (seq !== _searchSeq) return;
    tabsEl.hidden = true;
    searchResultsEl.hidden = false;
    searchResultsEl.innerHTML = "";
    searchResultsEl.appendChild(el("div", "srEmpty",
      "search unavailable (" + esc(String(err && err.message || err)) +
      ") — the Console server needs a restart"));
  }
}

searchBox.addEventListener("input", () => {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(runChatSearch, 250);
});
searchBox.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    ev.stopPropagation();   // clear the search, don't dismiss other overlays
    clearChatSearch(false);
    searchBox.blur();
  } else if (ev.key === "Enter") {
    clearTimeout(_searchTimer);
    runChatSearch();
  }
});
searchClearBtn.addEventListener("click", () => clearChatSearch(true));

/* ---------- share this chat (claude.ai-style public snapshot) ----------
   The share button publishes a read-only, self-contained HTML snapshot of the
   active conversation. Capture happens HERE, client-side: the transcript DOM is
   already pixel-perfect in the page, so we clone it, strip everything
   interactive, inline the stylesheet + local images, and POST the finished
   page to the server. The server keeps the canonical copy (data/shares/) and
   publishes it to a read-only Cloudflare Worker when credentials allow
   (share.py). Thinking + tool cards stay collapsible for free: they're native
   <details> elements, no JS needed in the snapshot. */

const SHARE_INLINE_CSS_ASSETS = ["mist-wall.png"];
const SHARE_PAGE_CSS = `
body.sharepage { display: block; overflow: auto; height: auto; min-height: 100vh; padding: 26px 18px 40px; }
.sharepage .session-log { position: static; overflow: visible; padding: 0; max-width: 860px; margin: 0 auto; }
.share-head { max-width: 860px; margin: 0 auto 26px; display: flex; align-items: center; gap: 14px;
  border-bottom: 1px solid var(--line); padding-bottom: 14px; }
.share-logo { width: 44px; height: 44px; object-fit: contain; }
.share-title { color: var(--teal); font-size: 17px; font-weight: 700; }
.share-sub { color: var(--dim); font-size: 12px; margin-top: 2px; }
.share-foot { max-width: 860px; margin: 34px auto 0; color: var(--dim); font-size: 11px;
  border-top: 1px solid var(--line); padding-top: 12px; }
.share-omitted { border: 1px dashed var(--line); color: var(--dim); font-size: 11px;
  padding: 8px 10px; margin: 6px 0; }
/* The icon font doesn't ship with the snapshot: hide icon spans, swap the
   pseudo-element glyphs for plain characters. */
.msi, md-icon { display: none !important; }
details.tool > summary.tool-head::before, .routine > summary::before { content: "▸"; font-family: inherit; }
details.tool[open] > summary.tool-head::before, .routine[open] > summary::before { content: "▾"; }
.modelrow.sel::before, .capBody h4::before { content: ""; font-family: inherit; }
`;

async function shareFetchDataURL(url, capBytes) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("fetch failed");
  const b = await r.blob();
  if (capBytes && b.size > capBytes) throw new Error("too big");
  return await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(b);
  });
}

let _shareCSSCache = null;
async function shareCSS() {
  if (_shareCSSCache) return _shareCSSCache;
  let css = "";
  for (const f of ["/md-tokens.css", "/style.css"]) {
    css += (await (await fetch(f)).text()) + "\n";
  }
  // Small theme assets ride along as data URIs (the wallpaper). Anything else
  // local would 404 on the share host, so blank it rather than shipping a broken
  // reference; the size cap below also keeps a huge asset out of the snapshot.
  for (const name of SHARE_INLINE_CSS_ASSETS) {
    if (css.indexOf(name) === -1) continue;
    try {
      const d = await shareFetchDataURL("/" + name, 400 * 1024);
      css = css.split('url("' + name + '")').join('url("' + d + '")');
    } catch (_) { /* falls through to the blanket blank below */ }
  }
  css = css.replace(/url\("(?!data:|https?:)[^"]*"\)/g, "none");
  _shareCSSCache = css;
  return css;
}

async function buildShareSnapshot(s) {
  const css = await shareCSS();
  const clone = s.logEl.cloneNode(true);
  clone.removeAttribute("hidden");
  clone.removeAttribute("style");
  // Interactive chrome that has no meaning in a read-only page.
  clone.querySelectorAll(".spinner, .perm-actions, .copy-btn, .rc-cook-btn, .genimg-dl, "
    + ".msg-actions, .msg-edit, .msg-confirm, .notice-actions")
    .forEach((e) => e.remove());
  // Remaining buttons (recipe timer chips, etc.) keep their look, lose their life.
  clone.querySelectorAll("button").forEach((b) => {
    const sp = document.createElement("span");
    sp.className = b.className;
    sp.innerHTML = b.innerHTML;
    b.replaceWith(sp);
  });
  clone.querySelectorAll("audio, video").forEach((m) => {
    const d = document.createElement("div");
    d.className = "share-omitted";
    d.textContent = "media attachment · not included in the shared copy";
    m.replaceWith(d);
  });
  // Local images become data URIs so the page is truly self-contained; remote
  // embeds stay remote. Oversized/unreadable ones degrade to a labeled stub.
  for (const img of Array.from(clone.querySelectorAll("img"))) {
    const src = img.getAttribute("src") || "";
    if (src.startsWith("data:") || /^https?:/i.test(src)) continue;
    try {
      img.src = await shareFetchDataURL(src, 3 * 1024 * 1024);
      img.removeAttribute("loading");
    } catch (_) {
      const d = document.createElement("div");
      d.className = "share-omitted";
      d.textContent = "image · not included in the shared copy";
      img.replaceWith(d);
    }
  }
  clone.querySelectorAll("a[href]").forEach((a) => {
    const h = a.getAttribute("href") || "";
    if (/^https?:/i.test(h)) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
    else { a.removeAttribute("href"); a.removeAttribute("target"); }  // /file, lightbox, local paths
  });
  clone.querySelectorAll("input, textarea, select").forEach((e) => { e.disabled = true; });
  clone.querySelectorAll("[contenteditable]").forEach((e) => e.removeAttribute("contenteditable"));

  const theme = document.documentElement.dataset.theme || "terminal";
  const title = s.title || "MIST Console chat";
  const when = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  // Provenance line: which model wrote this, at what thinking depth. The
  // session's own id wins; a chat that never switched runs the CLI default,
  // which the last init event reported.
  const modelId = s.model || (typeof lastInit !== "undefined" && lastInit && lastInit.model) || "";
  const mEntry = modelId && typeof MODELS !== "undefined" ? MODELS.find((m) => m.id === modelId) : null;
  const modelLabel = (mEntry && mEntry.label) || modelId;
  // The page header can afford the lead-in; the card's footer line cannot, and
  // the date is the part that gets cut when it doesn't fit.
  const provenance = [modelLabel ? "model: " + modelLabel : "",
                      "thinking: " + (s.effort || "default"),
                      "shared " + when].filter(Boolean).join(" · ");
  const subLine = "a conversation with MIST · " + provenance;
  let logo = "", logoSrc = "";
  try {
    logoSrc = await shareFetchDataURL("/mist-logo.png", 300 * 1024);
    logo = '<img class="share-logo" src="' + logoSrc + '" alt="MIST">';
  } catch (_) { /* header just goes logoless */ }
  const html = "<!DOCTYPE html>" +
    '<html lang="en" data-theme="' + esc(theme) + '"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>" + esc(title) + " · MIST Console</title>" +
    "<style>" + css + "\n" + SHARE_PAGE_CSS + "</style></head>" +
    '<body class="sharepage"><header class="share-head">' + logo +
    '<div class="share-headtext"><div class="share-title">' + esc(title) + "</div>" +
    '<div class="share-sub">' + esc(subLine) + "</div></div></header>" +
    '<main class="session-log">' + clone.innerHTML + "</main>" +
    '<footer class="share-foot">read-only snapshot shared from the MIST Console · ' +
    "the live conversation may have moved on</footer></body></html>";
  return { html, title, subLine, cardSub: provenance, logoDataURL: logoSrc };
}

// ---- link previews ---------------------------------------------------------
// Pasted into Discord/Slack/iMessage, a share link should say what the chat is
// rather than showing a bare URL. The description is the opening prompt (what
// the reader is about to walk into) and the card is drawn here, in the live
// page, so it inherits the theme the chat was actually read in.

function shareSummary(s) {
  const first = s.logEl.querySelector(".msg.user .body") || s.logEl.querySelector(".msg .body");
  const text = (first ? first.textContent : "").replace(/\s+/g, " ").trim();
  return text.slice(0, 400);
}

function shareCssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// Greedy wrap, hard-capped at maxLines with an ellipsis on the last one.
function shareWrap(ctx, text, maxWidth, maxLines) {
  const words = (text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    const next = line ? line + " " + w : w;
    if (ctx.measureText(next).width <= maxWidth || !line) { line = next; continue; }
    lines.push(line);
    line = w;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && words.length) {
    let last = lines[maxLines - 1];
    const consumed = lines.join(" ").split(/\s+/).length;
    if (consumed < words.length) {
      while (last && ctx.measureText(last + "…").width > maxWidth) {
        last = last.replace(/\s*\S$/, "");
      }
      lines[maxLines - 1] = last + "…";
    }
  }
  return lines;
}

async function shareCardPNG(title, subLine, snippet, logoDataURL) {
  try {
    const c = document.createElement("canvas");
    c.width = 1200; c.height = 630;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    try { await document.fonts.ready; } catch (_) {}

    const bg = shareCssVar("--bg", "#0b1620");
    const teal = shareCssVar("--teal", "#7fd6c8");
    const text = shareCssVar("--text", "#dfe7ea");
    const dim = shareCssVar("--dim", "#7e8f96");
    const line = shareCssVar("--line", "#2a3b44");
    const font = getComputedStyle(document.body).fontFamily ||
                 "ui-monospace, SFMono-Regular, monospace";

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 1200, 630);
    // Flat and sharp: one accent edge and a hairline, no rounding, no shadow.
    ctx.fillStyle = teal;
    ctx.fillRect(0, 0, 10, 630);

    const L = 84, R = 1116;
    let y = 96;
    let logoW = 0;
    if (logoDataURL) {
      try {
        const img = new Image();
        img.src = logoDataURL;
        await img.decode();
        const h = 54, w = Math.round(h * (img.width / img.height || 1));
        ctx.drawImage(img, L, y - 40, w, h);
        logoW = w + 18;
      } catch (_) { /* wordmark alone is fine */ }
    }
    ctx.fillStyle = teal;
    ctx.font = "700 26px " + font;
    ctx.textBaseline = "alphabetic";
    ctx.fillText("MIST CONSOLE", L + logoW, y);

    y = 236;
    ctx.fillStyle = text;
    ctx.font = "700 56px " + font;
    for (const ln of shareWrap(ctx, title, R - L, 2)) {
      ctx.fillText(ln, L, y);
      y += 70;
    }

    y += 14;
    ctx.fillStyle = dim;
    ctx.font = "400 28px " + font;
    for (const ln of shareWrap(ctx, snippet, R - L, 3)) {
      ctx.fillText(ln, L, y);
      y += 40;
    }

    ctx.fillStyle = line;
    ctx.fillRect(L, 522, R - L, 1);
    ctx.fillStyle = dim;
    ctx.font = "400 24px " + font;
    ctx.fillText(shareWrap(ctx, subLine, R - L, 1)[0] || "", L, 566);

    return c.toDataURL("image/png");
  } catch (_) {
    return null;   // no card just means the embed falls back to title + text
  }
}

function shareCopyText(text) {
  // WKWebView's async clipboard can be moody; execCommand is the reliable fallback.
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(() => shareCopyFallback(text));
  }
  return Promise.resolve(shareCopyFallback(text));
}
function shareCopyFallback(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); } catch (_) {}
  ta.remove();
}

let _shareBusy = false;
function shareAbsoluteLocal(path) { return location.origin + path; }

async function renderShareCard() {
  const body = $("#shareBody");
  const s = activeId && sessions.get(activeId);
  if (!s) { body.innerHTML = '<div class="share-note">Open a chat first.</div>'; return; }
  if (_shareBusy) return;
  body.innerHTML = '<div class="share-note">checking…</div>';
  let st = null;
  try {
    const r = await fetch("/sessions/" + s.id + "/share");
    if (!r.ok && r.status === 404) throw new Error("no-route");
    st = await r.json();
  } catch (_) {
    body.innerHTML = '<div class="share-note err">The running Console server predates share links. ' +
      "Restart it (quit the app, <code>lsof -tiTCP:5014 -sTCP:LISTEN | xargs kill</code>, reopen) to enable sharing.</div>";
    return;
  }
  body.innerHTML = "";
  const note = (cls, html) => { const d = el("div", cls); d.innerHTML = html; body.appendChild(d); return d; };
  const actions = el("div", "share-actions");

  if (!st.shared) {
    note("share-note",
      "Publishes a <b>read-only snapshot</b> of this whole conversation at an unguessable link — " +
      "anyone who has the link can read it. Audio/video stays out; images ride along. " +
      "Pasting the link anywhere that unfurls shows the chat title, its opening prompt " +
      "and a themed card. " +
      "Updating later reuses the same link; you can stop sharing any time.");
    if (!st.cloud || !st.cloud.has_creds) {
      note("share-note", "No Cloudflare share credentials yet, so the link will be <b>local-only</b> " +
        "(viewable on this Mac) until <code>CF_SHARE_API_TOKEN</code> lands in the harness .env. " +
        "MIST can walk you through minting one.");
    }
    const b = el("button", null, "create link");
    b.addEventListener("click", () => doShare(s));
    actions.appendChild(b);
    body.appendChild(actions);
    return;
  }

  const url = st.published && st.url ? st.url : shareAbsoluteLocal(st.local_url);
  const urlBox = el("div", "share-url", url);
  urlBox.title = "Click to copy";
  urlBox.addEventListener("click", async () => {
    await shareCopyText(url);
    urlBox.textContent = "copied ✓";
    setTimeout(() => { urlBox.textContent = url; }, 900);
  });
  body.appendChild(urlBox);
  if (!st.published) {
    const why = (st.reason && st.reason.message) || "";
    note("share-note err", "Not published to the public link yet — this URL only works on this Mac." +
      (why ? "<br>" + esc(why) : ""));
  }
  // What a recipient actually sees when the link unfurls.
  if (st.local_card_url) {
    const prev = el("div", "share-preview");
    const img = document.createElement("img");
    img.src = st.local_card_url + "?t=" + (st.updated || 0);
    img.alt = "link preview card";
    prev.appendChild(img);
    const cap = el("div", "share-preview-cap",
      esc(st.summary || "") || "how this link looks when pasted");
    prev.appendChild(cap);
    body.appendChild(prev);
  }

  const upd = st.updated ? new Date(st.updated * 1000).toLocaleString() : "";
  if (upd) note("share-note", "snapshot from " + esc(upd) + " · new messages aren’t shared until you update");

  const copyB = el("button", null, "copy link");
  copyB.addEventListener("click", () => urlBox.click());
  const openB = el("button", null, "open");
  openB.addEventListener("click", () => window.open(url, "_blank"));
  const updB = el("button", null, st.published ? "update snapshot" : "retry publish");
  updB.addEventListener("click", () => doShare(s));
  const stopB = el("button", "danger", "stop sharing");
  stopB.addEventListener("click", () => doUnshare(s));
  [copyB, openB, updB, stopB].forEach((x) => actions.appendChild(x));
  body.appendChild(actions);
}

async function doShare(s) {
  if (_shareBusy) return;
  _shareBusy = true;
  const body = $("#shareBody");
  body.innerHTML = '<div class="share-note">capturing snapshot…</div>';
  try {
    const snap = await buildShareSnapshot(s);
    const summary = shareSummary(s);
    body.innerHTML = '<div class="share-note">drawing the link preview…</div>';
    const card = await shareCardPNG(snap.title, snap.cardSub, summary, snap.logoDataURL);
    body.innerHTML = '<div class="share-note">publishing…</div>';
    const r = await fetch("/sessions/" + s.id + "/share", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html: snap.html, title: s.title || "", summary, card }),
    });
    const j = await r.json();
    _shareBusy = false;
    if (!j.ok) {
      body.innerHTML = '<div class="share-note err">' + esc(j.error || "share failed") + "</div>";
      return;
    }
    await renderShareCard();
    // Fresh link in hand: put it on the clipboard right away.
    const link = j.published && j.url ? j.url : shareAbsoluteLocal(j.local_url);
    shareCopyText(link);
  } catch (e) {
    _shareBusy = false;
    body.innerHTML = '<div class="share-note err">' + esc(String(e && e.message || e)) + "</div>";
  }
}

async function doUnshare(s) {
  if (_shareBusy) return;
  _shareBusy = true;
  const body = $("#shareBody");
  body.innerHTML = '<div class="share-note">removing the public copy…</div>';
  try {
    const r = await fetch("/sessions/" + s.id + "/share", { method: "DELETE" });
    const j = await r.json();
    _shareBusy = false;
    if (!j.ok) {
      body.innerHTML = '<div class="share-note err">' + esc(j.error || "couldn’t revoke") +
        "<br>The share is still live; try again.</div>";
      return;
    }
    await renderShareCard();
  } catch (e) {
    _shareBusy = false;
    body.innerHTML = '<div class="share-note err">' + esc(String(e && e.message || e)) + "</div>";
  }
}

function openShareCard(ev) {
  const card = $("#shareCard");
  if (!card.hidden) { card.hidden = true; return; }
  closeAnchoredCards("#shareCard");
  card.hidden = false;
  const trigger = (ev && ev.currentTarget) || $("#shareBtn");
  anchorCard(card, trigger);
  // The status fetch changes the card's size; re-anchor once content settles.
  renderShareCard().then(() => { if (!card.hidden) anchorCard(card, trigger); });
}
$("#shareBtn").addEventListener("click", openShareCard);
$("#shareClose").addEventListener("click", () => { $("#shareCard").hidden = true; });

/* ---------- phone: drawer rail (tap + swipe) + keyboard-aware viewport ---------- */
(function () {
  const mid = $("#mid"), rail = $("#tabrail"), open = $("#railOpen"), backdrop = $("#railBackdrop");
  if (!mid || !rail || !open || !backdrop) return;
  const isOpen = () => mid.classList.contains("rail-open");
  setRailOpen = (on) => { mid.classList.toggle("rail-open", on); backdrop.hidden = !on; };
  open.addEventListener("click", () => setRailOpen(!isOpen()));
  backdrop.addEventListener("click", () => setRailOpen(false));
  const title = $("#phoneTitle");
  if (title) title.addEventListener("click", () => setRailOpen(!isOpen()));
  closeRailDrawer = () => {
    if (!isOpen()) return false;
    setRailOpen(false);
    return true;
  };
  PHONE_MQ.addEventListener("change", () => setRailOpen(false));

  // Swipe: from the left edge to open, leftward on the drawer or its backdrop
  // to close, the drawer following the finger. Released past halfway, or with
  // a flick, it goes the rest of the way. Movement that starts vertical is a
  // scroll, and the gesture stands down without touching the event.
  const EDGE = 28, SLOP = 8, FLICK = 0.35;   // CSS px from the left, px before deciding, px per ms
  let mode = null, startX = 0, startY = 0, width = 0, x = 0, lastX = 0, lastT = 0, vx = 0, zr = 1;
  // Text size is a zoom on the root. Chromium reports rects and touch points
  // in zoomed pixels, Apple's WKWebView in unzoomed ones, and the transform we
  // write is in CSS px either way; so the ratio is measured, not assumed
  // (the same trick anchorCard uses).
  const rectScale = () => (rail.getBoundingClientRect().width / (rail.offsetWidth || 1)) || 1;
  const railWidth = () => rail.offsetWidth || Math.min(window.innerWidth * 0.86, 340);
  const place = (px) => {
    x = Math.min(0, Math.max(-width, px));
    rail.style.transform = "translateX(" + x + "px)";
    backdrop.style.opacity = String(1 + x / width);
  };
  document.addEventListener("touchstart", (e) => {
    mode = null;
    if (!isPhone() || e.touches.length !== 1) return;
    const t = e.touches[0];
    zr = rectScale();
    if (!isOpen() && t.clientX > EDGE * zr) return;
    if (isOpen() && !(rail.contains(e.target) || e.target === backdrop)) return;
    if (e.target.closest && e.target.closest("input, textarea, select")) return;
    mode = "pending";
    startX = t.clientX; startY = t.clientY; width = railWidth();
    lastX = startX; lastT = performance.now(); vx = 0;
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (!mode) return;
    const t = e.touches[0];
    const mx = (t.clientX - startX) / zr, my = (t.clientY - startY) / zr;
    if (mode === "pending") {
      if (Math.abs(mx) < SLOP && Math.abs(my) < SLOP) return;
      if (Math.abs(my) > Math.abs(mx)) { mode = null; return; }
      mode = "drag";
      rail.classList.add("dragging");
      backdrop.classList.add("dragging");
      backdrop.hidden = false;
    }
    e.preventDefault();
    const now = performance.now();
    vx = (t.clientX - lastX) / zr / Math.max(1, now - lastT);
    lastX = t.clientX; lastT = now;
    place(isOpen() ? mx : -width + mx);
  }, { passive: false });
  const finish = () => {
    if (mode !== "drag") { mode = null; return; }
    mode = null;
    const goOpen = vx > FLICK ? true : vx < -FLICK ? false : x > -width / 2;
    rail.classList.remove("dragging");
    backdrop.classList.remove("dragging");
    rail.style.transform = "";
    backdrop.style.opacity = "";
    setRailOpen(goOpen);
  };
  document.addEventListener("touchend", finish);
  document.addEventListener("touchcancel", finish);
})();
/* ---------- phone: status chip that mirrors the badge strip ---------- */
(function () {
  const chip = $("#phoneStatus"), bar = $("#topbar");
  if (!chip || !bar) return;
  const dot = chip.querySelector(".ps-dot"), text = chip.querySelector(".ps-text");
  const status = $("#status"), model = $("#model"), ctx = $("#ctx");
  if (!dot || !text || !status || !model || !ctx) return;
  const sync = () => {
    chip.dataset.state = status.dataset.state || "idle";
    crystalDot(dot, chip.dataset.state);
    // "claude-opus-5[1m]" -> "opus-5[1m]"; "model —" / "model: default" -> nothing
    let m = (model.textContent || "").trim();
    m = /^model\b/.test(m) ? "" : m.replace(/^claude-/, "");
    const pct = parseFloat((ctx.textContent || "").replace(/^ctx\s*/, ""));
    const parts = [];
    if (m) parts.push(m);
    if (!isNaN(pct)) parts.push(Math.round(pct) + "%");
    const st = (status.textContent || "").trim();
    if (!parts.length || (chip.dataset.state !== "idle" && st)) parts.push(st || "idle");
    text.textContent = parts.join(" · ");
    chip.title = [status.textContent, model.textContent, ctx.textContent].filter(Boolean).join(" · ");
  };
  const mo = new MutationObserver(sync);
  [status, model, ctx].forEach((n) => mo.observe(n, { attributes: true, childList: true, characterData: true, subtree: true }));
  const setOpen = (on) => {
    bar.classList.toggle("info-open", on);
    chip.classList.toggle("open", on);
    chip.setAttribute("aria-expanded", on ? "true" : "false");
  };
  chip.addEventListener("click", () => setOpen(!bar.classList.contains("info-open")));
  PHONE_MQ.addEventListener("change", () => setOpen(false));
  sync();
})();
// On touch the return key is a newline, so the desktop hint would mislead.
if (isTouch()) input.placeholder = "Talk to MIST…";
// iOS shrinks the visual viewport for the keyboard and leaves the layout
// viewport alone, so a 100dvh page keeps its composer under the keys. Track the
// visual height into --vvh (style.css sizes the body from it on phones) and
// undo the scroll WebKit applies to reveal the focused field.
(function () {
  const vv = window.visualViewport;
  if (!vv) return;
  let raf = 0;
  const sync = () => {
    raf = 0;
    if (!isPhone()) { document.documentElement.style.removeProperty("--vvh"); return; }
    // Text size is a CSS zoom on the root, and a px length inside it renders
    // zoomed, so the visual height is divided by the zoom or a 125% Console
    // gets a body 25% taller than the screen (the top bar scrolled off it).
    const zoom = parseFloat(document.documentElement.style.zoom) || 1;
    document.documentElement.style.setProperty("--zoom", String(zoom));   // vw-sized things divide by it (style.css)
    document.documentElement.style.setProperty("--vvh", Math.round(vv.height / zoom) + "px");
    if (window.scrollY) window.scrollTo(0, 0);
    const a = activeId && sessions.get(activeId);
    if (a) a.scroll();   // keep following the bottom while the log area resizes
  };
  const queue = () => { if (!raf) raf = requestAnimationFrame(sync); };
  vv.addEventListener("resize", queue);
  vv.addEventListener("scroll", queue);
  PHONE_MQ.addEventListener("change", queue);
  window.addEventListener("mist:zoom", queue);   // text size changed; --vvh and --zoom follow
  sync();
})();

/* ---------- phone section in settings: remote access + pairing ---------- */
function renderRemote(st) {
  const en = $("#remoteEnabled");
  if (!en || !st) return;
  en.selected = !!st.enabled;
  $("#tunnelEnabled").selected = !!st.tunnel;
  const state = $("#remoteState");
  state.textContent = st.enabled ? "on" : "off";
  state.classList.toggle("on", !!st.enabled);
  $("#remoteBody").hidden = !st.enabled;
  const ru = $("#remoteUrl");
  if (document.activeElement !== ru) ru.value = st.remote_url || "";
  const ka = $("#keepAwake");
  if (ka) {
    ka.selected = !!st.keep_awake;
    const a = st.awake || {};
    $("#awakeState").textContent = !st.keep_awake ? "" : a.holding ? "holding" : a.on_ac === false ? "on battery, not held" : "";
    $("#awakeState").classList.toggle("on", !!a.holding);
  }
  const lan = $("#remoteLan");
  lan.innerHTML = "";
  (st.lan_urls || []).forEach((u) => lan.appendChild(el("div", "ru", '<span class="msi">wifi</span>' + esc(u))));
  if (!(st.lan_urls || []).length) lan.appendChild(el("div", "ru dim", "no network address right now"));
  const ts = st.tunnel_state || {};
  const tun = $("#tunnelState");
  tun.innerHTML = "";
  if (!st.tunnel) {
    tun.appendChild(el("div", "ru dim", ts.installed ? "off" : "cloudflared is not installed (brew install cloudflared)"));
  } else if (ts.url) {
    tun.appendChild(el("div", "ru", '<span class="msi">public</span>' + esc(ts.url)));
  } else if (ts.error) {
    tun.appendChild(el("div", "ru err", esc(ts.error)));
  } else {
    tun.appendChild(el("div", "ru dim", "starting the tunnel…"));
    setTimeout(loadRemote, 4000);   // the URL lands a few seconds after the process starts
  }
  const qr = $("#pairQr");
  qr.innerHTML = "";
  qr.dataset.pairing = st.pairing || "";
  if (st.pairing && typeof qrcode === "function") {
    try {
      // Level L and a real quiet zone: this is read off a screen by a phone
      // camera, so fewer, bigger modules beat error-correction headroom.
      const q = qrcode(0, "L");   // type 0: smallest version that fits
      q.addData(st.pairing);
      q.make();
      qr.innerHTML = q.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
    } catch (_) { qr.textContent = "too much for a QR code; use the pairing link"; }
  }
  const disc = $("#remoteDiscovery");
  disc.textContent = st.discovery
    ? "Discovery lookup for the phone: " + st.discovery
    : "No discovery lookup: the share Worker is not set up (CF_SHARE_API_TOKEN in the harness .env), so a changed tunnel address only reaches the phone while it is on this network.";
}
async function loadRemote() {
  try { renderRemote(await (await fetch("/remote")).json()); } catch (_) {}
}
async function postRemote(body) {
  try {
    const r = await fetch("/remote", { method: "POST", headers: { "Content-Type": "application/json" },
                                       body: JSON.stringify(body) });
    renderRemote(await r.json());
  } catch (_) {}
}
if ($("#remoteEnabled")) {
  $("#remoteEnabled").addEventListener("change", (e) => postRemote({ enabled: e.target.selected }));
  $("#tunnelEnabled").addEventListener("change", (e) => postRemote({ tunnel: e.target.selected }));
  $("#remoteUrl").addEventListener("change", (e) => postRemote({ remote_url: e.target.value }));
  $("#keepAwake").addEventListener("change", (e) => postRemote({ keep_awake: e.target.selected }));
  $("#pairCopy").addEventListener("click", async () => {
    const p = $("#pairQr").dataset.pairing;
    if (!p) return;
    const btn = $("#pairCopy");
    try {
      await navigator.clipboard.writeText(p);
      btn.textContent = "copied";
      setTimeout(() => { btn.textContent = "copy pairing link"; }, 1500);
    } catch (_) { prompt("Pairing link:", p); }
  });
  $("#remoteRotate").addEventListener("click", async () => {
    if (!confirm("Rotate the pairing token? Every paired phone has to scan the new code.")) return;
    try { renderRemote(await (await fetch("/remote/rotate", { method: "POST" })).json()); } catch (_) {}
  });
  // Inside the iOS app this opens the native server sheet (the shell intercepts
  // the mist: scheme); it is hidden everywhere else (.shell-only).
  $("#phoneNative").addEventListener("click", () => { location.href = "mist://settings"; });
}
