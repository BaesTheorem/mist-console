"""Versioned snapshots of media files embedded in chat messages.

A MIST reply embeds a local file as `![alt](/abs/path.png)` and the page loads it
through `/file?path=...` at view time. When the same path is overwritten across
turns (an image edited five times, always saved to the same name), every earlier
bubble and lightbox resolves to the newest file, so the transcript no longer
shows what MIST showed at the time.

Fix: when an assistant message is recorded (bridge._record), every embedded local
media file is copied under data/embeds/ named by content hash, and an index line
`{"path", "ts", "snap"}` is appended. The page tags each embed with the timestamp
of the bubble it belongs to (`/file?path=...&at=<ts>`), and `resolve()` returns
the snapshot taken at or after that moment: the first record whose `ts` is at or
past the bubble's `ts` is the one made for that very message. No index entry
(older chats, an over-sized file) falls back to the live file.

INVARIANTS
- `safe_path` is the single allowlist for anything /file serves; SNAP_DIR is in it.
- Snapshot files are immutable: same content -> same name, never rewritten.
- The index only ever grows; entries are appended in recording order.
"""

import hashlib
import json
import logging
import os
import re
import shutil
import threading

# Same expression bridge.py uses (not imported: bridge imports this module).
DATA_DIR = (os.environ.get("MIST_CONSOLE_DATA_DIR")
            or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))
SNAP_DIR = os.path.join(DATA_DIR, "embeds")
INDEX_PATH = os.path.join(SNAP_DIR, "index.jsonl")

IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac"}
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".webm"}
MEDIA_EXTS = IMG_EXTS | AUDIO_EXTS | VIDEO_EXTS
# Types the WebView may render in the app's origin. Everything else is served
# Content-Disposition: attachment, so a stray .html/.svg under an allowlisted
# root can never execute same-origin.
INLINE_EXTS = MEDIA_EXTS | {".pdf"}
# Never serve these even under an allowlisted root; the harness .env lives in
# one of the roots and localhost is reachable cross-origin from a browser.
SECRET_EXTS = {".env", ".pem", ".key", ".p12", ".keychain"}
ROOTS = [os.path.realpath(os.path.expanduser(p)) for p in (
    "~/Downloads", "~/Exobrain/Attachments", "~/Documents/Exobrain harness", SNAP_DIR)]

# Above this a snapshot costs more disk than it is worth (a long video); the
# embed then keeps resolving to the live file, as before.
SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024
# How far the bubble's timestamp may precede its snapshot and still match. The
# bubble is stamped at content_block_start, the snapshot at the assistant event
# that closes the message, so the real distance is the message's stream time.
# Any positive slack only matters for clocks that step backwards.
AT_SLACK = 2.0

log = logging.getLogger(__name__)
_EMBED_RE = re.compile(r"!\[[^\]]*\]\(([^)]+)\)")
_lock = threading.Lock()
_index = None   # realpath -> [(ts, snap_name), ...] in append order


def realpath(raw):
    return os.path.realpath(os.path.expanduser(raw or ""))


def safe_path(raw, must_exist=True):
    """Resolve `raw` to a servable file under the allowlist, or None. Any
    extension is allowed (the chat embeds arbitrary files as download cards),
    but hidden files/dirs and credential-shaped extensions stay unreachable,
    and only INLINE_EXTS render in the page (see app.py /file)."""
    path = realpath(raw)
    for root in ROOTS:
        if path == root or path.startswith(root + os.sep):
            rel = path[len(root):]
            if any(part.startswith(".") for part in rel.split(os.sep) if part):
                return None
            if os.path.splitext(path)[1].lower() in SECRET_EXTS:
                return None
            if must_exist and not os.path.isfile(path):
                return None
            return path
    return None


def _load():
    """The in-memory index, read from disk on first use. Call under _lock."""
    global _index
    if _index is not None:
        return _index
    idx = {}
    try:
        with open(INDEX_PATH) as f:
            for line in f:
                try:
                    o = json.loads(line)
                    idx.setdefault(o["path"], []).append((float(o["ts"]), o["snap"]))
                except (ValueError, KeyError, TypeError):
                    log.warning("embeds index: skipping torn line %r", line[:80])
    except FileNotFoundError:
        pass
    _index = idx
    return idx


def _unescape_md(p):
    # Paths in recorded text are raw markdown, but a `)` inside a path can't
    # appear there anyway; only whitespace trimming is needed.
    return p.strip()


def embedded_paths(text):
    """Local media paths referenced by `![..](path)` in `text`, in order."""
    out = []
    for m in _EMBED_RE.finditer(text or ""):
        p = _unescape_md(m.group(1)).removeprefix("file://")
        if not p.startswith(("/", "~")):
            continue
        if os.path.splitext(p)[1].lower() in MEDIA_EXTS:
            out.append(p)
    return out


def _texts_of(obj):
    t = obj.get("type")
    if t == "assistant":
        for b in ((obj.get("message") or {}).get("content") or []):
            if isinstance(b, dict) and b.get("type") == "text" and b.get("text"):
                yield b["text"]
    elif t == "mist_msg":
        for b in (obj.get("blocks") or []):
            if isinstance(b, dict) and b.get("kind") == "text" and b.get("text"):
                yield b["text"]


def record(path, ts):
    """Snapshot `path` as seen now, stamped `ts`. Returns the snapshot name or
    None (not allowlisted, missing, too large)."""
    real = safe_path(path)
    if not real:
        return None
    try:
        if os.path.getsize(real) > SNAPSHOT_MAX_BYTES:
            return None
        h = hashlib.sha1()
        with open(real, "rb") as f:
            while chunk := f.read(1 << 20):
                h.update(chunk)
    except OSError:
        return None
    name = h.hexdigest()[:12] + "-" + os.path.basename(real)
    dest = os.path.join(SNAP_DIR, name)
    with _lock:
        idx = _load()
        try:
            os.makedirs(SNAP_DIR, exist_ok=True)
            if not os.path.exists(dest):
                tmp = dest + ".part"
                shutil.copyfile(real, tmp)
                os.replace(tmp, dest)
            with open(INDEX_PATH, "a") as f:
                f.write(json.dumps({"path": real, "ts": ts, "snap": name}) + "\n")
        except OSError:
            return None
        idx.setdefault(real, []).append((float(ts), name))
    return name


def snapshot_event(obj):
    """Snapshot every media file an assistant event embeds. Never raises:
    recording the chat must not depend on a copy succeeding."""
    try:
        ts = float(obj.get("ts") or 0)
        seen = set()
        for text in _texts_of(obj):
            for p in embedded_paths(text):
                if p not in seen:
                    seen.add(p)
                    record(p, ts)
    except Exception:   # logged, never propagated into _record
        log.exception("embeds: snapshot failed")


def resolve(raw, at):
    """Snapshot path for `raw` as it was for a bubble stamped `at` (epoch
    seconds), or None to serve the live file."""
    if not at:
        return None
    real = realpath(raw)
    with _lock:
        entries = list(_load().get(real) or [])
    for ts, name in entries:
        if ts >= float(at) - AT_SLACK:
            snap = os.path.join(SNAP_DIR, name)
            return snap if os.path.isfile(snap) else None
    return None
