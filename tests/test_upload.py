"""POST /upload: the phone's file picker sends a video (or any non-image
file) here as a raw body and gets back a Mac path for the composer.

- The body lands byte-for-byte under tmp/uploads, never partly written.
- The stored name keeps a sanitized stem and extension; a path in ?name=
  cannot leave the upload folder, and a secret extension is defused.
- An empty body is refused and leaves no file.
"""
# ruff: noqa: SLF001  (white-box tests of app.py internals)
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["MIST_CONSOLE_DATA_DIR"] = tempfile.mkdtemp(prefix="mist-upload-test-")

import pytest  # noqa: E402

import app  # noqa: E402  (needs the env var above first)

client = app.app.test_client()


@pytest.fixture(autouse=True)
def upload_dir(monkeypatch, tmp_path):
    monkeypatch.setattr(app, "_UPLOAD_DIR", str(tmp_path))
    return tmp_path


def test_video_body_saved_intact(upload_dir):
    body = os.urandom(3 * app._UPLOAD_CHUNK + 17)
    r = client.post("/upload?name=IMG_0042.MOV", data=body,
                    content_type="application/octet-stream")
    j = r.get_json()
    assert r.status_code == 200 and j["ok"]
    assert os.path.dirname(j["path"]) == str(upload_dir)
    assert j["name"].endswith("-IMG_0042.mov")
    assert j["size"] == len(body)
    with open(j["path"], "rb") as f:
        assert f.read() == body
    assert not [p for p in os.listdir(upload_dir) if p.endswith(".part")]


def test_name_cannot_escape_folder(upload_dir):
    r = client.post("/upload?name=../../etc/my%20clip!.mp4", data=b"x")
    j = r.get_json()
    assert os.path.dirname(j["path"]) == str(upload_dir)
    assert j["name"].endswith("-my-clip.mp4")


def test_secret_extension_defused():
    j = client.post("/upload?name=prod.env", data=b"x").get_json()
    assert j["name"].endswith(".env.txt")


def test_empty_body_refused(upload_dir):
    r = client.post("/upload?name=a.mov", data=b"")
    assert r.status_code == 400
    assert os.listdir(upload_dir) == []
