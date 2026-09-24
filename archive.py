"""archive.py — condense old chat transcripts so data/ stops growing without bound.

INVARIANTS:
- Condensing is lossy on purpose and only ever runs on a chat that is unpinned,
  dormant (no backend), unwatched (no SSE subscriber) and older than
  ARCHIVE_AFTER_DAYS. Pinned chats are never touched.
- The output replays through the same code path as an imported chat:
  `user_text` events stay as they are, every assistant API message becomes one
  `mist_msg` {blocks} event, the last `context` event and any `compact_boundary`
  dividers are kept, and everything else (stream deltas, tool result sidecars,
  task/progress ticks, stderr) is dropped. Event `seq` and `ts` stamps are
  preserved so ordering, timestamps and rewind anchors keep working.
- The same Condenser serves the in-memory replay window: bridge._load_history
  condenses everything older than HISTORY_CAP raw events instead of dropping it,
  so a long chat still replays from its first message.
- `mist_msg` carries the CLI `uuid` of its last content block, so rewind() can
  still find an anchor in a condensed chat.
- Rewrite is atomic (temp file + os.replace); a crash mid-run leaves the
  original intact.

Measured on this machine's data/ (2026-09-20): 2.9 GB across 1374 chats, 14
files over 20 MB, 237 chats untouched for 90+ days. Stream deltas and tool
result payloads are the bulk; the condensed form is typically 1-5% of the size.
"""
import json
import os
import time

ARCHIVE_AFTER_DAYS = 90
RESULT_CAP = 6000          # chars of tool result kept (renderHistMsg shows this much)


def _text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content
                       if isinstance(p, dict) and p.get("type") == "text")
    return ""


class Condenser:
    """Streaming condenser: feed() raw Console events in order, finish() returns
    the condensed list. Single pass and bounded by the output size, so a 500k-line
    jsonl never has to sit in memory whole. A tool's result arrives (in a `user`
    event) after the assistant message that called it, so tool blocks are emitted
    with an empty result and filled in when the result shows up. Feeding events
    that are already condensed (`mist_msg`, `user_text`) passes them through, so
    running it twice over the same stretch is safe.

    Used by condense() for the on-disk archive tier and by bridge._load_history
    for the in-memory replay window (see HISTORY_CAP there)."""

    def __init__(self):
        self.out = []
        self._msgs = {}          # api message id -> mist_msg event being assembled
        self._pending = {}       # tool_use_id -> tool block awaiting its result
        self._last_context = None
        self.n_in = 0

    def feed(self, obj):
        self.n_in += 1
        t = obj.get("type")
        if t == "user_text":
            self.out.append(obj)
        elif t == "context":
            self._last_context = obj
        elif t == "mist_msg":
            self.out.append(obj)          # already condensed
        elif t == "system" and obj.get("subtype") == "compact_boundary":
            self.out.append(obj)          # a real divider in the transcript; cheap to keep
        elif t == "user":
            content = (obj.get("message") or {}).get("content")
            if isinstance(content, list):
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "tool_result":
                        blk = self._pending.pop(b.get("tool_use_id"), None)
                        if blk is None:
                            continue
                        txt = b.get("content")
                        if isinstance(txt, list):
                            txt = "".join(p.get("text", "") for p in txt
                                          if isinstance(p, dict))
                        blk["result"] = str(txt or "")[:RESULT_CAP]
        elif t == "assistant" and not obj.get("parent_tool_use_id"):
            m = obj.get("message") or {}
            mid = m.get("id") or obj.get("uuid") or len(self.out)
            ev = self._msgs.get(mid)
            if ev is None:
                ev = {"type": "mist_msg", "blocks": [], "ts": obj.get("ts"),
                      "seq": obj.get("seq"), "uuid": obj.get("uuid")}
                self._msgs[mid] = ev
                self.out.append(ev)
            else:
                ev["uuid"] = obj.get("uuid") or ev.get("uuid")
            for b in (m.get("content") or []):
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text" and (b.get("text") or "").strip():
                    ev["blocks"].append({"kind": "text", "text": b["text"]})
                elif b.get("type") == "thinking" and (b.get("thinking") or "").strip():
                    ev["blocks"].append({"kind": "thinking", "text": b["thinking"]})
                elif b.get("type") == "tool_use":
                    blk = {"kind": "tool", "name": b.get("name", "tool"),
                           "input": b.get("input", {}), "result": ""}
                    ev["blocks"].append(blk)
                    if b.get("id"):
                        self._pending[b["id"]] = blk

    def finish(self):
        out = [ev for ev in self.out if ev.get("type") != "mist_msg" or ev.get("blocks")]
        if self._last_context is not None:
            out.append(self._last_context)
        return out


def condense_events(events):
    """Condense an in-order iterable of Console events to a list."""
    c = Condenser()
    for obj in events:
        c.feed(obj)
    return c.finish()


def condense(path):
    """Rewrite one Console jsonl into its condensed form. Returns
    (events_before, events_after) or None if the file was left alone."""
    if not os.path.exists(path):
        return None
    c = Condenser()
    with open(path) as f:
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except Exception:  # noqa: S112, BLE001 -- a corrupt line is skipped, the rest are kept
                continue
            c.feed(obj)
    out = c.finish()
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w") as f:
        f.writelines(json.dumps(ev) + "\n" for ev in out)
    os.replace(tmp, path)
    return c.n_in, len(out)


def due(session, now=None):
    """Is this chat old and idle enough to condense?"""
    now = now or time.time()
    if session.pinned or session.archived or session.alive:
        return False
    if getattr(session, "_subscribers", None):
        return False
    if getattr(session, "_turn_active", False):
        return False
    return (now - (session.last_activity or now)) > ARCHIVE_AFTER_DAYS * 86400
