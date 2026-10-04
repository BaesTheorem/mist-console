"""design.py — the link between a chat's working directory and its Claude Design
project.

Each repo MIST designs a UI for carries one small file, `design/claude-design.json`,
that names the Claude Design project (claude.ai/design/p/<id>) the repo's screens
live in. The Console's design pane reads it to open the right project for the
active chat, and the /ui-design skill reads it to know where to push context and
pull the handoff from. It is committed on purpose: a project id is an address,
not a credential, and a fresh clone must find the same canvas.

Shape:
    {"project": "<uuid>", "url": "https://claude.ai/design/p/<uuid>",
     "name": "<project name>", "design_system": "<uuid or null>",
     "linked": "<ISO timestamp>"}
"""
import json
import os
import re
import time

LINK_REL = os.path.join("design", "claude-design.json")
DESIGN_HOME = "https://claude.ai/design"
_ID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_URL_RE = re.compile(r"claude\.ai/design/p/([0-9a-f-]{36})", re.I)


def link_path(cwd):
    return os.path.join(cwd, LINK_REL) if cwd else None


def read_link(cwd):
    """The repo's design link, or None when the repo has no project yet. A
    malformed file reads as None too: the pane then shows the Design home, and the
    skill makes a fresh link."""
    p = link_path(cwd)
    if not p or not os.path.isfile(p):
        return None
    try:
        with open(p, encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(d, dict) or not d.get("project"):
        return None
    d.setdefault("url", project_url(d["project"]))
    return d


def parse_project(ref):
    """A project id from a bare uuid or a claude.ai/design/p/<id> URL; None otherwise."""
    ref = (ref or "").strip()
    if _ID_RE.match(ref):
        return ref.lower()
    m = _URL_RE.search(ref)
    return m.group(1).lower() if m else None


def project_url(project_id):
    return f"{DESIGN_HOME}/p/{project_id}"


def write_link(cwd, project_ref, name=None, design_system=None):
    """Record the project for this repo. Returns the link written, or raises
    ValueError when `project_ref` is not a project id or URL."""
    pid = parse_project(project_ref)
    if not pid:
        raise ValueError("not a Claude Design project id or URL")
    if not cwd:
        raise ValueError("no working directory")
    p = os.path.join(cwd, LINK_REL)
    old = read_link(cwd) or {}
    d = {"project": pid, "url": project_url(pid),
         "name": name or old.get("name") or os.path.basename(cwd.rstrip("/")),
         "design_system": design_system if design_system is not None else old.get("design_system"),
         "linked": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2)
        f.write("\n")
    return d


def pane_info(cwd):
    """What the pane needs for a chat: the URL to show and the link, if any."""
    link = read_link(cwd)
    return {"cwd": cwd, "url": (link or {}).get("url") or DESIGN_HOME,
            "linked": bool(link), "project": (link or {}).get("project"),
            "name": (link or {}).get("name"), "file": link_path(cwd)}
