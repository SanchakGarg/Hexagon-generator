import { loadGeometry } from './urdf.js';
import { deriveLattice, deriveEdge, fitWall, centerKept, buildNodes, buildEdges, buildOutline, offsetLoop, summarize, partsOf } from './layout.js';
import { renderWall } from './render.js';
import { initTheme, initSections } from './prefs.js';

const UNITS = { mm: 0.001, m: 1, in: 0.0254 };
const DECIMALS = { mm: 0, m: 3, in: 1 };
const HINTS = {
  '2d': 'hover to lift · click to select · scroll to zoom · drag to pan · double-click to reset',
  '3d': 'hover to lift · click to select · drag to orbit · scroll to zoom · right-drag to pan',
};
const MAX_ZOOM = 40;
const CLICK_SLOP = 4; // px a pointer may move and still count as a click

const $ = (id) => document.getElementById(id);
const widthIn = $('wall-width');
const heightIn = $('wall-height');
const thicknessIn = $('board-thickness');
const raiseIn = $('board-raise');
const unitButtons = [...document.querySelectorAll('#units [data-unit]')];
const viewport = $('viewport');
const svg = $('stage-svg');
const tip = $('tooltip');
const hexCard = $('hex-card');
const hint = $('hint');
const btn2d = $('view-2d');
const btn3d = $('view-3d');
const excludeBtn = $('exclude-btn');
const clearBtn = $('clear-btn');
const restoreBtn = $('restore-btn');
const boardToggle = $('board-toggle');
const pickBar = $('pick-bar');
const layerButtons = [...document.querySelectorAll('#layers [data-layer]')];
const groupButtons = [...document.querySelectorAll('#layers [data-group]')];
let geometry = null;
let lattice = null;
let unit = 'm';
let lastLayout = null;
let view = '2d';
let viewer = null;
let boardOn = true;

// hexagons are tracked by grid position, so a selection survives small wall edits
const keyOf = (h) => `${h.row}:${h.col}`;
const selected = new Set();
const excluded = new Set();

// which kinds of part are drawn; hidden parts still count and hexagons stay clickable
const LAYERS = layerButtons.map((b) => b.dataset.layer);
const show = Object.fromEntries(LAYERS.map((l) => [l, true]));
let gridHexes = [];

// 2D zoom state: the overlay's base viewBox, a zoom factor and the visible center, all in SVG units
let baseBox = null;
let zoom = { scale: 1, cx: 0, cy: 0 };
let zoomKey = '';

const formatLength = (m) => `${(m / UNITS[unit]).toFixed(DECIMALS[unit])} ${unit}`;

function applyViewBox() {
  if (!baseBox) return;
  const w = baseBox.w / zoom.scale;
  const h = baseBox.h / zoom.scale;
  const box = { x: zoom.cx - w / 2, y: zoom.cy - h / 2, w, h };
  svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
  viewer?.setViewBox(box);
}

function resetZoom() {
  zoom = { scale: 1, cx: baseBox.x + baseBox.w / 2, cy: baseBox.y + baseBox.h / 2 };
  applyViewBox();
}

// selection and exclusion live in a strip on the drawing, shown only while there is something to act on
function renderPicks() {
  const sel = gridHexes.filter((h) => selected.has(keyOf(h))).length;
  const exc = gridHexes.filter((h) => excluded.has(keyOf(h))).length;
  $('selected-count').textContent = sel;
  $('excluded-count').textContent = exc;
  for (const el of [$('pick-selected'), excludeBtn, clearBtn]) el.hidden = sel === 0;
  for (const el of [$('pick-excluded'), restoreBtn]) el.hidden = exc === 0;
  pickBar.hidden = sel === 0 && exc === 0;
  hint.classList.toggle('pushed', !pickBar.hidden);
}

