import { loadGeometry } from './urdf.js';
import { deriveLattice, deriveEdge, fitWall, centerKept, buildNodes, buildEdges, buildOutline, offsetLoop, summarize, partsOf, placeAllNodes } from './layout.js';
import { renderWall } from './render.js';
import { initTheme, initSections, loadSaves, storeSaves } from './prefs.js';

const UNITS = { mm: 0.001, m: 1, in: 0.0254 };
const DECIMALS = { mm: 0, m: 3, in: 1 };
const HINTS = {
  '2d': 'Hover to lift · click to select · scroll to zoom · drag to pan · double-click to reset',
  '3d': 'Hover to lift · click to select · drag to orbit · scroll to zoom · right-drag to pan',
  parts: 'Click nodes to pick them · scroll to zoom · drag to pan · double-click to reset',
};
const PAGES = ['Configure', 'Parts list'];
// LED strip: each channel holds 15 LEDs, the strip has 60 per metre and comes in 5 m rolls
const LEDS_PER_CHANNEL = 15;
const LEDS_PER_M = 60;
const ROLL_M = 5;
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
let page = 1;

// hexagons are tracked by grid position, so a selection survives small wall edits
const keyOf = (h) => `${h.row}:${h.col}`;
const selected = new Set();
const excluded = new Set();
// on the parts page single nodes are picked, and some can be built without a touch sensor
const nodePicks = new Set();
const noSensor = new Set();
let allNodes = [];

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

// selection and exclusion live in a strip on the drawing, shown only while there is something to act on; on the
// parts page the same strip picks nodes and leaves their touch sensors out
function renderPicks() {
  const parts = page === 2;
  const present = new Set(allNodes.map((n) => n.key));
  const sel = parts ? nodePicks.size : gridHexes.filter((h) => selected.has(keyOf(h))).length;
  const exc = parts ? [...noSensor].filter((k) => present.has(k)).length : gridHexes.filter((h) => excluded.has(keyOf(h))).length;
  $('selected-count').textContent = sel;
  $('excluded-count').textContent = exc;
  $('selected-label').textContent = parts ? `node${sel === 1 ? '' : 's'} picked` : 'selected';
  $('excluded-label').textContent = parts ? 'without touch sensor' : 'excluded';
  excludeBtn.textContent = parts ? 'No touch sensor' : 'Exclude';
  restoreBtn.textContent = parts ? 'Add sensors back' : 'Restore all';
  for (const el of [$('pick-selected'), excludeBtn, clearBtn]) el.hidden = sel === 0;
  for (const el of [$('pick-excluded'), restoreBtn]) el.hidden = exc === 0;
  pickBar.hidden = sel === 0 && exc === 0;
  hint.classList.toggle('pushed', !pickBar.hidden);
}

// what to buy for the wall as it stands
function renderBom(s, hexes, edges, rim) {
  const present = new Set(allNodes.map((n) => n.key));
  const skipped = [...noSensor].filter((k) => present.has(k)).length;
  const pixels = s.counts.leds * LEDS_PER_CHANNEL;
  const metres = pixels / LEDS_PER_M;
  const span = (k) => Math.max(...rim.map((p) => p[k])) - Math.min(...rim.map((p) => p[k]));
  const rows = [
    [hexes.length, 'Hexagon panels'],
    [edges.length, 'Edge pieces'],
    [s.counts.edge, 'Edge nodes'],
    [s.counts['2way'], '2-way nodes'],
    [s.counts['3way'], '3-way nodes'],
    [s.counts.nodes - skipped, 'Touch sensors', skipped ? `1 per node, ${skipped} left out` : '1 per node'],
    [Math.ceil(pixels / (LEDS_PER_M * ROLL_M)), `LED strip rolls (${ROLL_M} m)`, `${pixels} LEDs · ${+metres.toFixed(2)} m at ${LEDS_PER_M}/m`],
    [hexes.length, 'ESP32 Ethernet boards', '1 per hexagon · WT32-ETH01 works'],
  ];
  if (boardOn && rim.length) rows.push([1, 'Backboard', `${formatLength(span('x'))} × ${formatLength(span('z'))}`]);
  // written like a note: what, then how many at the end of the line, with any working in small print beneath
  $('bom').replaceChildren(
    ...rows
      .filter(([n]) => n > 0)
      .map(([n, label, note]) => {
        const line = document.createElement('p');
        line.className = 'line';
        const what = document.createElement('span');
        what.textContent = label;
        if (note) {
          const small = document.createElement('small');
          small.textContent = note;
          what.append(small);
        }
        const b = document.createElement('b');
        b.textContent = n;
        line.append(what, b);
        return line;
      }),
  );
}

