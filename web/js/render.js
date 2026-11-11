const rad = (d) => (d * Math.PI) / 180;
const fmt = (v) => +v.toFixed(5);

export function hexPoints(cx, cy, radius, rotation) {
  const pts = [];
  for (let k = 0; k < 6; k++) {
    const a = rad(30 + 60 * k + rotation);
    // SVG y grows downward, so the wall's z is negated here
    pts.push(`${fmt(cx + radius * Math.cos(a))},${fmt(cy - radius * Math.sin(a))}`);
  }
  return pts.join(' ');
}

// A hand-drawn copy of a hexagon outline: every corner nudged a little, the same way each time for the same seed,
// so a second pass with another seed reads as a double pencil stroke.
function sketchPoints(cx, cy, radius, seed) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const rand = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296 - 0.5;
  };
  const wiggle = radius * 0.035;
  const pts = [];
  for (let k = 0; k < 6; k++) {
    const a = rad(30 + 60 * k);
    pts.push(`${fmt(cx + radius * Math.cos(a) + rand() * wiggle)},${fmt(cy - radius * Math.sin(a) + rand() * wiggle)}`);
  }
  return pts.join(' ');
}

export const sketch = (cx, cy, radius, id) =>
  `<polygon class="sketch" points="${sketchPoints(cx, cy, radius, `${id}a`)}"/><polygon class="sketch" points="${sketchPoints(cx, cy, radius * 0.985, `${id}b`)}"/>`;

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function stripPoints(x1, y1, x2, y2, halfWidth) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const nx = (-(y2 - y1) / len) * halfWidth;
  const ny = ((x2 - x1) / len) * halfWidth;
  return [
    [x1 + nx, y1 + ny],
    [x2 + nx, y2 + ny],
    [x2 - nx, y2 - ny],
    [x1 - nx, y1 - ny],
  ]
    .map(([px, py]) => `${fmt(px)},${fmt(py)}`)
    .join(' ');
}

const line = (pts, y) => pts.map((p, i) => `${i ? 'L' : 'M'}${fmt(p.x)},${fmt(y(p.z))}`).join('');

// Each chain's signal wire in its own colour (solid on SIG, dashed on FREE), 5V and GND the same everywhere, a
// connector bar at both ends of every channel, chevrons for the data direction and a ring where a chain switches wire.
export function wiringSvg(w, y) {
  const out = ['<g class="wiring">'];
  for (const s of w.sheaths) out.push(`<path class="sheath" data-chain="${s.chain}" data-hex="${s.hexId}" d="${line(s.points, y)}" stroke-width="${fmt(w.lane * 4.4)}"/>`);
  // a wide invisible strip along each channel, a fixed size on screen, so a wire is easy to hover from far out
  for (const s of w.sheaths) {
    out.push(`<path class="hit" data-chain="${s.chain}" data-hex="${s.hexId}" d="${line(s.points, y)}" data-tip="${esc(`${s.chain} · channel ${s.channel}`)}"/>`);
  }
  for (const p of w.power) {
    out.push(`<path class="pwr pwr-${p.which.toLowerCase()}" data-chain="${p.chain}" data-hex="${p.hexId}" d="${line(p.points, y)}" data-tip="${esc(`${p.which} · channel ${p.channel}`)}"/>`);
  }
  for (const s of w.signals) {
    const tip = `${s.chain} · ${s.from} → ${s.to} on ${s.wire}\nchannel ${s.channel}`;
    out.push(`<path class="sig w-${s.key}${s.wire === 'FREE' ? ' free' : ''}" data-chain="${s.chain}" data-hex="${s.hexId}" d="${line(s.points, y)}" data-tip="${esc(tip)}"/>`);
  }
  for (const c of w.connectors) {
    const a = { x: c.x + c.n.x * c.half, z: c.z + c.n.z * c.half };
    const b = { x: c.x - c.n.x * c.half, z: c.z - c.n.z * c.half };
    const tip = `Channel ${c.channel} · ${c.end} (${c.end === 'IN' ? 'DIN' : 'DOUT'}) @ ${c.node}\n2510 4-pin: 1 5V · 2 SIG · 3 FREE · 4 GND`;
    out.push(`<path class="conn ${c.end.toLowerCase()} w-${c.chain.slice(1)}" data-chain="${c.chain}" data-hex="${c.hexId}" d="${line([a, b], y)}" data-tip="${esc(tip)}"/>`);
  }
  const k = w.lane * 1.1;
  for (const a of w.arrows) {
    const ux = Math.cos(a.angle);
    const uz = Math.sin(a.angle);
    const pts = [
      { x: a.x - ux * k + -uz * k, z: a.z - uz * k + ux * k },
      { x: a.x + ux * k * 0.4, z: a.z + uz * k * 0.4 },
      { x: a.x - ux * k - -uz * k, z: a.z - uz * k - ux * k },
    ];
    out.push(`<path class="chev w-${a.key}" data-chain="${a.chain}" data-hex="${a.hexId}" d="${line(pts, y)}"/>`);
  }
  for (const s of w.switches) {
    out.push(`<circle class="switch w-${s.key}" data-chain="${s.chain}" data-hex="${s.hexId}" cx="${fmt(s.x)}" cy="${fmt(y(s.z))}" r="${fmt(w.lane * ('135'.includes(s.key) ? 6.4 : 5.5))}" data-tip="${esc(`${s.chain} switches ${s.text} at ${s.node}`)}"/>`);
  }
  out.push('</g>');
  return out.join('');
}