function update() {
  const scale = UNITS[unit];
  const W = parseFloat(widthIn.value) * scale;
  const H = parseFloat(heightIn.value) * scale;
  const note = $('note');
  if (!(W > 0 && H > 0)) {
    note.textContent = 'Enter a width and height greater than zero.';
    return;
  }
  const t = parseFloat(thicknessIn.value) * scale;
  const raise = parseFloat(raiseIn.value) * scale;
  if (boardOn && !(t > 0 && raise >= 0)) {
    note.textContent = 'Enter a board thickness above zero and a raise of zero or more.';
    return;
  }

  // re-centre on what is left, so excluding hexagons doesn't leave the assembly off to one side
  gridHexes = centerKept(fitWall(W, H, lattice), (h) => !excluded.has(keyOf(h)), W, H);
  const hexes = gridHexes.filter((h) => !excluded.has(keyOf(h)));
  const removed = gridHexes.filter((h) => excluded.has(keyOf(h)));
  for (const key of [...selected]) if (!hexes.some((h) => keyOf(h) === key)) selected.delete(key);
  const selectedIds = new Set(hexes.filter((h) => selected.has(keyOf(h))).map((h) => h.id));

  const nodes = buildNodes(hexes, lattice);
  const edges = buildEdges(hexes, nodes, lattice);
  const s = summarize(hexes, nodes, lattice, edges);
  const outline = buildOutline(hexes, lattice);
  lastLayout = { W, H, hexes, nodes, edges, lat: lattice, board: { on: boardOn, t, raise }, outline };
  baseBox = renderWall(svg, { ...lastLayout, excluded: removed, selected: selectedIds, formatLength });
  if (hoveredId && !hexes.some((h) => h.id === hoveredId)) hoveredId = null;
  if (hoveredId) svg.querySelector(`[data-hex="${hoveredId}"]`)?.classList.add('hovered');
  showHexCard(hoveredId);
  viewer?.update(lastLayout);
  viewer?.setSelected(selectedIds);
  const key = `${W}x${H}`;
  // refit when the wall changes, or when the drawing grew or shrank while the view wasn't zoomed
  if (key !== zoomKey || zoom.scale === 1) {
    zoomKey = key;
    resetZoom();
  } else {
    applyViewBox();
  }
  renderPicks();

  for (const el of document.querySelectorAll('#layers [data-count]')) el.textContent = s.counts[el.dataset.count];
  $('total-nodes').textContent = s.counts.nodes;
  $('total-leds').textContent = s.counts.leds;
  // the board follows the outline, grown so the node bodies sit on it
  const rim = outline.flatMap((loop) => offsetLoop(loop, lattice.rho));
  const span = (k) => Math.max(...rim.map((p) => p[k])) - Math.min(...rim.map((p) => p[k]));
  $('board-size').textContent = boardOn && rim.length ? `board ${formatLength(span('x'))} × ${formatLength(span('z'))}` : '';

  if (gridHexes.length === 0) {
    note.textContent = `Wall too small. One hexagon needs at least ${formatLength(2 * lattice.hw)} × ${formatLength(2 * lattice.hh)}.`;
  } else if (s.hexagons === 0) {
    note.textContent = 'Every hexagon is excluded. Restore some to build the wall.';
  } else if (s.groups > 1) {
    note.textContent = `The fill splits into ${s.groups} separate groups. Restore or widen to link them.`;
  } else {
    note.textContent = '';
  }
}

function setUnit(next) {
  if (next === unit) return;
  const factor = UNITS[unit] / UNITS[next];
  for (const input of [widthIn, heightIn, thicknessIn, raiseIn]) {
    const v = parseFloat(input.value);
    if (v > 0) input.value = +(v * factor).toFixed(DECIMALS[next]);
  }
  unit = next;
  for (const b of unitButtons) b.setAttribute('aria-pressed', String(b.dataset.unit === next));
  for (const el of document.querySelectorAll('[data-unit-label]')) el.textContent = next;
  update();
}

for (const b of unitButtons) b.addEventListener('click', () => setUnit(b.dataset.unit));

// one hovered hexagon drives both the mesh ripple and the overlay (its label fades)
let hoveredId = null;
function hover(id) {
  if (id === hoveredId) return;
  hoveredId = id;
  for (const el of svg.querySelectorAll('.hex.hovered')) el.classList.remove('hovered');
  if (id) svg.querySelector(`[data-hex="${id}"]`)?.classList.add('hovered');
  viewer?.setHover(id);
  showHexCard(id);
}

// the nodes and LEDs one hexagon brings: its own, those of its Edges, and the joining nodes it owns
function showHexCard(id) {
  const h = id && lastLayout?.hexes.find((x) => x.id === id);
  if (!h) {
    hexCard.hidden = true;
    return;
  }
  const { nodes, edges, lat } = lastLayout;
  const own = edges.filter((e) => e.hexId === id).length;
  const rows = [
    ['nodes', lat.perHex.nodes + own * lat.perEdge.nodes + nodes.filter((n) => n.hexId === id).length],
    ['LEDs', lat.perHex.leds + own * lat.perEdge.leds],
  ];
  const title = document.createElement('p');
  title.className = 'hex-card-title';
  title.textContent = h.id;
  const dl = document.createElement('dl');
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    row.append(dt, dd);
    dl.append(row);
  }
  hexCard.replaceChildren(title, dl);
  hexCard.hidden = false;
}

