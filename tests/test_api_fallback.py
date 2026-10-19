"""A chat moves to the API key only on a plan-limit error with the gate open."""

import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bridge  # noqa: E402


class _Sync(threading.Thread):
    def start(self):
        self.run()


def _session(monkeypatch, gate_open):
    monkeypatch.setattr(bridge, "api_gate_open", lambda: gate_open)
    monkeypatch.setattr(bridge.threading, "Thread", _Sync)
    s = bridge.ClaudeSession.__new__(bridge.ClaudeSession)
    s.api_mode = False
    s._api_running = False
    s.events, s.restarts = [], []
    s._broadcast = s.events.append
    s.restart_backend = lambda: s.restarts.append(1)
    return s


LIMIT = {"type": "result", "is_error": True, "result": "You've hit your limit · resets 3am"}


def test_limit_and_gate_open_arms_api(monkeypatch):
    s = _session(monkeypatch, True)
    s._api_after_result(LIMIT)
    assert s.api_mode and s.restarts


def test_limit_but_gate_closed_stays_on_plan(monkeypatch):
    s = _session(monkeypatch, False)
    s._api_after_result(LIMIT)
    assert not s.api_mode and not s.restarts


def test_normal_turn_never_reads_gate(monkeypatch):
    s = _session(monkeypatch, True)
    monkeypatch.setattr(bridge, "api_gate_open", lambda: (_ for _ in ()).throw(AssertionError))
    s._api_after_result({"type": "result", "is_error": False, "result": "usage limit text in a reply"})
    assert not s.api_mode


def test_api_chat_returns_to_plan_when_gate_closes(monkeypatch):
    s = _session(monkeypatch, False)
    s.api_mode = s._api_running = True
    s._api_after_result({"type": "result", "is_error": False, "result": "ok"})
    assert not s.api_mode and s.restarts
