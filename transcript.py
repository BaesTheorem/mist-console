"""transcript.py: a chat as readable text, for the phone's offline cache.

Walks a chat's whole jsonl once and returns messages a reader can show with
no Console around: the user's text, MIST's text (one message per API message,
text blocks joined), and one line per tool call. Thinking, deltas, tool
results, progress ticks and every other stream event are dropped. Handles the
live shape (`assistant` events with content blocks) and the condensed /
imported shape (`mist_msg` blocks, see archive.py and importer.py).
"""
import json


def _tool_line(block):
    name = block.get("name") or "tool"
    inp = block.get("input") or {}
    hint = ""
    if isinstance(inp, dict):
        hint = (inp.get("description") or inp.get("command") or inp.get("file_path")
                or inp.get("pattern") or inp.get("query") or inp.get("prompt") or "")
        if isinstance(hint, str):
            hint = hint.strip().splitlines()[0] if hint.strip() else ""
        else:
            hint = ""
    return f"{name}: {hint[:160]}" if hint else name


def build(path, sid=None, title=None):
    messages = []
    cur = None          # assistant message being assembled: {"id", "text": [], "tools": [], "ts"}
    last_ts = None

    def flush():
        nonlocal cur
        if not cur:
            return
        text = "\n\n".join(t for t in cur["text"] if t).strip()
        if text:
            messages.append({"role": "assistant", "text": text, "ts": cur["ts"]})
        for line in cur["tools"]:
            messages.append({"role": "tool", "text": line, "ts": cur["ts"]})
        cur = None

    try:
        f = open(path, encoding="utf-8", errors="replace")
    except OSError:
        return {"id": sid, "title": title, "messages": [], "updated": None}
    with f:
        for line in f:
            try:
                e = json.loads(line)
            except Exception:
                continue
            t = e.get("type")
            ts = e.get("ts")
            if isinstance(ts, (int, float)):
                last_ts = ts if ts < 1e11 else ts / 1000
            if t == "user_text":
                flush()
                text = (e.get("text") or "").strip()
                if text:
                    messages.append({"role": "user", "text": text, "ts": last_ts})
            elif t == "assistant":
                msg = e.get("message") or {}
                mid = msg.get("id")
                if not cur or (mid and cur["id"] != mid):
                    flush()
                    cur = {"id": mid, "text": [], "tools": [], "ts": last_ts}
                content = msg.get("content")
                if isinstance(content, str):
                    cur["text"].append(content)
                elif isinstance(content, list):
                    for b in content:
                        if not isinstance(b, dict):
                            continue
                        if b.get("type") == "text" and b.get("text"):
                            cur["text"].append(b["text"])
                        elif b.get("type") == "tool_use":
                            cur["tools"].append(_tool_line(b))
            elif t == "mist_msg":
                flush()
                texts, tools = [], []
                for b in e.get("blocks") or []:
                    if not isinstance(b, dict):
                        continue
                    if b.get("kind") == "text" and b.get("text"):
                        texts.append(b["text"])
                    elif b.get("kind") == "tool":
                        tools.append(_tool_line({"name": b.get("name"), "input": b.get("input")}))
                text = "\n\n".join(texts).strip()
                if text:
                    messages.append({"role": "assistant", "text": text, "ts": last_ts})
                for line in tools:
                    messages.append({"role": "tool", "text": line, "ts": last_ts})
    flush()
    return {"id": sid, "title": title, "messages": messages,
            "updated": messages[-1]["ts"] if messages else last_ts}
