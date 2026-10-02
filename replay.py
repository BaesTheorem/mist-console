"""replay.py: rebuild a chat as text when its CLI transcript is gone.

Claude Code deletes a session transcript (~/.claude/projects/<slug>/<id>.jsonl)
once its mtime is older than cleanupPeriodDays. The Console keeps its own event
log of every chat (data/<sid>.jsonl), so the words survive even when the CLI's
copy does not. A send into such a chat used to fail with "No conversation found
with session ID", and the retry then started a blank session while the window
still showed the whole chat (2026-10-02, a camping chat from 2026-08-23). Now
the bridge starts a fresh session and its first message carries the text built
here (see ClaudeSession._seed_pending in bridge.py).

INVARIANTS:
- Only Alex's messages (minus Console control chips) and the text of MIST's
  replies go in. Thinking is dropped, a tool call becomes a one-line marker, and
  tool output never goes in.
- Events stamped at or after `stop_seq` are left out, so the message being sent
  is never part of its own replay.
- Over `cap` characters, the first message (the chat's original ask) and the
  newest messages are kept, with a marker where the middle was cut.
"""
import time

import archive

# 160k chars is roughly 40k tokens. Measured on 2026-10-02 over 120 chats whose
# transcripts had expired: median 11k chars, p95 81k, max 215k. So nearly every
# chat replays whole and the odd giant one keeps its start and its recent turns.
REPLAY_CAP = 160_000
MSG_CAP = 40_000           # one message longer than this is cut in the middle
TOOL_ARG_CHARS = 100

# The input field that best says what a tool call did, in order of preference.
_TOOL_ARG_KEYS = ("description", "file_path", "notebook_path", "url", "skill",
                  "pattern", "query", "command", "prompt")

HEADER = (
    "[MIST Console] The CLI transcript of this chat is gone: Claude Code deleted "
    "it after its retention period (last activity {last}). This is a new session. "
    "Below is the earlier conversation between Alex and you (MIST), rebuilt as "
    "text from the Console's own log. Tool calls show as one-line markers. Tool "
    "output and thinking are not included. Treat it as your memory of this chat, "
    "then answer Alex's new message, which follows the replay."
)


def _tool_marker(block):
    name = block.get("name") or "tool"
    inp = block.get("input") or {}
    arg = ""
    if isinstance(inp, dict):
        for key in _TOOL_ARG_KEYS:
            val = inp.get(key)
            if isinstance(val, str) and val.strip():
                arg = " ".join(val.split())
                break
    if len(arg) > TOOL_ARG_CHARS:
        arg = arg[:TOOL_ARG_CHARS - 1] + "…"
    return f"[tool: {name}: {arg}]" if arg else f"[tool: {name}]"


def _stamp(ts):
    if not isinstance(ts, (int, float)):
        return "unknown time"
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))


def _clip(text):
    if len(text) <= MSG_CAP:
        return text
    half = MSG_CAP // 2
    return (text[:half] + f"\n[... {len(text) - MSG_CAP} characters cut ...]\n"
            + text[-half:])


def messages(events, stop_seq=None):
    """[(who, ts, text, last_ts)] for the conversation in `events` (raw or
    condensed Console events), oldest first. Consecutive replies of one turn
    merge into one MIST entry: ts is when it began, last_ts its newest part."""
    cond = archive.Condenser()
    for ev in events:
        seq = ev.get("seq")
        # Filter, don't stop: seq is assigned before the append, so two threads
        # can land a pair of lines in the file out of order.
        if stop_seq is not None and isinstance(seq, int) and seq >= stop_seq:
            continue
        cond.feed(ev)
    out = []
    for ev in cond.finish():
        kind = ev.get("type")
        if kind == "user_text" and not ev.get("kind"):
            text = (ev.get("text") or "").strip()
            if ev.get("image"):
                text = (text + "\n" if text else "") + "[image attached]"
            # A send that failed and was sent again shows up twice in a row
            # with no reply between; keep one copy.
            if text and not (out and out[-1][0] == "Alex" and out[-1][2] == text):
                out.append(["Alex", ev.get("ts"), text, ev.get("ts")])
        elif kind == "mist_msg":
            parts = []
            for b in ev.get("blocks") or []:
                if b.get("kind") == "text" and (b.get("text") or "").strip():
                    parts.append(b["text"].strip())
                elif b.get("kind") == "tool":
                    parts.append(_tool_marker(b))
            if not parts:
                continue
            if out and out[-1][0] == "MIST":
                out[-1][2] += "\n" + "\n".join(parts)
                out[-1][3] = ev.get("ts") or out[-1][3]
            else:
                out.append(["MIST", ev.get("ts"), "\n".join(parts), ev.get("ts")])
    return [tuple(m) for m in out]


def build(events, stop_seq=None, cap=REPLAY_CAP):
    """The replay for a fresh session's first message, or None when the log
    holds no conversation. Returns (text, n_messages, n_omitted)."""
    msgs = messages(events, stop_seq)
    if not msgs:
        return None
    blocks = [f"[{_stamp(ts)}] {who}:\n{_clip(text)}" for who, ts, text, _last in msgs]
    omitted = 0
    if sum(len(b) + 2 for b in blocks) > cap:
        budget = cap - len(blocks[0])
        tail = []
        for b in reversed(blocks[1:]):
            if len(b) + 2 > budget:
                break
            tail.append(b)
            budget -= len(b) + 2
        tail.reverse()
        omitted = len(blocks) - 1 - len(tail)
        blocks = [blocks[0], f"[... {omitted} earlier messages left out to fit ...]"] + tail
    stamps = [m[3] for m in msgs if isinstance(m[3], (int, float))]
    header = HEADER.format(last=_stamp(max(stamps) if stamps else None))
    text = "<console_replay>\n" + header + "\n\n" + "\n\n".join(blocks) + "\n</console_replay>"
    return text, len(msgs), omitted
