"""A background task cannot outlive the backend that owns it: when the process
exits, every task still open in the ledger gets a synthesized terminal event
(bridge.ClaudeSession._close_tasks), so the monitor and the replay agree."""
import os
import queue
import sys

os.environ.setdefault("MIST_CONSOLE_DATA_DIR", "/tmp/mist-console-test-data")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bridge  # noqa: E402


def _session():
    s = bridge.ClaudeSession(id="ledger-test", autostart=False)
    s._record = lambda obj: None          # no jsonl writes from a unit test
    q = queue.Queue()
    s._subscribers.append(q)
    return s, q


def _drain(q):
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return out


def test_started_opens_and_terminal_notification_closes():
    s, _ = _session()
    s._note_task_event({"type": "system", "subtype": "task_started", "task_id": "a", "description": "batch 0"})
    s._note_task_event({"type": "system", "subtype": "task_progress", "task_id": "b", "description": "batch 1"})
    assert set(s._open_tasks) == {"a", "b"}
    s._note_task_event({"type": "system", "subtype": "task_notification", "task_id": "a", "status": "completed"})
    s._note_task_event({"type": "system", "subtype": "task_updated", "task_id": "b", "patch": {"status": "failed"}})
    assert s._open_tasks == {}


def test_non_terminal_update_keeps_the_task_open():
    s, _ = _session()
    s._note_task_event({"type": "system", "subtype": "task_started", "task_id": "a", "description": "x"})
    s._note_task_event({"type": "system", "subtype": "task_updated", "task_id": "a", "patch": {"status": "running"}})
    s._note_task_event({"type": "system", "subtype": "task_notification", "task_id": ""})
    assert "a" in s._open_tasks


def test_process_exit_kills_every_open_task_once():
    s, q = _session()
    for i in range(3):
        s._note_task_event({"type": "system", "subtype": "task_started",
                            "task_id": f"t{i}", "description": f"Parse Amazon pack sizes batch {i}"})
    s._close_tasks(s._take_open_tasks())
    evs = _drain(q)
    assert [e["task_id"] for e in evs] == ["t0", "t1", "t2"]
    assert all(e["type"] == "system" and e["subtype"] == "task_updated" and e["status"] == "killed" for e in evs)
    assert "batch 2" in evs[2]["summary"]
    assert all("ts" in e and "seq" in e for e in evs)   # recorded like any live event
    # The ledger is empty now; a second exit (respawn, model switch) closes nothing again.
    s._close_tasks(s._take_open_tasks())
    assert _drain(q) == []
    assert s._open_tasks == {}


def test_stop_ack_path_shape_matches_the_synthesized_close():
    s, q = _session()
    s._note_task_event({"type": "system", "subtype": "task_started", "task_id": "k", "description": "d"})
    s._close_tasks(s._take_open_tasks())
    ev = _drain(q)[0]
    assert {k: ev[k] for k in ("type", "subtype", "task_id", "status")} == {
        "type": "system", "subtype": "task_updated", "task_id": "k", "status": "killed"}
