"""POST /send carries every composer image, not only the last one pasted.

- An `images` list reaches the session as one file path per image, in order.
- The older single `image` field still works.
- One unreadable image refuses the whole send (no text-only reply).
- More than _IMG_MAX_COUNT images are refused before any decode.
- The expired-transcript replay counts the images of a multi-image turn.
"""
# ruff: noqa: SLF001  (white-box tests of app.py internals)
import base64
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["MIST_CONSOLE_DATA_DIR"] = tempfile.mkdtemp(prefix="mist-multi-image-test-")

import pytest  # noqa: E402

import app  # noqa: E402  (needs the env var above first)
import replay  # noqa: E402

client = app.app.test_client()
PNG = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"x" * 64).decode()


class StubSession:
    title = "New chat"

    def __init__(self):
        self.calls = []

    def maybe_auth_command(self, _text):
        return False

    def context_gate(self):
        return None

    def send(self, text, **kw):
        self.calls.append((text, kw))
        return True


@pytest.fixture
def sess(monkeypatch, tmp_path):
    s = StubSession()
    monkeypatch.setattr(app, "_PASTE_DIR", str(tmp_path))
    monkeypatch.setattr(app, "_sessions", {"s1": s})
    monkeypatch.setattr(app, "_touch", lambda _s: None)
    monkeypatch.setattr(app, "_save_meta", lambda: None)
    return s


def test_every_image_reaches_the_session(sess, tmp_path):
    j = client.post("/send/s1", json={"text": "compare", "images": [PNG, PNG, PNG]}).get_json()
    assert j["ok"]
    (text, kw), = sess.calls
    assert text == "compare"
    paths = kw["image_paths"]
    assert len(paths) == 3 and len(set(paths)) == 3
    assert all(os.path.dirname(p) == str(tmp_path) and os.path.exists(p) for p in paths)


def test_legacy_single_image_field(sess):
    assert client.post("/send/s1", json={"text": "", "image": PNG}).get_json()["ok"]
    assert len(sess.calls[0][1]["image_paths"]) == 1


def test_one_bad_image_refuses_the_send(sess):
    j = client.post("/send/s1", json={"text": "hi", "images": [PNG, "data:text/plain;base64,eA=="]}).get_json()
    assert j == {"ok": False, "error": "image"}
    assert sess.calls == []


def test_too_many_images_refused(sess):
    j = client.post("/send/s1", json={"images": [PNG] * (app._IMG_MAX_COUNT + 1)}).get_json()
    assert j["too_many"] == app._IMG_MAX_COUNT and not j["ok"]
    assert sess.calls == []


def test_replay_counts_images():
    evs = [{"type": "user_text", "text": "look", "seq": 1, "image": "/a.png", "images": ["/a.png", "/b.png"]},
           {"type": "user_text", "text": "one", "seq": 2, "image": "/c.png"}]
    built = replay.build(evs)
    assert built and "[2 images attached]" in built[0] and "[image attached]" in built[0]