function update() {
  refreshTabStates();
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
  allNodes = gridHexes.length ? placeAllNodes(hexes, nodes, edges, lattice, gridHexes[0]) : [];
  const present = new Set(allNodes.map((n) => n.key));
  for (const key of [...nodePicks]) if (!present.has(key)) nodePicks.delete(key);
  const picks = page === 2 ? { nodes: allNodes, selected: nodePicks, noSensor } : null;
  baseBox = renderWall(svg, { ...lastLayout, excluded: removed, selected: selectedIds, formatLength, picks });
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
  $('tally-nodes').textContent = s.counts.nodes;
  $('tally-leds').textContent = s.counts.leds;
  // the board follows the outline, grown so the node bodies sit on it
  const rim = outline.flatMap((loop) => offsetLoop(loop, lattice.rho));
  const span = (k) => Math.max(...rim.map((p) => p[k])) - Math.min(...rim.map((p) => p[k]));
  $('board-size').textContent = boardOn && rim.length ? `Board ${formatLength(span('x'))} × ${formatLength(span('z'))}` : '';
  renderBom(s, hexes, edges, rim);

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
    ['Nodes', lat.perHex.nodes + own * lat.perEdge.nodes + nodes.filter((n) => n.hexId === id).length],
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

// the node whose body holds a wall point, on the parts page
function nodeAt(p) {
  if (!p) return null;
  let best = null;
  for (const n of allNodes) {
    const d = Math.hypot(p.x - n.x, p.z - n.z);
    if (d <= lattice.rho * 1.6 && (!best || d < best.d)) best = { key: n.key, d };
  }
  return best?.key ?? null;
}

function togglePick(key) {
  if (nodePicks.has(key)) nodePicks.delete(key);
  else nodePicks.add(key);
  update();
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
  if (page === 2) {
    for (const key of nodePicks) noSensor.add(key);
    nodePicks.clear();
    update();
    return;
  }
  for (const key of selected) excluded.add(key);
  selected.clear();
  hover(null);
  update();
});
clearBtn.addEventListener('click', () => {
  nodePicks.clear();
  selected.clear();
  update();
});
restoreBtn.addEventListener('click', () => {
  if (page === 2) noSensor.clear();
  else excluded.clear();
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
  hint.textContent = page === 2 ? HINTS.parts : HINTS[next];
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
  refreshTabStates();
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
function setBoard(on) {
  boardOn = on;
  boardToggle.setAttribute('aria-checked', String(boardOn));
  for (const input of [thicknessIn, raiseIn]) input.disabled = !boardOn;
  $('board-body').classList.toggle('off', !boardOn);
}
boardToggle.addEventListener('click', (e) => {
  e.preventDefault();
  setBoard(!boardOn);
  update();
});

// --- pages: configure the wall, then the parts list ----------------------------

const app = document.querySelector('.app');
const backBtn = $('back-btn');
const nextBtn = $('next-btn');

function setPage(next) {
  page = next;
  app.dataset.page = String(page);
  $('page-count').textContent = `Page ${page} of ${PAGES.length} · ${PAGES[page - 1]}`;
  backBtn.hidden = page === 1;
  nextBtn.hidden = page === PAGES.length;
  // each page picks its own things
  selected.clear();
  nodePicks.clear();
  hover(null);
  // until the meshes are in, the hint says they are loading
  if (viewer) hint.textContent = page === 2 ? HINTS.parts : HINTS[view];
  if (lattice) update();
}
backBtn.addEventListener('click', () => setPage(page - 1));
nextBtn.addEventListener('click', () => setPage(page + 1));

// --- tabs: each one an open design, like browser tabs; saves keep them in this browser -------

const saveDialog = $('save-dialog');
const saveName = $('save-name');
const saveError = $('save-error');
const tabList = $('tab-list');
const tabPlus = $('tab-plus');
const tabMenu = $('tab-menu');
let statusTimer = 0;

function status(text) {
  $('save-status').textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => ($('save-status').textContent = ''), 4000);
}

const snapshot = () => ({
  unit,
  width: widthIn.value,
  height: heightIn.value,
  thickness: thicknessIn.value,
  raise: raiseIn.value,
  board: boardOn,
  excluded: [...excluded],
  noSensor: [...noSensor],
  show: { ...show },
});

function restore(c) {
  if (UNITS[c.unit]) {
    unit = c.unit;
    for (const b of unitButtons) b.setAttribute('aria-pressed', String(b.dataset.unit === unit));
    for (const el of document.querySelectorAll('[data-unit-label]')) el.textContent = unit;
  }
  widthIn.value = c.width ?? widthIn.value;
  heightIn.value = c.height ?? heightIn.value;
  thicknessIn.value = c.thickness ?? thicknessIn.value;
  raiseIn.value = c.raise ?? raiseIn.value;
  setBoard(c.board !== false);
  for (const [set, list] of [[excluded, c.excluded], [noSensor, c.noSensor]]) {
    set.clear();
    for (const k of list ?? []) set.add(k);
  }
  selected.clear();
  nodePicks.clear();
  for (const l of LAYERS) show[l] = c.show?.[l] !== false;
  applyLayers();
  if (lattice) update();
}

// A tab holds its design while another is on screen. saveId links it to a save; savedName and savedConfig are
// that save as stored, so the tab can tell saved (green tick) from changed since (grey clock). A tab never saved
// shows a red dot.
const tabs = [];
let active = null;
let tabSeq = 0;
let fresh = ''; // a new design as the page first loads, to tell an untouched tab from an edited one
const tabEls = new Map();

const configOf = (t) => JSON.stringify(t === active ? snapshot() : t.config);

function tabState(t) {
  if (!t.saveId) return 'unsaved';
  return configOf(t) === t.savedConfig && t.name === t.savedName ? 'saved' : 'pending';
}

// worth a warning before the tab goes: edited since its last save, or since it opened if never saved
const hasChanges = (t) => (t.saveId ? tabState(t) === 'pending' : configOf(t) !== fresh);

// new tabs are Untitled, Untitled 2, Untitled 3… taking the lowest number not open
function untitled() {
  const names = new Set(tabs.map((t) => t.name));
  let n = 1;
  while (names.has(n === 1 ? 'Untitled' : `Untitled ${n}`)) n++;
  return n === 1 ? 'Untitled' : `Untitled ${n}`;
}

const STATES = {
  saved: ['Saved', '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.2 6.4 4.9 9 9.8 3.2"/></svg>'],
  pending: ['Changes not saved yet', '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6"/><path d="M6 3.5V6l1.7 1.2"/></svg>'],
  unsaved: ['Not saved', ''],
};

function refreshTabStates() {
  for (const t of tabs) {
    const el = tabEls.get(t.id)?.querySelector('.tab-state');
    const state = tabState(t);
    if (!el || el.dataset.state === state) continue;
    el.dataset.state = state;
    el.title = STATES[state][0];
    el.setAttribute('aria-label', STATES[state][0]);
    el.innerHTML = STATES[state][1];
  }
}

// tabs are kept and updated in place rather than redrawn, so a double-click lands on the same element twice
function renderTabs() {
  for (const [id, el] of tabEls) {
    if (!tabs.some((t) => t.id === id)) {
      el.remove();
      tabEls.delete(id);
    }
  }
  for (const t of tabs) {
    let el = tabEls.get(t.id);
    if (!el) {
      el = tabElement(t);
      tabEls.set(t.id, el);
    }
    const on = t === active;
    el.setAttribute('aria-selected', String(on));
    el.tabIndex = on ? 0 : -1;
    const name = el.querySelector('.tab-name');
    if (name) name.textContent = t.name;
    el.title = t.name;
    el.querySelector('.tab-close').setAttribute('aria-label', `Close ${t.name}`);
    tabList.append(el);
  }
  tabList.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  refreshTabStates();
}

function tabElement(t) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.setAttribute('role', 'tab');
  const name = document.createElement('span');
  name.className = 'tab-name';
  const state = document.createElement('span');
  state.className = 'tab-state';
  state.setAttribute('role', 'img');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'tab-close';
  close.tabIndex = -1;
  close.textContent = '×';
  el.append(name, state, close);
  el.addEventListener('click', () => activate(t));
  el.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.tab-close')) rename(t);
  });
  // a middle click closes, as in a browser
  el.addEventListener('auxclick', (e) => e.button === 1 && closeTab(t));
  el.addEventListener('keydown', (e) => {
    if (e.target !== el) return;
    if (e.key === 'F2' || e.key === 'Enter') {
      e.preventDefault();
      rename(t);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const next = tabs[(tabs.indexOf(t) + (e.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length];
      activate(next);
      tabEls.get(next.id)?.focus();
    } else if (e.key === 'Delete') {
      closeTab(t);
    }
  });
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(t);
  });
  return el;
}

