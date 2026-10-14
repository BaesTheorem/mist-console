"""Launch and load paths that were slow, kept fast.

- The phone gets gzipped text; this Mac's loopback window does not (no CPU
  spent where there is no network to save).
- The transcript importer never opens a file the registry already knows, and
  does not read an unchanged file twice.
"""
import gzip
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["MIST_CONSOLE_DATA_DIR"] = tempfile.mkdtemp(prefix="mist-loadspeed-test-")

import app  # noqa: E402  (needs the env var above first)
import importer  # noqa: E402

client = app.app.test_client()


def _remote(monkeypatch):
    monkeypatch.setattr(app.remote, "is_local", lambda req: False)
    monkeypatch.setattr(app.remote, "enabled", lambda: True)
    monkeypatch.setattr(app.remote, "authorized", lambda req: True)


def test_remote_text_is_gzipped(monkeypatch):
    plain = client.get("/app.js").get_data()
    _remote(monkeypatch)
    r = client.get("/app.js", headers={"Accept-Encoding": "gzip, deflate, br"})
    assert r.headers.get("Content-Encoding") == "gzip"
    assert "Accept-Encoding" in r.headers.get("Vary", "")
    assert gzip.decompress(r.get_data()) == plain
    big = [{"id": f"s{i}", "title": f"chat {i}"} for i in range(500)]
    monkeypatch.setattr(app, "_session_list", lambda: big)
    r = client.get("/sessions", headers={"Accept-Encoding": "gzip"})
    assert r.headers.get("Content-Encoding") == "gzip"
    assert json.loads(gzip.decompress(r.get_data())) == big


def test_local_and_unaccepting_clients_get_plain(monkeypatch):
    r = client.get("/app.js", headers={"Accept-Encoding": "gzip"})
    assert "Content-Encoding" not in r.headers
    _remote(monkeypatch)
    r = client.get("/app.js")
    assert "Content-Encoding" not in r.headers


def test_importer_skips_known_and_caches(tmp_path, monkeypatch):
    proj = tmp_path / "proj"
    proj.mkdir()
    def turn(t):
        return json.dumps({"type": "user", "message": {"content": t}})
    (proj / "known.jsonl").write_text(turn("a") + "\n" + turn("b") + "\n")
    (proj / "new.jsonl").write_text(turn("first question") + "\n" + turn("second") + "\n")
    (proj / "one.jsonl").write_text(turn("only one turn") + "\n")
    monkeypatch.setattr(importer, "PROJECT_DIR", str(proj))
    opened = []
    real = importer._summarize
    monkeypatch.setattr(importer, "_summarize", lambda p, need=2: opened.append(os.path.basename(p)) or real(p, need))
    cache = str(tmp_path / "cache.json")
    got = importer.scan_recent(skip={"known"}, cache_path=cache)
    assert [x["uuid"] for x in got] == ["new"]
    assert got[0]["title"] == "first question"
    assert sorted(opened) == ["new.jsonl", "one.jsonl"]
    opened.clear()
    again = importer.scan_recent(skip={"known"}, cache_path=cache)
    assert [x["uuid"] for x in again] == ["new"] and again[0]["title"] == "first question"
    assert opened == []   # nothing changed, nothing read
