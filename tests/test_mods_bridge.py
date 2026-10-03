"""Claude Mods + remote surface in the bridge: the spawn environment names the
mods folder, the flags turn into CLI switches, the engine's pushes are relayed
with the right record flag, dialog kinds follow the protocol (declared ->
card, undeclared -> silence), and an engine ask the page never answers gets
its default shape before the CLI's 5 s deadline."""
import json
import os
import queue
import sys
import time

os.environ.setdefault("MIST_CONSOLE_DATA_DIR", "/tmp/mist-console-test-data")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bridge  # noqa: E402


class _Stdin:
    def __init__(self):
        self.lines = []

    def write(self, s):
        self.lines.append(s)

    def flush(self):
        pass


class _Proc:
    def __init__(self):
        self.stdin = _Stdin()


def _session(alive=True):
    s = bridge.ClaudeSession(id="mods-test", autostart=False)
    s._record = lambda obj: None
    s.proc = _Proc()
    s.alive = alive
    q = queue.Queue()
    s._subscribers.append(q)
    return s, q


def _drain(q):
    out = []
    while not q.empty():
        out.append(q.get_nowait())
    return out


def _written(s):
    return [json.loads(x) for x in s.proc.stdin.lines]


def test_flags_become_cli_switches(tmp_path, monkeypatch):
    monkeypatch.setattr(bridge, "FLAGS_PATH", str(tmp_path / "flags.json"))
    bridge.save_flags({"prompt_suggestions": True, "hook_events": False, "subagent_text": True,
                       "chrome": False, "fallback_model": "sonnet", "autocompact": "200k",
                       "max_budget_usd": "3"})
    s = bridge.ClaudeSession(id="flags", title="Hello there", autostart=False)
    cmd = s._build_cmd()
    assert "--prompt-suggestions" in cmd
    assert "--include-hook-events" not in cmd
    assert "--forward-subagent-text" in cmd
    assert "--chrome" not in cmd
    assert cmd[cmd.index("--fallback-model") + 1] == "sonnet"
    assert cmd[cmd.index("--autocompact") + 1] == "200k"
    assert cmd[cmd.index("--max-budget-usd") + 1] == "3"
    assert cmd[cmd.index("--name") + 1] == "Hello there"
    # unknown keys and wrong types never land
    bridge.save_flags({"bogus": 1, "chrome": "yes"})
    assert "bogus" not in bridge.FLAGS and bridge.FLAGS["chrome"] is True
    bridge.save_flags(dict(bridge.FLAG_DEFAULTS))


def test_initialize_declares_dialog_kinds():
    s, _ = _session()
    s._maybe_init_control()
    req = _written(s)[0]["request"]
    assert req["subtype"] == "initialize"
    assert req["supportedDialogKinds"] == ["refusal_fallback_prompt"]


def test_ui_pushes_are_live_only_and_remembered():
    s, q = _session()
    recorded = []
    s._record = recorded.append
    for sub, extra in (("ui_status", {"plugin": "p", "text": "3 tools"}),
                       ("ui_toast", {"plugin": "p", "text": "hi", "timeout_ms": 4000}),
                       ("ui_panes", {"panes": [{"id": "a", "title": "A", "plugin": "p"}],
                                     "shown_id": "a", "focused_id": None, "focus_requested_id": None})):
        obj = dict(extra, type="system", subtype=sub)
        s._note_ui_push(obj)
        s._broadcast(obj, record=False)
    evs = _drain(q)
    assert [e["subtype"] for e in evs] == ["ui_status", "ui_toast", "ui_panes"]
    assert recorded == []                      # ephemeral: never written to the log
    assert s.mod_status == {"p": "3 tools"}
    assert s.panes["shown_id"] == "a"
    s._note_ui_push({"type": "system", "subtype": "ui_status", "plugin": "p", "text": None})
    assert s.mod_status == {}


def test_declared_dialog_becomes_a_card_and_answers():
    s, q = _session()
    s._notify_dialog = lambda ev: None
    s._handle_control_request({"type": "control_request", "request_id": "r1", "request": {
        "subtype": "request_user_dialog", "dialog_kind": "refusal_fallback_prompt",
        "payload": {"originalModel": "opus", "fallbackModel": "sonnet"}}})
    ev = _drain(q)[0]
    assert ev["type"] == "dialog_request" and ev["kind"] == "refusal_fallback_prompt"
    assert s.respond_dialog("r1", "retry_fallback")
    resp = _written(s)[-1]["response"]
    assert resp["request_id"] == "r1"
    assert resp["response"] == {"behavior": "completed", "result": "retry_fallback"}
    assert not s.respond_dialog("r1", "retry_fallback")   # answered once


