// Page 4, the build guide: a sketchbook that walks from the finished wall down to its parts. A cover with the wall
// drawn by hand, the steps to make a hexagon, the node's three layers in 3D, one LED channel up close, where every
// node and channel goes (a hexagon at a time), and the parts list, which can be edited, added to and exported.
import { hexPoints, sketch, esc, arrowsSvg } from './render.js';
import { chainPath } from './wiring.js';

const fmt = (v) => +v.toFixed(5);
const rad = (d) => (d * Math.PI) / 180;
const KIND_NAMES = { mcu: 'MCU node', normal: 'built-in node', edge: 'edge node', '2way': '2-way node', '3way': '3-way node' };
const CUSTOM_SECTION = 'Extras';

// the hexagon each browser box shows, kept while the guide is redrawn
const browse = { nodes: null, channels: null };

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

function sheet(num, title, ...kids) {
  return h('section', { class: 'sheet' }, h('h2', { class: 'sheet-title' }, num != null ? h('span', { class: 'num' }, String(num)) : null, title), ...kids);
}

// --- drawings of the wall --------------------------------------------------------------------------------------

// the whole wall, or one hexagon of it with a margin, in SVG units with y running down from the wall's top
function frameOf(L, only = null) {
  const pts = [];
  const hexes = only ? [only] : L.hexes;
  for (const x of hexes) for (let k = 0; k < 6; k++) pts.push({ x: x.x + L.lat.R * Math.cos(rad(30 + 60 * k)), z: x.z + L.lat.R * Math.sin(rad(30 + 60 * k)) });
  for (const e of L.edges) if (!only || e.hexId === only.id) pts.push({ x: e.tipX, z: e.tipZ });
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => L.H - p.z);
  const pad = L.lat.R * (only ? 0.22 : 0.12);
  const x0 = Math.min(...xs) - pad;
  const y0 = Math.min(...ys) - pad;
  return { x: x0, y: y0, w: Math.max(...xs) + pad - x0, h: Math.max(...ys) + pad - y0 };
}

const hexOutlines = (L, y, faint = () => false) =>
  L.hexes.map((x) => `<g class="pb-hex${faint(x) ? ' faint' : ''}" data-hex="${x.id}"><polygon class="fill" points="${hexPoints(x.x, y(x.z), L.lat.R, 0)}"/>${sketch(x.x, y(x.z), L.lat.R, x.id)}</g>`).join('');

const edgeStrips = (L, y, faint = () => false) =>
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
      return `<polygon class="pb-edge${faint(e) ? ' faint' : ''}" points="${pts.map(([px, pz]) => `${fmt(px)},${fmt(y(pz))}`).join(' ')}"/>`;
    })
    .join('');

// an LED channel as a painted-black bar with its LEDs dotted along it
function channelBars(L, channels, y, faint = () => false) {
  const rho = L.lat.rho;
  return channels
    .map((c) => {
      const dx = c.out.x - c.in.x;
      const dz = c.out.z - c.in.z;
      const len = Math.hypot(dx, dz);
      const a = { x: c.in.x + (dx / len) * rho * 1.1, z: c.in.z + (dz / len) * rho * 1.1 };
      const b = { x: c.out.x - (dx / len) * rho * 1.1, z: c.out.z - (dz / len) * rho * 1.1 };
      const d = `M${fmt(a.x)},${fmt(y(a.z))}L${fmt(b.x)},${fmt(y(b.z))}`;
      const cls = faint(c) ? ' faint' : '';
      return `<path class="pb-chan${cls}" d="${d}" stroke-width="${fmt(rho * 0.7)}"/><path class="pb-leds${cls}" d="${d}" pathLength="15" stroke-width="${fmt(rho * 0.3)}"/>`;
    })
    .join('');
}

