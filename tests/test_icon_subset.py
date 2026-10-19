"""The cut icon font must hold every icon name the UI uses.

static/vendor/MaterialSymbolsSharp.subset.woff carries only the icons that
appear as words in static/; an icon added without a rebuild would show as
plain text. bin/subset-icons --check names any that are missing.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


@pytest.mark.skipif(shutil.which("uv") is None, reason="bin/subset-icons runs through uv")
def test_subset_covers_every_icon_in_use():
    r = subprocess.run([str(ROOT / "bin" / "subset-icons"), "--check"], capture_output=True, text=True, timeout=300)
    assert r.returncode == 0, r.stderr or r.stdout
