"""/stream drops base64 image data from the copy it sends the page, and
leaves the event in history untouched."""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["MIST_CONSOLE_DATA_DIR"] = tempfile.mkdtemp(prefix="mist-stream-img-test-")

import app  # noqa: E402  (needs the env var first)


def _event():
    img = {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "A" * 5000}}
    return {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "t1", "content": [img, {"type": "text", "text": "ok"}]},
        dict(img),
    ]}}


def test_images_are_dropped_from_the_page_copy():
    ev = _event()
    out = app._for_page(ev)
    tr, top = out["message"]["content"]
    assert tr["content"][0]["source"] == {"type": "omitted", "media_type": "image/png", "bytes": 5000}
    assert tr["content"][1]["text"] == "ok"
    assert top["source"]["type"] == "omitted"
    assert len(app._sse(out)) < 1000


def test_history_keeps_its_images():
    ev = _event()
    app._for_page(ev)
    assert ev["message"]["content"][0]["content"][0]["source"]["data"] == "A" * 5000


def test_events_without_images_pass_through_as_is():
    ev = {"type": "assistant", "message": {"content": [{"type": "text", "text": "hi"}]}}
    assert app._for_page(ev) is ev
    assert app._for_page({"type": "replay_done"}) == {"type": "replay_done"}
