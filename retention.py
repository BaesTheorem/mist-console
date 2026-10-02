"""retention.py: suspend the CLI transcript countdown while a chat is pinned.

Claude Code deletes a session's files once their mtime is older than
cleanupPeriodDays. Checked in claude 2.1.287: the startup sweep stats each
~/.claude/projects/<slug>/<id>.jsonl, unlinks it when its mtime is before
now - period, and removes the <id>/ folder with it; files inside <id>/ are also
swept one by one on their own mtimes. replay.py rebuilds an expired chat as
text, but a pinned chat should keep its real transcript, tool output and all.

So while a chat is pinned its clock stands still: every tick moves the mtime of
each of the chat's CLI files forward by the time since the previous tick. A
file written since that tick keeps its real mtime, which is fresher anyway.
After an unpin the shifting stops, and the countdown continues from where it
stood (activity while pinned counts, as it would unpinned).

INVARIANTS:
- Only mtimes change (os.utime); file content is never touched.
- An mtime only moves forward, and never past the tick's `now`.
- Only the files of each pinned chat's current CLI session are touched.
- The per-chat clocks persist (data/retention.json), so time the Console was
  down while a chat was pinned is frozen too.
"""
import json
import os
import threading
import time

TICK_SEC = 600
_SIDECARS = (".ccr-tip.json", ".precompact.json")
_lock = threading.Lock()


def session_files(transcript):
    """The CLI files of one session: <id>.jsonl, its sidecars, and every file
    under its <id>/ folder (tool results, subagent transcripts)."""
    base = transcript[:-len(".jsonl")]
    out = [transcript]
    out += [base + side for side in _SIDECARS if os.path.isfile(base + side)]
    if os.path.isdir(base):
        for root, _dirs, files in os.walk(base):
            out += [os.path.join(root, f) for f in files]
    return out


def shift(paths, since, now):
    """Move each file's mtime forward by now - since, unless it was written
    after `since`. Returns how many files moved."""
    delta = now - since
    if delta <= 0:
        return 0
    moved = 0
    for p in paths:
        try:
            st = os.stat(p)
            if st.st_mtime > since:
                continue      # written since the last tick: its age is real
            os.utime(p, (st.st_atime, min(st.st_mtime + delta, now)))
            moved += 1
        except OSError:
            continue          # swept or rotated under us; nothing to hold
    return moved


def _load(path):
    try:
        with open(path) as f:
            data = json.load(f)
        return {k: float(v) for k, v in data.items()} if isinstance(data, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def _save(path, state):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, path)


def tick(sessions, find_transcript, state_path, now=None):
    """One pass over every chat. `sessions`: objects with .id, .pinned, .cwd
    and .claude_session_id. `find_transcript(cwd, csid)` gives the path of the
    CLI transcript. A chat pinned since the last pass starts its frozen clock
    now; one unpinned since then gets a last shift and its clock removed.
    Returns how many files moved."""
    now = time.time() if now is None else now
    sessions = list(sessions)
    with _lock:
        state = _load(state_path)
        before = dict(state)
        moved = 0
        for s in sessions:
            since = state.get(s.id)
            if s.pinned:
                state[s.id] = now
            elif since is not None:
                del state[s.id]
            if since is None or not s.claude_session_id:
                continue
            path = find_transcript(s.cwd, s.claude_session_id)
            if os.path.isfile(path):
                moved += shift(session_files(path), since, now)
        known = {s.id for s in sessions}
        for sid in [k for k in state if k not in known]:
            del state[sid]    # the chat was deleted
        if state != before:
            _save(state_path, state)
        return moved
