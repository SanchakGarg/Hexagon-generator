// The assembly guide: a book of sheets read one at a time, its table of contents in the side panel. It starts with
// the finished wall, lists the steps, then takes each in turn: the node and its layers, the two circuit boards, the
// LED channel, where every node goes on the backboard (and how its switches are set), where every channel goes,
// and how the strips and touch sensors are wired. The editable parts list closes it.
import { hexPoints, sketch, esc, arrowsSvg, wiringSvg, sensorsSvg, groupClass } from './render.js';
import { chainPath, DIP_CONTACTS } from './wiring.js';
import { isUrl, vendorName } from './parts.js';

export const GUIDE_PAGES = [
  { id: 'intro', title: 'Introduction' },
  { id: 'steps', title: 'Steps to assemble' },
  { id: 'nodes', title: 'Node assembly' },
  { id: 'circuits', title: 'Circuits' },
  { id: 'channels', title: 'LED channel preparation' },
  { id: 'backboard', title: 'Nodes on the backboard' },
  { id: 'placement', title: 'LED channel placement' },
  { id: 'wiring', title: 'Strip wiring and touch sensors' },
  { id: 'parts', title: 'Parts list' },
];

const fmt = (v) => +v.toFixed(5);
const rad = (d) => (d * Math.PI) / 180;
const KIND_NAMES = { mcu: 'MCU node', normal: 'built-in node', edge: 'edge node', '2way': '2-way node', '3way': '3-way node' };
const CUSTOM_SECTION = 'Extras';
const CLICK_SLOP = 4;
// node labels in reading order: M, the built-in nodes, the corners, the Edge plates
const LABEL_ORDER = ['M', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f', 'E1', 'E2', 'E3'];
const byLabel = (a, b) => LABEL_ORDER.indexOf(a.label) - LABEL_ORDER.indexOf(b.label);

// the hexagon each browser box shows, kept while the guide is redrawn
const browse = {};

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat().filter((x) => x != null && x !== false));
  return el;
};

const svgEl = (viewBox, inner, cls = '') => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', `${fmt(viewBox.x)} ${fmt(viewBox.y)} ${fmt(viewBox.w)} ${fmt(viewBox.h)}`);
  s.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  if (cls) s.setAttribute('class', cls);
  s.innerHTML = inner;
  return s;
};

function sheet(id, ...kids) {
  const i = GUIDE_PAGES.findIndex((p) => p.id === id);
  const title = GUIDE_PAGES[i].title;
  return h('section', { class: 'sheet', 'data-gpage': id }, h('h2', { class: 'sheet-title' }, h('span', { class: 'num' }, String(i + 1)), title), ...kids);
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// --- drawings of the wall --------------------------------------------------------------------------------------

// the whole wall, or one hexagon of it with a margin, in SVG units with y running down from the wall's top
function frameOf(L, only = null, pad = only ? 0.22 : 0.12) {
  const pts = [];
  const hexes = only ? [only] : L.hexes;
  for (const x of hexes) for (let k = 0; k < 6; k++) pts.push({ x: x.x + L.lat.R * Math.cos(rad(30 + 60 * k)), z: x.z + L.lat.R * Math.sin(rad(30 + 60 * k)) });
  for (const e of L.edges) if (!only || e.hexId === only.id) pts.push({ x: e.tipX, z: e.tipZ });
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => L.H - p.z);
  const p = L.lat.R * pad;
  const x0 = Math.min(...xs) - p;
  const y0 = Math.min(...ys) - p;
  return { x: x0, y: y0, w: Math.max(...xs) + p - x0, h: Math.max(...ys) + p - y0 };
}

const hexOutlines = (L, y) =>
  L.hexes.map((x) => `<g class="pb-hex" data-hex="${x.id}"><polygon class="fill" points="${hexPoints(x.x, y(x.z), L.lat.R, 0)}"/>${sketch(x.x, y(x.z), L.lat.R, x.id)}</g>`).join('');

const edgeStrips = (L, y) =>
  L.edges
    .map((e) => {
      const ux = Math.cos(rad(e.angle));
      const uz = Math.sin(rad(e.angle));
      const w = L.lat.rho * 0.55;
      const pts = [
        [e.x - uz * w, e.z + ux * w],
        [e.tipX - uz * w, e.tipZ + ux * w],
        [e.tipX + uz * w, e.tipZ - ux * w],
        [e.x + uz * w, e.z - ux * w],
      ];
      return `<polygon class="pb-edge" points="${pts.map(([px, pz]) => `${fmt(px)},${fmt(y(pz))}`).join(' ')}"/>`;
    })
    .join('');

// an LED channel as a painted-black bar with its LEDs dotted along it
function channelBars(L, channels, y) {
  const rho = L.lat.rho;
  return channels
    .map((c) => {
      const dx = c.out.x - c.in.x;
      const dz = c.out.z - c.in.z;
      const len = Math.hypot(dx, dz);
      const a = { x: c.in.x + (dx / len) * rho * 1.1, z: c.in.z + (dz / len) * rho * 1.1 };
      const b = { x: c.out.x - (dx / len) * rho * 1.1, z: c.out.z - (dz / len) * rho * 1.1 };
      const d = `M${fmt(a.x)},${fmt(y(a.z))}L${fmt(b.x)},${fmt(y(b.z))}`;
      return `<path class="pb-chan" d="${d}" stroke-width="${fmt(rho * 0.7)}"/><path class="pb-leds" d="${d}" pathLength="15" stroke-width="${fmt(rho * 0.3)}"/>`;
    })
    .join('');
}

// --- hand-drawn marks: every line wobbles a little and is gone over twice, the same way each time for one seed --------

function rng(seed) {
  let v = 2166136261;
  for (const ch of String(seed)) v = Math.imul(v ^ ch.charCodeAt(0), 16777619);
  return () => {
    v = Math.imul(v ^ (v >>> 15), 2246822507);
    v = Math.imul(v ^ (v >>> 13), 3266489909);
    return ((v ^= v >>> 16) >>> 0) / 4294967296 - 0.5;
  };
}

// a pencil line through points (already in SVG units): each stretch bows a touch and its ends miss a little
function wobbly(pts, seed, j, closed = false) {
  const r = rng(seed);
  const p = pts.map(([px, py]) => [px + r() * j, py + r() * j]);
  if (closed) p.push([p[0][0] + r() * j * 0.6, p[0][1] + r() * j * 0.6]);
  let d = `M${fmt(p[0][0])},${fmt(p[0][1])}`;
  for (let i = 1; i < p.length; i++) {
    const [x0, y0] = p[i - 1];
    const [x1, y1] = p[i];
    const bow = r() * Math.hypot(x1 - x0, y1 - y0) * 0.09;
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    const cx = (x0 + x1) / 2 - ((y1 - y0) / len) * bow;
    const cy = (y0 + y1) / 2 + ((x1 - x0) / len) * bow;
    d += `Q${fmt(cx)},${fmt(cy)} ${fmt(x1)},${fmt(y1)}`;
  }
  return d;
}

const hexCorners = (cx, cy, r) => Array.from({ length: 6 }, (_, k) => [cx + r * Math.cos(rad(30 + 60 * k)), cy - r * Math.sin(rad(30 + 60 * k))]);

// an arrow drawn by hand from a to b (SVG units): a bowed shaft and an open head of two quick strokes, each gone
// over twice, on a pale halo so it reads over the drawing under it
function handArrow(a, b, seed, head, cls, attrs = '', inner = '') {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const n = [-u[1], u[0]];
  const back = (s) => [b[0] - u[0] * head + n[0] * head * s, b[1] - u[1] * head + n[1] * head * s];
  const j = head * 0.12;
  const strokes = [
    wobbly([a, b], `${seed}s`, j),
    wobbly([back(0.55), b], `${seed}l`, j * 0.5),
    wobbly([back(-0.55), b], `${seed}r`, j * 0.5),
  ];
  const again = [wobbly([a, b], `${seed}s2`, j * 1.6), wobbly([back(0.6), b, back(-0.5)], `${seed}h2`, j)];
  return `<g class="hand-arrow ${cls}" ${attrs}>${strokes.map((d) => `<path class="halo" d="${d}"/>`).join('')}${strokes.map((d) => `<path class="ink" d="${d}"/>`).join('')}${again.map((d) => `<path class="ink again" d="${d}"/>`).join('')}${inner}</g>`;
}

