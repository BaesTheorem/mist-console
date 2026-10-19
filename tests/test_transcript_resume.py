"""Phone transcript and stream resume.

- transcript.build leaves out subagent turns (parent_tool_use_id set): they
  are a tool's inner workings, not MIST's reply or Alex's message.
- archive.Condenser stamps each mist_msg with the seq range it folded, and a
  stream resume whose `after` falls inside a condensed message replays in full
  instead of skipping the rest of that message.
"""
# ruff: noqa: SLF001  (white-box tests of app internals)
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("MIST_CONSOLE_DATA_DIR", tempfile.mkdtemp(prefix="mist-transcript-test-"))

import app  # noqa: E402
import archive  # noqa: E402
import transcript  # noqa: E402


def _write(events):
    fd, path = tempfile.mkstemp(suffix=".jsonl")
    with os.fdopen(fd, "w") as f:
        f.writelines(json.dumps(e) + "\n" for e in events)
    return path


def _asst(mid, text, parent=None, seq=None, tool=None):
    content = [{"type": "text", "text": text}]
    if tool:
        content.append({"type": "tool_use", "id": tool, "name": "Bash", "input": {"command": "ls"}})
    ev = {"type": "assistant", "message": {"id": mid, "content": content}}
    if parent:
        ev["parent_tool_use_id"] = parent
    if seq is not None:
        ev["seq"] = seq
    return ev


def test_subagent_turns_left_out():
    path = _write([
        {"type": "user_text", "text": "research X", "ts": 1},
        _asst("m1", "Starting an agent.", tool="toolu_1"),
        _asst("sub1", "subagent thinking out loud", parent="toolu_1"),
        {"type": "user", "parent_tool_use_id": "toolu_1",
         "message": {"content": [{"type": "text", "text": "subagent prompt"}]}},
        {"type": "user_text", "text": "a prompt inside the agent", "parent_tool_use_id": "toolu_1"},
        _asst("m2", "Here is what it found."),
    ])
    try:
        msgs = transcript.build(path)["messages"]
    finally:
        os.unlink(path)
    texts = [(m["role"], m["text"]) for m in msgs]
    assert ("assistant", "subagent thinking out loud") not in texts
    assert all(m["text"] != "a prompt inside the agent" for m in msgs)
    assert [t for r, t in texts if r == "assistant"] == ["Starting an agent.", "Here is what it found."]
    assert [t for r, t in texts if r == "user"] == ["research X"]


def test_condenser_records_seq_end():
    out = archive.condense_events([
        {"type": "user_text", "text": "go", "seq": 1},
        _asst("m1", "part one", seq=2, tool="toolu_a"),
        {"type": "stream_event", "seq": 3},
        _asst("m1", "part two", seq=4),
        {"type": "user", "seq": 6, "message": {"content": [
            {"type": "tool_result", "tool_use_id": "toolu_a", "content": "ok"}]}},
        _asst("m2", "done", seq=7),
    ])
    msgs = [e for e in out if e["type"] == "mist_msg"]
    assert (msgs[0]["seq"], msgs[0]["seq_end"]) == (2, 6)
    assert (msgs[1]["seq"], msgs[1]["seq_end"]) == (7, 7)


def test_resume_inside_condensed_message_replays_full():
    hist = [{"type": "user_text", "seq": 1},
            {"type": "mist_msg", "seq": 2, "seq_end": 6, "blocks": [{"kind": "text", "text": "x"}]},
            {"type": "user_text", "seq": 9}]
    assert app._resume_splits_condensed(hist, 4)        # saw part of the message
    assert not app._resume_splits_condensed(hist, 6)    # saw all of it
    assert not app._resume_splits_condensed(hist, 8)
    assert not app._resume_splits_condensed(hist, 1)    # message is wholly after
    # a condensed event without seq_end (archived on disk before the field)
    legacy = [{"type": "mist_msg", "seq": 2, "blocks": []}, {"type": "user_text", "seq": 9}]
    assert app._resume_splits_condensed(legacy, 5)
    assert not app._resume_splits_condensed(legacy, 8)
    assert app._resume_splits_condensed([{"type": "mist_msg", "seq": 2}], 5)