// The LED channels view: one arrow along each channel from DIN to DOUT, in the colour of the chain that drives it.
// A hovered chain also shows where its signal leaves the LEDs: a dotted line beside the partner channel it rides
// back on, and a dotted ring at each switch. A pulse then runs down the chain hop by hop, like the data passing along.
export function arrowsSvg(arrows, jumps, lat, y) {
  const head = lat.rho * 1.1;
  const out = ['<g class="wiring chans">'];
  for (const a of arrows) {
    const base = { x: a.b.x - a.u.x * head, z: a.b.z - a.u.z * head };
    const n = { x: -a.u.z * head * 0.5, z: a.u.x * head * 0.5 };
    const tri = [a.b, { x: base.x + n.x, z: base.z + n.z }, { x: base.x - n.x, z: base.z - n.z }];
    const attrs = `data-chain="${a.chain}" data-hex="${a.hexId}"`;
    const tip = `Channel ${a.channel} · ${a.chain}\nDIN @ ${a.din} → DOUT @ ${a.dout}`;
    out.push(`<path class="hit" ${attrs} d="${line(a.span, y)}" data-tip="${esc(tip)}"/>`);
    out.push(`<path class="pulse w-${a.key}" ${attrs} d="${line(a.span, y)}" pathLength="100" stroke-width="${fmt(lat.rho * 0.55)}" style="--i:${a.order}"/>`);
    out.push(`<path class="arrow w-${a.key}" ${attrs} d="${line([a.a, base], y)}"/>`);
    out.push(`<polygon class="head w-${a.key}" ${attrs} points="${tri.map((p) => `${fmt(p.x)},${fmt(y(p.z))}`).join(' ')}"/>`);
  }
  for (const j of jumps ?? []) {
    const attrs = `data-chain="${j.chain}" data-hex="${j.hexId}"`;
    out.push(`<path class="jump w-${j.key}" ${attrs} d="${line(j.span, y)}"/>`);
    out.push(`<path class="pulse w-${j.key}" ${attrs} d="${line(j.span, y)}" pathLength="100" stroke-width="${fmt(lat.rho * 0.55)}" style="--i:${j.order}"/>`);
    for (const s of j.switches) {
      out.push(`<circle class="jsw w-${j.key}" ${attrs} cx="${fmt(s.x)}" cy="${fmt(y(s.z))}" r="${fmt(lat.rho * 1.35)}" data-tip="${esc(`${j.chain} switches ${s.text} at ${s.node}`)}"/>`);
    }
  }
  out.push('</g>');
  return out.join('');
}