// a node as a small hexagon washed in its kind's colour, the wash a little off the pencil line as paint would be,
// with a hand-drawn arrow for the way its node-1 side points. Over the rendered meshes the node is already drawn,
// so only its arrow and label go on top.
function nodeMarks(L, nodes, y, { arrows = false, labels = false, scale = 1, bodies = true } = {}) {
  const r = L.lat.rho * scale;
  return nodes
    .map((n) => {
      const seed = n.key ?? `${n.hexId}${n.label}`;
      const cx = n.x;
      const cy = y(n.z);
      const j = r * 0.09;
      let out = '';
      if (bodies) {
        out += `<g class="pb-node k-${n.kind}"><title>${esc(`${n.label ?? ''} · ${KIND_NAMES[n.kind] ?? n.kind}`)}</title>`;
        out += `<path class="wash" d="${wobbly(hexCorners(cx + r * 0.1, cy + r * 0.08, r * 0.96), `${seed}w`, j * 1.4, true)}"/>`;
        out += `<path class="ink" d="${wobbly(hexCorners(cx, cy, r), `${seed}a`, j, true)}"/>`;
        out += `<path class="ink again" d="${wobbly(hexCorners(cx, cy, r * 0.97), `${seed}b`, j * 1.3, true)}"/></g>`;
      }
      if (arrows && n.facing != null) {
        const u = [Math.cos(rad(n.facing)), -Math.sin(rad(n.facing))];
        out += handArrow([cx + u[0] * r * 1.05, cy + u[1] * r * 1.05], [cx + u[0] * r * 2.9, cy + u[1] * r * 2.9], `${seed}f`, r * 0.7, 'pb-face');
      }
      if (labels && bodies) out += `<text class="pb-nlabel" x="${fmt(cx)}" y="${fmt(cy)}" font-size="${fmt(r * 0.95)}">${esc(n.label ?? '')}</text>`;
      else if (labels) {
        const fs = L.lat.rho * 1.1;
        out += `<text class="pb-nlabel on-render" x="${fmt(cx)}" y="${fmt(cy)}" font-size="${fmt(fs)}" stroke-width="${fmt(fs * 0.27)}">${esc(n.label ?? '')}</text>`;
      }
      return out;
    })
    .join('');
}

// nodes that sit on a hexagon: inside or on its outline, and the plates on its own Edges
function nodesOf(L, allNodes, hex) {
  return allNodes.filter((n) => n.hexId === hex.id || Math.hypot(n.x - hex.x, n.z - hex.z) <= L.lat.R * 1.02);
}

// a wiring set cut down to one hexagon's share
const onlyHex = (w, id) => w && Object.fromEntries(Object.entries(w).map(([k, v]) => [k, Array.isArray(v) ? v.filter((x) => x.hexId === id) : v]));

let clipSeq = 0;

// The wall as the configurator draws it, from the URDF meshes, under the guide's own marks. A single hexagon is
// drawn in full over a pale shadow of its neighbours that fades out the further it reaches from the hexagon.
// Without meshes it falls back to outlines.
function baseDrawing(ctx, L, box, y, { hex = null, channels = null, softLeds = false } = {}) {
  const { lat } = L;
  const n = ++clipSeq;
  // the shadow is opaque round the hexagon and gone by the box's corners
  const fade = () => {
    const cx = hex.x;
    const cy = y(hex.z);
    const far = Math.max(...[
      [box.x, box.y],
      [box.x + box.w, box.y],
      [box.x, box.y + box.h],
      [box.x + box.w, box.y + box.h],
    ].map(([px, py]) => Math.hypot(px - cx, py - cy)));
    const inner = Math.min(0.95, (lat.R * 0.9) / far);
    return `<radialGradient id="pb-grad-${n}" gradientUnits="userSpaceOnUse" cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(far)}"><stop offset="${fmt(inner)}" stop-color="#fff" stop-opacity="1"/><stop offset="${fmt(inner + (1 - inner) * 0.45)}" stop-color="#fff" stop-opacity="0.45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient><mask id="pb-fade-${n}" maskUnits="userSpaceOnUse" x="${fmt(box.x)}" y="${fmt(box.y)}" width="${fmt(box.w)}" height="${fmt(box.h)}"><rect x="${fmt(box.x)}" y="${fmt(box.y)}" width="${fmt(box.w)}" height="${fmt(box.h)}" fill="url(#pb-grad-${n})"/></mask>`;
  };
  const width = hex ? 1100 : 1600;
  const url = ctx.snapshot?.(box, width, { softLeds });
  if (!url) {
    const chans = channels ?? [];
    const draw = (hexes) => {
      const ids = new Set(hexes.map((x) => x.id));
      return edgeStrips({ ...L, edges: L.edges.filter((e) => ids.has(e.hexId)) }, y) + hexOutlines({ ...L, hexes }, y) + channelBars(L, chans.filter((c) => ids.has(c.hexId)), y);
    };
    if (!hex) return draw(L.hexes);
    return `${fade()}<g class="pb-shadow" mask="url(#pb-fade-${n})">${draw(L.hexes.filter((x) => x !== hex))}</g>${draw([hex])}`;
  }
  const image = (id) => `<image class="pb-render" id="${id}" href="${url}" x="${fmt(box.x)}" y="${fmt(box.y)}" width="${fmt(box.w)}" height="${fmt(box.h)}" preserveAspectRatio="none"/>`;
  if (!hex) return image(`pb-img-${n}`);
  // the hexagon itself, its nodes and Edges, cut out of the same still and drawn in full over the shadow
  const mine = nodesOf(L, ctx.allNodes, hex);
  const edges = L.edges.filter((e) => e.hexId === hex.id);
  const shapes = [
    `<polygon points="${hexPoints(hex.x, y(hex.z), lat.R + lat.rho * 0.7, 0)}"/>`,
    ...mine.map((m) => `<circle cx="${fmt(m.x)}" cy="${fmt(y(m.z))}" r="${fmt(lat.rho * 1.35)}"/>`),
    edgeStrips({ ...L, edges, lat: { ...lat, rho: lat.rho * 2.6 } }, y),
  ];
  return `${fade()}<clipPath id="pb-clip-${n}">${shapes.join('')}</clipPath><g class="pb-shadow" mask="url(#pb-fade-${n})">${image(`pb-img-${n}`)}</g><use href="#pb-img-${n}" clip-path="url(#pb-clip-${n})"/>`;
}

// see-through hexagons over a drawing, to click one
const pickHexes = (L, y) => L.hexes.map((x) => `<polygon class="pb-pick" data-hex="${x.id}" points="${hexPoints(x.x, y(x.z), L.lat.R, 0)}"/>`).join('');

// ◀ H3 of 12 ▶ with a dropdown, over a drawing of the one hexagon
function browser(kind, L, draw) {
  const ids = L.hexes.map((x) => x.id);
  if (!ids.includes(browse[kind])) browse[kind] = ids[0];
  const box = h('div', { class: 'pb-browser' });
  const select = h('select', { 'aria-label': 'Hexagon to show' }, ids.map((id) => h('option', { value: id, selected: id === browse[kind] }, id)));
  const count = h('span', { class: 'of' });
  const body = h('div', { class: 'pb-browser-body' });
  const go = (id) => {
    browse[kind] = id;
    select.value = id;
    count.textContent = `${ids.indexOf(id) + 1} of ${ids.length}`;
    body.replaceChildren(...draw(L.hexes.find((x) => x.id === id)));
  };
  const step = (d) => go(ids[(ids.indexOf(browse[kind]) + d + ids.length) % ids.length]);
  select.addEventListener('change', () => go(select.value));
  const bar = h('div', { class: 'pb-browser-bar' }, h('button', { type: 'button', class: 'btn', 'aria-label': 'Previous hexagon', onclick: () => step(-1) }, '◀'), select, count, h('button', { type: 'button', class: 'btn', 'aria-label': 'Next hexagon', onclick: () => step(1) }, '▶'));
  // a single hexagon needs no stepping through
  bar.hidden = ids.length < 2;
  box.append(bar, body);
  go(browse[kind]);
  box.goTo = go;
  return box;
}

// --- interaction on the drawings --------------------------------------------------------------------------------

// the page's one tooltip, beside the pointer, for anything with a data-tip
function tipOn(svg) {
  const tip = document.getElementById('tooltip');
  svg.addEventListener('pointermove', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (!t || !tip) {
      if (tip) tip.hidden = true;
      return;
    }
    tip.textContent = t.dataset.tip;
    tip.hidden = false;
    const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    const yy = Math.min(e.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
    tip.style.transform = `translate(${x}px, ${yy}px)`;
  });
  svg.addEventListener('pointerleave', () => tip && (tip.hidden = true));
}

// A chain, or a chain in one hexagon, picked out of a wiring drawing: it stays bright (and its signal runs down it
// in the LED channels view) while the rest fades back.
function focusWires(svg, chain, hexId) {
  const group = svg.querySelector('.wiring');
  if (!group) return;
  group.classList.toggle('focus', !!chain);
  for (const el of group.querySelectorAll('.lit')) el.classList.remove('lit');
  if (!chain) return;
  for (const el of group.querySelectorAll(`[data-chain="${chain}"]${hexId ? `[data-hex="${hexId}"]` : ''}`)) el.classList.add('lit');
}

// hovering a wire picks out its chain in its hexagon; leaving the wires lets it go
function hoverWires(svg) {
  let cur = '';
  svg.addEventListener('pointermove', (e) => {
    const w = e.target.closest?.('.wiring [data-chain]');
    const key = w ? `${w.dataset.chain}|${w.dataset.hex}` : '';
    if (key === cur) return;
    cur = key;
    focusWires(svg, w?.dataset.chain ?? null, w?.dataset.hex ?? null);
  });
  svg.addEventListener('pointerleave', () => {
    cur = '';
    focusWires(svg, null);
  });
}