// placed hexagon whose outline contains a wall point, so channels and the gaps between them all count; a node and
// an Edge count as part of the hexagon they belong to
function hexAt(p) {
  if (!p || !lastLayout) return null;
  const { R } = lattice;
  const node = lastLayout.nodes.find((n) => Math.hypot(p.x - n.x, p.z - n.z) <= lattice.rho);
  if (node) return node.hexId;
  const half = (R * Math.sqrt(3)) / 2;
  for (const h of lastLayout.hexes) {
    const dx = Math.abs(p.x - h.x);
    const dz = Math.abs(p.z - h.z);
    if (dx <= half && dz <= R - dx / Math.sqrt(3)) return h.id;
  }
  for (const e of lastLayout.edges) {
    const vx = e.tipX - e.x;
    const vz = e.tipZ - e.z;
    const t = Math.max(0, Math.min(1, ((p.x - e.x) * vx + (p.z - e.z) * vz) / (vx * vx + vz * vz)));
    if (Math.hypot(p.x - (e.x + t * vx), p.z - (e.z + t * vz)) <= lattice.rho) return e.hexId;
  }
  return null;
}

// SVG overlay coordinates have y running down from the wall's top edge
const wallFromSvg = (e) => {
  const p = svgPoint(e);
  return { x: p.x, z: lastLayout.H - p.y };
};

function toggleSelect(id) {
  const h = gridHexes.find((g) => g.id === id);
  if (!h) return;
  const key = keyOf(h);
  if (selected.has(key)) selected.delete(key);
  else selected.add(key);
  update();
}

excludeBtn.addEventListener('click', () => {
  for (const key of selected) excluded.add(key);
  selected.clear();
  hover(null);
  update();
});
clearBtn.addEventListener('click', () => {
  selected.clear();
  update();
});
restoreBtn.addEventListener('click', () => {
  excluded.clear();
  update();
});

function setView(next) {
  view = next;
  btn2d.setAttribute('aria-pressed', String(next === '2d'));
  btn3d.setAttribute('aria-pressed', String(next === '3d'));
  tip.hidden = true;
  if (!viewer) {
    svg.toggleAttribute('hidden', next !== '2d');
    return;
  }
  // the overlay leaves as the camera starts to fly and comes back once it has landed on the front view
  if (next === '3d') svg.toggleAttribute('hidden', true);
  hint.textContent = HINTS[next];
  hover(null);
  viewer.setMode(next).then(() => {
    if (view === '2d') svg.toggleAttribute('hidden', false);
  });
}

// a group shows ticked when all its kinds are on, half-ticked when only some are
const groupLayers = (g) => [...document.querySelectorAll(`[data-group-of="${g}"] [data-layer]`)].map((b) => b.dataset.layer);

function applyLayers() {
  for (const b of layerButtons) b.setAttribute('aria-pressed', String(show[b.dataset.layer]));
  for (const b of groupButtons) {
    const on = groupLayers(b.dataset.group).map((l) => show[l]);
    b.setAttribute('aria-pressed', on.every(Boolean) ? 'true' : on.some(Boolean) ? 'mixed' : 'false');
  }
  for (const l of LAYERS) svg.classList.toggle(`hide-${l}`, !show[l]);
  viewer?.setShow(show);
}

for (const b of layerButtons) {
  b.addEventListener('click', () => {
    show[b.dataset.layer] = !show[b.dataset.layer];
    applyLayers();
  });
}
for (const b of groupButtons) {
  b.addEventListener('click', () => {
    const layers = groupLayers(b.dataset.group);
    const next = !layers.every((l) => show[l]);
    for (const l of layers) show[l] = next;
    applyLayers();
  });
}
$('show-all-btn').addEventListener('click', () => {
  for (const l of LAYERS) show[l] = true;
  applyLayers();
});
$('hide-all-btn').addEventListener('click', () => {
  for (const l of LAYERS) show[l] = false;
  applyLayers();
});

// the switch sits in the card's title row, so it must not also fold the card
boardToggle.addEventListener('click', (e) => {
  e.preventDefault();
  boardOn = !boardOn;
  boardToggle.setAttribute('aria-checked', String(boardOn));
  for (const input of [thicknessIn, raiseIn]) input.disabled = !boardOn;
  $('board-body').classList.toggle('off', !boardOn);
  update();
});

btn2d.addEventListener('click', () => setView('2d'));
btn3d.addEventListener('click', () => setView('3d'));

// --- 2D: tooltips, hover, click, zoom and pan --------------------------------

function svgPoint(e) {
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
  return { x: p.x, y: p.y };
}

