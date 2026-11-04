// The backboard cut from stock sheets. The board is the wall's outline grown by a node body (the same shape the
// parts list sizes), lengths in metres on the wall plane: x to the right, z up, seen from the front.
//
// Sheets are laid edge to edge on a grid over the board. The grid is tried with the sheets upright and turned, and
// anchored at each corner of the board, and the layout needing the fewest sheets wins. Each sheet then carries the
// part of the board that falls on it: its cutout.

const EPS = 1e-9;

// positive for a counter-clockwise loop
const areaOf = (loop) => loop.reduce((s, p, i) => {
  const q = loop[(i + 1) % loop.length];
  return s + (p.x * q.z - q.x * p.z) / 2;
}, 0);

// a loop clipped to a rectangle (Sutherland–Hodgman). Where a concave board leaves the sheet and comes back, the
// result runs along the sheet's edge between the two parts, which is the edge of the sheet itself: nothing to cut.
function clip(loop, r) {
  const sides = [
    [(p) => p.x >= r.x0 - EPS, (a, b) => at(a, b, (r.x0 - a.x) / (b.x - a.x))],
    [(p) => p.x <= r.x1 + EPS, (a, b) => at(a, b, (r.x1 - a.x) / (b.x - a.x))],
    [(p) => p.z >= r.z0 - EPS, (a, b) => at(a, b, (r.z0 - a.z) / (b.z - a.z))],
    [(p) => p.z <= r.z1 + EPS, (a, b) => at(a, b, (r.z1 - a.z) / (b.z - a.z))],
  ];
  let out = loop;
  for (const [inside, cross] of sides) {
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const p = src[i];
      const q = src[(i + 1) % src.length];
      const pin = inside(p);
      const qin = inside(q);
      if (pin) out.push(p);
      if (pin !== qin) out.push(cross(p, q));
    }
    if (!out.length) break;
  }
  return tidy(out);
}
const at = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });

// drops repeated points and points on a straight run, so a cut is one line per side
function tidy(loop) {
  const tol = 1e-7;
  let pts = loop.filter((p, i) => {
    const q = loop[(i + 1) % loop.length];
    return Math.hypot(p.x - q.x, p.z - q.z) > tol;
  });
  let changed = true;
  while (changed && pts.length > 2) {
    changed = false;
    const keep = pts.filter((p, i) => {
      const a = pts[(i + pts.length - 1) % pts.length];
      const b = pts[(i + 1) % pts.length];
      const cross = (p.x - a.x) * (b.z - a.z) - (p.z - a.z) * (b.x - a.x);
      return Math.abs(cross) > tol * Math.hypot(b.x - a.x, b.z - a.z);
    });
    if (keep.length !== pts.length) {
      pts = keep;
      changed = true;
    }
  }
  return pts.length >= 3 ? pts : [];
}

// one layout of sheets sw × sh over the board, the grid starting at (ox, oz)
function layout(loops, box, sw, sh, ox, oz) {
  const cols = Math.ceil((box.x1 - ox) / sw - 1e-6);
  const rows = Math.ceil((box.z1 - oz) / sh - 1e-6);
  const cells = [];
  // numbered as read from the front: top row first, left to right
  for (let j = rows - 1; j >= 0; j--) {
    for (let i = 0; i < cols; i++) {
      const r = { x0: ox + i * sw, z0: oz + j * sh, x1: ox + (i + 1) * sw, z1: oz + (j + 1) * sh };
      const pieces = loops.map((l) => clip(l, r)).filter((l) => l.length);
      const area = pieces.reduce((s, l) => s + areaOf(l), 0);
      if (area > sw * sh * 1e-4) cells.push({ ...r, col: i + 1, row: rows - j, pieces, area });
    }
  }
  cells.forEach((c, n) => (c.n = n + 1));
  return { cells, cols, rows };
}

