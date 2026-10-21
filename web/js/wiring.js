// LED wiring inside each hexagon, all lengths in meters on the wall plane.
//
// Every LED channel is a NeoPixel strip with a data direction: its IN end takes the data, its OUT end passes it on.
// Each end has four pins: 5V, GND, SIG (the strip's data) and FREE (a spare wire that runs past the LEDs).
//
// The MCU node M drives six chains, a pair around each side the hexagon borrows (60°, 180°, 300°). For side s the
// first chain runs M → inner(s+30) → X on SIG, where X is the node at the middle of side s (an Edge plate, or the
// neighbour's own 3, 6 or 9). There it switches SIG → FREE and rides the FREE wire of its partner's channel back to
// inner(s−30), switches FREE → SIG, and goes on to outer(s−60) → corner(s−30), then along the Edge to its plate if
// side s has an Edge. With a neighbour instead the chain stops at the corner, which the neighbour's controller
// serves. The second chain of the pair is the mirror image. The chains are L1–L6, in the order of their first stops
// 1, 2, 4, 5, 7, 8.

const SIDES = [60, 180, 300];
const CHAIN_NAMES = { 1: 'L1', 2: 'L2', 4: 'L3', 5: 'L4', 7: 'L5', 8: 'L6' };
const rad = (d) => (d * Math.PI) / 180;

// across a channel, looking from IN to OUT, the four wires lie left to right in this order
const LANES = { '5V': 1.5, SIG: 0.5, FREE: -0.5, GND: -1.5, MID: 0 };

export function buildWiring(hexes, edges, lat, allNodes) {
  const R = lat.R;
  const near = (x, z) => {
    let best = null;
    for (const n of allNodes) {
      const d = Math.hypot(n.x - x, n.z - z);
      if (!best || d < best.d) best = { n, d };
    }
    return best && best.d < R * 0.2 ? best.n : null;
  };
  const at = (h, r, a) => near(h.x + r * Math.cos(rad(a)), h.z + r * Math.sin(rad(a)));
  const inner = R / 2;
  const mid = (R * Math.sqrt(3)) / 2;

  const chains = [];
  const channels = [];
  for (const h of hexes) {
    const M = at(h, 0, 0);
    if (!M) continue;
    for (const s of SIDES) {
      const edge = edges.find((e) => e.hexId === h.id && e.side === s);
      const plate = edge && near((edge.x + edge.tipX) / 2, (edge.z + edge.tipZ) / 2);
      for (const sign of [1, -1]) {
        const first = at(h, inner, s + 30 * sign);
        const X = at(h, mid, s);
        const back = at(h, inner, s - 30 * sign);
        const outer = at(h, mid, s - 60 * sign);
        const corner = at(h, R, s - 30 * sign);
        if (!first || !X || !back || !outer || !corner) continue;
        const id = CHAIN_NAMES[first.label] ?? `L${first.label}`;
        const stops = [M, first, X, back, outer, corner];
        if (plate) stops.push(plate);
        const hops = [];
        for (let i = 1; i < stops.length; i++) {
          const from = stops[i - 1];
          const to = stops[i];
          // the hop back from X rides the partner's channel, which runs the other way
          const wire = from === X ? 'FREE' : 'SIG';
          const channel = wire === 'SIG' ? { in: from, out: to, onEdge: !!plate && i === stops.length - 1 } : { in: to, out: from, onEdge: false };
          hops.push({ from, to, wire, channel });
          if (wire === 'SIG') channels.push({ ...channel, chain: id, hexId: h.id });
        }
        chains.push({ id, key: id.slice(1), hexId: h.id, side: s, stops, hops, edge: !!plate });
      }
    }
  }
  return { chains, channels };
}

// a short name for a node in a channel or path, like 7 or E2
const nm = (n) => n.label ?? '?';
export const channelName = (c) => `${nm(c.in)}→${nm(c.out)}`;
export const chainPath = (chain) =>
  chain.hops.map((hop, i) => (i === 0 ? nm(hop.from) : '') + (hop.wire === 'FREE' ? ' ⇢ ' : '→') + nm(hop.to)).join('');