// a node as a small hexagon in its kind's colour, with a tiny arrow for the way its node-1 side points
function nodeMarks(L, nodes, y, { arrows = false, labels = false, faint = () => false, scale = 1 } = {}) {
  const r = L.lat.rho * scale;
  return nodes
    .map((n) => {
      const cls = faint(n) ? ' faint' : '';
      let out = `<polygon class="pb-node k-${n.kind}${cls}" points="${hexPoints(n.x, y(n.z), r, 0)}"><title>${esc(`${n.label ?? ''} · ${KIND_NAMES[n.kind] ?? n.kind}`)}</title></polygon>`;
      if (arrows && n.facing != null) {
        const u = { x: Math.cos(rad(n.facing)), z: Math.sin(rad(n.facing)) };
        const n2 = { x: -u.z, z: u.x };
        const tail = { x: n.x + u.x * r * 0.95, z: n.z + u.z * r * 0.95 };
        const tip = { x: n.x + u.x * r * 2.9, z: n.z + u.z * r * 2.9 };
        const base = { x: n.x + u.x * r * 2.1, z: n.z + u.z * r * 2.1 };
        const k = r * 0.55;
        out += `<path class="pb-face${cls}" d="M${fmt(tail.x)},${fmt(y(tail.z))}L${fmt(base.x)},${fmt(y(base.z))}"/>`;
        out += `<polygon class="pb-face-head${cls}" points="${fmt(tip.x)},${fmt(y(tip.z))} ${fmt(base.x + n2.x * k)},${fmt(y(base.z + n2.z * k))} ${fmt(base.x - n2.x * k)},${fmt(y(base.z - n2.z * k))}"/>`;
      }
      if (labels) out += `<text class="pb-nlabel${cls}" x="${fmt(n.x)}" y="${fmt(y(n.z))}" font-size="${fmt(r * 0.95)}">${esc(n.label ?? '')}</text>`;
      return out;
    })
    .join('');
}

// nodes that sit on a hexagon: inside or on its outline, and the plates on its own Edges
function nodesOf(L, allNodes, hex) {
  return allNodes.filter((n) => n.hexId === hex.id || Math.hypot(n.x - hex.x, n.z - hex.z) <= L.lat.R * 1.02);
}

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
  box.append(
    h('div', { class: 'pb-browser-bar' }, h('button', { type: 'button', class: 'btn', 'aria-label': 'Previous hexagon', onclick: () => step(-1) }, '◀'), select, count, h('button', { type: 'button', class: 'btn', 'aria-label': 'Next hexagon', onclick: () => step(1) }, '▶')),
    body,
  );
  go(browse[kind]);
  box.goTo = go;
  return box;
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
const isUrl = (s) => /^https?:\/\/\S+$/i.test(s.trim());