// a key whose rows pick out their chain in every hexagon of a drawing
function wireKey(rows, cls, target) {
  const key = h('div', { class: `wkey ${cls}` }, rows.map(([chain, c]) => h('p', { class: `chain ${c}`, 'data-chain': chain }, h('i', { class: 'swatch' }), h('b', {}, chain))));
  for (const row of key.querySelectorAll('[data-chain]')) row.addEventListener('pointerenter', () => target() && focusWires(target(), row.dataset.chain, null));
  key.addEventListener('pointerleave', () => target() && focusWires(target(), null));
  return key;
}

// The whole wall up close: drag to pan, the buttons or a pinch (or ctrl/⌘ and the wheel) to zoom, double-click to
// fit it again. A drag never counts as a click on what it started over.
function zoomable(svg, box) {
  let z = { s: 1, cx: box.x + box.w / 2, cy: box.y + box.h / 2 };
  const apply = () => {
    const w = box.w / z.s;
    const hh = box.h / z.s;
    svg.setAttribute('viewBox', `${fmt(z.cx - w / 2)} ${fmt(z.cy - hh / 2)} ${fmt(w)} ${fmt(hh)}`);
  };
  const at = (e) => new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
  const zoomTo = (s, p = { x: z.cx, y: z.cy }) => {
    const next = Math.min(12, Math.max(1, s));
    const k = z.s / next;
    z = { s: next, cx: p.x + (z.cx - p.x) * k, cy: p.y + (z.cy - p.y) * k };
    apply();
  };
  svg.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomTo(z.s * Math.exp(-e.deltaY * 0.004), at(e));
    },
    { passive: false },
  );
  let drag = null;
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, cx: z.cx, cy: z.cy, per: 1 / svg.getScreenCTM().a, moved: false };
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > CLICK_SLOP && z.s > 1) {
      drag.moved = true;
      svg.classList.add('panning');
      try {
        svg.setPointerCapture(e.pointerId);
      } catch {}
    }
    if (drag.moved) {
      z = { ...z, cx: drag.cx - dx * drag.per, cy: drag.cy - dy * drag.per };
      apply();
    }
  });
  const end = () => {
    svg.classList.remove('panning');
    // the click that ends a pan is swallowed below
    if (drag?.moved) svg.dataset.dragged = '';
    drag = null;
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener(
    'click',
    (e) => {
      if ('dragged' in svg.dataset) {
        delete svg.dataset.dragged;
        e.stopPropagation();
      }
    },
    true,
  );
  svg.addEventListener('dblclick', () => zoomTo(1, { x: box.x + box.w / 2, y: box.y + box.h / 2 }) || ((z.cx = box.x + box.w / 2), (z.cy = box.y + box.h / 2), apply()));
  const wrap = h(
    'div',
    { class: 'pb-zoomwrap' },
    svg,
    h(
      'div',
      { class: 'pb-zoombar' },
      h('button', { type: 'button', class: 'btn', 'aria-label': 'Zoom in', title: 'Zoom in', onclick: () => zoomTo(z.s * 1.5) }, '+'),
      h('button', { type: 'button', class: 'btn', 'aria-label': 'Zoom out', title: 'Zoom out', onclick: () => zoomTo(z.s / 1.5) }, '−'),
      h('button', { type: 'button', class: 'btn', 'aria-label': 'Fit the whole wall', title: 'Fit the whole wall', onclick: () => ((z = { s: 1, cx: box.x + box.w / 2, cy: box.y + box.h / 2 }), apply()) }, '⤢'),
    ),
  );
  return wrap;
}

