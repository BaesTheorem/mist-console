"""A script that reuses one progress --id (aa-get opens a bar per file) gets a
new, labeled bar each time: an explicit start opens a new generation even right
after the last bar closed, and a generation opened by a label-less `set` keeps
the last known label (bridge.ClaudeSession.progress)."""
import os
import queue
import sys

os.environ.setdefault("MIST_CONSOLE_DATA_DIR", "/tmp/mist-console-test-data")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bridge  # noqa: E402


def _session():
    s = bridge.ClaudeSession(id="progress-test", autostart=False)
    s._record = lambda obj: None
    q = queue.Queue()
    s._subscribers.append(q)
    return s, q


def _bars(q):
    out = []
    while not q.empty():
        ev = q.get_nowait()
        if ev.get("type") == "progress":
            out.append(ev)
    return out


def test_start_right_after_done_opens_labeled_bar():
    s, q = _session()
    s.progress({"id": "aa-get", "status": "running", "label": "Books", "start": True})
    s.progress({"id": "aa-get", "status": "done"})
    s.progress({"id": "aa-get", "status": "running", "label": "Books", "start": True})
    evs = _bars(q)
    assert [e["id"] for e in evs] == ["aa-get", "aa-get", "aa-get~1"]
    assert evs[-1]["label"] == "Books"


def test_straggler_without_start_is_still_ignored():
    s, q = _session()
    s.progress({"id": "x", "status": "running", "label": "L"})
    s.progress({"id": "x", "status": "done"})
    s.progress({"id": "x", "status": "running", "label": "L"})
    assert [e["id"] for e in _bars(q)] == ["x", "x"]


def test_new_generation_from_set_keeps_label():
    s, q = _session()
    s.progress({"id": "ocr", "status": "running", "label": "OCR book"})
    s.progress({"id": "ocr", "status": "done"})
    s._progress["ocr"]["last"] -= 10          # well clear of the straggler window
    s.progress({"id": "ocr", "status": "running", "pct": 5})
    ev = _bars(q)[-1]
    assert ev["id"] == "ocr~1" and ev["label"] == "OCR book"
