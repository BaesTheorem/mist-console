"""Fleet panel ledger, the outdated-backend check, the /metrics beacon route,
and bin/console-health's turn timing (cold = SessionStart hook in the gap,
queued sends not timed)."""
# ruff: noqa: SLF001
import importlib.machinery
import importlib.util
import json
import os
import sys
import tempfile
import time

os.environ["MIST_CONSOLE_DATA_DIR"] = tempfile.mkdtemp(prefix="mist-fleet-test-")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import app  # noqa: E402
import bridge  # noqa: E402

client = app.app.test_client()


def _session(sid="fleet-test"):
    s = bridge.ClaudeSession(id=sid, autostart=False)
    s._record = lambda obj: None
    return s


def test_fleet_snapshot_tracks_open_tasks_and_drops_finished():
    s = _session()
    s._note_task_event({"subtype": "task_started", "task_id": "a", "description": "research",
                        "task_type": "local_agent", "is_backgrounded": True, "ts": time.time() - 30})
    s._note_task_event({"subtype": "task_started", "task_id": "b", "description": "ls",
                        "task_type": "local_bash"})
    s._note_task_event({"subtype": "task_progress", "task_id": "a", "description": "reading pages"})
    snap = s.fleet_snapshot()
    by = {t["id"]: t for t in snap["tasks"]}
    assert set(by) == {"a", "b"}
    assert by["a"]["background"] and not by["b"]["background"]
    assert by["a"]["last"] == "reading pages" and by["a"]["age"] >= 29
    s._note_task_event({"subtype": "task_notification", "task_id": "b", "status": "completed"})
    assert [t["id"] for t in s.fleet_snapshot()["tasks"]] == ["a"]
    s._take_open_tasks()
    assert s.fleet_snapshot()["tasks"] == [] and s._task_info == {}


def test_fleet_route_lists_only_busy_chats():
    busy, idle = _session("busy"), _session("idle")
    busy._turn_active, busy._turn_started = True, time.time() - 5
    app._sessions["busy"], app._sessions["idle"] = busy, idle
    try:
        j = client.get("/fleet").get_json()
        ids = [c["id"] for c in j["chats"]]
        assert "busy" in ids and "idle" not in ids
        assert next(c for c in j["chats"] if c["id"] == "busy")["turn"]["age"] >= 4
        assert isinstance(j["routines"], list)
    finally:
        app._sessions.pop("busy", None)
        app._sessions.pop("idle", None)


def test_outdated_backend_detection(tmp_path, monkeypatch):
    binf = tmp_path / "claude"
    binf.write_text("x")
    monkeypatch.setattr(bridge, "CLAUDE", str(binf))
    s = _session()
    s._started_at = 0
    assert not s._binary_newer_than_backend()          # never started: nothing to compare
    s._started_at = os.path.getmtime(binf) + 10
    assert not s._binary_newer_than_backend()          # started after the update
    s._started_at = os.path.getmtime(binf) - 10
    assert s._binary_newer_than_backend()              # CLI updated under a live backend


def test_metrics_route_keeps_known_kinds_only():
    r = client.post("/metrics", json={"events": [
        {"kind": "switch", "ms": 41.26, "client": "mac"},
        {"kind": "reconnect", "what": "chat", "client": "phone"},
        {"kind": "evil", "ms": 1}, "junk"]})
    assert r.get_json()["kept"] == 2
    rows = [json.loads(x) for x in open(app.METRICS_PATH)]
    assert [x["kind"] for x in rows[-2:]] == ["switch", "reconnect"]
    assert rows[-2]["ms"] == 41.3 and rows[-1]["client"] == "phone"


def _load_health():
    path = os.path.join(ROOT, "bin", "console-health")
    loader = importlib.machinery.SourceFileLoader("console_health", path)
    spec = importlib.util.spec_from_loader("console_health", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def test_health_turn_timing(tmp_path, monkeypatch):
    h = _load_health()
    monkeypatch.setattr(h, "DATA", str(tmp_path))
    t = time.time() - 3600
    ev = [
        # warm turn: init every turn (the CLI does that), first token after 2 s
        {"type": "user_text", "ts": t},
        {"type": "system", "subtype": "init", "ts": t + .1},
        {"type": "stream_event", "event": {"type": "message_start"}, "ts": t + 2},
        {"type": "user_text", "ts": t + 3},                     # queued: not timed
        {"type": "result", "ts": t + 10},
        # cold turn: a SessionStart hook inside the gap
        {"type": "user_text", "ts": t + 100},
        {"type": "system", "subtype": "hook_response", "hook_name": "SessionStart:resume", "ts": t + 101},
        {"type": "stream_event", "event": {"type": "message_start"}, "ts": t + 106},
        {"type": "result", "ts": t + 120},
        {"type": "process_exit", "code": 1, "ts": t + 200},
    ]
    (tmp_path / "s1.jsonl").write_text("\n".join(json.dumps(e) for e in ev) + "\n")
    warm, cold, turns, exits, _ = h.scan_turns(1)
    assert warm == [2] and cold == [6]
    assert turns == [10, 20]
    assert exits["crash"] == 1
