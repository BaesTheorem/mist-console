"""POST /last-chat records the open chat per client, so a restart reopens it.
The phone and the Mac keep separate places, and bad input is refused."""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["MIST_CONSOLE_DATA_DIR"] = tempfile.mkdtemp(prefix="mist-lastchat-test-")

import app  # noqa: E402  (needs the env var above first)

client = app.app.test_client()


def test_round_trip_per_client():
    assert client.get("/last-chat?client=mac").get_json()["id"] is None
    assert client.post("/last-chat", json={"client": "mac", "id": "i_abc-1"}).status_code == 200
    assert client.post("/last-chat", json={"client": "ios", "id": "i_xyz"}).status_code == 200
    assert client.get("/last-chat?client=mac").get_json()["id"] == "i_abc-1"
    assert client.get("/last-chat?client=ios").get_json()["id"] == "i_xyz"


def test_rejects_bad_input():
    assert client.post("/last-chat", json={"client": "tv", "id": "i_1"}).status_code == 400
    assert client.post("/last-chat", json={"client": "mac", "id": "../etc"}).status_code == 400
    assert client.post("/last-chat", json={"client": "mac"}).status_code == 400