// The fewest sheets of sheetW × sheetH that cover the board. loops: the board's outline loops (holes run the other
// way). Returns the sheets used, each with its cutout, or null when there is no board.
export function planSheets(loops, sheetW, sheetH) {
  const pts = loops.flat();
  if (!pts.length || !(sheetW > 0 && sheetH > 0)) return null;
  const box = {
    x0: Math.min(...pts.map((p) => p.x)),
    x1: Math.max(...pts.map((p) => p.x)),
    z0: Math.min(...pts.map((p) => p.z)),
    z1: Math.max(...pts.map((p) => p.z)),
  };
  const boardArea = loops.reduce((s, l) => s + areaOf(l), 0);
  let best = null;
  for (const turned of [false, true]) {
    const sw = turned ? sheetH : sheetW;
    const sh = turned ? sheetW : sheetH;
    const cols = Math.ceil((box.x1 - box.x0) / sw - 1e-6);
    const rows = Math.ceil((box.z1 - box.z0) / sh - 1e-6);
    // anchored at either side, or centred, in each direction
    const xs = [box.x0, box.x1 - cols * sw, (box.x0 + box.x1 - cols * sw) / 2];
    const zs = [box.z0, box.z1 - rows * sh, (box.z0 + box.z1 - rows * sh) / 2];
    for (const ox of xs) {
      for (const oz of zs) {
        const l = layout(loops, box, sw, sh, ox, oz);
        if (!best || l.cells.length < best.cells.length) best = { ...l, turned, sw, sh, ox, oz };
      }
    }
  }
  return { ...best, count: best.cells.length, box, boardArea, sheetW, sheetH };
}

// --- DXF ---------------------------------------------------------------------------------------------------------

// The cutouts as a DXF (R12, millimetres): every sheet drawn as its outline on layer SHEET with its cutout on layer
// CUT and its number on layer LABEL, set out in the board's own grid with a gap between sheets, so the file is also
// the map of where each piece goes.
export function sheetsDxf(plan, { title = 'Backboard', gapMm = 100 } = {}) {
  const mm = (m) => +(m * 1000).toFixed(3);
  const out = [];
  const add = (...pairs) => {
    for (let i = 0; i < pairs.length; i += 2) out.push(String(pairs[i]), String(pairs[i + 1]));
  };
  add(0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC');
  add(0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER', 70, 3);
  for (const [name, color] of [['SHEET', 8], ['CUT', 1], ['LABEL', 5]]) add(0, 'LAYER', 2, name, 70, 0, 62, color, 6, 'CONTINUOUS');
  add(0, 'ENDTAB', 0, 'ENDSEC');
  add(0, 'SECTION', 2, 'ENTITIES');
  const poly = (layer, pts) => {
    add(0, 'POLYLINE', 8, layer, 66, 1, 70, 1, 10, 0, 20, 0, 30, 0);
    for (const p of pts) add(0, 'VERTEX', 8, layer, 10, p.x, 20, p.y, 30, 0);
    add(0, 'SEQEND', 8, layer);
  };
  const text = (x, y, h, s) => add(0, 'TEXT', 8, 'LABEL', 10, x, 20, y, 30, 0, 40, h, 1, s);
  const gap = gapMm;
  const W = mm(plan.sw);
  const H = mm(plan.sh);
  const textH = Math.max(20, Math.min(W, H) * 0.04);
  for (const c of plan.cells) {
    // where this sheet sits in the drawing: its column and row in the board's grid, spread apart by the gap
    const i = Math.round((c.x0 - plan.ox) / plan.sw);
    const j = Math.round((c.z0 - plan.oz) / plan.sh);
    const bx = i * (W + gap);
    const by = j * (H + gap);
    poly('SHEET', [{ x: bx, y: by }, { x: bx + W, y: by }, { x: bx + W, y: by + H }, { x: bx, y: by + H }]);
    for (const piece of c.pieces) poly('CUT', piece.map((p) => ({ x: +(bx + mm(p.x - c.x0)).toFixed(3), y: +(by + mm(p.z - c.z0)).toFixed(3) })));
    text(bx + textH * 0.6, by + H - textH * 1.6, textH, `${title} sheet ${c.n} of ${plan.count}`);
  }
  add(0, 'ENDSEC', 0, 'EOF');
  return out.join('\n') + '\n';
}
