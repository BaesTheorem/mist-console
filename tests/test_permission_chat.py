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


# ---- the reason line on the card (bridge._perm_reason) ----------------------
# The request shapes below are the ones claude 2.1.322 sent on 2026-11-11.

def _why(mode="bypassPermissions", **req):
    req.setdefault("tool_name", "Bash")
    return bridge.ClaudeSession._perm_reason(req, mode)


def test_reason_for_removal_of_the_working_folder():
    w = _why(decision_reason_type="safetyCheck",
             decision_reason="Dangerous rm operation on working directory or its ancestor: /a/tmp/x")
    assert "deletes the folder" in w["text"] and "/a/tmp/x" in w["text"]
    assert "bypass too" in w["text"]
    assert w["raw"].startswith("Dangerous rm")


def test_reason_for_the_identity_guard_hook():
    w = _why(decision_reason_type="hook",
             decision_reason="Identity guard: this command makes a web request and contains "
                             "Alex's email or street address. A site that asks...")
    assert w["short"] == "identity guard"
    assert "contains your email or street address" in w["text"]


def test_reason_in_an_asking_mode_names_the_mode_and_path():
    w = _why(mode="default", blocked_path="/a/x.txt")
    assert "Default mode" in w["text"] and "/a/x.txt" in w["text"]
    assert "bypass" not in w["text"].lower()


def test_unknown_reason_keeps_the_cli_wording():
    w = _why(decision_reason_type="somethingNew", decision_reason="New thing happened")
    assert w["raw"] == "New thing happened" and w["text"]


def test_plan_and_question_cards_get_no_reason():
    assert _why(tool_name="ExitPlanMode") is None
    assert _why(tool_name="AskUserQuestion") is None


def test_request_event_and_banner_carry_the_reason():
    s = _session()
    s.events = []
    s._broadcast = s.events.append
    s.banners = []
    s._notify_permission = lambda *a: s.banners.append(a)
    s._handle_control_request({"request_id": "r9", "request": {
        "subtype": "can_use_tool", "tool_name": "Bash", "input": {"command": "rm -rf x"},
        "decision_reason_type": "safetyCheck",
        "decision_reason": "Dangerous rm operation on working directory or its ancestor: /a/x"}})
    assert s.events[0]["why"]["short"] == "deletes its own working folder"
    assert s.banners[0][3] == s.events[0]["why"]