// a click on a hexagon of an overview shows it in a browser
function pickInto(svg, b) {
  svg.addEventListener('click', (e) => {
    const id = e.target.closest('[data-hex]')?.dataset.hex;
    if (!id || !b) return;
    b.goTo(id);
    b.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

// --- the LED channel up close ---------------------------------------------------------------------------------

// One channel drawn to scale from above (3 SVG units a millimetre): the black aluminium channel, the strip of LEDs
// at their real pitch, and a 2510 4-pin connector at each end. 5V, SIG and GND are soldered from the strip's pads
// to pins 1, 2 and 4; pin 3, FREE, is a jump wire from connector to connector that skips the LEDs.
function channelDrawing({ CHANNEL_CM, LEDS_PER_CHANNEL, LEDS_PER_M }) {
  const k = 3;
  const chanL = CHANNEL_CM * 10 * k;
  const pitch = (1000 / LEDS_PER_M) * k;
  const stripL = LEDS_PER_CHANNEL * pitch;
  const x0 = 130;
  const x1 = x0 + chanL;
  const s0 = x0 + (chanL - stripL) / 2;
  const s1 = s0 + stripL;
  const W = x1 + 130;
  const top = 120;
  const bot = 230;
  const pins = { '5V': 140, SIG: 162, FREE: 184, GND: 206 };
  const pads = { '5V': 158, SIG: 172, GND: 186 };
  const cls = { '5V': 'v5', SIG: 'sig', GND: 'gnd' };
  const out = [];
  // the channel, painted black, with its open groove
  out.push(`<rect class="cd-chan" x="${x0}" y="${top}" width="${chanL}" height="${bot - top}" rx="6"/>`);
  out.push(`<rect class="cd-groove" x="${x0 + 6}" y="${top + 22}" width="${chanL - 12}" height="${bot - top - 36}" rx="3"/>`);
  // the strip and its LEDs
  out.push(`<rect class="cd-strip" x="${s0}" y="150" width="${stripL}" height="44" rx="3"/>`);
  for (let i = 0; i < LEDS_PER_CHANNEL; i++) {
    const cx = s0 + pitch / 2 + i * pitch;
    out.push(`<rect class="cd-led" x="${cx - 8}" y="164" width="16" height="16" rx="2"/><circle class="cd-glow" cx="${cx}" cy="172" r="4"/>`);
  }
  // data runs DIN → DOUT
  for (let i = 1; i < LEDS_PER_CHANNEL; i += 3) {
    const cx = s0 + i * pitch + pitch;
    out.push(`<path class="cd-chev" d="M${cx - 4},155 l5,4 -5,4"/>`);
  }
  // connectors: a body with four pins, then wires
  for (const [x, side] of [
    [24, 'IN'],
    [x1 + 52, 'OUT'],
  ]) {
    out.push(`<rect class="cd-conn" x="${x}" y="128" width="54" height="90" rx="5"/>`);
    out.push(`<text class="cd-cap" x="${x + 27}" y="118" text-anchor="middle">${side === 'IN' ? 'IN · DIN' : 'OUT · DOUT'}</text>`);
    Object.entries(pins).forEach(([name, py], i) => {
      const px = side === 'IN' ? x + 54 : x;
      out.push(`<circle class="cd-pin" cx="${px}" cy="${py}" r="3.4"/>`);
      out.push(`<text class="cd-pinno" x="${x + 27}" y="${py + 5}" text-anchor="middle">${i + 1}</text>`);
    });
  }
  // the three soldered wires at each end
  for (const name of ['5V', 'SIG', 'GND']) {
    const lx = 78;
    const rx = x1 + 52;
    out.push(`<path class="cd-w ${cls[name]}" d="M${lx},${pins[name]} C${lx + 40},${pins[name]} ${s0 - 40},${pads[name]} ${s0 + 2},${pads[name]}"/>`);
    out.push(`<path class="cd-w ${cls[name]}" d="M${rx},${pins[name]} C${rx - 40},${pins[name]} ${s1 + 40},${pads[name]} ${s1 - 2},${pads[name]}"/>`);
    out.push(`<circle class="cd-solder" cx="${s0 + 3}" cy="${pads[name]}" r="3"/><circle class="cd-solder" cx="${s1 - 3}" cy="${pads[name]}" r="3"/>`);
  }
  // FREE: pin 3 to pin 3, under the strip
  out.push(`<path class="cd-w free" d="M78,${pins.FREE} C100,${pins.FREE} 110,212 ${x0 + 30},212 L${x1 - 30},212 C${x1 + 10},212 ${x1 + 30},${pins.FREE} ${x1 + 52},${pins.FREE}"/>`);
  // notes
  const mid = (x0 + x1) / 2;
  out.push(`<path class="cd-dim" d="M${x0},258 H${x1} M${x0},250 v16 M${x1},250 v16"/>`);
  out.push(`<text class="cd-note" x="${mid}" y="284" text-anchor="middle">${CHANNEL_CM} cm aluminium channel, painted black</text>`);
  const p0 = s0 + pitch / 2 + 2 * pitch;
  out.push(`<path class="cd-dim" d="M${p0},98 H${p0 + pitch} M${p0},92 v12 M${p0 + pitch},92 v12"/>`);
  out.push(`<text class="cd-note" x="${p0 + pitch / 2}" y="84" text-anchor="middle">${(1000 / LEDS_PER_M).toFixed(1)} mm apart (${LEDS_PER_M} LEDs/m)</text>`);
  out.push(`<text class="cd-note" x="${mid}" y="40" text-anchor="middle">${LEDS_PER_CHANNEL} LEDs · ${(stripL / k / 10).toFixed(1)} cm of strip</text>`);
  out.push(`<path class="cd-lead" d="M${mid},48 L${mid},146"/>`);
  out.push(`<text class="cd-note free" x="${mid}" y="330" text-anchor="middle">FREE jump wire: pin 3 to pin 3, past the LEDs</text>`);
  out.push(`<path class="cd-lead" d="M${mid},314 L${mid},216"/>`);
  out.push(`<text class="cd-note" x="51" y="250" text-anchor="middle">2510</text><text class="cd-note small" x="51" y="268" text-anchor="middle">4-pin</text>`);
  out.push(`<text class="cd-note" x="${x1 + 79}" y="250" text-anchor="middle">2510</text><text class="cd-note small" x="${x1 + 79}" y="268" text-anchor="middle">4-pin</text>`);
  return svgEl({ x: 0, y: 20, w: W, h: 330 }, out.join(''), 'pb-channel');
}

// one channel, IN on the left: SIG runs through the LEDs, FREE runs past them; for the strip wiring key
const CONNECTOR_SVG = `<svg class="conn-diagram" viewBox="0 0 280 118" role="img" aria-label="A channel with a 4-pin connector at each end: 5V, SIG, FREE and GND. SIG runs through the LEDs from DIN to DOUT; FREE runs straight past them.">
  <text class="cap" x="58" y="11" text-anchor="middle">IN · DIN</text>
  <text class="cap" x="222" y="11" text-anchor="middle">OUT · DOUT</text>
  <rect class="body" x="66" y="18" width="148" height="92" rx="5"/>
  <g class="pins"><text x="4" y="34">1 5V</text><text x="4" y="56">2 SIG</text><text x="4" y="78">3 FREE</text><text x="4" y="100">4 GND</text></g>
  <rect class="plug" x="50" y="20" width="16" height="88" rx="2"/>
  <rect class="plug" x="214" y="20" width="16" height="88" rx="2"/>
  <line class="v5" x1="58" y1="30" x2="222" y2="30"/>
  <line class="gnd" x1="58" y1="96" x2="222" y2="96"/>
  <line class="free" x1="58" y1="74" x2="222" y2="74"/>
  <path class="sig" d="M58 52 H222"/>
  <g class="leds"><rect x="86" y="45" width="14" height="14" rx="2"/><rect x="122" y="45" width="14" height="14" rx="2"/><rect x="158" y="45" width="14" height="14" rx="2"/></g>
  <path class="chev" d="M107 48 l5 4 -5 4 M143 48 l5 4 -5 4 M179 48 l5 4 -5 4"/>
  <g class="dots"><circle cx="58" cy="30" r="2.6"/><circle cx="58" cy="52" r="2.6"/><circle cx="58" cy="74" r="2.6"/><circle cx="58" cy="96" r="2.6"/><circle cx="222" cy="30" r="2.6"/><circle cx="222" cy="52" r="2.6"/><circle cx="222" cy="74" r="2.6"/><circle cx="222" cy="96" r="2.6"/></g>
  <text class="note" x="236" y="56">→ next</text>
  <text class="note" x="236" y="78">bypass</text>
</svg>`;

// --- the DIP switches ---------------------------------------------------------------------------------------------

// Four 2-way DIP switches as they sit on the board, each slider up for ON or down for off.
function dipSvg(dip) {
  const W = 34;
  const out = [];
  dip.forEach((pair, s) => {
    const x = s * (W + 10);
    out.push(`<text class="dip-sw" x="${x + W / 2}" y="9" text-anchor="middle">SW${s + 1}</text>`);
    out.push(`<rect class="dip-body" x="${x}" y="13" width="${W}" height="38" rx="3"/>`);
    pair.forEach((on, p) => {
      const sx = x + 5 + p * 14;
      out.push(`<rect class="dip-slot" x="${sx}" y="18" width="10" height="28" rx="2"/>`);
      out.push(`<rect class="dip-knob${on ? ' on' : ''}" x="${sx + 1}" y="${on ? 19 : 33}" width="8" height="12" rx="1.5"/>`);
      out.push(`<text class="dip-pos" x="${sx + 5}" y="62" text-anchor="middle">${p + 1}</text>`);
    });
  });
  out.push(`<text class="dip-on" x="${4 * (W + 10) - 6}" y="22">ON</text>`);
  return svgEl({ x: -2, y: 0, w: 4 * (W + 10) + 20, h: 66 }, out.join(''), 'dip');
}

const dipText = (dip) => dip.map((pair, i) => `SW${i + 1} ${pair.map((on) => (on ? 'ON' : 'off')).join(' ')}`).join(' · ');
const isCentral = (n) => n.kind === 'mcu';

function switchCard(n, s, hex) {
  const where = n.hexId !== hex.id ? ` · fitted with ${n.hexId}` : '';
  const head = h('p', { class: 'sw-head' }, h('b', {}, n.label ?? '?'), h('span', {}, `${KIND_NAMES[n.kind] ?? n.kind}${where}`));
  if (isCentral(n)) return h('div', { class: 'sw-card central', 'data-node': n.key }, head, h('p', { class: 'sw-note' }, 'Central Node board: no switches. Its six ports are driven straight from the ESP32.'));
  if (!s) return h('div', { class: 'sw-card', 'data-node': n.key }, head, h('p', { class: 'sw-note' }, 'No LED chain passes through it: all switches off.'), dipSvg([[false, false], [false, false], [false, false], [false, false]]));
  const links = s.links.map((l) => `${l.chain}: ${l.from.replace('.', ' ')} → ${l.to.replace('.', ' ')}`);
  return h(
    'div',
    { class: `sw-card${s.clash ? ' clash' : ''}`, 'data-node': n.key },
    head,
    dipSvg(s.dip),
    links.length ? h('p', { class: 'sw-links' }, links.join(' · ')) : null,
    s.clash ? h('p', { class: 'sw-warn' }, `No setting routes this node on its own: the closest also ties in ${s.clash.map((p) => p.replace('.', ' ')).join(', ')}, where another channel is plugged in. Unplug that channel's ${s.clash.map((p) => p.split('.')[1]).join('/')} wire at this node, or bridge the link with a jumper.`) : null,
  );
}

// --- the parts list -------------------------------------------------------------------------------------------

// the computed list with this guide's edits laid over it: changed values, descriptions and links, and added rows
export function mergeBom(bom, edits) {
  const o = edits.overrides ?? {};
  const sections = bom.sections.map((sec) => ({ ...sec, items: sec.items.map((i) => applyEdit(i, o[i.key])) }));
  if (!sections.some((s) => s.title === CUSTOM_SECTION)) sections.push({ title: CUSTOM_SECTION, note: 'your own additions', items: [] });
  for (const c of edits.custom ?? []) {
    const sec = sections.find((s) => s.title === c.section) ?? sections.at(-1);
    sec.items.push({ key: c.id, custom: true, label: c.label ?? '', qty: c.qty ?? null, rate: c.rate ?? null, desc: c.desc ?? '', link: c.link ?? '' });
  }
  return { sections, inputs: bom.inputs };
}

function applyEdit(item, e = {}) {
  const out = { ...item, desc: item.desc ?? '', link: item.link ?? '', base: item };
  if ('qty' in e) {
    out.qty = e.qty;
    // a quantity typed over the computed one is kept as typed, not as a formula
    if (e.qty !== item.qty) delete out.f;
  }
  if ('rate' in e) out.rate = e.rate;
  if ('desc' in e) out.desc = e.desc;
  if ('link' in e) out.link = e.link;
  out.edited = Object.keys(e).length > 0;
  return out;
}

const cost = (i) => (i.qty != null && i.rate != null ? i.qty * i.rate : null);
const sum = (items) => items.reduce((t, i) => t + (cost(i) ?? 0), 0);
const num = (v) => (v === '' || v == null || !Number.isFinite(+v) ? null : +v);

function bomSheet(ctx) {
  const { edits, rupees } = ctx;
  const table = h('div', { class: 'pb-bom', role: 'table', 'aria-label': 'Parts list' });
  const totalEl = h('b', { class: 'amount' });
  const save = () => {
    ctx.onEdits(edits);
    draw();
  };
  // typed values are kept as they go and the sums follow; only adding, removing or resetting a row redraws the list,
  // so moving from field to field never loses the cursor
  const field = (cls, value, attrs, onChange) => {
    const el = h('input', { class: cls, value: value ?? '', ...attrs });
    el.addEventListener('input', () => {
      onChange(el.value);
      ctx.onEdits(edits);
      refreshSums();
    });
    return el;
  };

  let rows = [];
  let merged = null;
  function refreshSums() {
    merged = mergeBom(ctx.bom, edits);
    for (const r of rows) r();
    totalEl.textContent = rupees(sum(merged.sections.flatMap((s) => s.items)));
  }

  function draw() {
    merged = mergeBom(ctx.bom, edits);
    rows = [];
    const head = h('div', { class: 'pb-row cols', role: 'row' }, ['Item', 'Description', 'Qty', 'Price each', 'Amount', 'Vendor', ''].map((t) => h('span', { role: 'columnheader' }, t)));
    const out = [head];
    merged.sections.forEach((sec, si) => {
      const subEl = h('b', { class: 'amount' });
      out.push(h('div', { class: 'pb-row section', role: 'row' }, h('span', { class: 'sec-title' }, sec.title, sec.note ? h('small', {}, sec.note) : null), h('span'), h('span'), h('span'), subEl, h('span'), h('span')));
      rows.push(() => (subEl.textContent = rupees(sum(merged.sections[si].items))));
      sec.items.forEach((item, ii) => {
        const cur = () => merged.sections[si].items[ii];
        const amountEl = h('span', { class: 'amount' });
        rows.push(() => {
          const c = cost(cur());
          amountEl.textContent = c == null ? '--' : rupees(c);
        });
        let label;
        let tools;
        if (item.custom) {
          const c = edits.custom.find((x) => x.id === item.key);
          label = field('label', item.label, { placeholder: 'New item', 'aria-label': 'Item' }, (v) => (c.label = v));
          tools = h('button', { type: 'button', class: 'mini', title: 'Remove this item', 'aria-label': 'Remove this item', onclick: () => ((edits.custom = edits.custom.filter((x) => x !== c)), save()) }, '×');
        } else {
          label = h('span', { class: 'label' }, item.label, item.note ? h('small', {}, item.note) : null);
          tools = h('button', { type: 'button', class: 'mini', title: 'Back to the worked-out values', 'aria-label': 'Reset this row', onclick: () => (delete edits.overrides[item.key], save()) }, '↺');
        }
        const set = (k, v) => {
          if (item.custom) {
            edits.custom.find((x) => x.id === item.key)[k] = v;
          } else {
            const o = (edits.overrides[item.key] ??= {});
            // back to what was worked out: no longer an edit
            if ((k === 'qty' || k === 'rate') && v === (item.base?.[k] ?? null)) delete o[k];
            else if ((k === 'desc' || k === 'link') && v === (item.base?.[k] ?? '')) delete o[k];
            else o[k] = v;
            if (!Object.keys(o).length) delete edits.overrides[item.key];
          }
        };
        const link = field('link', item.link, { placeholder: 'shop link, phone…', 'aria-label': `Vendor for ${item.label || 'item'}` }, (v) => set('link', v.trim()));
        // a link reads as the shop's name, linked; the pencil opens the link itself to change it
        const shop = h('a', { class: 'shop', target: '_blank', rel: 'noopener' });
        const pencil = h('button', { type: 'button', class: 'mini', title: 'Change the link', 'aria-label': `Change the vendor link for ${item.label || 'item'}` }, '✎');
        const showShop = () => {
          const v = link.value.trim();
          const on = isUrl(v) && document.activeElement !== link;
          shop.href = on ? v : '#';
          shop.textContent = on ? vendorName(v) : '';
          shop.title = on ? v : '';
          shop.hidden = pencil.hidden = !on;
          link.hidden = on;
        };
        pencil.addEventListener('click', () => {
          shop.hidden = pencil.hidden = true;
          link.hidden = false;
          link.focus();
        });
        link.addEventListener('blur', showShop);
        showShop();
        let rowEl = null;
        rows.push(() => {
          if (!rowEl || item.custom) return;
          const o = edits.overrides[item.key] ?? {};
          for (const k of ['desc', 'qty', 'rate', 'link']) rowEl.querySelector(`input.${k}`)?.classList.toggle('edited', k in o);
          tools.hidden = !Object.keys(o).length;
        });
        out.push(
          (rowEl = h(
            'div',
            { class: `pb-row item${item.custom ? ' custom' : ''}`, role: 'row' },
            label,
            field('desc', item.desc, { placeholder: 'description', 'aria-label': `Description of ${item.label || 'item'}` }, (v) => set('desc', v)),
            field('qty', item.qty, { type: 'number', min: '0', step: 'any', inputmode: 'decimal', placeholder: '--', 'aria-label': `Quantity of ${item.label || 'item'}` }, (v) => set('qty', num(v))),
            field('rate', item.rate, { type: 'number', min: '0', step: 'any', inputmode: 'decimal', placeholder: '--', 'aria-label': `Price each of ${item.label || 'item'}` }, (v) => set('rate', num(v))),
            amountEl,
            h('span', { class: 'linkcell' }, link, shop, pencil),
            tools,
          )),
        );
      });
      const add = h('button', { type: 'button', class: 'add', onclick: () => {
        const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
        edits.custom.push({ id, section: sec.title, label: '', qty: 1, rate: null, desc: '', link: '' });
        save();
        // the new row's name, ready to type
        const inputs = [...table.querySelectorAll('.pb-row.custom input.label')];
        inputs.find((el) => !el.value)?.focus();
      } }, `+ Add item to ${sec.title}`);
      out.push(h('div', { class: 'pb-row adder' }, add));
    });
    const unpricedEl = h('small');
    rows.push(() => {
      const n = merged.sections.flatMap((s) => s.items).filter((i) => cost(i) == null).length;
      unpricedEl.textContent = n ? `${n} item${n === 1 ? '' : 's'} not priced yet` : '';
    });
    out.push(h('div', { class: 'pb-row grand', role: 'row' }, h('span', {}, 'Total', unpricedEl), h('span'), h('span'), h('span'), totalEl, h('span'), h('span')));
    table.replaceChildren(...out);
    refreshSums();
  }
  draw();

  return sheet(
    'parts',
    h('p', {}, 'Everything to buy for this wall. Change any quantity, price or description, add where to buy it, or add your own items. Your changes stay in this browser until you share the guide.'),
    h(
      'div',
      { class: 'pb-actions no-print' },
      h('button', { type: 'button', class: 'btn', onclick: () => ctx.exportExcel(mergeBom(ctx.bom, edits)) }, 'Export Excel'),
      h('button', { type: 'button', class: 'btn', onclick: () => printBom(ctx, mergeBom(ctx.bom, edits)) }, 'Export PDF'),
    ),
    table,
    // the printed book has the list as a plain table instead of the fields
    h('div', { class: 'print-only' }, bomTable(ctx, mergeBom(ctx.bom, edits))),
  );
}

// the parts list as a plain table, for print
function bomTable(ctx, merged) {
  const money = (v) => (v == null ? '' : ctx.rupees(v));
  const cell = (tag, text, cls) => h(tag, cls ? { class: cls } : {}, text ?? '');
  const rows = [];
  for (const sec of merged.sections) {
    if (!sec.items.length) continue;
    rows.push(h('tr', { class: 'sec' }, cell('td', sec.title), cell('td', ''), cell('td', ''), cell('td', ''), cell('td', money(sum(sec.items)), 'n'), cell('td', '')));
    for (const i of sec.items) {
      const vendor = isUrl(i.link) ? h('td', {}, h('a', { href: i.link.trim() }, vendorName(i.link))) : cell('td', i.link);
      rows.push(h('tr', {}, cell('td', i.label), cell('td', i.desc), cell('td', i.qty ?? '', 'n'), cell('td', money(i.rate), 'n'), cell('td', money(cost(i)), 'n'), vendor));
    }
  }
  rows.push(h('tr', { class: 'total' }, cell('td', 'Total'), cell('td', ''), cell('td', ''), cell('td', ''), cell('td', money(sum(merged.sections.flatMap((s) => s.items))), 'n'), cell('td', '')));
  return h('table', { class: 'print-table' }, h('thead', {}, h('tr', {}, ['Item', 'Description', 'Qty', 'Price each', 'Amount', 'Vendor'].map((t, i) => cell('th', t, i >= 2 && i <= 4 ? 'n' : '')))), h('tbody', {}, rows));
}

// the parts list's own PDF is the browser's print to PDF of the plain table, and nothing else on the page
function printBom(ctx, merged) {
  const host = document.getElementById('pb-print');
  host.replaceChildren(
    h('h1', {}, `${ctx.name} · parts list`),
    h('p', {}, `${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })} · prices in rupees`),
    bomTable(ctx, merged),
  );
  const title = document.title;
  document.title = `${ctx.name} parts`;
  document.body.classList.add('print-bom');
  window.print();
  document.body.classList.remove('print-bom');
  document.title = title;
}

// --- the guide ------------------------------------------------------------------------------------------------

export function renderPlaybook(root, ctx) {
  const L = ctx.layout;
  const { lat } = L;
  const y = (z) => L.H - z;
  const c = ctx.counts;
  const K = ctx.constants;
  if (!L.hexes.length) {
    root.replaceChildren(sheet('intro', h('p', {}, 'There are no hexagons on the wall yet. Go back to the configurator and give the wall a size.')));
    return;
  }
  const channels = ctx.topology.channels;
  const lengths = Math.ceil(c.leds / K.CHANNELS_PER_LENGTH);
  const kg = ((c.nodes * K.NODE_GRAMS) / 1000).toFixed(2);
  const sensors = c.nodes - ctx.sensorsLeftOut;
  const general = c.nodes - c.mcu;
  const go = (id) => h('button', { type: 'button', class: 'pb-go no-print', onclick: () => ctx.go(id) }, `${GUIDE_PAGES.find((p) => p.id === id).title} →`);
  const whole = frameOf(L);
  const mount3d = (kind, cls = '') => {
    const box = h('div', { class: `pb-parts pb-3d ${cls}`, 'data-3d': kind });
    ctx.mount3d(box, kind);
    return box;
  };

  // 1. the finished wall, what it is and what it does
  const intro = sheet(
    'intro',
    h('p', { class: 'kicker' }, 'Assembly guide'),
    h('h1', { class: 'cover-title' }, ctx.name),
    svgEl(whole, ctx.snapshot ? baseDrawing(ctx, L, whole, y) : baseDrawing(ctx, L, whole, y, { channels }) + nodeMarks(L, ctx.allNodes, y), 'pb-wall'),
    h('p', { class: 'caption' }, `${plural(L.hexes.length, 'hexagon')} · ${plural(c.leds, 'LED channel')} · ${c.leds * K.LEDS_PER_CHANNEL} LEDs · ${plural(c.nodes, 'node')} · ${ctx.formatLength(L.W)} × ${ctx.formatLength(L.H)} wall`),
    h('h3', {}, 'The hexagon project'),
    h('p', {}, 'A hexagon wall is a honeycomb of light. Every side of every hexagon is an LED channel: a strip of tiny lights in a black aluminium channel. Where the sides meet sits a node, a small 3D-printed stack that holds a circuit board, the channel ends and a touch sensor. At the centre of each hexagon is its own brain, the MCU node M, with an ESP32 that drives that hexagon’s lights.'),
    h('h3', {}, 'What it does'),
    h(
      'ul',
      { class: 'doodles' },
      h('li', {}, 'Lights every channel in any colour or pattern, LED by LED.'),
      h('li', {}, 'Feels touch: tap a node and the wall can answer right there.'),
      h('li', {}, 'Each hexagon runs on its own ESP32-ETH01 and 5 V supply, linked by Ethernet, so the wall grows a hexagon at a time.'),
    ),
    h('h3', {}, 'How to use this guide'),
    h('p', {}, 'Each page takes one part of the build. Pick a page from the contents on the left, or step through with Next. Drawings are of this wall: hover them for details, and step through the hexagons one at a time where a page shows one.'),
  );

  // filled in just before the book is printed: where to open it online, at the very top of the first page
  intro.prepend(h('div', { class: 'print-head print-only' }));

  // 2. the order of work
  const steps = sheet(
    'steps',
    h('p', {}, 'Work through these in order. Tick them off as you go.'),
    h(
      'ol',
      { class: 'steps' },
      h(
        'li',
        {},
        h('h3', {}, 'Prepare the nodes'),
        h(
          'ol',
          { class: 'substeps' },
          h('li', {}, `3D print the bottom, middle and top plates for ${plural(c.nodes, 'node')}: about ${K.NODE_GRAMS} g each, ${kg} kg of filament in all.`),
          h('li', {}, `Press a touch sensor into the top plate of ${plural(sensors, 'node')}${ctx.sensorsLeftOut ? `; ${plural(ctx.sensorsLeftOut, 'node goes', 'nodes go')} without one` : ''}.`),
          h('li', {}, 'Stand each circuit board off the bottom plate on three M3 × 6 mm standoffs, then stack the middle and top plates with M3 screws and nuts.'),
        ),
        go('nodes'),
      ),
      h(
        'li',
        {},
        h('h3', {}, 'Complete the circuits'),
        h(
          'ol',
          { class: 'substeps' },
          h('li', {}, `Have the boards made from the KiCad files: ${plural(c.mcu, 'Central Node')} (one per hexagon) and ${plural(general, 'General Node')}.`),
          h('li', {}, 'Solder the six 4-pin LED ports, the PCF8574 touch expander and its resistors, and the sockets for the touch sensor and the I2C pair.'),
          h('li', {}, 'On every General Node solder the four DIP switches; on every Central Node the XT60 power input and the 8-pin lead to the ESP32.'),
        ),
        go('circuits'),
      ),
      h(
        'li',
        {},
        h('h3', {}, 'Prepare the LED channels'),
        h(
          'ol',
          { class: 'substeps' },
          h('li', {}, `Cut the aluminium channels to ${K.CHANNEL_CM} cm: ${K.CHANNELS_PER_LENGTH} from each ${K.LENGTH_CM / 100} m length, ${plural(c.leds, 'channel')} from ${plural(lengths, 'length')}. Paint them black.`),
          h('li', {}, `Put the LED strip in: ${K.LEDS_PER_CHANNEL} LEDs in each channel, the DIN end at the IN side.`),
          h('li', {}, `Solder a 2510 4-pin connector at each end (${plural(c.leds * 2, 'connector')}): 5V, SIG and GND to pins 1, 2 and 4, and the FREE jump wire from pin 3 to pin 3.`),
        ),
        go('channels'),
      ),
      h(
        'li',
        {},
        h('h3', {}, 'Put everything together'),
        h(
          'ol',
          { class: 'substeps' },
          h('li', {}, 'Screw every node to the backboard where its hexagon puts it, turned so its arrow points the way shown.'),
          h('li', {}, 'Set each General Node’s DIP switches as listed for it.'),
          h('li', {}, 'Plug in every LED channel so its data runs the way its arrow shows.'),
          h('li', {}, 'Wire the touch sensors and the SDA / SCL twisted pairs, then power each hexagon and connect its ESP32 by Ethernet.'),
        ),
        h('div', { class: 'pb-gos' }, go('backboard'), go('placement'), go('wiring')),
      ),
    ),
  );

  // 3. the node and its layers
  const counts = {};
  for (const n of ctx.allNodes) counts[n.kind] = (counts[n.kind] ?? 0) + 1;
  const nodes = sheet(
    'nodes',
    h('p', {}, 'Every node is a stack of three 3D-printed layers around a circuit board. The first model shows them coming together; then each layer on its own. Drag any of them to turn it.'),
    mount3d('node', 'four'),
    h(
      'div',
      { class: 'pb-parts-captions four' },
      h('div', {}, h('b', {}, 'Assembled'), h('span', {}, 'the three layers stacked')),
      h('div', {}, h('b', {}, 'Bottom'), h('span', {}, 'holds the circuit')),
      h('div', {}, h('b', {}, 'Middle'), h('span', {}, 'holds the LED channels')),
      h('div', {}, h('b', {}, 'Top'), h('span', {}, 'holds the touch sensor')),
    ),
    h('h3', {}, 'The layers'),
    h(
      'dl',
      { class: 'pb-defs' },
      h('dt', {}, 'Bottom plate and cover'),
      h('dd', {}, 'Screws to the backboard with two drywall screws. The circuit board stands off it on three M3 × 6 mm standoffs, its six LED ports facing out through the sides.'),
      h('dt', {}, 'Middle plate'),
      h('dd', {}, 'Takes the ends of up to six LED channels, one on each side, so the channels’ connectors meet the board’s ports.'),
      h('dt', {}, 'Top plate'),
      h('dd', {}, 'Closes the stack and holds the touch sensor under its face, wired to the board’s 3-pin socket. Three M3 screws and nuts hold the layers together.'),
    ),
    h('h3', {}, 'Nodes on this wall'),
    h(
      'table',
      { class: 'pb-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Node'), h('th', {}, 'Labels'), h('th', {}, 'Board'), h('th', { class: 'n' }, 'How many'))),
      h(
        'tbody',
        {},
        [
          ['mcu', 'M', 'Central Node'],
          ['normal', '1–9, E1–E3', 'General Node'],
          ['edge', 'a–f, on the outline', 'General Node'],
          ['2way', 'a–f, shared by two hexagons', 'General Node'],
          ['3way', 'a–f, shared by three hexagons', 'General Node'],
        ]
          .filter(([k]) => counts[k])
          .map(([k, labels, board]) => h('tr', {}, h('td', {}, h('i', { class: `sw k-${k}` }), ' ', KIND_NAMES[k]), h('td', {}, labels), h('td', {}, board), h('td', { class: 'n' }, String(counts[k])))),
      ),
    ),
    h('p', { class: 'caption' }, `${plural(sensors, 'node')} with a touch sensor${ctx.sensorsLeftOut ? `, ${ctx.sensorsLeftOut} without` : ''}. A node’s node-1 side is the one its touch sensor is wired toward; it is the side its arrow points on the backboard page.`),
  );

  // 4. the two circuit boards
  const circuits = sheet(
    'circuits',
    h('p', {}, 'Two boards, both hexagons the size of a node, drawn here from their KiCad designs. Drag either one to turn it.'),
    mount3d('circuits', 'two'),
    h('div', { class: 'pb-parts-captions two' }, h('div', {}, h('b', {}, 'Central Node'), h('span', {}, `${plural(c.mcu, 'board')}, one per hexagon`)), h('div', {}, h('b', {}, 'General Node'), h('span', {}, `${plural(general, 'board')}, every other node`))),
    h('div', { class: 'pb-cols' },
      h(
        'div',
        {},
        h('h3', {}, 'Central Node'),
        h('p', {}, 'Sits at M, the centre of each hexagon, and starts all six of its LED chains.'),
        h(
          'ul',
          { class: 'doodles' },
          h('li', {}, 'XT60 input for the hexagon’s 5 V supply, shared to every port.'),
          h('li', {}, '8-pin JST EH lead to the ESP32-ETH01: one data line for each of the six ports, plus SDA and SCL.'),
          h('li', {}, 'Six Molex KK-254 4-pin LED ports, L1–L6.'),
          h('li', {}, 'PCF8574 I/O expander on I2C, reading pin 3 of each port, with three sockets for the touch pairs coming in from T1–T3.'),
          h('li', {}, '3-pin socket for its own touch sensor.'),
        ),
      ),
      h(
        'div',
        {},
        h('h3', {}, 'General Node'),
        h('p', {}, 'Every other node: it passes data from the channel coming in to the one going out.'),
        h(
          'ul',
          { class: 'doodles' },
          h('li', {}, 'Six Molex KK-254 4-pin LED ports, L1–L6, with 5V and GND joined through.'),
          h('li', {}, 'Four 2-way DIP switches, SW1–SW4, that link the data pins of the ports: set per node so each chain takes its path.'),
          h('li', {}, 'PCF8574 I/O expander for touch, its address set by R1–R3, with I2C sockets J1 and J16.'),
          h('li', {}, '3-pin socket for the touch sensor; its signal also goes out on pin 3 of port L1.'),
        ),
      ),
    ),
    h('h3', {}, 'The LED ports'),
    h('p', {}, 'Every port takes a channel’s 2510 connector, pins in the same order on both boards. L1 is the node-1 side; L2–L6 follow clockwise, seen from the front.'),
    h('div', { class: 'pb-key' }, h('span', { class: 'k v5' }, '1 · 5V'), h('span', { class: 'k sig' }, '2 · SIG'), h('span', { class: 'k free' }, '3 · FREE'), h('span', { class: 'k gnd' }, '4 · GND')),
    h('h3', {}, 'What each switch joins'),
    h(
      'table',
      { class: 'pb-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Switch'), h('th', {}, 'Position 1'), h('th', {}, 'Position 2'))),
      h('tbody', {}, [1, 2, 3, 4].map((sw) => h('tr', {}, h('td', {}, `SW${sw}`), ...[1, 2].map((pos) => {
        const x = DIP_CONTACTS.find((d) => d.sw === sw && d.pos === pos);
        return h('td', {}, `${x.a.replace('.', ' ')} ↔ ${x.b.replace('.', ' ')}`);
      })))),
    ),
  );

  // 5. the LED channel
  const channelsSheet = sheet(
    'channels',
    h('p', {}, `We get aluminium channel in ${K.LENGTH_CM / 100} m lengths, cut it to ${K.CHANNEL_CM} cm and paint it black. Inside goes a strip of ${K.LEDS_PER_CHANNEL} LEDs (a ${K.LEDS_PER_M}-per-metre WS2812B strip). At each end a 2510 4-pin connector is soldered on with 3 wires, 5V, SIG and GND, and one FREE jump wire runs straight from one connector to the other, past the LEDs.`),
    mount3d('channel', 'one'),
    h('div', { class: 'pb-figure' }, channelDrawing(K)),
    h('div', { class: 'pb-key' }, h('span', { class: 'k v5' }, '1 · 5V'), h('span', { class: 'k sig' }, '2 · SIG'), h('span', { class: 'k free' }, '3 · FREE'), h('span', { class: 'k gnd' }, '4 · GND')),
    h('h3', {}, 'Making one'),
    h(
      'ol',
      { class: 'substeps' },
      h('li', {}, `Cut ${plural(c.leds, 'channel')} to ${K.CHANNEL_CM} cm from ${plural(lengths, 'length')}; file the cut ends smooth.`),
      h('li', {}, 'Paint them black and let them dry.'),
      h('li', {}, `Cut the strip into pieces of ${K.LEDS_PER_CHANNEL} LEDs and stick one in each channel, its DIN end (the arrows on the strip point away from it) at the IN side.`),
      h('li', {}, 'Solder 5V, SIG and GND from the strip’s pads to pins 1, 2 and 4 of the connector at each end.'),
      h('li', {}, 'Run the FREE jump wire from pin 3 at one end to pin 3 at the other, under the strip.'),
      h('li', {}, 'Mark the IN end, so the channel goes in the right way round.'),
    ),
  );

  // 6. nodes on the backboard: the wall to explore, then a hexagon at a time with each node's switches
  const switches = ctx.switches;
  const nodeTip = (n) => {
    const s = switches.get(n);
    const sw = isCentral(n) ? 'Central Node · no switches' : s ? dipText(s.dip) : 'all switches off';
    return `${n.label} · ${KIND_NAMES[n.kind] ?? n.kind} in ${n.hexId}\n${sw}${s?.clash ? '\nneeds a fix, see its card' : ''}`;
  };
  const nodeHits = (nodes) => nodes.map((n) => `<circle class="pb-nhit${switches.get(n)?.clash ? ' clash' : ''}" data-node="${n.key}" cx="${fmt(n.x)}" cy="${fmt(y(n.z))}" r="${fmt(lat.rho * 1.5)}" data-tip="${esc(nodeTip(n))}"/>`).join('');
  const boardBrowser = browser('backboard', L, (hex) => {
    const mine = nodesOf(L, ctx.allNodes, hex).sort(byLabel);
    const box = frameOf(L, hex, 0.62);
    const drawing = svgEl(box, baseDrawing(ctx, L, box, y, { hex }) + nodeMarks(L, mine, y, { arrows: true, labels: true, scale: 1.4, bodies: !ctx.snapshot }) + nodeHits(mine), 'pb-zoom');
    tipOn(drawing);
    const cards = h('div', { class: 'sw-cards' }, mine.map((n) => switchCard(n, switches.get(n), hex)));
    // a card and its node light up together
    const light = (key) => {
      for (const el of drawing.querySelectorAll('.pb-nhit.on')) el.classList.remove('on');
      for (const el of cards.querySelectorAll('.sw-card.on')) el.classList.remove('on');
      if (!key) return;
      drawing.querySelector(`.pb-nhit[data-node="${key}"]`)?.classList.add('on');
      cards.querySelector(`.sw-card[data-node="${key}"]`)?.classList.add('on');
    };
    for (const card of cards.children) {
      card.addEventListener('pointerenter', () => light(card.dataset.node));
      card.addEventListener('pointerleave', () => light(null));
    }
    drawing.addEventListener('pointermove', (e) => light(e.target.closest?.('.pb-nhit')?.dataset.node ?? null));
    drawing.addEventListener('pointerleave', () => light(null));
    const corners = mine.filter((n) => /^[a-f]$/.test(n.label ?? ''));
    const borrowed = corners.filter((n) => n.hexId !== hex.id);
    const kinds = {};
    for (const n of mine) kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
    return [
      drawing,
      h(
        'p',
        { class: 'caption' },
        `${hex.id}: ${plural(mine.length, 'node')} (${Object.entries(kinds).map(([k, n]) => `${n} ${KIND_NAMES[k]}${n === 1 ? '' : 's'}`).join(', ')}).`,
        borrowed.length ? ` Corners ${borrowed.map((n) => `${n.label} (from ${n.hexId})`).join(', ')} are fitted with their neighbours.` : '',
      ),
      h('h3', {}, `Switch settings in ${hex.id}`),
      cards,
    ];
  });
  const wallSvg = svgEl(whole, baseDrawing(ctx, L, whole, y) + nodeMarks(L, ctx.allNodes, y, { arrows: true, bodies: !ctx.snapshot }) + pickHexes(L, y) + nodeHits(ctx.allNodes), 'pb-wall pickable');
  tipOn(wallSvg);
  pickInto(wallSvg, boardBrowser);
  const clashes = [...switches].filter(([, s]) => s.clash);
  const allSwitches = h(
    'details',
    { class: 'pb-all' },
    h('summary', {}, h('span', {}, `Every node’s switches (${switches.size} General Nodes)`)),
    h(
      'table',
      { class: 'pb-table dips' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Hexagon'), h('th', {}, 'Node'), ...[1, 2, 3, 4].map((i) => h('th', {}, `SW${i}`)))),
      h(
        'tbody',
        {},
        L.hexes.flatMap((hex) =>
          ctx.allNodes
            .filter((n) => n.hexId === hex.id && !isCentral(n))
            .sort(byLabel)
            .map((n) => {
              const s = switches.get(n);
              const dip = s?.dip ?? [[false, false], [false, false], [false, false], [false, false]];
              return h('tr', { class: s?.clash ? 'clash' : null }, h('td', {}, hex.id), h('td', {}, n.label ?? '?'), ...dip.map((pair) => h('td', {}, pair.map((on, i) => h('span', { class: on ? 'on' : 'off' }, `${i + 1} ${on ? 'ON' : 'off'}`)))));
            }),
        ),
      ),
    ),
  );
  const backboard = sheet(
    'backboard',
    h('p', {}, 'Each node screws to the backboard where its hexagon puts it. Every node is turned a set way: the arrow shows where its node-1 side points. Drag to pan and zoom with the buttons; hover a node for its switches, or click a hexagon to see it alone below.'),
    zoomable(wallSvg, whole),
    h('div', { class: 'pb-legend' }, ['mcu', 'normal', 'edge', '2way', '3way'].map((k) => h('span', {}, h('i', { class: `sw k-${k}` }), KIND_NAMES[k]))),
    h('h3', {}, 'Switch combinations'),
    h('p', {}, 'Each General Node has four DIP switches that link the data pins of its ports, so the data of every chain goes on to the right channel. Every node needs its own setting: set them before the node goes on the board, slider up for ON.'),
    clashes.length ? h('p', { class: 'sw-warn' }, `${plural(clashes.length, 'node')} (${clashes.map(([n]) => `${n.label} in ${n.hexId}`).join(', ')}) cannot be routed by the switches alone; their cards say what to do.`) : null,
    boardBrowser,
    allSwitches,
  );

  // 7. which way each LED channel runs, with the data running down a hovered chain
  const jumps = ctx.jumps;
  const chanBrowser = browser('placement', L, (hex) => {
    const box = frameOf(L, hex, 0.62);
    const mine = nodesOf(L, ctx.allNodes, hex);
    const arrows = ctx.arrows.filter((a) => a.hexId === hex.id);
    const drawing = svgEl(box, baseDrawing(ctx, L, box, y, { hex, channels, softLeds: true }) + nodeMarks(L, mine, y, { labels: true, scale: 1.4, bodies: !ctx.snapshot }) + arrowsSvg(arrows, jumps.filter((j) => j.hexId === hex.id), lat, y), 'pb-zoom wires');
    hoverWires(drawing);
    tipOn(drawing);
    const chains = ctx.topology.chains.filter((x) => x.hexId === hex.id).sort((a, b) => a.id.localeCompare(b.id));
    const list = h('ul', { class: 'pb-chains' }, chains.map((ch) => h('li', { class: `w-${ch.key}`, 'data-chain': ch.id }, h('i', { class: 'sw' }), h('b', {}, ch.id), h('span', {}, chainPath(ch)))));
    for (const li of list.children) {
      li.addEventListener('pointerenter', () => focusWires(drawing, li.dataset.chain, hex.id));
      li.addEventListener('pointerleave', () => focusWires(drawing, null));
    }
    return [drawing, list, h('p', { class: 'caption' }, 'Each chain starts at M. → runs through the LEDs of a channel; ⇢ is the hop back on the FREE wire. Hover a chain to watch its data run.')];
  });
  const placementSvg = svgEl(whole, baseDrawing(ctx, L, whole, y, { softLeds: true }) + pickHexes(L, y) + arrowsSvg(ctx.arrows, jumps, lat, y), 'pb-wall pickable wires');
  hoverWires(placementSvg);
  tipOn(placementSvg);
  pickInto(placementSvg, chanBrowser);
  let placementKeyTarget = placementSvg;
  const placement = sheet(
    'placement',
    h('p', {}, 'Every LED channel has a direction: data goes in at DIN and out at DOUT. Fit each channel so its arrow points the way shown, in the colour of the chain that drives it. Hover a channel to watch its signal run down the chain, through the dotted bypass where it jumps onto a channel’s FREE wire and back. Click a hexagon to see it alone below.'),
    zoomable(placementSvg, whole),
    wireKey([1, 2, 3, 4, 5, 6].map((k) => [`L${k}`, `w-${k}`]), 'six', () => placementKeyTarget),
    chanBrowser,
  );
  placementKeyTarget = placementSvg;

  // 8. strip wiring and touch sensors, a hexagon at a time
  let stripTarget = null;
  const stripBrowser = browser('wiring', L, (hex) => {
    const box = frameOf(L, hex, 0.62);
    const mine = nodesOf(L, ctx.allNodes, hex);
    const drawing = svgEl(box, baseDrawing(ctx, L, box, y, { hex, channels, softLeds: true }) + wiringSvg(onlyHex(ctx.wiring, hex.id), y) + nodeMarks(L, mine, y, { labels: true, scale: 1.4, bodies: !ctx.snapshot }), 'pb-zoom wires');
    hoverWires(drawing);
    tipOn(drawing);
    stripTarget = drawing;
    return [drawing];
  });
  let touchTarget = null;
  const touchBrowser = browser('touch', L, (hex) => {
    const box = frameOf(L, hex, 0.62);
    const mine = nodesOf(L, ctx.allNodes, hex);
    const drawing = svgEl(box, baseDrawing(ctx, L, box, y, { hex, channels, softLeds: true }) + sensorsSvg(onlyHex(ctx.sensors, hex.id), lat, y) + nodeMarks(L, mine, y, { labels: true, scale: 1.4, bodies: !ctx.snapshot }), 'pb-zoom wires');
    hoverWires(drawing);
    tipOn(drawing);
    touchTarget = drawing;
    return [drawing];
  });
  const wiring = sheet(
    'wiring',
    h('h3', {}, 'Strip wiring'),
    h('p', {}, 'Each hexagon’s M drives six chains, L1–L6. A chain runs out from M through the LEDs of one channel after another. At a turn (E1–E3, or a neighbour’s 3, 6 or 9) its DOUT SIG is switched onto pin 3 FREE of its partner channel, rides back past the LEDs, and is switched to that channel’s DIN SIG again at the inner node: the dotted rings. 5V and GND run through every connector. Hover a wire, or a chain in the key, to pick it out.'),
    h('div', { class: 'pb-cols narrow' }, h('div', { html: CONNECTOR_SVG }), h('div', {}, h('p', { class: 'help' }, 'A 2510 4-pin connector at each end of every channel, pins 1–4 in the same order at both ends. A coloured bar on the drawing marks a channel’s IN end.'), wireKey([1, 2, 3, 4, 5, 6].map((k) => [`L${k}`, `w-${k}`]), 'six', () => stripTarget))),
    stripBrowser,
    h('h3', {}, 'Touch sensors'),
    h('p', {}, `Each node’s sensor is wired, from the dot, to M or to T1, T2, T3 (collected at nodes 3, 6 and 9); a ring is a node that takes its own. T1, T2 and T3 each go on to M as a twisted SDA / SCL pair: 3 → 4 → M, 6 → 7 → M, 9 → 1 → M. ${ctx.sensorsLeftOut ? `The ${plural(ctx.sensorsLeftOut, 'node')} left without a sensor in the configurator ${ctx.sensorsLeftOut === 1 ? 'is' : 'are'} left out here. ` : ''}Hover a wire, or a group in the key, to pick it out.`),
    wireKey([['M', 't-m'], ['T1', 't-1'], ['T2', 't-2'], ['T3', 't-3']], 'tkey', () => touchTarget),
    touchBrowser,
  );

  root.replaceChildren(intro, steps, nodes, circuits, channelsSheet, backboard, placement, wiring, bomSheet(ctx));
}

