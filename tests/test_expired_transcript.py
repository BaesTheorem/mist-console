"""A chat whose CLI transcript expired gets its conversation back as text.

Claude Code deletes a session transcript after cleanupPeriodDays. The Console
used to --resume the dead id, fail with "No conversation found", and then start
a blank session while the window still showed the whole chat (2026-10-02). Now
the next spawn starts fresh and the next send carries a replay built from the
Console's own log (replay.py).
"""
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("MIST_CONSOLE_DATA_DIR", "/tmp/mist-console-test-data")
os.makedirs(os.environ["MIST_CONSOLE_DATA_DIR"], exist_ok=True)

import bridge
import replay


def _chat():
    """Two turns: a question with a tool call and thinking, then a follow-up."""
    return [
        {"type": "user_text", "text": "Find the closest place to camp.", "seq": 1, "ts": 1787529387.0},
        {"type": "assistant", "seq": 2, "uuid": "u2", "ts": 1787529390.0, "message": {
            "id": "m2", "content": [
                {"type": "thinking", "thinking": "SECRET-THINKING"},
                {"type": "text", "text": "Checking the atlas."},
                {"type": "tool_use", "id": "t1", "name": "Bash",
                 "input": {"command": "curl https://example.org", "description": "Query the MDC atlas"}}]}},
        {"type": "user", "seq": 3, "message": {"content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": "TOOL-OUTPUT"}]}},
        {"type": "assistant", "seq": 4, "uuid": "u4", "ts": 1787530099.0, "message": {
            "id": "m4", "content": [{"type": "text", "text": "Crooked River is the closest free site."}]}},
        {"type": "user_text", "text": "pause", "kind": "pause", "seq": 5, "ts": 1787530100.0},
        {"type": "user_text", "text": "Save this list to Obsidian", "seq": 6, "ts": 1790963211.0},
        {"type": "result", "seq": 7, "is_error": True},
    ]


# ---- replay.build ----------------------------------------------------------

def test_replay_has_both_sides_and_drops_thinking_and_tool_output():
    text, n, omitted = replay.build(_chat(), stop_seq=6)
    assert text.startswith("<console_replay>") and text.endswith("</console_replay>")
    assert "Alex:\nFind the closest place to camp." in text
    assert "Checking the atlas.\n[tool: Bash: Query the MDC atlas]\nCrooked River" in text
    assert "SECRET-THINKING" not in text
    assert "TOOL-OUTPUT" not in text
    assert "pause" not in text.split("\n\n", 1)[1]      # a control chip is not a message
    assert "Save this list" not in text                  # stop_seq keeps the new message out
    assert (n, omitted) == (2, 0)


def test_replay_keeps_one_copy_of_a_resent_message():
    events = _chat()[:4] + [
        {"type": "user_text", "text": "Save this list", "seq": 10, "ts": 1.0},
        {"type": "user_text", "text": "Save this list", "seq": 11, "ts": 2.0},
    ]
    text, n, _ = replay.build(events)
    assert text.count("Save this list") == 1 and n == 3


def test_replay_reads_a_condensed_log():
    events = [{"type": "user_text", "text": "hi", "seq": 1, "ts": 1.0},
              {"type": "mist_msg", "seq": 2, "ts": 2.0, "blocks": [
                  {"kind": "text", "text": "hello"}, {"kind": "tool", "name": "Read",
                                                      "input": {"file_path": "/a/b.md"}, "result": "x"}]}]
    text, n, _ = replay.build(events)
    assert "MIST:\nhello\n[tool: Read: /a/b.md]" in text and n == 2


def test_replay_over_the_cap_keeps_the_first_ask_and_the_newest_turns():
    events = []
    for i in range(200):
        events.append({"type": "user_text", "text": f"question {i} " + "q" * 900, "seq": 2 * i, "ts": float(i)})
        events.append({"type": "mist_msg", "seq": 2 * i + 1, "ts": float(i),
                       "blocks": [{"kind": "text", "text": f"answer {i} " + "a" * 900}]})
    text, n, omitted = replay.build(events, cap=50_000)
    assert n == 400 and omitted > 0
    assert "question 0 " in text and "answer 199 " in text
    assert "question 1 " not in text
    assert f"[... {omitted} earlier messages left out to fit ...]" in text
    assert len(text) < 50_000 + 2_000           # the header is the only overshoot


def test_replay_of_an_empty_log_is_none():
    assert replay.build([]) is None
    assert replay.build([{"type": "user_text", "text": "x", "seq": 5}], stop_seq=5) is None


# ---- bridge ----------------------------------------------------------------

