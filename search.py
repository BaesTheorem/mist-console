"""Full-text search over the Console's own chat logs (data/*.jsonl).

INVARIANTS:
- The index (data/search-index.db) is derived state: safe to delete, rebuilt
  on the next search. It lives in data/, which is gitignored.
- Indexing is incremental by (mtime, size); a changed file is fully re-indexed
  (logs are append-only, but partial offsets aren't worth the fragility).
- Only user_text and assistant text are indexed — no tool results, no
  stream deltas, no thinking blocks.
"""

import json
import os
import re
import sqlite3
import threading
import time

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
DB_PATH = os.path.join(DATA_DIR, "search-index.db")

# FTS snippet markers — control chars that can't appear in chat text, replaced
# with real markup by the frontend after HTML-escaping.
MARK_L, MARK_R = "\x01", "\x02"

SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY,
    sid TEXT UNIQUE NOT NULL,
    mtime REAL NOT NULL,
    size INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id),
    sid TEXT NOT NULL,
    role TEXT NOT NULL,
    seq INTEGER NOT NULL,
    text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_file ON messages(file_id);
CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(
    text, content='messages', content_rowid='id', tokenize='porter unicode61'
);
"""

_lock = threading.Lock()          # one indexer at a time
_last_scan = 0.0                  # throttle full-directory rescans
SCAN_INTERVAL = 10                # seconds


def _connect():
    db = sqlite3.connect(DB_PATH, timeout=15)
    db.execute("PRAGMA busy_timeout = 15000")
    db.executescript(SCHEMA)
    return db


def _extract(record):
    """(role, text) for an indexable record, else None."""
    rtype = record.get("type")
    if rtype == "user_text":
        text = (record.get("text") or "").strip()
        return ("user", text) if text else None
    if rtype == "assistant":
        msg = record.get("message")
        if not isinstance(msg, dict):
            return None
        content = msg.get("content")
        if isinstance(content, str):
            parts = [content]
        elif isinstance(content, list):
            parts = [c.get("text", "") for c in content
                     if isinstance(c, dict) and c.get("type") == "text"]
        else:
            return None
        text = "\n".join(p for p in parts if p).strip()
        return ("assistant", text) if text else None
    return None


def _index_file(db, path, sid):
    stat = os.stat(path)
    row = db.execute("SELECT id, mtime, size FROM files WHERE sid = ?",
                     (sid,)).fetchone()
    if row and row[1] == stat.st_mtime and row[2] == stat.st_size:
        return
    if row:
        file_id = row[0]
        for mid, text in db.execute(
                "SELECT id, text FROM messages WHERE file_id = ?", (file_id,)):
            db.execute("INSERT INTO msg_fts(msg_fts, rowid, text) "
                       "VALUES('delete', ?, ?)", (mid, text))
        db.execute("DELETE FROM messages WHERE file_id = ?", (file_id,))
        db.execute("UPDATE files SET mtime = ?, size = ? WHERE id = ?",
                   (stat.st_mtime, stat.st_size, file_id))
    else:
        file_id = db.execute(
            "INSERT INTO files(sid, mtime, size) VALUES(?,?,?)",
            (sid, stat.st_mtime, stat.st_size)).lastrowid

    seq = 0
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            hit = _extract(record)
            if not hit:
                continue
            seq += 1
            mid = db.execute(
                "INSERT INTO messages(file_id, sid, role, seq, text) "
                "VALUES(?,?,?,?,?)", (file_id, sid, hit[0], seq, hit[1])
            ).lastrowid
            db.execute("INSERT INTO msg_fts(rowid, text) VALUES(?, ?)",
                       (mid, hit[1]))


def _update_index(db, force=False):
    global _last_scan
    now = time.monotonic()
    if not force and now - _last_scan < SCAN_INTERVAL:
        return
    on_disk = {}
    for name in os.listdir(DATA_DIR):
        if name.endswith(".jsonl"):
            on_disk[name[:-6]] = os.path.join(DATA_DIR, name)
    for sid, path in on_disk.items():
        _index_file(db, path, sid)
    # drop entries for deleted chats
    for sid, file_id in db.execute("SELECT sid, id FROM files").fetchall():
        if sid not in on_disk:
            for mid, text in db.execute(
                    "SELECT id, text FROM messages WHERE file_id = ?",
                    (file_id,)):
                db.execute("INSERT INTO msg_fts(msg_fts, rowid, text) "
                           "VALUES('delete', ?, ?)", (mid, text))
            db.execute("DELETE FROM messages WHERE file_id = ?", (file_id,))
            db.execute("DELETE FROM files WHERE id = ?", (file_id,))
    db.commit()
    _last_scan = now


def _fts_query(raw):
    """Free text -> safe FTS5 query: each term quoted, ANDed, last term
    treated as a prefix so search-as-you-type matches partial words."""
    terms = re.findall(r"\S+", raw)[:12]
    if not terms:
        return ""
    quoted = ['"{}"'.format(t.replace('"', '""')) for t in terms]
    quoted[-1] += "*"
    return " ".join(quoted)


def search(query, limit=60):
    """Search all chat logs. Returns hits newest-file-first, grouped upstream.

    Each hit: {sid, role, seq, snippet} with MARK_L/MARK_R around matches.
    """
    fts = _fts_query(query)
    if not fts:
        return []
    with _lock:
        db = _connect()
        try:
            _update_index(db)
            rows = db.execute(
                "SELECT m.sid, m.role, m.seq, "
                "snippet(msg_fts, 0, ?, ?, '…', 28), f.mtime "
                "FROM msg_fts JOIN messages m ON m.id = msg_fts.rowid "
                "JOIN files f ON f.id = m.file_id "
                "WHERE msg_fts MATCH ? "
                "ORDER BY f.mtime DESC, m.seq DESC LIMIT ?",
                (MARK_L, MARK_R, fts, limit)).fetchall()
        except sqlite3.OperationalError:
            return []
        finally:
            db.close()
    return [{"sid": sid, "role": role, "seq": seq,
             "snippet": re.sub(r"\s+", " ", snip).strip()}
            for sid, role, seq, snip, _mt in rows]


def reindex():
    """Force a full freshness scan now (still incremental per file)."""
    with _lock:
        db = _connect()
        try:
            _update_index(db, force=True)
        finally:
            db.close()
