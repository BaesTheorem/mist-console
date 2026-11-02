/* ---------- Cooking for Engineers layout ----------
   The recipe card's table view. A recipe's optional "cfe" field holds the tree
   (contract: Exobrain harness recipes/recipekit/model.py):
     {"before": [str], "ops": [{"op": str, "in": [int | "@k"], "timer": sec, "name": str}]}
   An int input is an ingredient index (the flattened list, groups in order, the
   same index the card's checkboxes use); "@k" is the result of op k; the last
   op is the finished dish.

   The layout matches recipe_grid, which draws the vault tables: ingredients
   down the left in input order, each op in the column equal to its height,
   spanning the rows of its leaves, and stretched right (colspan) to the column
   of the op it feeds. tests/test_cfe_layout.py runs these functions in node
   and compares them cell for cell with recipe_grid.

   Pure functions, no DOM. Tolerant like the harness's model.forest(): a bad or
   forward input is dropped, an op with no inputs left is dropped, and anything
   that feeds nothing becomes its own root, so a card always has a table to
   show while the harness's validator names the problem. */
(function (root) {
  "use strict";

  function flatIngredients(list) {
    const out = [];
    (Array.isArray(list) ? list : []).forEach((it) => {
      if (it && typeof it === "object" && Array.isArray(it.items)) it.items.forEach((x) => out.push(String(x)));
      else out.push(String(it));
    });
    return out;
  }

  function cfeRef(x) {
    if (typeof x === "number" && Number.isInteger(x)) return ["ing", x];
    if (typeof x === "string") {
      const s = x.trim();
      const m = s.match(/^@(\d+)$/);
      if (m) return ["op", Number(m[1])];
      if (/^\d+$/.test(s)) return ["ing", Number(s)];
    }
    return null;
  }

  function cfeOps(obj) {
    const cfe = obj && obj.cfe;
    return cfe && typeof cfe === "object" && Array.isArray(cfe.ops) ? cfe.ops : [];
  }

  function cfeForest(obj) {
    const ings = flatIngredients(obj && obj.ingredients);
    const ops = cfeOps(obj);
    const built = [];
    const fed = new Set();
    const used = new Set();
    ops.forEach((op, k) => {
      if (!op || typeof op !== "object") { built.push(null); return; }
      const t = op.timer;
      const node = {
        kind: "op", index: k, label: String(op.op || "").trim() || "?", children: [],
        timer: Number.isInteger(t) && t > 0 ? t : null,
      };
      (Array.isArray(op.in) ? op.in : []).forEach((x) => {
        const ref = cfeRef(x);
        if (!ref) return;
        const i = ref[1];
        if (ref[0] === "ing" && i >= 0 && i < ings.length) {
          node.children.push({ kind: "ing", index: i, label: ings[i], children: [] });
          used.add(i);
        } else if (ref[0] === "op" && i >= 0 && i < k && built[i]) {
          node.children.push(built[i]);
          fed.add(i);
        }
      });
      built.push(node.children.length ? node : null);
    });
    const roots = [];
    let last = null;
    for (let k = built.length - 1; k >= 0; k--) if (built[k]) { last = built[k]; break; }
    if (last) roots.push(last);
    built.forEach((n, k) => { if (n && n !== last && !fed.has(k)) roots.push(n); });
    if (ops.length) ings.forEach((label, i) => { if (!used.has(i)) roots.push({ kind: "ing", index: i, label, children: [] }); });
    return roots;
  }

  // [{rows, cols, cells: [{r, c, rs, cs, kind, index, text, timer}]}], one table per root.
  function cfeLayout(obj) {
    return cfeForest(obj).map((rootNode) => {
      const heights = new Map();
      const height = (n) => {
        if (n.kind === "ing") return 0;
        if (!heights.has(n)) heights.set(n, 1 + Math.max(...n.children.map(height)));
        return heights.get(n);
      };
      const cols = height(rootNode) + 1;
      const cells = [];
      let row = 0;
      const walk = (n, parentCol) => {
        const col = height(n);
        const top = row;
        if (n.kind === "ing") row += 1;
        else n.children.forEach((c) => walk(c, col));
        cells.push({ r: top, c: col, rs: row - top, cs: parentCol - col, kind: n.kind,
                     index: n.index, text: n.label, timer: n.timer || null });
      };
      walk(rootNode, cols);
      cells.sort((a, b) => a.r - b.r || a.c - b.c);
      return { rows: row, cols, cells };
    });
  }

  // True when the recipe has at least one usable op (the card shows its toggle).
  function cfeUsable(obj) {
    return cfeForest(obj).some((n) => n.kind === "op");
  }

  function cfeBefore(obj) {
    const b = obj && obj.cfe && obj.cfe.before;
    return Array.isArray(b) ? b.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : [];
  }

  const api = { flatIngredients, cfeRef, cfeForest, cfeLayout, cfeUsable, cfeBefore };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else Object.assign(root, api);
})(this);