// Smooth wall-space polylines for every wire, shared by the 2D drawing and the 3D model. A channel's four wires run
// side by side in lanes and bow a little along it, like loose cable; a chain's signal wire bends round each node
// into the next channel, and at a switch it crosses from one lane to the other.
export function strandPaths({ chains, channels }, lat) {
  const lane = lat.rho * 0.2;
  const trim = lat.rho * 0.95; // wires meet the connector at the node body's edge
  const geom = (c) => {
    const dx = c.out.x - c.in.x;
    const dz = c.out.z - c.in.z;
    const len = Math.hypot(dx, dz);
    const u = { x: dx / len, z: dz / len };
    return { len, u, n: { x: -u.z, z: u.x } };
  };
  // a wire along a channel, IN to OUT, in the given lane; bowed by a quadratic bend
  const along = (c, which, steps = 10) => {
    const { len, u, n } = geom(c);
    const o = LANES[which] * lane;
    const bow = Math.min(len * 0.04, lane * 1.6);
    const a = { x: c.in.x + u.x * trim + n.x * o, z: c.in.z + u.z * trim + n.z * o };
    const b = { x: c.out.x - u.x * trim + n.x * o, z: c.out.z - u.z * trim + n.z * o };
    const m = { x: (a.x + b.x) / 2 + n.x * bow, z: (a.z + b.z) / 2 + n.z * bow };
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const k = 1 - t;
      pts.push({ x: k * k * a.x + 2 * k * t * m.x + t * t * b.x, z: k * k * a.z + 2 * k * t * m.z + t * t * b.z });
    }
    return pts;
  };
  // a cubic bend from the end of one wire to the start of the next, round the node between them
  const bend = (p0, d0, p3, d3, steps = 8) => {
    const k = trim * 0.9;
    const p1 = { x: p0.x + d0.x * k, z: p0.z + d0.z * k };
    const p2 = { x: p3.x - d3.x * k, z: p3.z - d3.z * k };
    const pts = [];
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const s = 1 - t;
      pts.push({
        x: s * s * s * p0.x + 3 * s * s * t * p1.x + 3 * s * t * t * p2.x + t * t * t * p3.x,
        z: s * s * s * p0.z + 3 * s * s * t * p1.z + 3 * s * t * t * p2.z + t * t * t * p3.z,
      });
    }
    return pts;
  };
  const dirOf = (pts, end) => {
    const [a, b] = end ? [pts[pts.length - 2], pts[pts.length - 1]] : [pts[0], pts[1]];
    const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { x: (b.x - a.x) / l, z: (b.z - a.z) / l };
  };

  const power = [];
  const connectors = [];
  const sheaths = [];
  for (const c of channels) {
    const name = channelName(c);
    // the four wires lie on a pale ribbon, so they read over the dark channel
    sheaths.push({ chain: c.chain, hexId: c.hexId, channel: name, points: along(c, 'MID') });
    for (const which of ['5V', 'GND']) power.push({ which, channel: name, chain: c.chain, hexId: c.hexId, points: along(c, which) });
    const { u, n } = geom(c);
    for (const [end, node, sign] of [['IN', c.in, 1], ['OUT', c.out, -1]]) {
      const x = node.x + u.x * trim * sign;
      const z = node.z + u.z * trim * sign;
      connectors.push({ end, channel: name, node: nm(node), chain: c.chain, hexId: c.hexId, x, z, n, half: lane * 2 });
    }
  }

  const signals = [];
  const arrows = [];
  const switches = [];
  for (const chain of chains) {
    let prev = null;
    chain.hops.forEach((hop, i) => {
      let pts = along(hop.channel, hop.wire);
      if (hop.wire === 'FREE') pts = pts.reverse();
      const lead = prev ? bend(prev[prev.length - 1], dirOf(prev, true), pts[0], dirOf(pts, false)) : [];
      const all = [...(prev ? [prev[prev.length - 1]] : []), ...lead, ...pts];
      signals.push({ chain: chain.id, key: chain.key, hexId: chain.hexId, wire: hop.wire, channel: channelName(hop.channel), from: nm(hop.from), to: nm(hop.to), points: all });
      const m = pts[Math.floor(pts.length / 2)];
      const d = dirOf(pts.slice(Math.floor(pts.length / 2) - 1), false);
      arrows.push({ key: chain.key, chain: chain.id, hexId: chain.hexId, x: m.x, z: m.z, angle: Math.atan2(d.z, d.x) });
      if (i > 0 && hop.wire !== chain.hops[i - 1].wire) {
        switches.push({ key: chain.key, chain: chain.id, hexId: chain.hexId, x: hop.from.x, z: hop.from.z, node: nm(hop.from), text: `${chain.hops[i - 1].wire}→${hop.wire}` });
      }
      prev = pts;
    });
  }
  return { sheaths, signals, power, connectors, arrows, switches, lane };
}
