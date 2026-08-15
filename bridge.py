"""
bridge.py — manages headless `claude` processes and relays their stream-json
event protocol to subscribers (the SSE endpoint), with per-session history
persistence so conversations survive reloads, tab switches, and app restarts.

A session can be DORMANT (loaded from disk, transcript visible, no process) and
starts its claude process lazily on the first send.
"""
import json
import os
import queue
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request

HARNESS = "/Users/alexhedtke/Documents/Exobrain harness"


def _find_claude():
    """Locate the `claude` CLI instead of hardcoding one install path.

    WHY: the CLI has moved homes before. It used to live in the npm-global
    prefix; the native installer puts it at ~/.local/bin/claude. A hardcoded
    path survives an upgrade but not a *reinstall by another method*, and the
    failure is opaque — every session dies at spawn with a missing-file error
    and the Console just says "error" on send. Probe the known homes, then
    fall back to PATH.
    """
    candidates = [
        os.path.expanduser("~/.local/bin/claude"),      # native installer
        os.path.expanduser("~/.npm-global/bin/claude"),  # npm global prefix
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
    ]
    for path in candidates:
        if os.access(path, os.X_OK):
            return path
    return shutil.which("claude") or candidates[0]


CLAUDE = _find_claude()
# Every subprocess we spawn puts the CLI's own directory on PATH, so `claude`
# is callable by name from anything the session shells out to.
CLAUDE_BIN_DIR = os.path.dirname(CLAUDE)
# Persona comes from the harness CLAUDE.md (auto-loaded via cwd=HARNESS), not a side file.
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
os.makedirs(DATA_DIR, exist_ok=True)

DEFAULT_PERMISSION_MODE = "bypassPermissions"
HISTORY_CAP = 8000   # max events kept in memory for replay (jsonl keeps all)

# Where the Console answers, and where its own CLI tools live. Both are handed to
# every session's environment so a shell inside a chat can talk back to that chat
# (see ensure_started + the /progress route).
CONSOLE_BIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bin")
CONSOLE_URL = os.environ.get("MIST_CONSOLE_URL", "http://127.0.0.1:5014")
# Banners for blocking permission asks (see _notify_permission).
NOTIFY_BIN = os.path.join(HARNESS, "mist-voice", "bin", "mist-notify")

# Progress-event policy. A download posts many updates a second; broadcasting all
# of them is fine (SSE is cheap) but PERSISTING all of them is not — the jsonl is
# replayed on every open, and a 10-minute install would bury the transcript in
# thousands of dead ticks. So intermediate ticks are ephemeral (live subscribers
# only) and only the first event for a bar and its terminal state hit disk: a
# replayed transcript shows each transfer once, in its final state.
PROGRESS_MIN_INTERVAL = 0.15   # seconds between broadcasts per bar (terminal always passes)
PROGRESS_TERMINAL = ("done", "error", "canceled")

# app.py sets this to its _save_meta so a session can persist itself the instant
# its claude_session_id is assigned (on the backend's init event) — otherwise the
# id lives only in memory until the 10s periodic saver, and a window close /
# crash in between reopens the chat empty with its transcript orphaned.
on_meta_dirty = None

# Event slimming. Raw stream-json events carry a `tool_use_result` sidecar that
# nothing in the Console reads; for edits/reads of large files it embeds whole
# file snapshots — one edit to the 13 MB dnd-sheet index.html persisted ~14 MB,
# and a single coding session's jsonl reached 1.5 GB (data/ hit 21 GB, and the
# nightly Exobrain backup ballooned with it). Oversized payloads are stubbed
# before they reach history/disk; a generic string cap then bounds any future
# event shape we haven't met yet. Raise the caps if a feature ever needs the
# full payloads back.
TOOL_RESULT_STUB_OVER = 32_768   # bytes of serialized tool_use_result kept as-is
STRING_CAP = 262_144             # any longer string field is truncated


def _slim_event(obj):
    """Return obj with oversized payloads stubbed/truncated. Copy-on-write:
    the dict already broadcast to live subscribers is never mutated."""
    try:
        out = obj
        tur = obj.get("tool_use_result")
        if tur is not None:
            blob = json.dumps(tur)
            if len(blob) > TOOL_RESULT_STUB_OVER:
                out = dict(obj)
                out["tool_use_result"] = {"_stubbed": True, "_bytes": len(blob)}
        if len(json.dumps(out)) > 2 * STRING_CAP:
            def walk(v):
                if isinstance(v, str) and len(v) > STRING_CAP:
                    return v[:STRING_CAP] + "…[+%d chars stripped]" % (len(v) - STRING_CAP)
                if isinstance(v, list):
                    return [walk(x) for x in v]
                if isinstance(v, dict):
                    return {k: walk(x) for k, x in v.items()}
                return v
            out = walk(out)
        return out
    except Exception:
        return obj

# Context-cost cap. A headless `claude -p --resume` re-bills the WHOLE conversation
# every turn (no interactive auto-compact here), so a long-lived chat gets quietly
# expensive — the token sink behind "the Console burns tokens during heavy coding".
# We surface that: a one-shot notice when occupancy crosses CTX_WARN_PCT, and a soft
# gate at CTX_HARD_PCT that holds the first over-threshold send (then lets the next
# one through, so the user is never locked out). Thresholds match the ctx badge's
# own yellow(60)/red(80) cues in app.js so the warning lines up with the color.
CTX_WARN_PCT = 60
CTX_HARD_PCT = 80

# Idle-process reaper. Each open chat holds a live `claude` backend (~300 MB plus
# a steady sliver of CPU) for as long as the Console runs, even when the
# conversation has been untouched for hours — so a day of chat-hopping leaves a
# dozen idle backends pinning GBs of RAM. After IDLE_REAP_SEC of no activity (and
# no in-flight turn) the reaper puts a backend dormant; the next send revives it
# via --resume with full context. This is pure RAM/CPU reclamation: a --resume
# turn re-bills the whole conversation regardless (see the CTX cost note above),
# and the warm prompt cache is already gone after ~5 min idle, so reaping a
# long-idle chat costs zero extra tokens. Set MIST_CONSOLE_IDLE_REAP_SEC=0 to
# disable.
IDLE_REAP_SEC = int(os.environ.get("MIST_CONSOLE_IDLE_REAP_SEC", "900"))


