"""'Chat about this' on a permission card: the call does not run, the turn
goes on, and the model gets the instruction to explain and wait."""
# ruff: noqa: SLF001
import os
import sys

os.environ.setdefault("MIST_CONSOLE_DATA_DIR", "/tmp/mist-console-test-data")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import bridge  # noqa: E402


def _session():
    s = bridge.ClaudeSession(id="perm-chat-test", autostart=False)
    s._record = lambda obj: None          # no jsonl writes from a unit test
    s.sent = []
    s._write_stdin = lambda obj: s.sent.append(obj) or True
    return s


def _answer(s, tool, decision):
    s._pending_perms["r1"] = {"tool_name": tool, "input": {"command": "x"}, "suggestions": []}
    assert s.respond_permission("r1", decision)
    return s.sent[-1]["response"]["response"]


def test_chat_denies_without_interrupt_and_explains():
    r = _answer(_session(), "Bash", "chat")
    assert r["behavior"] == "deny"
    assert r["interrupt"] is False
    assert r["message"] == bridge.CHAT_ABOUT_THIS


def test_plain_deny_still_interrupts():
    r = _answer(_session(), "Bash", "deny")
    assert r["behavior"] == "deny" and r["interrupt"] is True


def test_chat_on_a_question_card_is_a_dismiss():
    r = _answer(_session(), "AskUserQuestion", "chat")
    assert r["behavior"] == "deny" and r["interrupt"] is False
    assert r["message"] != bridge.CHAT_ABOUT_THIS