// The touch sensors view: each node's sensor wire runs to the node that collects it, in that node's colour, with a
// dot where it starts and chevrons toward where it goes; a ring marks a node that takes its own. Each outer node's
// group goes on to M as a twisted SDA / SCL pair.
export const groupClass = (g) => (g === 'M' ? 't-m' : `t-${g.slice(1)}`);
export function sensorsSvg(s, lat, y) {
  const out = ['<g class="wiring touch">'];
  for (const r of s.runs) {
    const attrs = `data-chain="${r.group}" data-hex="${r.hexId}"`;
    const route = [r.from, ...r.via, r.to].join(' → ');
    const tip = `${r.group} · touch sensor at ${r.from}\nwired ${route}`;
    out.push(`<path class="hit" ${attrs} d="${line(r.points, y)}" data-tip="${esc(tip)}"/>`);
    out.push(`<path class="tw ${groupClass(r.group)}" ${attrs} d="${line(r.points, y)}"/>`);
  }
  for (const t of s.trunks) {
    const attrs = `data-chain="${t.group}" data-hex="${t.hexId}"`;
    const tip = `${t.group} · SDA / SCL twisted pair from ${t.from} to M\nwired ${[t.from, ...t.via, t.to].join(' → ')}`;
    out.push(`<path class="hit" ${attrs} d="${line(t.points, y)}" data-tip="${esc(tip)}"/>`);
    t.strands.forEach((pts, i) => out.push(`<path class="twist${i ? ' back' : ''} ${groupClass(t.group)}" ${attrs} d="${line(pts, y)}"/>`));
  }
  const k = s.lane * 1.4;
  for (const a of s.arrows) {
    const ux = Math.cos(a.angle);
    const uz = Math.sin(a.angle);
    const pts = [
      { x: a.x - ux * k - uz * k, z: a.z - uz * k + ux * k },
      { x: a.x + ux * k * 0.4, z: a.z + uz * k * 0.4 },
      { x: a.x - ux * k + uz * k, z: a.z - uz * k - ux * k },
    ];
    out.push(`<path class="chev ${groupClass(a.group)}" data-chain="${a.group}" data-hex="${a.hexId}" d="${line(pts, y)}"/>`);
  }
  for (const d of s.dots) {
    out.push(`<circle class="tdot ${groupClass(d.group)}" data-chain="${d.group}" data-hex="${d.hexId}" cx="${fmt(d.x)}" cy="${fmt(y(d.z))}" r="${fmt(s.lane * 1.3)}"/>`);
  }
  for (const r of s.rings) {
    const tip = `${r.group} · touch sensor at ${r.node}\nwired straight into ${r.node}`;
    out.push(`<circle class="tring ${groupClass(r.group)}" data-chain="${r.group}" data-hex="${r.hexId}" cx="${fmt(r.x)}" cy="${fmt(y(r.z))}" r="${fmt(lat.rho * 1.3)}" data-tip="${esc(tip)}"/>`);
  }
  out.push('</g>');
  return out.join('');
}

// One linear dimension as an engineering drawing draws it, in screen coordinates (y down): extension lines leave
// the feature points p1 and p2 a small gap off and run a little past the dimension line, which sits `offset` out
// along the normal of p1 → p2 with an arrowhead on each extension line, and the value is centred above it, turned
// to run along it and read from below or from the right. When the span is too short for the value, the arrows
// point in from outside and the value goes past the p2 end.
export function dimension(p1, p2, offset, label, { fs, a, gap, ext }) {
  const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const u = { x: (p2.x - p1.x) / len, y: (p2.y - p1.y) / len };
  const n = { x: -u.y, y: u.x };
  const side = Math.sign(offset) || 1;
  const at = (p, s, t = 0) => ({ x: p.x + n.x * s + u.x * t, y: p.y + n.y * s + u.y * t });
  const d1 = at(p1, offset);
  const d2 = at(p2, offset);
  const textW = String(label).length * fs * 0.48;
  const inside = len >= a * 2.4 + textW;
  const head = (tip, dir) => {
    const b = { x: tip.x + u.x * a * dir, y: tip.y + u.y * a * dir };
    return [tip, { x: b.x + n.x * a * 0.3, y: b.y + n.y * a * 0.3 }, { x: b.x - n.x * a * 0.3, y: b.y - n.y * a * 0.3 }];
  };
  let angle = (Math.atan2(u.y, u.x) * 180) / Math.PI;
  if (angle > 90.01 || angle <= -90.01) angle += angle > 0 ? -180 : 180;
  const r = (angle * Math.PI) / 180;
  const up = { x: Math.sin(r), y: -Math.cos(r) };
  const mid = inside ? { x: (d1.x + d2.x) / 2, y: (d1.y + d2.y) / 2 } : at(p2, offset, a * 2.6 + textW / 2);
  return {
    ext: [
      [at(p1, side * gap), at(p1, offset + side * ext)],
      [at(p2, side * gap), at(p2, offset + side * ext)],
    ],
    line: inside ? [d1, d2] : [at(p1, offset, -a * 2.4), at(p2, offset, a * 2.4)],
    arrows: inside ? [head(d1, 1), head(d2, -1)] : [head(d1, -1), head(d2, 1)],
    text: { x: mid.x + up.x * fs * 0.3, y: mid.y + up.y * fs * 0.3, angle, label: String(label), fs },
  };
}