class _FakeProc:
    def __init__(self, stdout=()):
        self.stdin = io.StringIO()
        self.stdout = iter(stdout)

    def written(self):
        return [json.loads(line) for line in self.stdin.getvalue().splitlines()]


def _session(tmp_path, monkeypatch, csid="dead-beef", loaded=True):
    monkeypatch.setattr(bridge, "CLI_PROJECTS", str(tmp_path / "projects"))
    (tmp_path / "projects" / "-x").mkdir(parents=True)
    s = bridge.ClaudeSession(id="t-exp", autostart=False, claude_session_id=csid,
                             cwd=str(tmp_path))
    s._jsonl = str(tmp_path / "t-exp.jsonl")
    with open(s._jsonl, "w") as f:
        f.writelines(json.dumps(ev) + "\n" for ev in _chat()[:4])
    if loaded:
        s._history_loaded = True
        s._ev_seq = 4
    return s


def test_a_missing_cli_file_means_no_resume(tmp_path, monkeypatch):
    s = _session(tmp_path, monkeypatch)
    assert s._transcript_gone()
    s._seed_pending = True
    assert "--resume" not in s._build_cmd()


def test_a_present_cli_file_still_resumes(tmp_path, monkeypatch):
    s = _session(tmp_path, monkeypatch)
    (tmp_path / "projects" / "-x" / "dead-beef.jsonl").write_text("{}\n")
    assert not s._transcript_gone()
    cmd = s._build_cmd()
    assert cmd[cmd.index("--resume") + 1] == "dead-beef"


def test_send_into_an_expired_chat_carries_the_replay(tmp_path, monkeypatch):
    s = _session(tmp_path, monkeypatch)
    s._seed_pending = True
    s.proc, s.alive = _FakeProc(), True
    monkeypatch.setattr(s, "ensure_started", lambda: None)
    assert s.send("Save this list to Obsidian")
    content = s.proc.written()[0]["message"]["content"]
    assert content[0]["text"].startswith("<console_replay>")
    assert "Crooked River" in content[0]["text"]
    assert "Save this list" not in content[0]["text"]
    assert content[1] == {"type": "text", "text": "Save this list to Obsidian"}
    shown = [e for e in s.history if e["type"] in ("user_text", "notice")]
    assert (shown[0]["type"], shown[0]["text"]) == ("user_text", "Save this list to Obsidian")
    assert shown[1]["type"] == "notice" and "2 messages" in shown[1]["text"]
    assert s._seed_pending and s._seed_inflight     # until the new session inits


def test_init_after_a_seeded_send_ends_the_seeding(tmp_path, monkeypatch):
    s = _session(tmp_path, monkeypatch)
    s._seed_pending = s._seed_inflight = True
    init = json.dumps({"type": "system", "subtype": "init", "session_id": "new-id"})
    s.proc = _FakeProc(stdout=[init + "\n"])
    s._read_stdout(s.proc)
    assert not s._seed_pending and not s._seed_inflight
    assert s.claude_session_id == "new-id"


def test_a_refused_resume_reseeds_and_resends(tmp_path, monkeypatch):
    s = _session(tmp_path, monkeypatch)
    (tmp_path / "projects" / "-x" / "dead-beef.jsonl").write_text("{}\n")   # pre-check passes
    old = _FakeProc()
    old.wait = lambda: 1
    s.proc, s.alive = old, True
    assert s.send("Save this list to Obsidian")
    assert "<console_replay>" not in old.stdin.getvalue()
    s._resume_missing = True          # what _read_stderr sets on "No conversation found"
    new = _FakeProc()

    def fake_start():
        s.proc, s.alive = new, True
    monkeypatch.setattr(s, "ensure_started", fake_start)
    s._watch(old)
    content = new.written()[0]["message"]["content"]
    assert content[0]["text"].startswith("<console_replay>")
    assert content[1]["text"] == "Save this list to Obsidian"
    assert sum(e["type"] == "user_text" for e in s.history) == 1   # not shown twice


def test_a_send_before_the_chat_is_opened_still_gets_the_replay(tmp_path, monkeypatch):
    s = _session(tmp_path, monkeypatch, loaded=False)   # _ev_seq still 0
    s._seed_pending = True
    s.proc, s.alive = _FakeProc(), True
    monkeypatch.setattr(s, "ensure_started", lambda: None)
    assert s.send("Save this list to Obsidian")
    content = s.proc.written()[0]["message"]["content"]
    assert "Crooked River" in content[0]["text"]
    assert [e["seq"] for e in s.history][-2:] == [5, 6]    # user_text, then the notice