function activate(t) {
  if (t === active) return;
  if (active) {
    active.config = snapshot();
    active.page = page;
  }
  active = t;
  restore(t.config);
  setPage(t.page);
  renderTabs();
}

function openTab({ name = untitled(), config = JSON.parse(fresh), save = null } = {}) {
  const t = { id: ++tabSeq, name, config, page: 1, saveId: save?.id ?? null, savedName: save?.name ?? null, savedConfig: null };
  tabs.push(t);
  activate(t);
  // read back what the inputs hold, so a just-opened save compares as unchanged
  if (save) t.savedConfig = configOf(t);
  refreshTabStates();
  return t;
}

function closeTab(t) {
  if (hasChanges(t) && !confirm(`Close “${t.name}” without saving? Its changes will be lost.`)) return;
  const i = tabs.indexOf(t);
  tabs.splice(i, 1);
  if (t === active) {
    active = null;
    if (tabs.length) activate(tabs[Math.min(i, tabs.length - 1)]);
    else openTab();
  }
  renderTabs();
}

// the name is edited in place; Enter or clicking away keeps it, Escape or an empty name puts the old one back
function rename(t) {
  activate(t);
  const el = tabEls.get(t.id);
  const name = el?.querySelector('.tab-name');
  if (!name) return;
  const input = document.createElement('input');
  input.className = 'tab-rename';
  input.value = t.name;
  input.maxLength = 60;
  input.setAttribute('aria-label', 'Tab name');
  input.size = Math.max(4, t.name.length);
  name.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (keep && v) t.name = v;
    input.replaceWith(name);
    renderTabs();
    el.focus();
  };
  input.addEventListener('input', () => (input.size = Math.max(4, input.value.length)));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  for (const type of ['click', 'dblclick', 'auxclick']) input.addEventListener(type, (e) => e.stopPropagation());
}

