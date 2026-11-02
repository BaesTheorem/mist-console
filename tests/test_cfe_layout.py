"""static/cfe.js lays out the recipe card's Cooking for Engineers table.

The vault draws the same tables with recipe_grid (Exobrain harness,
recipes/bin/recipe layout), so the two must agree cell for cell. The fixed
cases below pin the rules without the harness; the oracle test runs only when
the harness CLI and uv are present.
"""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
HARNESS = Path.home() / "Documents" / "Exobrain harness" / "recipes" / "bin" / "recipe"
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="needs node")

BREAD = {
    "title": "Bread",
    "ingredients": ["2 bananas", "6 tbsp butter", "1 tsp vanilla",
                    {"group": "Dry", "items": ["1 1/3 cups flour", "1/2 tsp salt"]}, "1/2 cup walnuts"],
    "steps": ["x"],
    "cfe": {"before": ["Preheat the oven"], "ops": [
        {"op": "mash", "in": [0]}, {"op": "melt", "in": [1]},
        {"op": "stir", "in": ["@0", "@1", 2], "name": "wet mix"},
        {"op": "whisk", "in": [3, 4]},
        {"op": "fold", "in": ["@2", "@3", 5]},
        {"op": "bake 55 min", "in": ["@4"], "timer": 3300}]},
}
LOOSE = {"ingredients": ["a", "b", "c"], "cfe": {"ops": [{"op": "mix", "in": [0, "@5", "junk"]}, {"op": "", "in": []}]}}


def node(fn, obj):
    script = ("const c = require(process.argv[1]); const o = JSON.parse(process.argv[2]);"
              f"process.stdout.write(JSON.stringify(c.{fn}(o)));")
    r = subprocess.run(["node", "-e", script, str(ROOT / "static" / "cfe.js"), json.dumps(obj)],
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def cells(tables):
    return [sorted((c["r"], c["c"], c["rs"], c["cs"], c["kind"], c["index"]) for c in t["cells"]) for t in tables]


def test_bread_layout_rules():
    [t] = node("cfeLayout", BREAD)
    assert (t["rows"], t["cols"]) == (6, 5)
    at = {(c["r"], c["c"]): c for c in t["cells"]}
    assert at[(0, 2)]["text"] == "stir" and at[(0, 2)]["rs"] == 3
    assert at[(2, 0)]["cs"] == 2 and at[(3, 1)]["cs"] == 2 and at[(5, 0)]["cs"] == 3
    assert at[(0, 4)]["timer"] == 3300 and at[(0, 4)]["rs"] == 6


def test_loose_parts_become_roots_and_bad_inputs_drop():
    tables = node("cfeLayout", LOOSE)
    assert [len(t["cells"]) for t in tables] == [2, 1, 1]       # mix(a), then loose b and c
    assert node("cfeUsable", LOOSE) is True
    assert node("cfeUsable", {"ingredients": ["a"]}) is False
    assert node("cfeBefore", BREAD) == ["Preheat the oven"]


@pytest.mark.skipif(not HARNESS.exists() or shutil.which("uv") is None, reason="needs the harness recipe CLI")
@pytest.mark.parametrize("obj", [BREAD, LOOSE])
def test_matches_recipe_grid(obj, tmp_path):
    f = tmp_path / "r.json"
    f.write_text(json.dumps(obj))
    r = subprocess.run([str(HARNESS), "layout", "--file", str(f)], capture_output=True, text=True, timeout=300)
    assert r.returncode == 0, r.stderr
    assert cells(node("cfeLayout", obj)) == cells(json.loads(r.stdout))
