"""A tapped banner from a headless sender opens a chat seeded with the whole
notification (see notifchat.py INVARIANTS)."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import notifchat  # noqa: E402


def _history(tmp_path, *lines):
    p = tmp_path / "history.jsonl"
    p.write_text("".join(json.dumps(x) + "\n" for x in lines))
    return str(p)


def test_by_nid_matches_the_field_not_a_substring(tmp_path):
    h = _history(tmp_path,
                 {"nid": "1-1", "body": "mentions 2-2 in the text"},
                 {"nid": "2-2", "body": "old"},
                 {"nid": "2-2", "body": "newest wins"},
                 "not json at all")
    assert notifchat.by_nid(h, "2-2")["body"] == "newest wins"
    assert notifchat.by_nid(h, "1-1")["body"].startswith("mentions")
    assert notifchat.by_nid(h, "9-9") is None
    assert notifchat.by_nid(h, "") is None
    assert notifchat.by_nid(str(tmp_path / "missing"), "1-1") is None


def test_seed_carries_every_field_and_ends_with_the_reason():
    n = {"title": "Gatorade watch", "subtitle": "Sub", "body": "Restock live\nsecond line",
         "ts": 1790755044.0, "origin": "routine morning-briefing", "group": "watchers",
         "source": "https://example.com/item", "image": "/tmp/p.png",
         "actions": [{"label": "Buy", "target": "https://example.com/buy"}],
         "context": "watch log tail"}
    s = notifchat.seed(n)
    for needle in ("Title: Gatorade watch", "Subtitle: Sub", "Restock live\nsecond line",
                   "from routine morning-briefing", "group watchers",
                   "Source link: https://example.com/item", "Buy -> https://example.com/buy",
                   "Image: /tmp/p.png", "Context from the sender:\nwatch log tail"):
        assert needle in s
    assert s.endswith("Alex wants to chat about this.")
    assert notifchat.seed(n, reply="do it").endswith("Alex replied from the banner: do it")


def test_seed_of_a_bare_notification_has_no_empty_fields():
    s = notifchat.seed({"title": "MIST", "body": "Inbox over five"})
    assert "Subtitle" not in s and "Source link" not in s and "Buttons" not in s
    assert "Context from the sender" not in s
    assert "Sent:" not in s   # no ts, no origin, no group
    assert "\n\n\n" not in s


def test_title_for_names_the_alert():
    assert notifchat.title_for({"title": "MIST", "body": "Inbox over five\nmore"}) == "Inbox over five"
    assert notifchat.title_for({"title": "Watch", "body": "Restock"}) == "Watch: Restock"
    assert notifchat.title_for({"title": "T", "body": "x" * 100}).endswith("…")
    assert notifchat.title_for({}) == "Notification"
