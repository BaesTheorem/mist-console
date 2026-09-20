"""archive.py — condense old chat transcripts so data/ stops growing without bound.

INVARIANTS:
- Condensing is lossy on purpose and only ever runs on a chat that is unpinned,
  dormant (no backend), unwatched (no SSE subscriber) and older than
  ARCHIVE_AFTER_DAYS. Pinned chats are never touched.
- The output replays through the same code path as an imported chat:
  `user_text` events stay as they are, every assistant API message becomes one
  `mist_msg` {blocks} event, the last `context` event is kept, and everything
  else (stream deltas, tool result sidecars, task/progress ticks, stderr) is
  dropped. Event `seq` and `ts` stamps are preserved so ordering, timestamps
  and rewind anchors keep working.
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


def condense(path):
    """Rewrite one Console jsonl into its condensed form. Returns
    (events_before, events_after) or None if the file was left alone."""
    if not os.path.exists(path):
        return None
    results = {}          # tool_use_id -> result text
    lines = []
    n_before = 0
    with open(path) as f:
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except Exception:
                continue
            n_before += 1
            lines.append(obj)
            if obj.get("type") == "user":
                content = (obj.get("message") or {}).get("content")
                if isinstance(content, list):
                    for b in content:
                        if isinstance(b, dict) and b.get("type") == "tool_result":
                            txt = b.get("content")
                            if isinstance(txt, list):
                                txt = "".join(p.get("text", "") for p in txt
                                              if isinstance(p, dict))
                            results[b.get("tool_use_id")] = str(txt or "")[:RESULT_CAP]
    out = []
    msgs = {}             # api message id -> mist_msg event being assembled
    last_context = None
    for obj in lines:
        t = obj.get("type")
        if t == "user_text":
            out.append(obj)
        elif t == "context":
            last_context = obj
        elif t == "mist_msg":
            out.append(obj)          # already condensed
        elif t == "assistant" and not obj.get("parent_tool_use_id"):
            m = obj.get("message") or {}
            mid = m.get("id") or obj.get("uuid") or len(out)
            ev = msgs.get(mid)
            if ev is None:
                ev = {"type": "mist_msg", "blocks": [], "ts": obj.get("ts"),
                      "seq": obj.get("seq"), "uuid": obj.get("uuid")}
                msgs[mid] = ev
                out.append(ev)
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
                    ev["blocks"].append({"kind": "tool", "name": b.get("name", "tool"),
                                         "input": b.get("input", {}),
                                         "result": results.get(b.get("id"), "")})
    out = [ev for ev in out if ev.get("type") != "mist_msg" or ev.get("blocks")]
    if last_context is not None:
        out.append(last_context)
    tmp = path + ".tmp.%d" % os.getpid()
    with open(tmp, "w") as f:
        for ev in out:
            f.write(json.dumps(ev) + "\n")
    os.replace(tmp, path)
    return n_before, len(out)


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
