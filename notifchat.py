"""Chats opened from a notification banner.

A banner from a headless sender (a launchd watcher, a scheduled routine, a
script with no Console chat behind it) links to "console:notif.<nid>". When it
is tapped the Console opens a chat whose first message is the notification in
full, whatever context the sender attached, and the reason the chat exists:
Alex tapped it. These two helpers are the pure half of that (find the history
line, write the seed); app.py owns the session and the send.

INVARIANTS
- by_nid() matches on the "nid" field only, newest line first; a substring hit
  in another field never counts.
- seed() ends with "Alex wants to chat about this." unless a banner reply is
  given, in which case it ends with that reply verbatim.
- seed() never drops a field the sender set (subtitle, source, actions, image,
  context, origin, group); an absent field leaves no empty line behind.
"""
import json
import time


def by_nid(history_path, nid):
    """The history line for one notification, newest match wins."""
    if not nid:
        return None
    try:
        with open(history_path) as f:
            lines = f.readlines()
    except OSError:
        return None
    for ln in reversed(lines):
        if nid not in ln:
            continue
        try:
            n = json.loads(ln)
        except ValueError:
            continue
        if n.get("nid") == nid:
            return n
    return None


def seed(n, reply=None):
    """The first message of a chat opened from a banner: the whole notification,
    what the sender knew, and why the chat exists."""
    when = ""
    if n.get("ts"):
        try:
            when = time.strftime("%A %Y-%m-%d %H:%M", time.localtime(float(n["ts"])))
        except (TypeError, ValueError, OverflowError):
            pass
    lines = ["A MIST notification that Alex tapped.", ""]
    lines.append(f"Title: {n.get('title') or 'MIST'}")
    if n.get("subtitle"):
        lines.append(f"Subtitle: {n['subtitle']}")
    lines += ["Message:", (n.get("body") or "").strip(), ""]
    meta = []
    if when:
        meta.append(f"sent {when}")
    if n.get("origin"):
        meta.append(f"from {n['origin']}")
    if n.get("group"):
        meta.append(f"group {n['group']}")
    if meta:
        lines.append("Sent: " + ", ".join(meta))
    if n.get("source"):
        lines.append(f"Source link: {n['source']}")
    acts = [a for a in (n.get("actions") or []) if isinstance(a, dict)]
    if acts:
        lines.append("Buttons: " + "; ".join(
            f"{a.get('label')} -> {a.get('target')}" for a in acts))
    if n.get("image"):
        lines.append(f"Image: {n['image']}")
    if n.get("context"):
        lines += ["", "Context from the sender:", n["context"].strip()]
    if lines[-1] != "":
        lines.append("")
    if reply:
        lines.append(f"Alex replied from the banner: {reply}")
    else:
        lines.append("Alex wants to chat about this.")
    return "\n".join(lines)


def title_for(n):
    """Rail title for the opened chat: the alert's name and first line."""
    title = n.get("title") or "MIST"
    body = (n.get("body") or "").strip().splitlines()
    body = body[0] if body else ""
    t = body if title in ("MIST", "") else f"{title}: {body}"
    return (t[:60] + "…") if len(t) > 60 else (t or "Notification")
