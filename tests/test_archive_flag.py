"""Archiving a chat hides it from the rail without touching its transcript.
POST /sessions/<id>/archive toggles (or sets) the flag, archiving unpins,
pinning unarchives, and sessions.json rows written before the flag split
(where "archived" meant condensed) migrate to `condensed`."""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_dir = tempfile.mkdtemp(prefix="mist-archive-test-")
os.environ["MIST_CONSOLE_DATA_DIR"] = _dir
with open(os.path.join(_dir, "sessions.json"), "w") as f:
    json.dump([
        {"id": "s1", "title": "old row", "archived": True, "claude_session_id": "c1"},
        {"id": "s2", "title": "new row", "condensed": False, "archived": True,
         "archived_at": 5.0, "claude_session_id": "c2"},
        {"id": "s3", "title": "pinned", "pinned": True, "pin_order": 0,
         "claude_session_id": "c3"},
    ], f)

import app  # noqa: E402  (needs the env var and the seed file above first)

client = app.app.test_client()


def test_old_archived_key_means_condensed():
    s1, s2 = app._sessions["s1"], app._sessions["s2"]
    assert s1.condensed and not s1.archived
    assert s2.archived and not s2.condensed and s2.archived_at == 5.0


def test_archive_toggles_and_unpins():
    r = client.post("/sessions/s3/archive").get_json()
    assert r["archived"] and not r["pinned"] and r["archived_at"]
    meta = next(m for m in client.get("/sessions").get_json() if m["id"] == "s3")
    assert meta["archived"] and not meta["pinned"] and "condensed" in meta
    r = client.post("/sessions/s3/archive").get_json()
    assert not r["archived"] and r["archived_at"] is None


def test_pin_unarchives():
    client.post("/sessions/s3/archive", json={"archived": True})
    assert app._sessions["s3"].archived
    r = client.post("/sessions/s3/pin").get_json()
    assert r["pinned"] and not app._sessions["s3"].archived
    client.post("/sessions/s3/archive", json={"archived": False})
    assert client.post("/sessions/nope/archive").status_code == 404


def test_saved_rows_carry_both_flags():
    client.post("/sessions/s2/archive", json={"archived": True})
    app._save_meta_now()
    rows = {m["id"]: m for m in json.load(open(os.path.join(_dir, "sessions.json")))}
    assert rows["s1"]["condensed"] and not rows["s1"]["archived"]
    assert rows["s2"]["archived"] and rows["s2"]["archived_at"]