// stores the tab on screen under a name; returns why it could not, or '' once saved
function saveAs(name) {
  const t = active;
  const saves = loadSaves();
  if (saves.some((x) => x.name === name && x.id !== t.saveId)) return `There's already a save called “${name}”. Pick another name.`;
  const id = t.saveId ?? `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const config = snapshot();
  if (!storeSaves([{ id, name, savedAt: Date.now(), config }, ...saves.filter((x) => x.id !== id)])) {
    return 'This browser would not store it (private window or storage blocked).';
  }
  Object.assign(t, { name, saveId: id, savedName: name, savedConfig: JSON.stringify(config) });
  renderTabs();
  status(`Saved “${name}”`);
  return '';
}

function askName(error = '') {
  saveName.value = active.name;
  saveError.textContent = error;
  saveDialog.showModal();
  saveName.select();
}

// a tab saved before saves straight away under its tab name; a first save asks for the name to keep
function save() {
  if (saveDialog.open) return;
  if (!active.saveId) return askName();
  const error = saveAs(active.name);
  if (error) askName(error);
}

$('save-btn').addEventListener('click', save);
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  }
});

$('save-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = saveName.value.trim();
  if (!name) {
    saveError.textContent = 'Give the design a name to save it.';
    saveName.focus();
    return;
  }
  const error = saveAs(name);
  if (error) {
    saveError.textContent = error;
    saveName.focus();
  } else {
    saveDialog.close();
  }
});

for (const b of saveDialog.querySelectorAll('[data-close]')) b.addEventListener('click', () => saveDialog.close());
// a click on the backdrop lands on the dialog itself
saveDialog.addEventListener('click', (e) => e.target === saveDialog && saveDialog.close());

// the + menu: a fresh tab, or any saved design (switching to it if it is already open)
function renderMenu() {
  $('saves-list').replaceChildren(
    ...loadSaves().map((s) => {
      const li = document.createElement('li');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'menu-item';
      open.setAttribute('role', 'menuitem');
      const name = document.createElement('b');
      name.textContent = s.name;
      const meta = document.createElement('small');
      const c = s.config;
      meta.textContent = `${c.width} × ${c.height} ${c.unit} · ${new Date(s.savedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
      open.append(name, meta);
      open.addEventListener('click', () => {
        closeMenu();
        const already = tabs.find((t) => t.saveId === s.id);
        if (already) activate(already);
        else openTab({ name: s.name, config: s.config, save: s });
        status(`Opened “${s.name}”`);
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'menu-del';
      del.textContent = '×';
      del.title = 'Delete this save';
      del.setAttribute('aria-label', `Delete ${s.name}`);
      del.addEventListener('click', () => {
        if (!confirm(`Delete the save “${s.name}”? This can't be undone.`)) return;
        storeSaves(loadSaves().filter((x) => x.id !== s.id));
        // an open tab of it stays, now unsaved
        for (const t of tabs) if (t.saveId === s.id) Object.assign(t, { saveId: null, savedName: null, savedConfig: null });
        refreshTabStates();
        renderMenu();
      });
      li.append(open, del);
      return li;
    }),
  );
}

function closeMenu() {
  tabMenu.hidden = true;
  tabPlus.setAttribute('aria-expanded', 'false');
}

tabPlus.addEventListener('click', () => {
  if (!tabMenu.hidden) return closeMenu();
  renderMenu();
  tabMenu.hidden = false;
  tabPlus.setAttribute('aria-expanded', 'true');
  $('menu-new').focus();
});
$('menu-new').addEventListener('click', () => {
  closeMenu();
  openTab();
});
document.addEventListener('pointerdown', (e) => {
  if (!tabMenu.hidden && !e.target.closest('.tab-add')) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !tabMenu.hidden) {
    closeMenu();
    tabPlus.focus();
  }
});
window.addEventListener('beforeunload', (e) => {
  if (tabs.some(hasChanges)) e.preventDefault();
});

fresh = JSON.stringify(snapshot());
openTab();

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
  if (page === 2) {
    const key = nodeAt(was.point);
    if (key) togglePick(key);
    return;
  }
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
  hover(page === 2 ? null : hexAt(wallFromSvg(e)));
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
    hover(page === 2 ? null : hexAt(viewer.wallPoint(e.clientX, e.clientY)));
  });
  canvas.addEventListener('pointerup', (e) => {
    const p = press;
    press = null;
    if (view !== '3d' || !p || p.button !== 0) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_SLOP) return;
    const point = viewer.wallPoint(e.clientX, e.clientY);
    if (page === 2) {
      const key = nodeAt(point);
      if (key) togglePick(key);
      return;
    }
    const id = hexAt(point);
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
    // each plate stack in the hexagon model is a built-in node; the one at the centre is the MCU node
    lattice.hexNodes = geometry.hexVisuals
      .filter((v) => v.part === 'middle_plate')
      .map((v) => {
        const dx = v.xyz[0] - lattice.hexCenter.x;
        const dz = v.xyz[2] - lattice.hexCenter.z;
        return { dx, dz, mcu: Math.hypot(dx, dz) < 0.05 };
      });
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