const pts = (list) => list.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ');
export function dimensionSvg(d) {
  const seg = ([p, q]) => `M${fmt(p.x)},${fmt(p.y)} L${fmt(q.x)},${fmt(q.y)}`;
  const t = d.text;
  return `<path class="ext" d="${d.ext.map(seg).join(' ')}"/><path d="${seg(d.line)}"/>${d.arrows.map((h) => `<polygon points="${pts(h)}"/>`).join('')}<text x="${fmt(t.x)}" y="${fmt(t.y)}" text-anchor="middle" font-size="${fmt(t.fs)}" transform="rotate(${fmt(t.angle)} ${fmt(t.x)} ${fmt(t.y)})">${esc(t.label)}</text>`;
}

// The overall size of one hexagon (the top-left one, which has open space above and to its left), in screen
// coordinates and lettered the same size as the wall's: its width across the flats above it, and its height
// corner to corner on its left.
export function hexDimensions(hexes, lat, y, formatLength, size) {
  if (!hexes.length) return null;
  const h = hexes.reduce((b, c) => (y(c.z) < y(b.z) - 1e-6 || (Math.abs(y(c.z) - y(b.z)) < 1e-6 && c.x < b.x) ? c : b));
  const R = lat.R;
  const f = lat.pitch / 2;
  const cx = h.x;
  const cy = y(h.z);
  const style = { fs: size * 0.03, a: size * 0.016, gap: size * 0.006, ext: size * 0.014 };
  const k = style.fs * 2.2; // how far each dimension line stands off the hexagon
  const dims = [
    dimension({ x: cx - f, y: cy - R / 2 }, { x: cx + f, y: cy - R / 2 }, -(R / 2 + k), formatLength(lat.pitch), style),
    dimension({ x: cx, y: cy + R }, { x: cx, y: cy - R }, -(f + k), formatLength(2 * R), style),
  ];
  return { dims, bounds: { minX: cx - f - k - style.fs * 1.5, minY: cy - R - k - style.fs * 1.5 } };
}

