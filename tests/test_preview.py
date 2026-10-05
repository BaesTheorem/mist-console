"""The artifacts drawer previews HTML in a sandboxed origin: /preview serves
.html/.svg with a CSP sandbox and refuses other types, /file keeps serving
them as attachments, and a request from an opaque origin (Origin: null, or
Sec-Fetch-Site: cross-site) cannot change state even from loopback."""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["MIST_CONSOLE_DATA_DIR"] = tempfile.mkdtemp(prefix="mist-preview-test-")

import app  # noqa: E402  (needs the env var above first)
import embeds  # noqa: E402

client = app.app.test_client()


def _artifact(name, body="<!doctype html><title>t</title><p>hi</p>"):
    # under an allowlisted root: the harness tree
    root = next(r for r in embeds.ROOTS if r.endswith("Exobrain harness"))
    d = os.path.join(root, "tmp", "artifact-tests")
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, name)
    with open(p, "w") as f:
        f.write(body)
    return p


def test_preview_serves_html_sandboxed():
    p = _artifact("page.html")
    try:
        r = client.get("/preview", query_string={"path": p})
        assert r.status_code == 200
        assert r.headers["Content-Security-Policy"].startswith("sandbox")
        assert "allow-same-origin" not in r.headers["Content-Security-Policy"]
        assert "attachment" not in r.headers.get("Content-Disposition", "")
        assert b"<p>hi</p>" in r.data
        # /file still hands the same page over as a download, never inline
        r2 = client.get("/file", query_string={"path": p})
        assert r2.status_code == 200
        assert "attachment" in r2.headers.get("Content-Disposition", "")
    finally:
        os.remove(p)


def test_preview_refuses_other_types_and_missing():
    p = _artifact("notes.txt", "plain")
    try:
        assert client.get("/preview", query_string={"path": p}).status_code == 415
    finally:
        os.remove(p)
    assert client.get("/preview", query_string={"path": "/nowhere/x.html"}).status_code == 404
    assert client.get("/preview", query_string={"path": "/etc/hosts"}).status_code == 404


def test_opaque_origin_cannot_mutate():
    r = client.post("/sessions", headers={"Origin": "null"})
    assert r.status_code == 403
    r = client.post("/sessions", headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403
    # reads are untouched, and the Console's own page (same-origin) still works
    assert client.get("/sessions", headers={"Origin": "null"}).status_code == 200
    r = client.post("/sessions", headers={"Sec-Fetch-Site": "same-origin"})
    assert r.status_code == 200
    client.delete("/sessions/" + r.get_json()["id"])