function bomSheet(ctx, num_) {
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
    const head = h('div', { class: 'pb-row cols', role: 'row' }, ['Item', 'Description', 'Qty', 'Price each', 'Amount', 'Link / contact', ''].map((t) => h('span', { role: 'columnheader' }, t)));
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
            else if ((k === 'desc' || k === 'link') && v === '') delete o[k];
            else o[k] = v;
            if (!Object.keys(o).length) delete edits.overrides[item.key];
          }
        };
        const link = field('link', item.link, { placeholder: 'shop link, phone…', 'aria-label': `Link or contact for ${item.label || 'item'}` }, (v) => set('link', v.trim()));
        let rowEl = null;
        rows.push(() => {
          if (!rowEl || item.custom) return;
          const o = edits.overrides[item.key] ?? {};
          for (const k of ['desc', 'qty', 'rate', 'link']) rowEl.querySelector(`input.${k}`)?.classList.toggle('edited', k in o);
          tools.hidden = !Object.keys(o).length;
        });
        const open = isUrl(item.link ?? '') ? h('a', { class: 'go', href: item.link.trim(), target: '_blank', rel: 'noopener', title: 'Open link' }, '↗') : null;
        out.push(
          (rowEl = h(
            'div',
            { class: `pb-row item${item.custom ? ' custom' : ''}`, role: 'row' },
            label,
            field('desc', item.desc, { placeholder: 'description', 'aria-label': `Description of ${item.label || 'item'}` }, (v) => set('desc', v)),
            field('qty', item.qty, { type: 'number', min: '0', step: 'any', inputmode: 'decimal', placeholder: '--', 'aria-label': `Quantity of ${item.label || 'item'}` }, (v) => set('qty', num(v))),
            field('rate', item.rate, { type: 'number', min: '0', step: 'any', inputmode: 'decimal', placeholder: '--', 'aria-label': `Price each of ${item.label || 'item'}` }, (v) => set('rate', num(v))),
            amountEl,
            h('span', { class: 'linkcell' }, link, open),
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

  const shareOut = h('div', { class: 'pb-share-out', hidden: true });
  return sheet(
    num_,
    'Parts list',
    h('p', {}, 'Everything to buy for this wall. Change any quantity, price or description, add where to buy it, or add your own items. Your changes stay in this browser until you share the guide.'),
    h(
      'div',
      { class: 'pb-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => ctx.exportExcel(mergeBom(ctx.bom, edits)) }, 'Export Excel'),
      h('button', { type: 'button', class: 'btn', onclick: () => printBom(ctx, mergeBom(ctx.bom, edits)) }, 'Export PDF'),
      h('button', { type: 'button', class: 'btn primary', onclick: () => shareGuide(ctx, shareOut) }, 'Share guide'),
    ),
    shareOut,
    table,
  );
}

// the PDF is the browser's print to PDF of a plain table, and nothing else on the page
function printBom(ctx, merged) {
  const { rupees } = ctx;
  const host = document.getElementById('pb-print');
  const money = (v) => (v == null ? '' : rupees(v));
  const cell = (tag, text, cls) => h(tag, cls ? { class: cls } : {}, text ?? '');
  const rows = [];
  for (const sec of merged.sections) {
    if (!sec.items.length) continue;
    rows.push(h('tr', { class: 'sec' }, cell('td', sec.title), cell('td', ''), cell('td', ''), cell('td', ''), cell('td', money(sum(sec.items)), 'n'), cell('td', '')));
    for (const i of sec.items) {
      rows.push(h('tr', {}, cell('td', i.label), cell('td', i.desc), cell('td', i.qty ?? '', 'n'), cell('td', money(i.rate), 'n'), cell('td', money(cost(i)), 'n'), cell('td', i.link)));
    }
  }
  rows.push(h('tr', { class: 'total' }, cell('td', 'Total'), cell('td', ''), cell('td', ''), cell('td', ''), cell('td', money(sum(merged.sections.flatMap((s) => s.items))), 'n'), cell('td', '')));
  host.replaceChildren(
    h('h1', {}, `${ctx.name} · parts list`),
    h('p', {}, `${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })} · prices in rupees`),
    h('table', {}, h('thead', {}, h('tr', {}, ['Item', 'Description', 'Qty', 'Price each', 'Amount', 'Link / contact'].map((t, i) => cell('th', t, i >= 2 && i <= 4 ? 'n' : '')))), h('tbody', {}, rows)),
  );
  const title = document.title;
  document.title = `${ctx.name} parts`;
  window.print();
  document.title = title;
}

async function shareGuide(ctx, out) {
  out.hidden = false;
  out.replaceChildren(h('span', {}, 'Saving…'));
  try {
    const url = await ctx.share(ctx.edits);
    const input = h('input', { class: 'url', value: url, readonly: true, 'aria-label': 'Share link', onfocus: (e) => e.target.select() });
    const copy = h('button', { type: 'button', class: 'btn', onclick: async () => {
      try {
        await navigator.clipboard.writeText(url);
        copy.textContent = 'Copied';
      } catch {
        input.select();
      }
    } }, 'Copy');
    out.replaceChildren(h('span', {}, 'Anyone with this link can open and edit this guide:'), input, copy);
  } catch (err) {
    out.replaceChildren(h('span', { class: 'err' }, `Could not share: ${err.message}`));
  }
}

// --- the guide ------------------------------------------------------------------------------------------------

export function renderPlaybook(root, ctx) {
  const L = ctx.layout;
  const { lat } = L;
  const y = (z) => L.H - z;
  const c = ctx.counts;
  const K = ctx.constants;
  if (!L.hexes.length) {
    root.replaceChildren(sheet(null, 'Build guide', h('p', {}, 'There are no hexagons on the wall yet. Go back to page 1 and give the wall a size.')));
    return;
  }
  const channels = ctx.topology.channels;
  const lengths = Math.ceil(c.leds / K.CHANNELS_PER_LENGTH);
  const kg = ((c.nodes * K.NODE_GRAMS) / 1000).toFixed(2);
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  // cover: the wall sketched, what this is and what it does
  const whole = frameOf(L);
  const cover = h(
    'section',
    { class: 'sheet cover' },
    h('p', { class: 'kicker' }, 'Build guide'),
    h('h1', {}, ctx.name),
    svgEl(whole, hexOutlines(L, y) + edgeStrips(L, y) + channelBars(L, channels, y) + nodeMarks(L, ctx.allNodes, y), 'pb-wall'),
    h('p', { class: 'caption' }, `${plural(L.hexes.length, 'hexagon')} · ${plural(c.leds, 'LED channel')} · ${c.leds * K.LEDS_PER_CHANNEL} LEDs · ${plural(c.nodes, 'node')}`),
    h('h3', {}, 'The hexagon project'),
    h('p', {}, 'A hexagon wall is a honeycomb of light. Every side of every hexagon is an LED channel: a strip of tiny lights in a black aluminium channel. Where the sides meet sits a node, a small 3D-printed stack that holds the channel ends, the wiring and a touch sensor. At the centre of each hexagon is its own brain, the MCU node M, with an ESP32 that drives that hexagon’s lights.'),
    h('h3', {}, 'What it does'),
    h(
      'ul',
      { class: 'doodles' },
      h('li', {}, 'Lights every channel in any colour or pattern, LED by LED.'),
      h('li', {}, 'Feels touch: tap a node and the wall can answer right there.'),
      h('li', {}, 'Each hexagon runs on its own ESP32-ETH01 and 5 V supply, linked by Ethernet, so the wall grows a hexagon at a time.'),
      h('li', {}, `This one is ${plural(L.hexes.length, 'hexagon')} across a ${ctx.formatLength(L.W)} × ${ctx.formatLength(L.H)} wall.`),
    ),
  );

  // the order of work, so far
  const steps = sheet(
    1,
    'Making a complete hexagon',
    h('p', {}, 'Work through these in order. Tick them off as you go.'),
    h(
      'ol',
      { class: 'steps' },
      h(
        'li',
        {},
        h('h3', {}, 'Prepare the LED channels'),
        h(
          'ol',
          { class: 'substeps' },
          h('li', {}, `Get the connectors: ${plural(c.leds * 2, '2510 4-pin connector')}, 2 for every channel.`),
          h('li', {}, `Cut the aluminium channels to ${K.CHANNEL_CM} cm: ${K.CHANNELS_PER_LENGTH} from each ${K.LENGTH_CM / 100} m length, ${plural(c.leds, 'channel')} from ${plural(lengths, 'length')}.`),
          h('li', {}, 'Paint them black, and let them dry.'),
          h('li', {}, `Put the LED strip in: ${K.LEDS_PER_CHANNEL} LEDs in each channel, the DIN end at the IN side.`),
          h('li', {}, 'Solder a connector at each end: 5V, SIG and GND to pins 1, 2 and 4, and the FREE jump wire from pin 3 to pin 3.'),
        ),
      ),
      h(
        'li',
        {},
        h('h3', {}, 'Prepare the nodes'),
        h('ol', { class: 'substeps' }, h('li', {}, `3D print the bottom, middle and top plates for ${plural(c.nodes, 'node')}: about ${K.NODE_GRAMS} g each, ${kg} kg of filament in all.`)),
      ),
      h('li', { class: 'later' }, h('h3', {}, 'More steps to come…')),
    ),
  );

  // the node's three layers
  const partsBox = h('div', { class: 'pb-parts' });
  const node = sheet(
    2,
    'Meet the node',
    h('p', {}, 'Every node is a stack of three 3D-printed layers. Drag one to turn it.'),
    partsBox,
    h(
      'div',
      { class: 'pb-parts-captions' },
      h('div', {}, h('b', {}, 'Bottom'), h('span', {}, 'holds the circuit')),
      h('div', {}, h('b', {}, 'Middle'), h('span', {}, 'holds the LED channels')),
      h('div', {}, h('b', {}, 'Top'), h('span', {}, 'holds the touch sensor')),
    ),
  );
  ctx.mountParts(partsBox);

  const channel = sheet(
    3,
    'The LED channel',
    h('p', {}, `We get aluminium channel in ${K.LENGTH_CM / 100} m lengths, cut it to ${K.CHANNEL_CM} cm and paint it black. Inside goes a strip of ${K.LEDS_PER_CHANNEL} LEDs (a ${K.LEDS_PER_M}-per-metre strip). At each end a 2510 4-pin connector is soldered on with 3 wires, 5V, SIG and GND, and one FREE jump wire runs straight from one connector to the other, past the LEDs.`),
    h('div', { class: 'pb-figure' }, channelDrawing(K)),
    h('div', { class: 'pb-key' }, h('span', { class: 'k v5' }, '1 · 5V'), h('span', { class: 'k sig' }, '2 · SIG'), h('span', { class: 'k free' }, '3 · FREE'), h('span', { class: 'k gnd' }, '4 · GND')),
  );

  // where every node goes
  const nodeBrowser = browser('nodes', L, (hex) => {
    const mine = new Set(nodesOf(L, ctx.allNodes, hex));
    const box = frameOf(L, hex);
    const faint = (n) => !mine.has(n);
    const drawing = svgEl(box, hexOutlines(L, y, (x) => x.id !== hex.id) + edgeStrips(L, y, (e) => e.hexId !== hex.id) + nodeMarks(L, ctx.allNodes, y, { arrows: true, labels: true, faint, scale: 1.4 }), 'pb-zoom');
    const corners = [...mine].filter((n) => /^[a-f]$/.test(n.label ?? ''));
    const borrowed = corners.filter((n) => n.hexId !== hex.id);
    const kinds = {};
    for (const n of mine) kinds[n.kind] = (kinds[n.kind] ?? 0) + 1;
    return [
      drawing,
      h(
        'p',
        { class: 'caption' },
        `${hex.id}: ${plural(mine.size, 'node')} (${Object.entries(kinds).map(([k, n]) => `${n} ${KIND_NAMES[k]}${n === 1 ? '' : 's'}`).join(', ')}).`,
        borrowed.length ? ` Corners ${borrowed.map((n) => `${n.label} (from ${n.hexId})`).join(', ')} are fitted with their neighbours.` : '',
      ),
    ];
  });
  const placements = sheet(
    4,
    'Node placements',
    h('p', {}, 'Here is the wall with just its hexagon outlines and where each node sits. Every node is turned a set way: the tiny arrow shows where its node-1 side points. Click a hexagon, or step through them below, to see one at a time.'),
    svgEl(whole, hexOutlines(L, y) + edgeStrips(L, y) + nodeMarks(L, ctx.allNodes, y, { arrows: true }), 'pb-wall pick'),
    h('div', { class: 'pb-legend' }, ['mcu', 'normal', 'edge', '2way', '3way'].map((k) => h('span', {}, h('i', { class: `sw k-${k}` }), KIND_NAMES[k]))),
    nodeBrowser,
  );

  // which way each LED channel runs
  const chanBrowser = browser('channels', L, (hex) => {
    const box = frameOf(L, hex);
    const arrows = ctx.arrows.filter((a) => a.hexId === hex.id);
    const others = ctx.arrows.filter((a) => a.hexId !== hex.id);
    const drawing = svgEl(
      box,
      hexOutlines(L, y, (x) => x.id !== hex.id) + edgeStrips(L, y, (e) => e.hexId !== hex.id) + nodeMarks(L, ctx.allNodes, y, { labels: true, faint: (n) => n.hexId !== hex.id && Math.hypot(n.x - hex.x, n.z - hex.z) > lat.R * 1.02, scale: 1.4 }) + `<g class="faint">${arrowsSvg(others, null, lat, y)}</g>` + arrowsSvg(arrows, null, lat, y),
      'pb-zoom',
    );
    const chains = ctx.topology.chains.filter((x) => x.hexId === hex.id).sort((a, b) => a.id.localeCompare(b.id));
    return [
      drawing,
      h('ul', { class: 'pb-chains' }, chains.map((ch) => h('li', { class: `w-${ch.key}` }, h('i', { class: 'sw' }), h('b', {}, ch.id), h('span', {}, chainPath(ch))))),
      h('p', { class: 'caption' }, 'Each chain starts at M. → runs through the LEDs of a channel; ⇢ is the hop back on the FREE wire.'),
    ];
  });
  const chanPlacements = sheet(
    5,
    'LED channel placements',
    h('p', {}, 'Every LED channel has a direction: data goes in at DIN and out at DOUT. Fit each channel so its arrow points the way shown, in the colour of the chain that drives it. Click a hexagon, or step through them below.'),
    svgEl(whole, hexOutlines(L, y) + edgeStrips(L, y) + arrowsSvg(ctx.arrows, null, lat, y), 'pb-wall pick'),
    h('div', { class: 'pb-legend' }, [1, 2, 3, 4, 5, 6].map((k) => h('span', { class: `w-${k}` }, h('i', { class: 'sw' }), `L${k}`))),
    chanBrowser,
  );

  // a click on a hexagon in an overview shows it in that sheet's browser
  for (const [sec, b] of [
    [placements, nodeBrowser],
    [chanPlacements, chanBrowser],
  ]) {
    sec.querySelector('svg.pick').addEventListener('click', (e) => {
      const id = e.target.closest('[data-hex]')?.dataset.hex;
      if (!id) return;
      b.goTo(id);
      b.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  const share = h('div', { class: 'pb-top' }, h('span', { class: 'kicker' }, ctx.shared ? 'Shared with you · edits stay in this browser' : ''), h('button', { type: 'button', class: 'btn', onclick: () => root.querySelector('.pb-bom')?.closest('.sheet').scrollIntoView({ behavior: 'smooth' }) }, 'Parts list ↓'));
  root.replaceChildren(share, cover, steps, node, channel, placements, chanPlacements, bomSheet(ctx, 6));
}
