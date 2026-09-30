"""Bookmarks and checklist state address a message by "<role>:<seq>" and
follow the chat through rewind and deletion (see bookmarks.py INVARIANTS)."""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["MIST_CONSOLE_DATA_DIR"] = tempfile.mkdtemp(prefix="mist-bm-test-")

import bookmarks  # noqa: E402  (needs the env var above first)


def setup_function(_):
    bookmarks.drop("s1")
    bookmarks.drop("s2")


def test_add_is_idempotent_and_normalizes_preview():
    a = bookmarks.add("s1", "user", 5, "  two   words\n here ")
    b = bookmarks.add("s1", "user", 5, "")
    assert a["id"] == b["id"] == "s1:user:5"
    assert b["preview"] == "two words here"
    assert len(bookmarks.list_for("s1")) == 1


def test_list_for_is_transcript_order_and_all_is_newest_first():
    bookmarks.add("s1", "mist", 40, "late")
    bookmarks.add("s1", "user", 3, "early")
    bookmarks.add("s2", "user", 1, "other chat")
    assert [b["seq"] for b in bookmarks.list_for("s1")] == [3, 40]
    assert bookmarks.list_all()[0]["sid"] == "s2"


def test_prune_drops_everything_at_or_after_the_cut():
    bookmarks.add("s1", "user", 3, "kept")
    bookmarks.add("s1", "mist", 4, "kept reply")
    bookmarks.add("s1", "user", 9, "cut point")
    bookmarks.add("s1", "mist", 12, "after")
    bookmarks.set_check("s1", "mist", 4, 0, True)
    bookmarks.set_check("s1", "mist", 12, 1, True)
    bookmarks.prune("s1", 9)
    assert [b["seq"] for b in bookmarks.list_for("s1")] == [3, 4]
    assert bookmarks.checks_for("s1") == {"mist:4": {"0": True}}


def test_drop_forgets_one_chat_only():
    bookmarks.add("s1", "user", 1, "a")
    bookmarks.add("s2", "user", 1, "b")
    bookmarks.set_check("s1", "user", 1, 0, True)
    bookmarks.drop("s1")
    assert bookmarks.list_for("s1") == []
    assert bookmarks.checks_for("s1") == {}
    assert len(bookmarks.list_for("s2")) == 1


def test_bad_addresses_are_rejected():
    import pytest
    with pytest.raises(ValueError):
        bookmarks.add("s1", "system", 1, "x")
    with pytest.raises(ValueError):
        bookmarks.set_check("s1", "user", "nope", 0, True)
    assert bookmarks.remove("s1", "user", 999) is False


def test_survives_a_reload_from_disk():
    bookmarks.add("s1", "user", 7, "persisted")
    bookmarks.set_check("s1", "user", 7, 2, True)
    # A fresh store object reading the same files sees the same state.
    fresh = bookmarks._Store(bookmarks.BOOKMARKS_PATH, "bookmarks", list)  # noqa: SLF001  (testing persistence)
    assert [b["seq"] for b in fresh.data()] == [7]
    fresh_ck = bookmarks._Store(bookmarks.CHECKS_PATH, "checks", dict)  # noqa: SLF001
    assert fresh_ck.data()["s1"]["user:7"] == {"2": True}
