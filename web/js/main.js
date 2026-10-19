import { loadGeometry } from './urdf.js';
import { deriveLattice, fitWall, buildNodes, summarize } from './layout.js';
import { renderWall } from './render.js';

const UNITS = { mm: 0.001, cm: 0.01, m: 1, ft: 0.3048 };
const DECIMALS = { mm: 0, cm: 1, m: 3, ft: 2 };

const $ = (id) => document.getElementById(id);
const widthIn = $('wall-width');
const heightIn = $('wall-height');
const unitIn = $('wall-unit');
const svg = $('stage-svg');
const tip = $('tooltip');
const stage3d = $('stage-3d');
const hint3d = $('hint-3d');
const btn2d = $('view-2d');
const btn3d = $('view-3d');
let geometry = null;
let lattice = null;
let currentUnit = unitIn.value;
let lastLayout = null;
let view = '2d';
let view3dPromise = null;
let view3d = null;

const formatLength = (m) => {
  const u = unitIn.value;
  return `${(m / UNITS[u]).toFixed(DECIMALS[u])} ${u}`;
};

function setStat(id, value) {
  $(id).textContent = value;
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
  const s = summarize(W, H, hexes, nodes, lattice);
  lastLayout = { W, H, hexes, nodes, lat: lattice };
  renderWall(svg, { ...lastLayout, formatLength });
  if (view3d && view === '3d') view3d.update(lastLayout);

  setStat('stat-hex', s.hexagons);
  setStat('stat-nodes', s.nodes);
  setStat('stat-3way', s.threeWay);
  setStat('stat-2way', s.twoWay);
  setStat('stat-edge', s.edge);
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

async function setView(next) {
  view = next;
  btn2d.setAttribute('aria-pressed', String(next === '2d'));
  btn3d.setAttribute('aria-pressed', String(next === '3d'));
  svg.toggleAttribute('hidden', next !== '2d');
  stage3d.hidden = next !== '3d';
  tip.hidden = true;
  if (next !== '3d') {
    view3d?.setVisible(false);
    return;
  }

  if (!view3dPromise) {
    hint3d.textContent = 'loading your STL meshes…';
    view3dPromise = import('./view3d.js').then((m) => m.createView3D(stage3d, geometry));
  }
  try {
    view3d = await view3dPromise;
  } catch (err) {
    view3dPromise = null;
    hint3d.textContent = `3D view failed to load: ${err.message}`;
    return;
  }
  hint3d.textContent = 'drag to orbit · scroll to zoom · right-drag to pan';
  if (view !== '3d') return;
  view3d.setVisible(true);
  if (lastLayout) view3d.update(lastLayout);
}

btn2d.addEventListener('click', () => setView('2d'));
btn3d.addEventListener('click', () => setView('3d'));

svg.addEventListener('pointermove', (e) => {
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

async function start() {
  if (location.protocol === 'file:') {
    $('note').textContent = 'Open this through the server: run ./hexwall.sh start, then visit http://localhost:8080';
    return;
  }
  try {
    geometry = await loadGeometry(new URL('..', location.href).href.replace(/\/$/, ''));
    lattice = deriveLattice(geometry.hexFrames, geometry.nodeFrames, geometry.nodeBodyRadius);
  } catch (err) {
    $('note').textContent = `Could not read the URDF files: ${err.message}`;
    return;
  }
  $('geometry').textContent =
    `R ${(lattice.R * 1000).toFixed(1)} mm · node r ${(lattice.r * 1000).toFixed(1)} mm · ` +
    `pitch ${(lattice.pitch * 1000).toFixed(1)} × ${(lattice.rowPitch * 1000).toFixed(1)} mm · ` +
    `residual ${(lattice.residual * 1000).toFixed(3)} mm`;

  widthIn.addEventListener('input', update);
  heightIn.addEventListener('input', update);
  unitIn.addEventListener('change', convertUnit);
  btn3d.disabled = false;
  update();
  if (location.hash === '#3d') setView('3d');
}

start();