// Draws the overlay in wall meters and returns its viewBox, which the mesh renderer matches.
export function renderWall(svg, { W, H, hexes, nodes, edges, excluded = [], selected = new Set(), lat, formatLength, picks = null, labels = null, wiring = null, channelArrows = null, channelJumps = null, sensors = null, sheets = null, hexDims = false }) {
  const size = Math.max(W, H);
  const pad = size * 0.14;
  const fsDim = size * 0.032;
  const fsHex = lat.R * 0.2;
  const nodeR = Math.max(lat.rho, size * 0.007);
  const y = (z) => H - z;

  // frame the wall plus every Edge tip
  const ext = { minX: 0, maxX: W, minY: 0, maxY: H };
  for (const e of edges) {
    ext.minX = Math.min(ext.minX, e.tipX);
    ext.maxX = Math.max(ext.maxX, e.tipX);
    ext.minY = Math.min(ext.minY, y(e.tipZ));
    ext.maxY = Math.max(ext.maxY, y(e.tipZ));
  }
  // re-centring can slide excluded outlines past the wall edge
  for (const h of excluded) {
    ext.minX = Math.min(ext.minX, h.x - lat.hw);
    ext.maxX = Math.max(ext.maxX, h.x + lat.hw);
    ext.minY = Math.min(ext.minY, y(h.z) - lat.hh);
    ext.maxY = Math.max(ext.maxY, y(h.z) + lat.hh);
  }
  // the sheets page: the stock sheets can reach past the wall
  for (const c of sheets?.plan.cells ?? []) {
    ext.minX = Math.min(ext.minX, c.x0);
    ext.maxX = Math.max(ext.maxX, c.x1);
    ext.minY = Math.min(ext.minY, y(c.z1));
    ext.maxY = Math.max(ext.maxY, y(c.z0));
  }
  // page 1 with dimensions on: one hexagon dimensioned, given room above and to its left
  const hd = hexDims ? hexDimensions(hexes, lat, y, formatLength, size) : null;
  if (hd) {
    ext.minX = Math.min(ext.minX, hd.bounds.minX);
    ext.minY = Math.min(ext.minY, hd.bounds.minY);
  }
  const viewBox = {
    x: ext.minX - pad,
    y: ext.minY - pad * 0.5,
    w: ext.maxX - ext.minX + pad * 1.5,
    h: ext.maxY - ext.minY + pad * 1.5,
  };

  const parts = [];
  parts.push(`<rect class="wall" x="0" y="0" width="${fmt(W)}" height="${fmt(H)}"/>`);

  const wallDim = { fs: fsDim, a: size * 0.016, gap: size * 0.006, ext: size * 0.014 };
  const dy = ext.maxY + pad * 0.45;
  const dx = ext.minX - pad * 0.45;
  parts.push(`<g class="dim">${dimensionSvg(dimension({ x: 0, y: H }, { x: W, y: H }, dy - H, formatLength(W), wallDim))}${dimensionSvg(dimension({ x: 0, y: H }, { x: 0, y: 0 }, dx, formatLength(H), wallDim))}</g>`);

  // the sheets page: the board shaded, and each sheet over it as a dashed box with its number
  if (sheets) {
    const d = sheets.loops.map((l) => `M${l.map((p) => `${fmt(p.x)},${fmt(y(p.z))}`).join(' L')} Z`).join(' ');
    parts.push(`<path class="board-rim" d="${d}" fill-rule="evenodd"/>`);
    for (const c of sheets.plan.cells) {
      parts.push(`<rect class="sheet-cell" x="${fmt(c.x0)}" y="${fmt(y(c.z1))}" width="${fmt(c.x1 - c.x0)}" height="${fmt(c.z1 - c.z0)}"/>`);
    }
  }

  for (const h of excluded) {
    const tip = `${h.id} · row ${h.row}, col ${h.col}\nExcluded · click to restore`;
    parts.push(`<g class="hex ghost" data-ghost="${h.id}" data-tip="${esc(tip)}">
      <polygon points="${hexPoints(h.x, y(h.z), lat.R, 0)}"/>${sketch(h.x, y(h.z), lat.R, h.id)}
      <text x="${fmt(h.x)}" y="${fmt(y(h.z) + fsHex * 0.35)}" text-anchor="middle" font-size="${fmt(fsHex)}">${h.id}</text>
    </g>`);
  }

  // placed hexagons and their parts carry no tooltip: hovering one brings up its note of nodes and LEDs instead
  for (const h of hexes) {
    parts.push(`<g class="hex${selected.has(h.id) ? ' selected' : ''}" data-hex="${h.id}">
      <polygon points="${hexPoints(h.x, y(h.z), lat.R, 0)}"/>${sketch(h.x, y(h.z), lat.R, h.id)}
      <text x="${fmt(h.x)}" y="${fmt(y(h.z) + fsHex * 0.35)}" text-anchor="middle" font-size="${fmt(fsHex)}">${h.id}</text>
    </g>`);
  }

  const half = Math.max(0.012, size * 0.005);
  for (const e of edges) parts.push(`<polygon class="edge" points="${stripPoints(e.x, y(e.z), e.tipX, y(e.tipZ), half)}"/>`);
  for (const n of nodes) {
    parts.push(`<polygon class="node node-${n.kind.replace('-', '')}" points="${hexPoints(n.x, y(n.z), nodeR, n.rotation)}"/>`);
  }

  if (hd) parts.push(`<g class="dim hexdim">${hd.dims.map(dimensionSvg).join('')}</g>`);

  // labels page: the LED wiring, under the node labels
  if (wiring) parts.push(wiringSvg(wiring, y));
  if (channelArrows) parts.push(arrowsSvg(channelArrows, channelJumps, lat, y));
  if (sensors) parts.push(sensorsSvg(sensors, lat, y));

  // labels page: a tiny label at the centre of every node, the same set in each hexagon
  if (labels) {
    const fs = lat.rho * 0.9;
    for (const n of labels) {
      parts.push(`<text class="nlabel" x="${fmt(n.x)}" y="${fmt(y(n.z))}" font-size="${fmt(fs)}">${esc(n.label ?? '')}</text>`);
    }
  }

  // parts page: every node can be picked; picked ones march, ones left without a touch sensor are struck through
  if (picks) {
    const r = lat.rho * 1.5;
    for (const n of picks.nodes) {
      const cls = `pick${picks.selected.has(n.key) ? ' on' : ''}${picks.noSensor.has(n.key) ? ' nosensor' : ''}`;
      const d = r * 0.7;
      parts.push(`<g class="${cls}" data-node="${n.key}"><circle cx="${fmt(n.x)}" cy="${fmt(y(n.z))}" r="${fmt(r)}"/><path d="M${fmt(n.x - d)},${fmt(y(n.z) + d)} L${fmt(n.x + d)},${fmt(y(n.z) - d)}"/></g>`);
    }
  }

  if (sheets) {
    const fs = Math.min(sheets.plan.sw, sheets.plan.sh) * 0.16;
    for (const c of sheets.plan.cells) {
      parts.push(`<text class="sheet-num" x="${fmt(c.x0 + fs * 0.35)}" y="${fmt(y(c.z1) + fs * 1.05)}" font-size="${fmt(fs)}">${c.n}</text>`);
    }
  }

  svg.innerHTML = parts.join('');
  return viewBox;
}
