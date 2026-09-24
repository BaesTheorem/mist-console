"""The in-memory replay window keeps a chat's beginning.

A long chat used to replay only its last HISTORY_CAP raw events, so the page
could not scroll back to the first message. Now everything older than the
window is condensed (archive.Condenser) instead of dropped.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("MIST_CONSOLE_DATA_DIR", "/tmp/mist-console-test-data")

import archive
import bridge


def _turn(seq, n_deltas, text, tool_id=None):
    """One user turn as the CLI records it: user_text, stream deltas, the
    assistant message, and (optionally) the tool's result in a user event."""
    ev = [{"type": "user_text", "text": text, "seq": seq, "ts": float(seq)}]
    seq += 1
    for _ in range(n_deltas):
        ev.append({"type": "stream_event", "seq": seq,
                   "event": {"type": "content_block_delta", "delta": {"text": "x"}}})
        seq += 1
    content = [{"type": "text", "text": "reply to " + text}]
    if tool_id:
        content.append({"type": "tool_use", "id": tool_id, "name": "Bash", "input": {"command": "ls"}})
    ev.append({"type": "assistant", "seq": seq, "uuid": f"u{seq}",
               "message": {"id": f"m{seq}", "content": content}})
    seq += 1
    if tool_id:
        ev.append({"type": "user", "seq": seq, "message": {"content": [
            {"type": "tool_result", "tool_use_id": tool_id, "content": "listing"}]}})
        seq += 1
    ev.append({"type": "context", "seq": seq, "pct": 10})
    return ev, seq + 1


def _chat(turns, deltas):
    events, seq = [], 1
    for i in range(turns):
        t, seq = _turn(seq, deltas, f"turn {i}", tool_id=f"t{i}")
        events += t
    return events


def test_under_cap_is_unchanged():
    ev = _chat(3, 5)
    assert bridge.fold_history(ev, 1000) == ev


def test_over_cap_keeps_first_message_and_all_turns():
    ev = _chat(10, 100)                    # ~1050 events
    out = bridge.fold_history(ev, 300)
    assert out[0] == ev[0]                 # the very first user message survives
    users = [e["text"] for e in out if e["type"] == "user_text"]
    assert users == [f"turn {i}" for i in range(10)]
    assert len(out) < len(ev)


def test_seam_falls_on_a_turn_boundary():
    ev = _chat(10, 100)
    out = bridge.fold_history(ev, 300)
    first_raw = next(i for i, e in enumerate(out) if e["type"] == "stream_event")
    assert out[first_raw - 1]["type"] == "user_text"
    # everything before the seam is condensed: no deltas, one mist_msg per reply
    before = out[:first_raw - 1]
    assert not any(e["type"] in ("stream_event", "assistant", "user") for e in before)
    assert all(b["result"] == "listing" for e in before if e["type"] == "mist_msg"
               for b in e["blocks"] if b["kind"] == "tool")


def test_seq_stays_monotonic():
    out = bridge.fold_history(_chat(10, 100), 300)
    seqs = [e["seq"] for e in out if isinstance(e.get("seq"), int)]
    assert seqs == sorted(seqs) and len(seqs) == len(set(seqs))


def test_refolding_is_stable():
    once = bridge.fold_history(_chat(10, 100), 300)
    twice = bridge.fold_history(once, 50)
    assert [e["text"] for e in twice if e["type"] == "user_text"] == \
           [e["text"] for e in once if e["type"] == "user_text"]
    assert twice[0] == once[0]


def test_condense_events_matches_condenser():
    ev = _chat(3, 5)
    out = archive.condense_events(ev)
    msgs = [e for e in out if e["type"] == "mist_msg"]
    assert len(msgs) == 3
    assert msgs[0]["blocks"][1] == {"kind": "tool", "name": "Bash", "input": {"command": "ls"},
                                    "result": "listing"}
    assert out[-1]["type"] == "context" and out[-1]["seq"] == ev[-1]["seq"]
