"""The New chat button shows a chat before the server answers: the page holds
an id from POST /sessions/reserve and sends it with POST /sessions. The server
uses a wanted id that is free, and gives a fresh one when it is taken or out of
range, so two chats never share an id."""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["MIST_CONSOLE_DATA_DIR"] = tempfile.mkdtemp(prefix="mist-reserve-test-")

import app  # noqa: E402  (needs the env var above first)

client = app.app.test_client()


def _drop(*sids):
    # Before the 1.5 s warm timer, so no test chat starts a claude backend.
    for sid in sids:
        client.delete("/sessions/" + sid)


def test_reserve_makes_no_chat_and_carries_the_defaults():
    j = client.post("/sessions/reserve").get_json()
    assert j["id"] not in app._sessions
    assert j["permission_mode"] == app.DEFAULT_PERMISSION_MODE
    assert client.post("/sessions/reserve").get_json()["id"] != j["id"]


def test_create_keeps_a_reserved_id():
    want = client.post("/sessions/reserve").get_json()["id"]
    got = client.post("/sessions", json={"id": want}).get_json()["id"]
    assert got == want and want in app._sessions
    _drop(got)


def test_taken_id_gets_a_fresh_one():
    want = client.post("/sessions/reserve").get_json()["id"]
    a = client.post("/sessions", json={"id": want}).get_json()["id"]
    b = client.post("/sessions", json={"id": want}).get_json()["id"]
    assert a == want and b != want and b in app._sessions
    _drop(a, b)


def test_id_from_before_a_restart_is_kept_and_moves_the_counter():
    # A restarted server forgot the reservation; the number is just past its counter.
    want = f"s{app._counter + 3}"
    got = client.post("/sessions", json={"id": want}).get_json()["id"]
    assert got == want
    nxt = client.post("/sessions").get_json()["id"]
    assert int(nxt[1:]) > int(want[1:])
    _drop(got, nxt)


def test_bad_or_far_ids_are_ignored():
    made = [client.post("/sessions", json={"id": bad}).get_json()["id"]
            for bad in ("s999999999", "../x", "i_abc", 7, None)]
    assert all(m.startswith("s") and int(m[1:]) < 100000 for m in made)
    assert len(set(made)) == len(made)
    _drop(*made)