def test_undeclared_dialog_gets_no_answer_at_all():
    s, q = _session()
    consumed = s._handle_control_request({"type": "control_request", "request_id": "r2", "request": {
        "subtype": "request_user_dialog", "dialog_kind": "auto_mode_server_fallback", "payload": {}}})
    assert consumed
    assert _written(s) == []                   # protocol: silence, never an error reply
    assert _drain(q) == []


def test_interrupt_cancels_a_pending_dialog():
    s, _ = _session()
    s._notify_dialog = lambda ev: None
    s._handle_control_request({"type": "control_request", "request_id": "r3", "request": {
        "subtype": "request_user_dialog", "dialog_kind": "refusal_fallback_prompt", "payload": {}}})
    s.interrupt()
    kinds = [w for w in _written(s) if w.get("type") == "control_response"]
    assert kinds and kinds[0]["response"]["response"] == {"behavior": "cancelled"}


def test_ui_ask_defaults_without_a_page():
    s, _ = _session()
    s._subscribers.clear()
    s._handle_control_request({"type": "control_request", "request_id": "a1", "request": {
        "subtype": "ui_prompt_read", "surface": "desktop", "client_id": "mist-console"}})
    resp = _written(s)[-1]["response"]
    assert resp["request_id"] == "a1" and resp["response"] == {"text": "", "cursor": 0}


def test_ui_ask_relayed_then_answered_by_the_page(monkeypatch):
    monkeypatch.setattr(bridge, "UI_ASK_TIMEOUT", 0.2)
    s, q = _session()
    s._handle_control_request({"type": "control_request", "request_id": "a2", "request": {
        "subtype": "ui_copy", "surface": "desktop", "client_id": "mist-console",
        "plugin": "p", "text": "copy me"}})
    ev = _drain(q)[0]
    assert ev["type"] == "ui_ask" and ev["ask"] == "ui_copy" and ev["text"] == "copy me"
    assert s.respond_ui_ask("a2", {"copied": True})
    assert _written(s)[-1]["response"]["response"] == {"copied": True}
    # the second one times out into its default
    s._handle_control_request({"type": "control_request", "request_id": "a3", "request": {
        "subtype": "ui_prompt_suggest", "surface": "desktop", "client_id": "mist-console", "text": "x"}})
    time.sleep(0.5)
    assert _written(s)[-1]["response"] == {"subtype": "success", "request_id": "a3",
                                           "response": {"shown": False}}


def test_ui_call_stamps_surface_and_client(monkeypatch):
    s, _ = _session()
    seen = {}

    def fake_control_call(subtype, payload=None, timeout=20.0):
        seen["subtype"] = subtype
        seen["payload"] = payload
        return True, {"tree": None, "hooked": False}
    s._ui_attached = True
    monkeypatch.setattr(s, "control_call", fake_control_call)
    ok, resp = s.ui_call("ui_render", {"component": "Pane", "instance_id": "x", "props": {}})
    assert ok and resp["hooked"] is False
    assert seen["subtype"] == "ui_render"
    assert seen["payload"]["surface"] == "desktop"
    assert seen["payload"]["client_id"] == "mist-console"
    assert seen["payload"]["viewport"]["columns"] > 0


def test_spawn_env_names_the_mods_folder(monkeypatch, tmp_path):
    mods = tmp_path / "mods"
    mods.mkdir()
    monkeypatch.setattr(bridge, "MODS_DIR", str(mods))
    monkeypatch.setenv("CLAUDE_CODE_PLUGIN_DIRS", "/elsewhere/plugins")
    captured = {}

    class FakeProc:
        stdin = _Stdin(); stdout = iter(()); stderr = iter(())

        def wait(self):
            return 0

        def poll(self):
            return 0

    def fake_popen(cmd, cwd=None, env=None, **kw):
        captured["env"] = env
        return FakeProc()
    monkeypatch.setattr(bridge.subprocess, "Popen", fake_popen)
    s = bridge.ClaudeSession(id="env", autostart=False)
    s._record = lambda obj: None
    s._maybe_init_control = lambda: None
    s.ensure_started()
    dirs = captured["env"]["CLAUDE_CODE_PLUGIN_DIRS"].split(os.pathsep)
    assert dirs[0] == str(mods) and "/elsewhere/plugins" in dirs
    assert captured["env"]["CLAUDE_CODE_PLUGIN_DIR_WATCH"] == "1"
    s.alive = False
