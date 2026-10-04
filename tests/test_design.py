"""design.py links a repo to its Claude Design project through
design/claude-design.json; GET /design reports it per chat and POST /design/<sid>
drives the pane (and can write the link)."""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["MIST_CONSOLE_DATA_DIR"] = tempfile.mkdtemp(prefix="mist-design-test-")

import app  # noqa: E402  (needs the env var above first)
import design  # noqa: E402

client = app.app.test_client()
PID = "0f1e2d3c-4b5a-4968-8777-66554433aabb"


def test_parse_project_accepts_id_and_url():
    assert design.parse_project(PID) == PID
    assert design.parse_project(PID.upper()) == PID
    assert design.parse_project(f"https://claude.ai/design/p/{PID}?tab=files") == PID
    assert design.parse_project("https://claude.ai/design") is None
    assert design.parse_project("not a project") is None


def test_link_round_trip_and_defaults():
    cwd = tempfile.mkdtemp(prefix="repo-")
    assert design.read_link(cwd) is None
    info = design.pane_info(cwd)
    assert info["url"] == design.DESIGN_HOME and info["linked"] is False
    d = design.write_link(cwd, f"https://claude.ai/design/p/{PID}")
    assert d["project"] == PID and d["name"] == os.path.basename(cwd)
    with open(os.path.join(cwd, "design", "claude-design.json")) as f:
        assert json.load(f)["url"] == design.project_url(PID)
    # a re-link keeps the name and design system unless told otherwise
    design.write_link(cwd, PID, design_system="ds-1")
    design.write_link(cwd, PID)
    assert design.read_link(cwd)["design_system"] == "ds-1"
    assert design.pane_info(cwd)["linked"] is True


def test_malformed_link_reads_as_none():
    cwd = tempfile.mkdtemp(prefix="repo-")
    os.makedirs(os.path.join(cwd, "design"))
    with open(os.path.join(cwd, "design", "claude-design.json"), "w") as f:
        f.write("{not json")
    assert design.read_link(cwd) is None


def test_routes():
    sid = client.post("/sessions").get_json()["id"]
    cwd = tempfile.mkdtemp(prefix="repo-")
    app._sessions[sid].cwd = cwd  # noqa: SLF001  test reaches into the registry on purpose
    assert client.get("/design?session=" + sid).get_json()["linked"] is False
    r = client.post("/design/" + sid, json={"project": "garbage"})
    assert r.status_code == 400
    r = client.post("/design/" + sid, json={"project": PID, "link": True, "name": "Pocket Dungeon"})
    assert r.status_code == 200 and r.get_json()["name"] == "Pocket Dungeon"
    assert design.read_link(cwd)["project"] == PID
    assert client.get("/design?session=" + sid).get_json()["url"] == design.project_url(PID)
    assert client.post("/design/nope", json={}).status_code == 404