def _tail_lines(path, max_lines):
    """Return the last `max_lines` lines of a (possibly huge) jsonl without reading
    the whole file. Seeks backward from EOF in 1 MiB blocks until enough newlines
    are collected. A single conversation's jsonl can be hundreds of MB; reading it
    end-to-end just to keep the last HISTORY_CAP events is what made cold start
    take ~10s+ (worse after a reboot). This bounds the read to roughly the tail
    we actually keep."""
    max_lines = max(1, max_lines)
    block = 1 << 20  # 1 MiB
    chunks = []      # collected newest-first, joined once (prepending in a loop is O(n^2))
    newlines = 0
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        pos = f.tell()
        while pos > 0 and newlines <= max_lines:
            step = min(block, pos)
            pos -= step
            f.seek(pos)
            chunk = f.read(step)
            chunks.append(chunk)
            newlines += chunk.count(b"\n")
    data = b"".join(reversed(chunks))
    return data.decode("utf-8", "replace").splitlines()[-max_lines:]

# Live rate-limit store, refreshed from each Console turn's rate_limit_event.
# WHY: the usage badges' % comes from ~/.claude/usage-cache.json, which only the
# interactive-CLI statusline refreshes. During Console-only use that cache goes
# stale and, once its window's resets_at passes, the front-end drops it and the
# 5h/7d badges go BLANK. The headless stream still emits rate_limit_event every
# turn carrying the live resets_at + status (but not the %), so we persist that
# here and /usage merges it — keeping a fresh reset countdown + blocked status
# (and preserving the cached % while the window hasn't rolled) so the badge
# stays populated whenever MIST has run at least one turn.
RATE_LIVE_PATH = os.path.join(DATA_DIR, "rate-live.json")
_rate_lock = threading.Lock()


def record_rate_limit(info):
    """Persist a live rate_limit_event's resets_at + status per window (atomic)."""
    t = (info or {}).get("rateLimitType")
    if t not in ("five_hour", "seven_day"):
        return
    rec = {"resets_at": info.get("resetsAt"), "status": info.get("status"),
           "ts": int(time.time())}
    if not rec["resets_at"]:
        return
    with _rate_lock:
        try:
            with open(RATE_LIVE_PATH) as f:
                d = json.load(f) or {}
        except Exception:
            d = {}
        d[t] = rec
        tmp = RATE_LIVE_PATH + ".tmp.%d" % os.getpid()
        try:
            with open(tmp, "w") as f:
                json.dump(d, f)
            os.replace(tmp, RATE_LIVE_PATH)
        except Exception:
            pass
    # A rate_limit_event means a real turn just ran, so the 5h/7d windows are
    # ACTIVE right now — the one safe moment to read the live utilization %.
    maybe_probe_rate_util()


# Live utilization %, read from the account API: GET api.anthropic.com/api/oauth/usage
# with Claude Code's own subscription OAuth token returns per-window utilization
# (0-100) and resets_at. It is a METADATA READ — no message is sent, no tokens are
# consumed, and it does not open or extend a rate-limit window (verified: three
# consecutive reads return identical numbers). That retires the old probe, which
# sent a real 1-token haiku /v1/messages call to harvest response headers and
# therefore could only safely fire right after a turn, inside an already-open
# window — leaving the % stale whenever the Console sat idle.
#
# Being free and side-effect-less, it can poll on a timer (see start_rate_poller):
# every RATE_POLL_ACTIVE_SEC while someone is looking at a Console window (any
# live SSE subscriber), every RATE_POLL_IDLE_SEC otherwise, plus an immediate
# read after each turn's rate_limit_event. /usage merges the result in as the
# authoritative %.
RATE_UTIL_PATH = os.path.join(DATA_DIR, "rate-util.json")
_PROBE_MIN_INTERVAL = 20           # floor between reads (post-turn bursts coalesce)
RATE_POLL_ACTIVE_SEC = 60          # someone has a Console window open
RATE_POLL_IDLE_SEC = 600           # server running, nobody watching
_probe_state = {"last_ts": 0.0}
_probe_state_lock = threading.Lock()


def _read_oauth_token():
    """Claude Code's subscription OAuth access token, read fresh from Keychain
    (Claude Code keeps it refreshed; reading per-probe means we always get a
    current token, or None if absent/locked)."""
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
            capture_output=True, text=True, timeout=5)
        if out.returncode != 0:
            return None
        return (json.loads(out.stdout).get("claudeAiOauth") or {}).get("accessToken")
    except Exception:
        return None


def _iso_to_epoch(raw):
    try:
        from datetime import datetime
        return int(datetime.fromisoformat(raw).timestamp())
    except Exception:
        return None


