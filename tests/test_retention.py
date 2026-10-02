"""Pinned chats hold their CLI transcript clock still (retention.py).

Claude Code deletes a transcript once its mtime is older than cleanupPeriodDays.
While a chat is pinned, each tick moves its files' mtimes forward by the time
since the last tick; after an unpin the countdown continues from there.
"""
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import retention

DAY = 86400.0
T0 = 1_790_000_000.0


def _setup(tmp_path):
    proj = tmp_path / "projects" / "-x"
    (proj / "abc" / "tool-results").mkdir(parents=True)
    files = {
        "jsonl": proj / "abc.jsonl",
        "tip": proj / "abc.ccr-tip.json",
        "tool": proj / "abc" / "tool-results" / "r1.txt",
        "other": proj / "zzz.jsonl",           # another chat's session
    }
    for f in files.values():
        f.write_text("x")
        os.utime(f, (T0 - 50 * DAY, T0 - 50 * DAY))
    chat = SimpleNamespace(id="s1", pinned=True, cwd="/w", claude_session_id="abc")

    def find(cwd, csid):
        return str(proj / f"{csid}.jsonl")
    return chat, find, files, str(tmp_path / "retention.json")


def _age(path, now):
    return round((now - os.stat(path).st_mtime) / DAY, 3)


def test_pinned_files_do_not_age(tmp_path):
    chat, find, files, state = _setup(tmp_path)
    assert retention.tick([chat], find, state, now=T0) == 0      # the clock starts
    assert retention.tick([chat], find, state, now=T0 + 20 * DAY) == 3
    for key in ("jsonl", "tip", "tool"):
        assert _age(files[key], T0 + 20 * DAY) == 50.0
    assert _age(files["other"], T0 + 20 * DAY) == 70.0          # not pinned: ages


def test_a_file_written_while_pinned_keeps_its_real_time(tmp_path):
    chat, find, files, state = _setup(tmp_path)
    retention.tick([chat], find, state, now=T0)
    os.utime(files["jsonl"], (T0 + DAY, T0 + DAY))                 # a turn happened
    retention.tick([chat], find, state, now=T0 + 2 * DAY)
    assert os.stat(files["jsonl"]).st_mtime == T0 + DAY
    assert _age(files["tool"], T0 + 2 * DAY) == 50.0


def test_unpin_resumes_the_countdown_where_it_stopped(tmp_path):
    chat, find, files, state = _setup(tmp_path)
    retention.tick([chat], find, state, now=T0)
    retention.tick([chat], find, state, now=T0 + DAY)
    chat.pinned = False
    retention.tick([chat], find, state, now=T0 + 2 * DAY)          # last shift at the unpin
    assert _age(files["jsonl"], T0 + 2 * DAY) == 50.0
    retention.tick([chat], find, state, now=T0 + 5 * DAY)          # unpinned: it ages again
    assert _age(files["jsonl"], T0 + 5 * DAY) == 53.0
    assert retention._load(state) == {}


def test_mtimes_never_pass_now_and_missing_files_are_skipped(tmp_path):
    chat, find, files, state = _setup(tmp_path)
    retention.tick([chat], find, state, now=T0)
    files["tip"].unlink()
    retention.tick([chat], find, state, now=T0 + 400 * DAY)
    assert os.stat(files["jsonl"]).st_mtime <= T0 + 400 * DAY


def test_clocks_of_deleted_chats_are_dropped(tmp_path):
    chat, find, _files, state = _setup(tmp_path)
    retention.tick([chat], find, state, now=T0)
    retention.tick([], find, state, now=T0 + DAY)
    assert retention._load(state) == {}