// Shows one sheet of the guide; the rest stay drawn so the printed book has them all. Going forward the old sheet
// turns over from its left edge like a book's page, uncovering the new one; going back the new one turns in over
// the old. dir is 1, -1, or 0 for no turn.
export function showGuidePage(root, id, dir = 0) {
  const sheets = [...root.querySelectorAll('.sheet[data-gpage]')];
  const old = sheets.find((s) => s.classList.contains('current'));
  const next = sheets.find((s) => s.dataset.gpage === id);
  for (const s of root.querySelectorAll('.turning')) s.classList.remove('turning', 'turn-out', 'turn-in', 'under');
  root.scrollTop = 0;
  const top = old?.offsetTop ?? 0;
  for (const s of sheets) s.classList.toggle('current', s === next);
  if (!old || !next || old === next || !dir || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // the old sheet is lifted out of the flow onto the new one's place: on top while it turns away, beneath while the
  // new one turns in over it
  const moving = dir > 0 ? old : next;
  const still = dir > 0 ? next : old;
  old.style.top = `${top}px`;
  if (dir < 0) old.classList.add('turning', 'under');
  moving.classList.add('turning', dir > 0 ? 'turn-out' : 'turn-in');
  const done = () => {
    moving.classList.remove('turning', 'turn-out', 'turn-in');
    still.classList.remove('turning', 'under');
    old.style.top = '';
  };
  // the shade on the page runs its own animation, whose end also reaches here
  const end = (e) => {
    if (e.target !== moving || e.pseudoElement) return;
    moving.removeEventListener('animationend', end);
    done();
  };
  moving.addEventListener('animationend', end);
  // in case the animation never runs (a hidden tab), the sheets settle anyway
  setTimeout(done, 1200);
}
