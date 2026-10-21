const rad = (d) => (d * Math.PI) / 180;
const fmt = (v) => +v.toFixed(5);

function hexPoints(cx, cy, radius, rotation) {
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

const sketch = (cx, cy, radius, id) =>
  `<polygon class="sketch" points="${sketchPoints(cx, cy, radius, `${id}a`)}"/><polygon class="sketch" points="${sketchPoints(cx, cy, radius * 0.985, `${id}b`)}"/>`;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

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

// Draws the overlay in wall meters and returns its viewBox, which the mesh renderer matches.
export function renderWall(svg, { W, H, hexes, nodes, edges, excluded = [], selected = new Set(), lat, formatLength, picks = null }) {
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
  const viewBox = {
    x: ext.minX - pad,
    y: ext.minY - pad * 0.5,
    w: ext.maxX - ext.minX + pad * 1.5,
    h: ext.maxY - ext.minY + pad * 1.5,
  };

  const parts = [];
  parts.push(`<rect class="wall" x="0" y="0" width="${fmt(W)}" height="${fmt(H)}"/>`);

  const tick = size * 0.015;
  const dy = ext.maxY + pad * 0.45;
  const dx = ext.minX - pad * 0.45;
  const a = tick * 0.9; // arrowhead size
  parts.push(`<g class="dim">
    <line x1="0" y1="${fmt(dy)}" x2="${fmt(W)}" y2="${fmt(dy)}"/>
    <path d="M${fmt(a)},${fmt(dy - a * 0.6)} L0,${fmt(dy)} L${fmt(a)},${fmt(dy + a * 0.6)} M${fmt(W - a)},${fmt(dy - a * 0.6)} L${fmt(W)},${fmt(dy)} L${fmt(W - a)},${fmt(dy + a * 0.6)}"/>
    <line x1="0" y1="${fmt(dy - tick)}" x2="0" y2="${fmt(dy + tick)}"/>
    <line x1="${fmt(W)}" y1="${fmt(dy - tick)}" x2="${fmt(W)}" y2="${fmt(dy + tick)}"/>
    <text x="${fmt(W / 2)}" y="${fmt(dy - tick * 1.4)}" text-anchor="middle" font-size="${fmt(fsDim)}">${esc(formatLength(W))}</text>
    <line x1="${fmt(dx)}" y1="0" x2="${fmt(dx)}" y2="${fmt(H)}"/>
    <path d="M${fmt(dx - a * 0.6)},${fmt(a)} L${fmt(dx)},0 L${fmt(dx + a * 0.6)},${fmt(a)} M${fmt(dx - a * 0.6)},${fmt(H - a)} L${fmt(dx)},${fmt(H)} L${fmt(dx + a * 0.6)},${fmt(H - a)}"/>
    <line x1="${fmt(dx - tick)}" y1="0" x2="${fmt(dx + tick)}" y2="0"/>
    <line x1="${fmt(dx - tick)}" y1="${fmt(H)}" x2="${fmt(dx + tick)}" y2="${fmt(H)}"/>
    <text x="${fmt(dx - tick * 1.4)}" y="${fmt(H / 2)}" text-anchor="middle" font-size="${fmt(fsDim)}" transform="rotate(-90 ${fmt(dx - tick * 1.4)} ${fmt(H / 2)})">${esc(formatLength(H))}</text>
  </g>`);

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

  // parts page: every node can be picked; picked ones march, ones left without a touch sensor are struck through
  if (picks) {
    const r = lat.rho * 1.5;
    for (const n of picks.nodes) {
      const cls = `pick${picks.selected.has(n.key) ? ' on' : ''}${picks.noSensor.has(n.key) ? ' nosensor' : ''}`;
      const d = r * 0.7;
      parts.push(`<g class="${cls}" data-node="${n.key}"><circle cx="${fmt(n.x)}" cy="${fmt(y(n.z))}" r="${fmt(r)}"/><path d="M${fmt(n.x - d)},${fmt(y(n.z) + d)} L${fmt(n.x + d)},${fmt(y(n.z) - d)}"/></g>`);
    }
  }

  svg.innerHTML = parts.join('');
  return viewBox;
}
