"""bookmarks.py — starred messages and per-message checklist state, on disk.

Two small JSON stores in data/ (gitignored runtime state, like notes.json):
  bookmarks.json  {"bookmarks": [{id, sid, role, seq, preview, created}, ...]}
  checks.json     {"checks": {sid: {"<role>:<seq>": {"<idx>": true}}}}

INVARIANTS:
- A message is addressed by "<role>:<seq>". For a user message, seq is its
  own `user_text` seq. For a MIST reply, seq is the seq of the FIRST top-level
  `assistant` event rendered into that bubble. Both survive every transform a
  chat goes through: archive.Condenser keeps `user_text` events verbatim and
  gives each `mist_msg` the seq of the assistant event it was built from, so
  a live bubble, a raw replay and a condensed replay all agree on the address.
  Subagent assistant events (parent_tool_use_id set) are never an address:
  the condenser drops them.
- Rewinding a chat at cut_seq (bridge.rewind) discards every event stamped at
  or after cut_seq, so prune() drops every entry with seq >= cut_seq. Deleting
  a chat drops all of its entries (drop()).
- Writes are atomic (temp file + fsync + os.replace); a corrupt or missing file
  loads as empty rather than raising.
- The checklist store only holds what the user has toggled. A box the user
  never touched keeps the state written in the markdown ([ ] or [x]).
"""

import json
import os
import threading
import time
from typing import Any, cast

DATA_DIR = (os.environ.get("MIST_CONSOLE_DATA_DIR")
            or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))
BOOKMARKS_PATH = os.path.join(DATA_DIR, "bookmarks.json")
CHECKS_PATH = os.path.join(DATA_DIR, "checks.json")
PREVIEW_CAP = 240
ROLES = ("user", "mist")


class _Store:
    """A dict persisted as one JSON file, loaded lazily, written atomically."""

    def __init__(self, path, key, empty):
        self.path = path
        self.key = key          # top-level key the payload lives under
        self.empty = empty      # factory for a fresh payload (list or dict)
        self.lock = threading.RLock()
        self._data = None

    def data(self):
        """The payload, loaded on first use. A missing or corrupt file, or one
        holding the wrong shape, starts empty rather than raising."""
        with self.lock:
            if self._data is None:
                loaded = self._load()
                self._data = loaded if isinstance(loaded, type(self.empty())) else self.empty()
            return self._data

    def _load(self):
        try:
            with open(self.path) as f:
                raw = json.load(f)
        except (OSError, ValueError):   # missing file, or not JSON
            return None
        return raw.get(self.key) if isinstance(raw, dict) else None

    def save(self):
        with self.lock:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w") as f:
                json.dump({self.key: self._data}, f, indent=1)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)


def _key(role, seq):
    return f"{role}:{int(seq)}"


def _valid(role, seq):
    if role not in ROLES:
        return False
    try:
        return int(seq) >= 0
    except (TypeError, ValueError):
        return False


# ---- bookmarks ---------------------------------------------------------------
_bm = _Store(BOOKMARKS_PATH, "bookmarks", list)


def _bm_list() -> list[dict[str, Any]]:
    return cast(list[dict[str, Any]], _bm.data())


def list_all():
    """Every bookmark, newest first."""
    with _bm.lock:
        return sorted((dict(b) for b in _bm_list()), key=lambda b: -b.get("created", 0))


def list_for(sid):
    """One chat's bookmarks in transcript order (by seq)."""
    with _bm.lock:
        return sorted((dict(b) for b in _bm_list() if b.get("sid") == sid),
                      key=lambda b: b.get("seq", 0))


def get(sid, role, seq):
    if not _valid(role, seq):
        return None
    with _bm.lock:
        for b in _bm_list():
            if b.get("sid") == sid and b.get("role") == role and b.get("seq") == int(seq):
                return dict(b)
    return None


def add(sid, role, seq, preview=""):
    """Bookmark a message. Idempotent: re-adding refreshes the preview only."""
    if not _valid(role, seq):
        raise ValueError("bad role or seq")
    preview = " ".join(str(preview or "").split())[:PREVIEW_CAP]
    with _bm.lock:
        for b in _bm_list():
            if b.get("sid") == sid and b.get("role") == role and b.get("seq") == int(seq):
                if preview:
                    b["preview"] = preview
                _bm.save()
                return dict(b)
        b = {"id": f"{sid}:{_key(role, seq)}", "sid": sid, "role": role, "seq": int(seq),
             "preview": preview, "created": time.time()}
        _bm_list().append(b)
        _bm.save()
        return dict(b)


def remove(sid, role, seq):
    if not _valid(role, seq):
        return False
    with _bm.lock:
        lst = _bm_list()
        n = len(lst)
        lst[:] = [b for b in lst
                  if not (b.get("sid") == sid and b.get("role") == role and b.get("seq") == int(seq))]
        if len(lst) != n:
            _bm.save()
            return True
    return False


# ---- checklist state ---------------------------------------------------------
_ck = _Store(CHECKS_PATH, "checks", dict)


def _ck_map() -> dict[str, dict[str, dict[str, bool]]]:
    return cast(dict[str, dict[str, dict[str, bool]]], _ck.data())


def checks_for(sid):
    """{"<role>:<seq>": {"<idx>": bool}} for one chat (a copy)."""
    with _ck.lock:
        return {k: dict(v) for k, v in (_ck_map().get(sid) or {}).items() if isinstance(v, dict)}


def set_check(sid, role, seq, idx, checked):
    if not _valid(role, seq):
        raise ValueError("bad role or seq")
    idx = int(idx)
    if idx < 0:
        raise ValueError("bad idx")
    with _ck.lock:
        per = _ck_map().setdefault(sid, {})
        boxes = per.setdefault(_key(role, seq), {})
        boxes[str(idx)] = bool(checked)
        _ck.save()
        return dict(boxes)


# ---- lifecycle hooks (rewind / delete) ---------------------------------------
def prune(sid, cut_seq):
    """A rewind dropped every event at or after cut_seq: forget the marks on
    those messages so the list never points at something that is gone."""
    try:
        cut = int(cut_seq)
    except (TypeError, ValueError):
        return
    with _bm.lock:
        lst = _bm_list()
        n = len(lst)
        lst[:] = [b for b in lst if not (b.get("sid") == sid and b.get("seq", 0) >= cut)]
        if len(lst) != n:
            _bm.save()
    with _ck.lock:
        per = _ck_map().get(sid)
        if per:
            gone = [k for k in per if int(k.split(":")[-1]) >= cut]
            for k in gone:
                del per[k]
            if gone:
                _ck.save()


def drop(sid):
    """The chat was deleted."""
    with _bm.lock:
        lst = _bm_list()
        n = len(lst)
        lst[:] = [b for b in lst if b.get("sid") != sid]
        if len(lst) != n:
            _bm.save()
    with _ck.lock:
        if _ck_map().pop(sid, None) is not None:
            _ck.save()