def _probe_rate_util():
    """Read GET /api/oauth/usage (free, no side effects) and persist per-window
    utilization. Silent no-op on any failure (expired token, offline) so the
    badge falls back to the live reset countdown and the CLI cache."""
    token = _read_oauth_token()
    if not token:
        return
    req = urllib.request.Request(
        "https://api.anthropic.com/api/oauth/usage",
        headers={"Authorization": "Bearer " + token,
                 "anthropic-beta": "oauth-2025-04-20"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode()) or {}
    except Exception:
        return
    rec, now = {}, int(time.time())
    for win in ("five_hour", "seven_day"):
        w = data.get(win) or {}
        util = w.get("utilization")
        if util is None:
            continue
        try:
            # The endpoint reports 0-100; rate-util.json keeps the 0-1 fraction
            # the old header probe wrote, so /usage and its readers don't change.
            rec[win] = {"utilization": float(util) / 100.0,
                        "resets_at": _iso_to_epoch(w.get("resets_at") or ""),
                        "status": None,
                        "ts": now}
        except (TypeError, ValueError):
            continue
    if not rec:
        return
    tmp = RATE_UTIL_PATH + ".tmp.%d" % os.getpid()
    try:
        with open(tmp, "w") as f:
            json.dump(rec, f)
        os.replace(tmp, RATE_UTIL_PATH)
    except Exception:
        pass


def maybe_probe_rate_util():
    """Throttled, non-blocking trigger (the read is free; the floor just keeps a
    burst of back-to-back turns from stampeding the endpoint)."""
    with _probe_state_lock:
        now = time.time()
        if now - _probe_state["last_ts"] < _PROBE_MIN_INTERVAL:
            return
        _probe_state["last_ts"] = now
    threading.Thread(target=_probe_rate_util, daemon=True).start()


def start_rate_poller(sessions):
    """Poll the free usage read on a timer so the badges stay near-real-time even
    while the Console just sits there: usage spent in the interactive CLI, in a
    background routine, or on the phone shows up within a minute, not on the next
    Console turn. Faster while any chat has a live SSE subscriber (a window is
    actually looking at the badges), slower when nobody is."""
    def loop():
        while True:
            try:
                watched = any(s._subscribers for s in list(sessions.values()))
            except Exception:
                watched = False
            maybe_probe_rate_util()
            time.sleep(RATE_POLL_ACTIVE_SEC if watched else RATE_POLL_IDLE_SEC)
    threading.Thread(target=loop, daemon=True).start()


# Scoped to Console sessions only (see _build_cmd). Stops MIST from talking at
# the room unprompted, without stopping her from handing over a file when asked.
# The Console already serves and plays .mp3/.wav inline (see _AUDIO_EXTS in
# app.py), so an audio *reply* is just another embed. What doesn't belong in a
# chat window is unrequested noise through the speakers.
NO_VOICE_PROMPT = (
    "You are running inside the MIST Console, a chat surface that renders audio "
    "inline but never expects sound it wasn't asked for. Do NOT speak aloud on "
    "your own initiative: no bare mist-say (it plays by default), no afplay, no "
    "`say`, no mist-notify sounds, nothing that comes out of the speakers unbidden. "
    "Default to text.\n"
    "When Alex explicitly asks for an audio or spoken response, render it and embed "
    "it: pipe your reply text to "
    "`'/Users/alexhedtke/Documents/Exobrain harness/mist-voice/.venv/bin/python' "
    "'/Users/alexhedtke/Documents/Exobrain harness/mist-voice/scripts/narrate.py' - "
    "-o '/Users/alexhedtke/Documents/Exobrain harness/tmp/audio/<name>.mp3'`, then put "
    "`![reply](/Users/alexhedtke/Documents/Exobrain harness/tmp/audio/<name>.mp3)` in "
    "your message so the Console shows a player. Write the path RAW, with literal "
    "spaces, and never percent-encode it. Always include the written text too; the audio "
    "is an addition to the reply, not a replacement for it. Synthesis is slower than "
    "real time, so keep spoken replies short and wrap the render in `mist-progress run`."
)

# The Console renders a first-class recipe card (ingredients checklist, step
# timers, a full-screen cooking mode) whenever the model emits a ```recipe
# fence. This prompt teaches the model the contract; static/app.js renders it.
RECIPE_PROMPT = (
    "When you give Alex a recipe, the Console renders it as an interactive "
    "recipe card with a cooking mode and clickable timers. Emit the recipe as a "
    "fenced code block with language `recipe` containing ONE JSON object:\n"
    '{"title": str, "serves": str, "time": {"prep": str, "cook": str, "total": str}, '
    '"ingredients": [str, ...] or [{"group": str, "items": [str, ...]}, ...], '
    '"steps": [{"text": str, "timer": seconds} or str, ...], "notes": str}\n'
    "Set \"timer\" (integer seconds) on every step that involves timed waiting "
    "(simmer, bake, rest, proof); omit it otherwise. Only title, ingredients, "
    "and steps are required. Keep prose around the block brief — the card IS "
    "the recipe. Use the block for any real recipe, not for one-line food tips."
)

# The Console renders a real, in-place progress element (see /progress + the
# `progress` event), so a long download/upload/install never looks like a hang.
# Every session gets the `mist-progress` CLI on PATH plus the env vars it needs
# to address THIS chat, and this prompt is how the model learns it exists.
PROGRESS_PROMPT = (
    "This Console renders live progress bars. Whenever a command you run has to "
    "download, upload, install, clone, sync, or otherwise transfer something that "
    "takes more than a few seconds, run it through `mist-progress run --label "
    "\"<what it is>\" -- <command>` (it passes the command's output through "
    "unchanged and draws a bar that updates in place in this chat). For work "
    "whose progress you compute yourself, use `mist-progress start/set/done`. "
    "Never leave the user watching a silent wait."
)


class ClaudeSession:
    """One conversation: a persisted event history + (lazily) a claude process."""

    def __init__(self, id=None, title=None, pinned=False, claude_session_id=None,
                 last_activity=None, autostart=True, import_path=None,
                 permission_mode=DEFAULT_PERMISSION_MODE, model=None, cwd=HARNESS,
                 pin_order=0, effort=None):
        self.id = id
        self.title = title
        self.pinned = pinned
        self.pin_order = pin_order   # manual sort position among pinned chats
        self.import_path = import_path   # Claude Code jsonl to lazily import on open
        self._import_done = False
        self.last_activity = last_activity or time.time()
        self.claude_session_id = claude_session_id   # for --resume after a restart
        self.permission_mode = permission_mode
        self.model = model
        self.effort = effort   # None -> omit --effort, let the CLI use its default
        self.cwd = cwd

        self.proc = None
        self.alive = False
        self.session_id = None
        self.last_init = None
        self.context_pct = None
        self._last_msg_usage = None  # usage of the latest assistant message (single-call snapshot)

        self.history = []
        self._jsonl = os.path.join(DATA_DIR, f"{id}.jsonl") if id else None
        self._subscribers = []
        self._lock = threading.Lock()
        self._hist_lock = threading.Lock()
        # stdin is a line-oriented JSON protocol shared by several writers (send,
        # control responses, interrupt, stop_task, the reader thread's auto-
        # decline). Interleaved partial writes corrupt it — a pasted image is
        # megabytes, far beyond one pipe write — so every write holds this lock.
        # Deliberately NOT self._lock: a big image write can block until the CLI
        # drains the pipe, and that must not stall the rest of the session.
        self._stdin_lock = threading.Lock()
        self._ev_seq = 0             # monotonic event stamp (see stream() dedup)
        self._resume_tried = False
        self._started_at = 0.0
        self._saw_init = False
        self._intentional_stop = False
        self._turn_active = False    # a send is in flight (no result yet); blocks reaping
        self._ctx_warned = False     # one-shot soft warning at CTX_WARN_PCT
        self._ctx_override = False    # one-shot hard-cap override (next send passes)
        self._ctl_seq = 0            # control_request id counter (stop_task)
        self._pending_stops = {}     # control request_id -> task_id awaiting ack
        self._pending_perms = {}     # can_use_tool request_id -> {input, suggestions}
        self._init_sent = False      # control-protocol initialize handshake sent?
        self._progress = {}          # progress bar id -> {last: ts, done: bool}

        # History loads lazily on first open (snapshot_history), NOT here. At
        # startup app.py constructs a ClaudeSession for every saved chat; eagerly
        # reading each one's full jsonl made cold start scale with the whole
        # data/ corpus (GBs). Dormant sessions now cost nothing until viewed.
        self._history_loaded = False
        if autostart:
            self.ensure_started()

    # ---- history persistence ----------------------------------------------
    def _load_history(self):
        # The ENTIRE load happens under _hist_lock. The old shape (set the flag
        # under the lock, then append outside it) let a second reader — another
        # window opening the same chat, or a live _record during the load — see a
        # half-loaded list and render a truncated transcript, or interleave a
        # fresh event in front of older history lines.
        with self._hist_lock:
            if self._history_loaded:
                return
            self._history_loaded = True
            if not self._jsonl or not os.path.exists(self._jsonl):
                return
            try:
                loaded = []
                for line in _tail_lines(self._jsonl, HISTORY_CAP):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        loaded.append(json.loads(line))
                    except Exception:
                        pass  # skip a truncated/corrupt line, keep the rest
                # Anything recorded while we were reading the file is NEWER than
                # every line in it — it belongs after the loaded tail.
                self.history = loaded + self.history
                self.history = self.history[-HISTORY_CAP:]
                # keep the event stamp monotonic across dormancy (stream() dedup
                # compares live queue stamps against replayed history stamps)
                for obj in self.history:
                    s = obj.get("seq")
                    if isinstance(s, int) and s > self._ev_seq:
                        self._ev_seq = s
                # restore context % from the last context event we saw
                for obj in reversed(self.history):
                    if obj.get("type") == "context":
                        self.context_pct = obj.get("pct")
                        break
            except Exception:
                pass

    def _record(self, obj):
        obj = _slim_event(obj)
        with self._hist_lock:
            self.history.append(obj)
            if len(self.history) > HISTORY_CAP:
                self.history = self.history[-HISTORY_CAP:]
            # The file append stays under the lock too: a large event is many
            # write() syscalls, and two threads appending concurrently interleave
            # them — both lines land mangled and replay silently skips them.
            if self._jsonl:
                try:
                    with open(self._jsonl, "a") as f:
                        f.write(json.dumps(obj) + "\n")
                except Exception:
                    pass

    def snapshot_history(self):
        self._load_history()   # lazy: read this chat's jsonl tail on first open
        with self._hist_lock:
            return list(self.history)

    def ensure_imported(self):
        """First time an imported tab is opened, convert its Claude Code jsonl
        into display events (then they persist to data/<id>.jsonl like any chat)."""
        if self._import_done or not self.import_path:
            return
        self._import_done = True
        # History is loaded lazily, so pull it in before deciding whether to
        # import — otherwise an already-converted chat looks empty on a fresh
        # process and we'd re-import, duplicating every event into the jsonl.
        self._load_history()
        if self.history:
            return
        try:
            import importer
            for ev in importer.convert(self.import_path):
                self._record(ev)
        except Exception:
            pass

    # ---- process lifecycle ------------------------------------------------
    def _build_cmd(self):
        cmd = [CLAUDE, "-p",
               "--input-format", "stream-json",
               "--output-format", "stream-json",
               "--include-partial-messages", "--verbose"]
        if self.permission_mode == "bypassPermissions":
            cmd.append("--dangerously-skip-permissions")
        elif self.permission_mode:
            cmd += ["--permission-mode", self.permission_mode]
            # Route every "ask" permission decision back to us over the control
            # protocol as a can_use_tool control_request (see _handle_control_request
            # + respond_permission), so default/acceptEdits/plan modes surface real
            # Allow/Deny cards in the UI instead of silently auto-running (as
            # bypassPermissions does — which stays untouched, no prompt tool).
            cmd += ["--permission-prompt-tool", "stdio"]
        # AskUserQuestion is an interactive picker the CLI resolves itself; in this
        # headless stream-json process there's no TTY, so it auto-dismisses with no
        # answer. Disable it so the model asks in plain text, which the user can
        # answer by typing a normal reply.
        cmd += ["--disallowed-tools", "AskUserQuestion"]
        # Full MCP parity with the interactive CLI: load every scope (user +
        # project + local) — the local stdio servers (things3/fitbit/withings),
        # linkedin (uvx @latest), and the claude.ai OAuth connectors
        # (Gmail/Calendar/Drive/MyChart). No --strict-mcp-config, so claude uses
        # its normal full resolution. The @latest/uvx servers resolve over the
        # network, so they connect a beat slower than the local ones.
        if self.claude_session_id and not self._resume_tried:
            cmd += ["--resume", self.claude_session_id]  # restore model context
        if self.model:
            cmd += ["--model", self.model]
        # Thinking depth. Omitted entirely when unset so the CLI applies its own
        # default; an unrecognised value is only warned about, not rejected, so
        # the valid set is enforced at the route (_VALID_EFFORTS in app.py).
        if self.effort:
            cmd += ["--effort", self.effort]
        # MIST's persona is NOT injected from a side file. It lives in the
        # Exobrain's CLAUDE.md ("Identity & Voice: MIST"), which `claude`
        # auto-loads because we run in the harness cwd (see HARNESS / cwd below).
        #
        # Voice is opt-in in the Console. CLAUDE.md grants MIST audio tools
        # (mist-say / mist-notify / mist-voice), and with bypassPermissions she
        # can run them unprompted, so she'd occasionally speak aloud mid-chat.
        # We scope a "don't speak unless asked" instruction to THIS session: an
        # explicit request still gets a rendered, embedded track. Other surfaces
        # (news-briefing podcast, note narration, the mist-terminal greeting)
        # are untouched, and we don't edit CLAUDE.md.
        cmd += ["--append-system-prompt",
                NO_VOICE_PROMPT + "\n\n" + PROGRESS_PROMPT + "\n\n" + RECIPE_PROMPT]
        return cmd

    def ensure_started(self):
        spawn_err = None
        with self._lock:
            if self.alive:
                return
            env = dict(os.environ)
            env["PATH"] = (CLAUDE_BIN_DIR
                           + ":" + os.path.expanduser("~/.npm-global/bin")
                           + ":/opt/homebrew/bin:/usr/local/bin:" + CONSOLE_BIN
                           + ":" + env.get("PATH", ""))
            # Address THIS chat from anything the session shells out to. A script
            # (or mist-progress) posts to $MIST_CONSOLE_URL/progress/$MIST_CONSOLE_SESSION
            # and its bar renders inline in the conversation that started it.
            env["MIST_CONSOLE_SESSION"] = self.id or ""
            env["MIST_CONSOLE_URL"] = CONSOLE_URL
            try:
                self.proc = subprocess.Popen(
                    self._build_cmd(), cwd=self.cwd, env=env,
                    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    text=True, bufsize=1)
            except Exception as e:
                # Broadcast AFTER releasing the lock: _broadcast re-acquires
                # self._lock, and threading.Lock is not reentrant — doing it here
                # deadlocked the whole session the first time a spawn failed
                # (deleted cwd, claude binary mid-update).
                spawn_err = str(e)
            else:
                self.alive = True
                self._started_at = time.time()
                self._saw_init = False
                self._init_sent = False
                self._pending_perms = {}
                # A fresh backend starts un-flagged. If the OLD process's watcher
                # never consumed a pending _intentional_stop (it skips itself once
                # self.proc is replaced), leaving it set would make this new
                # backend's first real crash look intentional and go unreported.
                self._intentional_stop = False
                # Each worker is pinned to THE process it was started for. They
                # check `self.proc is proc` before touching shared state, so a
                # thread belonging to an old backend (model switch, reap, crash +
                # respawn) can't flip flags or broadcast into the new one.
                proc = self.proc
                threading.Thread(target=self._read_stdout, args=(proc,), daemon=True).start()
                threading.Thread(target=self._read_stderr, args=(proc,), daemon=True).start()
                threading.Thread(target=self._watch, args=(proc,), daemon=True).start()
        if spawn_err is not None:
            self._broadcast({"type": "process_exit", "code": -1, "error": spawn_err})
            return
        # Enable the SDK control protocol so the CLI will route permission
        # decisions to us as can_use_tool control_requests. Only needed when a
        # prompt tool is in play (non-bypass modes); bypassPermissions never asks.
        self._maybe_init_control()

    def _maybe_init_control(self):
        if self._init_sent or not self.alive:
            return
        if not self.permission_mode or self.permission_mode == "bypassPermissions":
            return
        self._init_sent = True
        req = {"type": "control_request", "request_id": self._next_ctl_id("init"),
               "request": {"subtype": "initialize", "hooks": None}}
        self._write_stdin(req)

    def _next_ctl_id(self, prefix):
        with self._lock:
            self._ctl_seq += 1
            return f"console-{prefix}-{self._ctl_seq}"

    def _write_stdin(self, obj):
        """Write one JSON line to the claude process stdin. Returns True on success.
        Serialized: concurrent writers interleaving partial lines would corrupt
        the protocol (see _stdin_lock)."""
        if not self.alive or not self.proc or self.proc.stdin is None:
            return False
        try:
            with self._stdin_lock:
                self.proc.stdin.write(json.dumps(obj) + "\n")
                self.proc.stdin.flush()
            return True
        except (BrokenPipeError, ValueError, OSError):
            self.alive = False
            return False

    def _watch(self, proc):
        code = proc.wait()
        with self._lock:
            if self.proc is not proc:
                return   # an old backend finally died; the live one is not ours to touch
            self.alive = False
            self._turn_active = False
        if self._intentional_stop:           # close or model switch — not a crash
            self._intentional_stop = False
            return
        # If a --resume start died almost immediately without initializing, the
        # resumed session was probably invalid: retry once fresh.
        if (self.claude_session_id and not self._resume_tried and not self._saw_init
                and time.time() - self._started_at < 5):
            self._resume_tried = True
            self.claude_session_id = None
            self.ensure_started()
            return
        self._broadcast({"type": "process_exit", "code": code})

    def set_model(self, model):
        """Switch model. Goes dormant; next send revives with the new model and
        --resume (so conversation context carries over)."""
        self.model = model or None
        if self.alive:
            self._resume_tried = False
            self.stop()

    def set_effort(self, effort):
        """Switch thinking depth. Goes dormant; next send revives with the new
        effort and --resume (so conversation context carries over)."""
        effort = effort or None
        if effort == self.effort:
            return
        self.effort = effort
        if self.alive:
            self._resume_tried = False
            self.stop()

    def set_permission(self, mode):
        """Switch permission mode. Goes dormant; next send revives with the new
        mode and --resume (so conversation context carries over)."""
        if not mode or mode == self.permission_mode:
            return
        self.permission_mode = mode
        if self.alive:
            self._resume_tried = False
            self.stop()

    def set_cwd(self, cwd):
        """Switch the working directory (repo MIST runs in). Goes dormant and
        starts FRESH in the new repo on the next send. We clear the resume id
        because a claude transcript is keyed to the cwd it was created in, so
        --resume can't carry a conversation across directories — and a different
        repo means a different CLAUDE.md/context anyway."""
        if not cwd or cwd == self.cwd:
            return
        self.cwd = cwd
        self.claude_session_id = None
        self._resume_tried = False
        if self.alive:
            self.stop()

    def reap_if_idle(self, timeout):
        """Put a live-but-idle backend dormant to reclaim its RAM/CPU; returns
        True if reaped. Skips any session with an in-flight turn — a long coding
        turn looks 'idle' by last_activity alone (it's only refreshed on send and
        result), so the _turn_active guard is what keeps the reaper from killing
        work mid-stream. The next send revives via --resume with full context, so
        no conversation is lost and no extra tokens are spent (see IDLE_REAP_SEC).
        Mirrors set_model/set_permission: clear _resume_tried first so the revive
        actually --resumes instead of starting fresh."""
        # Checks AND the stop happen under the session lock, mutually exclusive
        # with send() reserving the turn (which sets _turn_active under the same
        # lock). Without this, a send landing in the gap between the checks and
        # stop() had its message written to a process the reaper was about to
        # SIGTERM — and because the stop was "intentional", the exit was swallowed
        # and the message vanished with a spinner left behind.
        with self._lock:
            if timeout <= 0 or not self.alive or self._turn_active:
                return False
            if time.time() - self.last_activity < timeout:
                return False
            self._resume_tried = False
            self._stop_locked()
        return True

    # ---- io ----------------------------------------------------------------
    def _read_stdout(self, proc):
        for line in proc.stdout:
            if self.proc is not proc:
                return   # replaced backend: stop relaying a dead process's output
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                obj = {"type": "raw", "text": line}
            if obj.get("type") == "system" and obj.get("subtype") == "init":
                self._saw_init = True
                self.session_id = obj.get("session_id")
                new_csid = obj.get("session_id")
                # Persist the id→transcript link the moment it exists, so a window
                # close or crash before the next periodic save can't leave this chat
                # reopening empty. Only fire when it actually changed (once per start).
                _changed = new_csid and new_csid != self.claude_session_id
                self.claude_session_id = new_csid
                self.last_init = obj
                if _changed and on_meta_dirty:
                    try:
                        on_meta_dirty()
                    except Exception:
                        pass
            elif obj.get("type") == "assistant":
                # Each assistant message carries the usage of ONE API call — a true
                # snapshot of current context occupancy. Keep the latest for ctx %.
                # Skip subagent (sidechain) messages: they carry the SUBAGENT's
                # context, not this session's, and would skew ctx way low.
                mu = (obj.get("message") or {}).get("usage")
                if mu and not obj.get("parent_tool_use_id"):
                    self._last_msg_usage = mu
            elif obj.get("type") == "result":
                self.last_activity = time.time()
                self._turn_active = False   # turn done; reaper may reclaim once idle
                self._emit_context(obj)
            elif obj.get("type") == "rate_limit_event":
                # Keep the usage badges' reset/status fresh during Console-only
                # use (see RATE_LIVE_PATH note); the front-end reads it via /usage.
                record_rate_limit(obj.get("rate_limit_info") or {})
            elif obj.get("type") == "control_response":
                # Ack for a stop_task we sent (see stop_task below). Translate it
                # into the same task lifecycle event the monitor already speaks —
                # a synthesized task_updated — so a kill resolves in the UI even
                # if the task registry never emits its own terminal event.
                resp = obj.get("response") or {}
                task_id = self._pending_stops.pop(resp.get("request_id"), None)
                if task_id:
                    if resp.get("subtype") == "success":
                        self._broadcast({"type": "system", "subtype": "task_updated",
                                         "task_id": task_id, "status": "killed"})
                    else:
                        self._broadcast({"type": "system", "subtype": "task_stop_failed",
                                         "task_id": task_id,
                                         "error": str(resp.get("error") or "stop failed")})
            elif obj.get("type") == "control_request":
                # The CLI is asking US something over the control protocol. The
                # one we care about is can_use_tool (a permission "ask"); surface
                # it as a card. Anything else blocking, we decline so the CLI
                # falls back to its default and never hangs waiting on us.
                if self._handle_control_request(obj):
                    continue   # handled + will emit its own UI event; don't raw-broadcast
            self._broadcast(obj)

    def _handle_control_request(self, obj):
        """Inbound control_request from the CLI. Returns True if consumed."""
        req = obj.get("request") or {}
        sub = req.get("subtype")
        req_id = obj.get("request_id")
        if sub == "can_use_tool":
            self._pending_perms[req_id] = {
                "input": req.get("input") or {},
                "suggestions": req.get("permission_suggestions") or [],
            }
            self._broadcast({
                "type": "permission_request",
                "request_id": req_id,
                "tool_name": req.get("tool_name"),
                "input": req.get("input") or {},
                "suggestions": req.get("permission_suggestions") or [],
                "blocked_path": req.get("blocked_path"),
            })
            self._notify_permission(req_id, req.get("tool_name"),
                                    req.get("input") or {})
            return True
        # Unknown blocking request (e.g. request_user_dialog): decline politely so
        # the CLI applies its default and the turn keeps moving.
        if req_id:
            self._write_stdin({"type": "control_response", "response": {
                "subtype": "error", "request_id": req_id,
                "error": f"unsupported control_request: {sub}"}})
            return True
        return False

    @staticmethod
    def _perm_summary(tool_name, tool_input):
        """One line describing what is being asked for, for the banner body."""
        d = tool_input if isinstance(tool_input, dict) else {}
        for key in ("command", "file_path", "path", "url", "pattern", "prompt"):
            val = d.get(key)
            if isinstance(val, str) and val.strip():
                val = " ".join(val.split())
                if len(val) > 140:
                    val = val[:139] + "…"
                return f"{tool_name or 'A tool'}: {val}"
        return f"{tool_name or 'A tool'} wants to run."

    def _notify_permission(self, req_id, tool_name, tool_input):
        """Put a blocking permission ask on a banner with the decision buttons
        wired straight back to /permission-response.

        Without this the ask only exists inside the Console window, so stepping
        away from the machine leaves the turn parked indefinitely on a card
        nobody is looking at. Only modes that actually ask ever reach here
        (bypassPermissions never asks), so there is no focus check and no
        quiet-hours logic: if this fires, the mode was a deliberate choice to be
        asked. Voice is off because a coding turn can stack several asks in a
        row and narrating each one would be unbearable; the sound still plays.
        """
        if not req_id:
            return
        try:
            url = f"{CONSOLE_URL}/sessions/{self.id}/permission-response"

            def button(label, payload):
                # Single-quoted for sh -c, so any embedded quote must be broken out.
                body = json.dumps(payload).replace("'", "'\\''")
                return (f"{label}=cmd:/usr/bin/curl -sS -X POST {url} "
                        f"-H 'Content-Type: application/json' -d '{body}'")

            subprocess.Popen(
                [NOTIFY_BIN, self._perm_summary(tool_name, tool_input),
                 "MIST needs permission", "Purr", f"console:{self.id}",
                 "--subtitle", str(tool_name or "tool"),
                 "--urgency", "timeSensitive",
                 "--group", f"perm-{self.id}",
                 "--id", f"perm-{req_id}",
                 "--no-voice",
                 "--action", button("Allow", {"request_id": req_id, "decision": "allow"}),
                 "--action", button("Always allow", {"request_id": req_id,
                                                     "decision": "allow", "remember": True}),
                 "--action", button("Deny", {"request_id": req_id, "decision": "deny"})],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass   # a missing/broken notifier must never swallow the permission card

    def _read_stderr(self, proc):
        for line in proc.stderr:
            if self.proc is not proc:
                return
            if line.strip():
                self._broadcast({"type": "stderr", "text": line.rstrip()})

    def _emit_context(self, result):
        try:
            # Use the latest assistant message's usage (one API call = current context
            # occupancy), NOT result.usage — the latter is the turn's CUMULATIVE total
            # across every internal tool-call round trip, so on a multi-step turn it sums
            # the context many times over and reads way past 100% (the old 357% bug).
            u = self._last_msg_usage or result.get("usage", {}) or {}
            used = (u.get("input_tokens", 0)
                    + u.get("cache_read_input_tokens", 0)
                    + u.get("cache_creation_input_tokens", 0))
            window = 0
            for mu in (result.get("modelUsage") or {}).values():
                window = max(window, mu.get("contextWindow", 0))
            if window:
                self.context_pct = round(min(used / window, 1.0) * 100, 1)
                self._broadcast({"type": "context", "pct": self.context_pct,
                                 "used": used, "window": window})
                self._check_context_cost()
        except Exception:
            pass

    def _check_context_cost(self):
        """Emit a one-shot warning when the conversation gets large enough that
        re-billing the whole window each turn is wasteful, and re-arm the warnings
        if occupancy falls back down (e.g. after a /compact or a fresh process)."""
        pct = self.context_pct
        if pct is None:
            return
        if pct < CTX_WARN_PCT:
            self._ctx_warned = False
            self._ctx_override = False
        elif CTX_WARN_PCT <= pct < CTX_HARD_PCT and not self._ctx_warned:
            self._ctx_warned = True
            self._broadcast({
                "type": "context_warning", "level": "warn", "pct": pct,
                "text": (f"This chat is at {pct:.0f}% of the context window. Long "
                         "conversations re-bill their whole history every message — "
                         "start a “+ new chat” for unrelated tasks to save tokens.")})

    def context_gate(self):
        """Cost cap checked before forwarding a message. Returns a reason string
        when the FIRST over-threshold send should be held (and arms a one-shot
        override so the immediate next send goes through), else None. Restored
        context_pct from a resumed transcript means this fires on the very first
        message into a big resumed chat — exactly the expensive case."""
        pct = self.context_pct
        if pct is None or pct < CTX_HARD_PCT:
            return None
        if self._ctx_override:
            return None
        self._ctx_override = True
        return (f"This chat is at {pct:.0f}% of the context window. Every message "
                "now re-bills the whole conversation, which burns tokens fast. "
                "Start a “+ new chat” for a new task, or send again to continue here.")

    # ---- progress bars -----------------------------------------------------
    def progress(self, payload):
        """Update one in-place progress bar in this chat. `payload` is the parsed
        body of POST /progress/<sid>: {id, label, status, pct, current, total,
        unit, detail, rate, eta}. Returns False only for an unusable payload.

        Throttled + mostly ephemeral (see PROGRESS_MIN_INTERVAL): a live viewer
        sees every meaningful tick, disk sees the start and the end."""
        pid = str(payload.get("id") or "").strip()
        if not pid:
            return False
        status = payload.get("status") or "running"
        if status not in ("running",) + PROGRESS_TERMINAL:
            status = "running"
        terminal = status in PROGRESS_TERMINAL
        now = time.time()
        with self._lock:
            st = self._progress.get(pid)
            first = st is None
            if first:
                st = self._progress[pid] = {"last": 0.0, "done": False, "gen": 0}
            if st["done"] and not first:
                # The docs sell --id as a STABLE key, so a script reusing one
                # (`--id model-download`, run daily) must get a fresh bar, not
                # silence forever. A running post well clear of the settle is a
                # new generation — new element in the UI via a suffixed id. Posts
                # right after the terminal frame are stragglers and stay ignored.
                if not terminal and now - st["last"] > 5:
                    st["done"] = False
                    st["gen"] += 1
                    first = True     # record the new bar's opening frame
                else:
                    return True
            if not terminal and not first and now - st["last"] < PROGRESS_MIN_INTERVAL:
                return True          # coalesce: the next tick is milliseconds away
            st["last"] = now
            gen = st["gen"]
            if terminal:
                st["done"] = True
                # Settled bars stay registered to absorb late stragglers, but a
                # long-lived chat shouldn't accumulate them forever: keep the
                # newest 200 settled entries and drop the oldest beyond that.
                done = [k for k, v in self._progress.items() if v["done"]]
                for k in done[:-200]:
                    del self._progress[k]
        # Later generations broadcast a suffixed id so the UI keys a NEW element
        # instead of resurrecting the settled bar sitting mid-transcript.
        ev_id = pid if not gen else "%s~%d" % (pid, gen)
        ev = {"type": "progress", "id": ev_id, "status": status}
        for k in ("label", "detail", "rate", "unit"):
            v = payload.get(k)
            if v is not None:
                ev[k] = str(v)[:200]
        for k in ("pct", "current", "total", "eta"):
            v = payload.get(k)
            if isinstance(v, (int, float)):
                ev[k] = v
        # A caller that reports bytes but no percentage still gets a real bar.
        if "pct" not in ev and ev.get("total"):
            try:
                ev["pct"] = max(0.0, min(100.0, ev["current"] / ev["total"] * 100))
            except (KeyError, TypeError, ZeroDivisionError):
                pass
        if terminal and status == "done" and "pct" in ev:
            ev["pct"] = 100.0
        # Only the opening and closing frames are worth keeping (see the policy
        # note at PROGRESS_MIN_INTERVAL).
        self._broadcast(ev, record=(first or terminal))
        return True

    # ---- pub/sub -----------------------------------------------------------
    def _broadcast(self, obj, record=True):
        # Stamp every event with the wall-clock time it was seen, so the front-end
        # can show an accurate per-message timestamp on both live turns and replay.
        if "ts" not in obj:
            obj["ts"] = time.time()
        with self._lock:
            # Monotonic stamp, persisted with the event: /stream subscribes BEFORE
            # snapshotting history and uses this to drop the overlap (an event in
            # both the snapshot and the queue), instead of the old subscribe-after
            # shape that silently LOST everything broadcast during a slow replay.
            self._ev_seq += 1
            obj["seq"] = self._ev_seq
            subs = list(self._subscribers)
        if record:
            self._record(obj)
        for q in subs:
            try:
                q.put_nowait(obj)
            except queue.Full:
                # Drop the OLDEST event, not this one. A stalled client that
                # drops whatever arrives next loses exactly the events that
                # matter most — the result that stops the spinner, a permission
                # card, a bar's terminal frame — and desyncs until a manual
                # reload. Old deltas are the expendable ones.
                try:
                    q.get_nowait()
                    q.put_nowait(obj)
                except Exception:
                    pass

    def subscribe(self):
        q = queue.Queue(maxsize=4000)
        with self._lock:
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            if q in self._subscribers:
                self._subscribers.remove(q)

    # ---- public api --------------------------------------------------------
    def send(self, text, image_path=None, url=None):
        self.ensure_started()
        if not self.alive or not self.proc or self.proc.stdin is None:
            return False
        full = text
        display = text
        if url:
            full = (text + "\n\n" if text else "") + f"[Current page: {url}]"
            display = (text + "\n" if text else "") + f"🔗 {url}"
        content = [{"type": "text", "text": full or "(see attachment)"}]
        img_for_display = None
        if image_path and os.path.exists(image_path):
            try:
                import base64
                ext = os.path.splitext(image_path)[1].lower().lstrip(".")
                media = {"jpg": "jpeg", "jpeg": "jpeg", "gif": "gif",
                         "webp": "webp"}.get(ext, "png")
                with open(image_path, "rb") as f:
                    b64 = base64.b64encode(f.read()).decode()
                content.append({"type": "image", "source": {
                    "type": "base64", "media_type": "image/" + media, "data": b64}})
                # Hand the front-end the path so it renders an inline thumbnail
                # (served via /file); falls back to a 📷 marker if it can't.
                img_for_display = image_path
            except Exception:
                pass
        if not self.title:
            t = text or "Screenshot" if image_path else (text or url or "New chat")
            self.title = (t[:40] + "…") if len(t) > 40 else t
        # Reserve the turn BEFORE broadcasting/writing, under the session lock:
        # once _turn_active is set the reaper (which checks it under the same
        # lock) can no longer put this backend dormant out from under the write.
        with self._lock:
            if not self.alive:
                return False
            self.last_activity = time.time()
            self._turn_active = True   # cleared on the matching result (or exit)
        ev = {"type": "user_text", "text": display}   # for live + replay
        if img_for_display:
            ev["image"] = img_for_display
        self._broadcast(ev)
        msg = {"type": "user", "message": {"role": "user", "content": content}}
        try:
            # _stdin_lock, not self._lock: an image payload is megabytes and this
            # write can block until the CLI drains the pipe — the session must
            # stay responsive (progress posts, /interrupt) while it does.
            with self._stdin_lock:
                self.proc.stdin.write(json.dumps(msg) + "\n")
                self.proc.stdin.flush()
            return True
        except (BrokenPipeError, ValueError, OSError):
            self.alive = False
            self._turn_active = False
            return False

    def stop_task(self, task_id):
        """Kill a running background task (agent or run_in_background shell) via
        the stream-json control protocol: {"subtype":"stop_task","task_id":...}.
        The CLI acks with a control_response, which _read_stdout translates into
        a task_updated(status=killed) for the monitor; it also treats
        not_found/not_running as success, so racing a task that just finished is
        harmless. Returns False only when there's no live process to signal —
        a dormant backend has no background tasks to kill anyway."""
        if not self.alive or not self.proc or self.proc.stdin is None:
            return False
        with self._lock:
            self._ctl_seq += 1
            req_id = f"console-stop-{self._ctl_seq}"
        self._pending_stops[req_id] = task_id
        req = {"type": "control_request", "request_id": req_id,
               "request": {"subtype": "stop_task", "task_id": task_id}}
        try:
            self.proc.stdin.write(json.dumps(req) + "\n")
            self.proc.stdin.flush()
            return True
        except (BrokenPipeError, ValueError, OSError):
            self._pending_stops.pop(req_id, None)
            self.alive = False
            return False

    def respond_permission(self, request_id, decision, remember=False,
                           updated_input=None, message=None):
        """Answer a can_use_tool permission request the UI surfaced. `decision`
        is "allow" or "deny". `remember=True` returns the CLI's own suggestions
        as updatedPermissions (the "don't ask again this session" affordance).
        Sends the control_response the CLI is blocked waiting on."""
        pend = self._pending_perms.pop(request_id, None)
        if pend is None:
            return False   # stale / already answered
        if decision == "allow":
            result = {"behavior": "allow",
                      "updatedInput": updated_input if updated_input is not None
                      else pend.get("input", {})}
            if remember and pend.get("suggestions"):
                result["updatedPermissions"] = pend["suggestions"]
        else:
            result = {"behavior": "deny",
                      "message": message or "Denied by the user.",
                      "interrupt": True}
        return self._write_stdin({"type": "control_response", "response": {
            "subtype": "success", "request_id": request_id, "response": result}})

    def interrupt(self):
        """Stop the in-flight turn via the control protocol (the Esc the TUI has),
        without killing the process — context is preserved and the next send just
        continues. The CLI ends the turn and emits a result, which clears
        _turn_active. Any permission cards still pending are moot, so drop them."""
        if not self.alive or not self.proc or self.proc.stdin is None:
            return False
        self._pending_perms.clear()
        req = {"type": "control_request", "request_id": self._next_ctl_id("interrupt"),
               "request": {"subtype": "interrupt"}}
        return self._write_stdin(req)

    # ---- auth slash commands ----------------------------------------------
    # The headless `claude -p` stream-json process does NOT execute interactive
    # slash commands typed as input, and /login needs a browser OAuth round-trip
    # a piped process can't drive on its own. So when the user types /login (or
    # /logout, /auth) in the Console we DON'T forward it to stdin — we shell out
    # to `claude auth ...`, stream its output into the chat as notices, and
    # restart this session on a successful (re-)login so the live process picks
    # up the fresh credentials. Without this, /login silently does nothing.
    AUTH_PATH_PREFIX = (CLAUDE_BIN_DIR
                        + ":" + os.path.expanduser("~/.npm-global/bin")
                        + ":/opt/homebrew/bin:/usr/local/bin:")

    def maybe_auth_command(self, text):
        """If `text` is an auth slash command the headless process can't run,
        handle it out of band and return True (consumed). Else return False."""
        t = (text or "").strip()
        low = t.lower()
        if low in ("/login", "/signin") or low.startswith(("/login ", "/signin ")):
            rest = t.split(None, 1)[1].strip() if " " in t else ""
            if rest.lower() == "status":
                self._dispatch_auth(t, "status", [])
            else:
                args = ["--claudeai"]
                if rest.lower() == "console":
                    args = ["--console"]
                elif "@" in rest:
                    args += ["--email", rest]
                self._dispatch_auth(t, "login", args)
            return True
        if low == "/logout":
            self._dispatch_auth(t, "logout", [])
            return True
        if low in ("/auth", "/auth status", "/whoami"):
            self._dispatch_auth(t, "status", [])
            return True
        return False

    def _dispatch_auth(self, echo, action, args):
        self._broadcast({"type": "user_text", "text": echo})
        if action == "login":
            self._broadcast({"type": "notice",
                             "text": "Signing in… a browser window will open to "
                                     "finish authentication."})
        threading.Thread(target=self._run_auth, args=(action, args), daemon=True).start()

    def _run_auth(self, action, args):
        cmd = [CLAUDE, "auth", action] + list(args)
        env = dict(os.environ)
        env["PATH"] = self.AUTH_PATH_PREFIX + env.get("PATH", "")
        try:
            p = subprocess.Popen(cmd, cwd=self.cwd, env=env,
                                 stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 text=True, bufsize=1)
        except Exception as e:
            self._broadcast({"type": "notice", "text": f"Couldn't start auth: {e}",
                             "err": True})
            self._broadcast({"type": "status_idle"})
            return
        for line in p.stdout:
            line = line.rstrip()
            if line:
                self._broadcast({"type": "notice", "text": line})
        code = p.wait()
        if action == "login" and code == 0:
            # Restart the live process so it loads the fresh credentials. Clearing
            # _resume_tried lets it --resume the same conversation under new auth.
            if self.alive:
                self._resume_tried = False
                self.stop()
            self._broadcast({"type": "notice",
                             "text": "Signed in. Send your message again to continue."})
        elif action == "logout" and code == 0:
            self._broadcast({"type": "notice", "text": "Signed out."})
        elif code != 0:
            self._broadcast({"type": "notice",
                             "text": f"`claude auth {action}` exited with code {code}.",
                             "err": True})
        self._broadcast({"type": "status_idle"})

    def stop(self):
        with self._lock:
            self._stop_locked()

    def _stop_locked(self):
        """Terminate the backend. Caller holds self._lock."""
        self._intentional_stop = True
        try:
            if self.proc and self.alive:
                if self.proc.stdin:
                    self.proc.stdin.close()
                self.proc.terminate()
        except Exception:
            pass
        self.alive = False

    def delete_data(self):
        try:
            if self._jsonl and os.path.exists(self._jsonl):
                os.remove(self._jsonl)
        except Exception:
            pass
