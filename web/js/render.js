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

export function renderWall(svg, { W, H, hexes, nodes, lat, formatLength }) {
  const size = Math.max(W, H);
  const pad = size * 0.14;
  const fsDim = size * 0.032;
  const fsHex = lat.R * 0.2;
  const nodeR = Math.max(lat.rho, size * 0.007);
  const y = (z) => H - z;

  svg.setAttribute('viewBox', `${fmt(-pad)} ${fmt(-pad * 0.5)} ${fmt(W + pad * 1.5)} ${fmt(H + pad * 1.5)}`);

  const parts = [];
  parts.push(`<rect class="wall" x="0" y="0" width="${fmt(W)}" height="${fmt(H)}"/>`);

  const tick = size * 0.015;
  const dy = H + pad * 0.45;
  const dx = -pad * 0.45;
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

  for (const h of hexes) {
    const tip = `${h.id} · row ${h.row}, col ${h.col}\n${jointsByHex.get(h.id).sort().join('\n')}`;
    parts.push(`<g class="hex" data-tip="${esc(tip)}">
      <polygon points="${hexPoints(h.x, y(h.z), lat.R, 0)}"/>
      <text x="${fmt(h.x)}" y="${fmt(y(h.z) + fsHex * 0.35)}" text-anchor="middle" font-size="${fmt(fsHex)}">${h.id}</text>
    </g>`);
  }

  for (const n of nodes) {
    const lines = n.joints.map((j) => `${j.nodeFrame} ↔ ${j.hexId}.${j.hexFrame}`).sort();
    const tip = `${n.id} · ${n.kind} (${n.type} corner)\n${lines.join('\n')}\nspare: ${n.spare.join(', ')}`;
    parts.push(`<polygon class="node node-${n.kind.replace('-', '')}" data-tip="${esc(tip)}" points="${hexPoints(n.x, y(n.z), nodeR, n.rotation)}"/>`);
  }

  svg.innerHTML = parts.join('');
}
