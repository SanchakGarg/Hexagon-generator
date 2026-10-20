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
export function renderWall(svg, { W, H, hexes, nodes, edges, excluded = [], selected = new Set(), lat, formatLength }) {
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
  parts.push(`<g class="dim">
    <line x1="0" y1="${fmt(dy)}" x2="${fmt(W)}" y2="${fmt(dy)}"/>
    <line x1="0" y1="${fmt(dy - tick)}" x2="0" y2="${fmt(dy + tick)}"/>
    <line x1="${fmt(W)}" y1="${fmt(dy - tick)}" x2="${fmt(W)}" y2="${fmt(dy + tick)}"/>
    <text x="${fmt(W / 2)}" y="${fmt(dy - tick * 1.4)}" text-anchor="middle" font-size="${fmt(fsDim)}">${esc(formatLength(W))}</text>
    <line x1="${fmt(dx)}" y1="0" x2="${fmt(dx)}" y2="${fmt(H)}"/>
    <line x1="${fmt(dx - tick)}" y1="0" x2="${fmt(dx + tick)}" y2="0"/>
    <line x1="${fmt(dx - tick)}" y1="${fmt(H)}" x2="${fmt(dx + tick)}" y2="${fmt(H)}"/>
    <text x="${fmt(dx - tick * 1.4)}" y="${fmt(H / 2)}" text-anchor="middle" font-size="${fmt(fsDim)}" transform="rotate(-90 ${fmt(dx - tick * 1.4)} ${fmt(H / 2)})">${esc(formatLength(H))}</text>
  </g>`);

  const jointsByHex = new Map(hexes.map((h) => [h.id, []]));
  for (const n of nodes) for (const j of n.joints) jointsByHex.get(j.hexId).push(`${j.hexFrame} → ${n.id}.${j.nodeFrame}`);

  for (const h of excluded) {
    const tip = `${h.id} · row ${h.row}, col ${h.col}\nexcluded · click to restore`;
    parts.push(`<g class="hex ghost" data-ghost="${h.id}" data-tip="${esc(tip)}">
      <polygon points="${hexPoints(h.x, y(h.z), lat.R, 0)}"/>
      <text x="${fmt(h.x)}" y="${fmt(y(h.z) + fsHex * 0.35)}" text-anchor="middle" font-size="${fmt(fsHex)}">${h.id}</text>
    </g>`);
  }

  for (const h of hexes) {
    const tip = `${h.id} · row ${h.row}, col ${h.col}\nclick to ${selected.has(h.id) ? 'deselect' : 'select'}\n${jointsByHex.get(h.id).sort().join('\n')}`;
    parts.push(`<g class="hex${selected.has(h.id) ? ' selected' : ''}" data-hex="${h.id}" data-tip="${esc(tip)}">
      <polygon points="${hexPoints(h.x, y(h.z), lat.R, 0)}"/>
      <text x="${fmt(h.x)}" y="${fmt(y(h.z) + fsHex * 0.35)}" text-anchor="middle" font-size="${fmt(fsHex)}">${h.id}</text>
    </g>`);
  }

  const edgesByNode = new Map();
  for (const e of edges) {
    const half = Math.max(0.012, size * 0.005);
    const tip = `${e.id} · Edge of ${e.hexId}\n${e.edgeFrame} ↔ ${e.nodeId}.${e.nodeFrame}\nlength ${formatLength(lat.edge.length)}`;
    parts.push(`<polygon class="edge" data-tip="${esc(tip)}" points="${stripPoints(e.x, y(e.z), e.tipX, y(e.tipZ), half)}"/>`);
    edgesByNode.set(e.nodeId, [...(edgesByNode.get(e.nodeId) ?? []), `${e.nodeFrame} ↔ ${e.id}.${e.edgeFrame}`]);
  }

  for (const n of nodes) {
    const lines = [...n.joints.map((j) => `${j.nodeFrame} ↔ ${j.hexId}.${j.hexFrame}`), ...(edgesByNode.get(n.id) ?? [])].sort();
    const tip = `${n.id} · ${n.kind} (${n.type} corner) · part of ${n.hexId}\n${lines.join('\n')}\nspare: ${n.spare.join(', ') || 'none'}`;
    parts.push(`<polygon class="node node-${n.kind.replace('-', '')}" data-tip="${esc(tip)}" points="${hexPoints(n.x, y(n.z), nodeR, n.rotation)}"/>`);
  }

  svg.innerHTML = parts.join('');
  return viewBox;
}
