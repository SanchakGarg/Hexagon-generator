import { loadGeometry } from './urdf.js';
import { deriveLattice, deriveEdge, fitWall, buildNodes, buildEdges, summarize } from './layout.js';
import { renderWall } from './render.js';

const UNITS = { mm: 0.001, cm: 0.01, m: 1, ft: 0.3048 };
const DECIMALS = { mm: 0, cm: 1, m: 3, ft: 2 };
const HINTS = {
  '2d': 'scroll to zoom · drag to pan · double-click to reset',
  '3d': 'drag to orbit · scroll to zoom · right-drag to pan',
};
const MAX_ZOOM = 40;

const $ = (id) => document.getElementById(id);
const widthIn = $('wall-width');
const heightIn = $('wall-height');
const unitIn = $('wall-unit');
const viewport = $('viewport');
const svg = $('stage-svg');
const tip = $('tooltip');
const hint = $('hint');
const btn2d = $('view-2d');
const btn3d = $('view-3d');
let geometry = null;
let lattice = null;
let currentUnit = unitIn.value;
let lastLayout = null;
let view = '2d';
let viewer = null;

// 2D zoom state: the overlay's base viewBox, a zoom factor and the visible center, all in SVG units
let baseBox = null;
let zoom = { scale: 1, cx: 0, cy: 0 };
let zoomKey = '';

const formatLength = (m) => {
  const u = unitIn.value;
  return `${(m / UNITS[u]).toFixed(DECIMALS[u])} ${u}`;
};

function setStat(id, value) {
  $(id).textContent = value;
}

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

function update() {
  const scale = UNITS[unitIn.value];
  const W = parseFloat(widthIn.value) * scale;
  const H = parseFloat(heightIn.value) * scale;
  const note = $('note');
  if (!(W > 0 && H > 0)) {
    note.textContent = 'Enter a width and height greater than zero.';
    return;
  }

  const hexes = fitWall(W, H, lattice);
  const nodes = buildNodes(hexes, lattice);
  const edges = buildEdges(hexes, nodes, lattice, W, H);
  const s = summarize(W, H, hexes, nodes, lattice, edges);
  lastLayout = { W, H, hexes, nodes, edges, lat: lattice };
  baseBox = renderWall(svg, { ...lastLayout, formatLength });
  viewer?.update(lastLayout);
  const key = `${W}x${H}`;
  if (key !== zoomKey) {
    zoomKey = key;
    resetZoom();
  } else {
    applyViewBox();
  }

  setStat('stat-hex', s.hexagons);
  setStat('stat-nodes', s.nodes);
  setStat('stat-3way', s.threeWay);
  setStat('stat-2way', s.twoWay);
  setStat('stat-edge', s.edge);
  setStat('stat-edges', s.edges);
  setStat('stat-joints', s.joints);
  setStat('stat-spare', s.spareFrames);
  setStat('stat-coverage', `${(s.coverage * 100).toFixed(1)}%`);

  if (s.hexagons === 0) {
    note.textContent = `Wall too small. One hexagon needs at least ${formatLength(2 * lattice.hw)} × ${formatLength(2 * lattice.hh)}.`;
  } else if (s.groups > 1) {
    note.textContent = `The fill splits into ${s.groups} separate groups. Widen the wall to link the rows.`;
  } else {
    note.textContent = '';
  }
}

function convertUnit() {
  const factor = UNITS[currentUnit] / UNITS[unitIn.value];
  for (const input of [widthIn, heightIn]) {
    const v = parseFloat(input.value);
    if (v > 0) input.value = +(v * factor).toFixed(DECIMALS[unitIn.value]);
  }
  currentUnit = unitIn.value;
  update();
}

function setView(next) {
  view = next;
  btn2d.setAttribute('aria-pressed', String(next === '2d'));
  btn3d.setAttribute('aria-pressed', String(next === '3d'));
  svg.toggleAttribute('hidden', next !== '2d');
  tip.hidden = true;
  if (viewer) {
    hint.textContent = HINTS[next];
    viewer.setMode(next);
  }
}

btn2d.addEventListener('click', () => setView('2d'));
btn3d.addEventListener('click', () => setView('3d'));

// --- 2D tooltips, zoom and pan ---------------------------------------------

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
  drag = { x: e.clientX, y: e.clientY, cx: zoom.cx, cy: zoom.cy, unitsPerPx: 1 / svg.getScreenCTM().a };
  svg.setPointerCapture(e.pointerId);
});
svg.addEventListener('pointerup', () => {
  drag = null;
  svg.classList.remove('panning');
});
svg.addEventListener('dblclick', () => baseBox && resetZoom());

svg.addEventListener('pointermove', (e) => {
  if (drag) {
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 3) svg.classList.add('panning');
    zoom = { ...zoom, cx: drag.cx - dx * drag.unitsPerPx, cy: drag.cy - dy * drag.unitsPerPx };
    applyViewBox();
    tip.hidden = true;
    return;
  }
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
svg.addEventListener('pointerleave', () => (tip.hidden = true));

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
  if (lastLayout) {
    viewer.update(lastLayout);
    applyViewBox();
  }
  setView(location.hash === '#3d' ? '3d' : view);
}

async function start() {
  if (location.protocol === 'file:') {
    $('note').textContent = 'Open this through the server: run ./hexwall.sh start, then visit http://localhost:8080';
    return;
  }
  try {
    geometry = await loadGeometry(new URL('..', location.href).href.replace(/\/$/, ''));
    lattice = deriveLattice(geometry.hexFrames, geometry.nodeFrames, geometry.nodeBodyRadius);
    lattice.edge = deriveEdge(geometry.edgeFrames, geometry.edgeVisuals, lattice);
  } catch (err) {
    $('note').textContent = `Could not read the URDF files: ${err.message}`;
    return;
  }
  $('geometry').textContent =
    `R ${(lattice.R * 1000).toFixed(1)} mm · node r ${(lattice.r * 1000).toFixed(1)} mm · ` +
    `edge ${(lattice.edge.length * 1000).toFixed(0)} mm · ` +
    `pitch ${(lattice.pitch * 1000).toFixed(1)} × ${(lattice.rowPitch * 1000).toFixed(1)} mm · ` +
    `residual ${(lattice.residual * 1000).toFixed(3)} mm`;

  widthIn.addEventListener('input', update);
  heightIn.addEventListener('input', update);
  unitIn.addEventListener('change', convertUnit);
  svg.classList.add('flat');
  update();
  startViewer();
}

start();