svg.addEventListener(
  'wheel',
  (e) => {
    if (!baseBox) return;
    e.preventDefault();
    const p = svgPoint(e);
    const next = Math.min(MAX_ZOOM, Math.max(1, zoom.scale * Math.exp(-e.deltaY * 0.0015)));
    const k = zoom.scale / next;
    zoom = { scale: next, cx: p.x + (zoom.cx - p.x) * k, cy: p.y + (zoom.cy - p.y) * k };
    applyViewBox();
  },
  { passive: false },
);

let drag = null;
svg.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !baseBox) return;
  drag = { x: e.clientX, y: e.clientY, cx: zoom.cx, cy: zoom.cy, unitsPerPx: 1 / svg.getScreenCTM().a, moved: false, target: e.target, point: wallFromSvg(e) };
  try {
    svg.setPointerCapture(e.pointerId);
  } catch {
    // capture is only a convenience for dragging past the edge
  }
});
svg.addEventListener('pointerup', () => {
  const was = drag;
  drag = null;
  svg.classList.remove('panning');
  if (!was || was.moved) return;
  // pointer capture retargets events to the svg, so use the element pressed on
  const ghost = was.target.closest('[data-ghost]');
  const id = hexAt(was.point);
  if (id) {
    toggleSelect(id);
  } else if (ghost) {
    const h = gridHexes.find((g) => g.id === ghost.dataset.ghost);
    if (h) excluded.delete(keyOf(h));
    update();
  }
});
svg.addEventListener('dblclick', () => baseBox && resetZoom());

svg.addEventListener('pointermove', (e) => {
  if (drag) {
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > CLICK_SLOP) {
      drag.moved = true;
      svg.classList.add('panning');
      hover(null);
    }
    if (drag.moved) {
      zoom = { ...zoom, cx: drag.cx - dx * drag.unitsPerPx, cy: drag.cy - dy * drag.unitsPerPx };
      applyViewBox();
      tip.hidden = true;
    }
    return;
  }
  hover(hexAt(wallFromSvg(e)));
  const target = e.target.closest('[data-tip]');
  if (!target) {
    tip.hidden = true;
    return;
  }
  tip.textContent = target.dataset.tip;
  tip.hidden = false;
  const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  const y = Math.min(e.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
  tip.style.transform = `translate(${x}px, ${y}px)`;
});
svg.addEventListener('pointerleave', () => {
  tip.hidden = true;
  hover(null);
});

// --- 3D: hover and click by raycasting the hexagon meshes ---------------------

function wire3d(canvas) {
  let press = null;
  canvas.addEventListener('pointerdown', (e) => {
    press = { x: e.clientX, y: e.clientY, button: e.button };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (view !== '3d' || e.buttons) return;
    hover(hexAt(viewer.wallPoint(e.clientX, e.clientY)));
  });
  canvas.addEventListener('pointerup', (e) => {
    const p = press;
    press = null;
    if (view !== '3d' || !p || p.button !== 0) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_SLOP) return;
    const id = hexAt(viewer.wallPoint(e.clientX, e.clientY));
    if (id) toggleSelect(id);
  });
  canvas.addEventListener('pointerleave', () => hover(null));
}

// --- startup ---------------------------------------------------------------

async function startViewer() {
  try {
    const { createViewer } = await import('./viewer.js');
    viewer = await createViewer(viewport, geometry);
  } catch (err) {
    // without meshes the overlay draws plain outlines instead
    svg.classList.add('flat');
    hint.textContent = `Could not render the STL meshes (${err.message}). Showing outlines.`;
    return;
  }
  svg.classList.remove('flat');
  btn3d.disabled = false;
  wire3d(viewer.canvas);
  viewer.setShow(show);
  if (lastLayout) update();
  setView(location.hash === '#3d' ? '3d' : view);
}

initSections();
initTheme(() => viewer?.setTheme());

async function start() {
  if (location.protocol === 'file:') {
    $('note').textContent = 'Open this through the server: run ./hexwall.sh start, then visit http://localhost:8080';
    return;
  }
  try {
    geometry = await loadGeometry(new URL('..', location.href).href.replace(/\/$/, ''));
    lattice = deriveLattice(geometry.hexFrames, geometry.nodeFrames, geometry.nodeBodyRadius);
    lattice.edge = deriveEdge(geometry.edgeFrames, geometry.edgeVisuals, lattice);
    lattice.perHex = partsOf(geometry.hexVisuals);
    lattice.perEdge = partsOf(geometry.edgeVisuals);
  } catch (err) {
    $('note').textContent = `Could not read the URDF files: ${err.message}`;
    return;
  }
  widthIn.addEventListener('input', update);
  heightIn.addEventListener('input', update);
  thicknessIn.addEventListener('input', update);
  raiseIn.addEventListener('input', update);
  svg.classList.add('flat');
  update();
  startViewer();
}

start();
