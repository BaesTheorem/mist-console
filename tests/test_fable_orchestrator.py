"""On Fable, a Console chat orchestrates and Opus 5.5 (1M) subagents work.

The prompt is appended at spawn and the subagent pin rides in the env, so a
model switch that crosses the Fable boundary has to respawn the backend.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("MIST_CONSOLE_DATA_DIR", "/tmp/mist-console-test-data")

import bridge


def _session(model):
    return bridge.ClaudeSession(id="t-fable", model=model, autostart=False)


def _appended(cmd):
    return cmd[cmd.index("--append-system-prompt") + 1]


def test_fable_gets_orchestrator_prompt():
    assert bridge.FABLE_ORCHESTRATOR_PROMPT in _appended(_session("claude-fable-5-1")._build_cmd())


def test_other_models_do_not():
    for model in ("claude-opus-5-5[1m]", "claude-sonnet-5", None):
        assert bridge.FABLE_ORCHESTRATOR_PROMPT not in _appended(_session(model)._build_cmd())


def test_worker_is_opus_1m_and_forced():
    env = bridge.FABLE_ORCHESTRATOR_ENV
    assert env["CLAUDE_CODE_SUBAGENT_MODEL"] == "claude-opus-5-5[1m]"
    assert env["CLAUDE_CODE_SUBAGENT_MODEL_FORCE"] == "1"


def test_switch_across_fable_respawns_instead_of_live():
    s = _session("claude-opus-5-5[1m]")
    s.alive = True
    calls = []
    s.control_call = lambda *a, **k: calls.append(a) or (True, None)
    s.stop = lambda *a, **k: setattr(s, "alive", False)
    assert s.set_model("claude-fable-5-1") is False
    assert calls == [] and s.alive is False


def test_switch_within_non_fable_stays_live():
    s = _session("claude-opus-5-5[1m]")
    s.alive = True
    s.control_call = lambda *a, **k: (True, None)
    assert s.set_model("claude-sonnet-5") is True
