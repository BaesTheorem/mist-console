"""Embeds from project folders render; other files there stay unreachable."""
import os

import embeds


def _touch(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write("x")


def test_media_root_serves_media_only(tmp_path, monkeypatch):
    root = os.path.realpath(str(tmp_path / "Documents"))
    monkeypatch.setattr(embeds, "MEDIA_ROOTS", [root])
    png = os.path.join(root, "kc311", "analysis", "report.png")
    html = os.path.join(root, "kc311", "analysis", "report.html")
    doc = os.path.join(root, "taxes", "return.docx")
    txt = os.path.join(root, "notes.txt")
    hidden = os.path.join(root, ".ssh", "id.png")
    for p in (png, html, doc, txt, hidden):
        _touch(p)
    assert embeds.safe_path(png) == png
    assert embeds.safe_path(html) == html
    assert embeds.safe_path(doc) is None
    assert embeds.safe_path(txt) is None
    assert embeds.safe_path(hidden) is None


def test_full_roots_unchanged():
    harness = next(r for r in embeds.ROOTS if r.endswith("Exobrain harness"))
    assert embeds.safe_path(os.path.join(harness, ".env"), must_exist=False) is None
