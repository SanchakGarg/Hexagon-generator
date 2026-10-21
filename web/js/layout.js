// All lengths in meters. Wall plane = URDF X (right) by Z (up).

// User-specified mating: 11, 21 and 31 (the upward corners) take node-5 and 12, 22 and 32 (the downward corners)
// take node-1. Each node is turned to make its own hexagon's frame meet that one; where hexagons share a node,
// one of them sets the turn and the others mate whichever frame then faces them.
const UP_CORNERS = new Set([30, 150, 270]);
const PREFERRED = { up: 'node-5', down: 'node-1' };
// which hexagon turns a shared node when no Edge decides it
const TURN_ORDER = ['11', '22', '12', '21', '31', '32'];
// A hexagon panel builds three of its six sides itself (right, upper-left, lower-left: side normals 0°, 120°, 240°);
// the neighbour across each of the other three builds that one. Where that neighbour is missing, an Edge completes
// the side, mating edge-1 to node-1 of the node at its upper-pointing end (the 30°, 150° or 270° corner), the node
// the hexagon holds by node-5. That node-1 runs along the side, so the Edge lies on it.
const EDGE_FRAME = 'edge-1';
const BORROWED_SIDES = [60, 180, 300];

const rad = (d) => (d * Math.PI) / 180;
const norm = (d) => ((d % 360) + 360) % 360;
const deg = (r) => norm((r * 180) / Math.PI);
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const snapCorner = (a) => norm(30 + Math.round((a - 30) / 60) * 60);
const angleDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

function centroid(points) {
  return { x: avg(points.map((p) => p.x)), y: avg(points.map((p) => p.y ?? 0)), z: avg(points.map((p) => p.z)) };
}

export function deriveLattice(hexFrames, nodeFrames, nodeBodyRadius) {
  const nc = centroid(Object.values(nodeFrames));
  const nodeAngles = {};
  const radii = [];
  for (const [name, p] of Object.entries(nodeFrames)) {
    radii.push(Math.hypot(p.x - nc.x, p.z - nc.z));
    nodeAngles[name] = deg(Math.atan2(p.z - nc.z, p.x - nc.x));
  }
  const r = avg(radii);

  const hc = centroid(Object.values(hexFrames));
  const cornerOf = {};
  const Rs = [];
  for (const [name, p] of Object.entries(hexFrames)) {
    const dx = p.x - hc.x;
    const dz = p.z - hc.z;
    const a = snapCorner(deg(Math.atan2(dz, dx)));
    const du = dx * Math.cos(rad(a)) + dz * Math.sin(rad(a));
    // frame sits at distance r from the corner at distance R along u(a)
    Rs.push(du + Math.sqrt(Math.max(0, du * du - (dx * dx + dz * dz) + r * r)));
    cornerOf[name] = a;
  }
  const R = avg(Rs);

  const frameOffset = {};
  let residual = 0;
  for (const [name, p] of Object.entries(hexFrames)) {
    const a = rad(cornerOf[name]);
    const ox = p.x - hc.x - R * Math.cos(a);
    const oz = p.z - hc.z - R * Math.sin(a);
    residual = Math.max(residual, Math.abs(Math.hypot(ox, oz) - r));
    frameOffset[name] = deg(Math.atan2(oz, ox));
  }

  // the turn that makes a node meet each hexagon frame on its preferred node frame
  const turnFor = {};
  for (const [name, a] of Object.entries(cornerOf)) {
    turnFor[name] = norm(frameOffset[name] - nodeAngles[PREFERRED[UP_CORNERS.has(a) ? 'up' : 'down']]);
  }

  return {
    R,
    r,
    rho: nodeBodyRadius,
    pitch: R * Math.sqrt(3),
    rowPitch: 1.5 * R,
    hw: (R * Math.sqrt(3)) / 2 + nodeBodyRadius,
    hh: R + nodeBodyRadius,
    cornerOf,
    turnFor,
    nodeAngles,
    residual,
    frameOffset,
    hexCenter: hc,
    nodeCenter: nc,
    // shift that puts node frames in the same thickness plane as hexagon frames
    nodeYOffset: hc.y - nc.y,
  };
}

// An Edge is one hexagon side with its midpoint plate stack; edge-1 sits at one end of it.
export function deriveEdge(edgeFrames, edgeVisuals, lat) {
  const anchor = edgeFrames[EDGE_FRAME];
  if (!anchor) throw new Error(`Edge URDF has no ${EDGE_FRAME} frame`);
  const plate = edgeVisuals.find((v) => v.part === 'middle_plate');
  const mid = plate
    ? { x: plate.xyz[0], z: plate.xyz[2] }
    : centroid(edgeVisuals.map((v) => ({ x: v.xyz[0], z: v.xyz[2] })));
  const half = Math.hypot(mid.x - anchor.x, mid.z - anchor.z);
  return {
    anchor,
    // direction from edge-1 toward the far end, in the Edge's own XZ plane
    axisAngle: deg(Math.atan2(mid.z - anchor.z, mid.x - anchor.x)),
    length: 2 * half,
    yOffset: lat.hexCenter.y - anchor.y,
  };
}

export function fitWall(W, H, lat) {
  const { pitch, rowPitch, hw, hh } = lat;
  if (W < 2 * hw || H < 2 * hh) return [];

  const eps = 1e-9;
  const rows = Math.floor((H - 2 * hh) / rowPitch + eps) + 1;
  const avail = W - 2 * hw;
  let best = null;
  for (const phase of [0, 1]) {
    const layout = [];
    let total = 0;
    for (let i = 0; i < rows; i++) {
      const shift = ((i + phase) % 2) * (pitch / 2);
      const n = avail + eps < shift ? 0 : Math.floor((avail - shift) / pitch + eps) + 1;
      layout.push({ shift, n });
      total += n;
    }
    if (!best || total > best.total) best = { layout, total };
  }

  const used = best.layout.filter((row) => row.n > 0);
  const minShift = Math.min(...used.map((row) => row.shift));
  const maxRight = Math.max(...used.map((row) => row.shift + (row.n - 1) * pitch));
  const dx = (W - (maxRight - minShift + 2 * hw)) / 2 - minShift;
  // centre on the rows that hold hexagons; a narrow wall leaves its shifted rows empty
  const first = best.layout.findIndex((row) => row.n > 0);
  const last = best.layout.findLastIndex((row) => row.n > 0);
  const dz = (H - (2 * hh + (last - first) * rowPitch)) / 2 - first * rowPitch;

  const hexes = [];
  best.layout.forEach((row, i) => {
    for (let c = 0; c < row.n; c++) {
      hexes.push({
        id: `H${hexes.length + 1}`,
        row: i + 1,
        col: c + 1,
        x: dx + hw + row.shift + c * pitch,
        z: H - dz - hh - i * rowPitch,
      });
    }
  });
  return hexes;
}

// Slide the whole grid so the kept hexagons sit centred on the wall; excluded ones move with it.
export function centerKept(grid, keep, W, H) {
  const kept = grid.filter(keep);
  if (!kept.length) return grid;
  const xs = kept.map((h) => h.x);
  const zs = kept.map((h) => h.z);
  const dx = W / 2 - (Math.min(...xs) + Math.max(...xs)) / 2;
  const dz = H / 2 - (Math.min(...zs) + Math.max(...zs)) / 2;
  return grid.map((h) => ({ ...h, x: h.x + dx, z: h.z + dz }));
}

const nearestFrame = (angles, rotation, target) => {
  let best = null;
  for (const [name, a] of Object.entries(angles)) {
    const d = angleDiff(a + rotation, target);
    if (!best || d < best.d) best = { name, d };
  }
  return best.name;
};

export function buildNodes(hexes, lat) {
  const keyOf = (x, z) => `${Math.round(x * 1e4)},${Math.round(z * 1e4)}`;
  const hexAt = new Set(hexes.map((h) => keyOf(h.x, h.z)));
  const byKey = new Map();
  for (const h of hexes) {
    for (const [frame, a] of Object.entries(lat.cornerOf)) {
      const x = h.x + lat.R * Math.cos(rad(a));
      const z = h.z + lat.R * Math.sin(rad(a));
      const key = keyOf(x, z);
      let node = byKey.get(key);
      if (!node) {
        node = { x, z, type: UP_CORNERS.has(a) ? 'up' : 'down', joints: [] };
        byKey.set(key, node);
      }
      // an Edge mates here when the side this upward corner starts has no neighbour (see buildEdges)
      const side = a + 30;
      const edge =
        UP_CORNERS.has(a) && !hexAt.has(keyOf(h.x + lat.pitch * Math.cos(rad(side)), h.z + lat.pitch * Math.sin(rad(side))));
      node.joints.push({ hexId: h.id, hexFrame: frame, edge });
    }
  }

  // The hexagon with an Edge here turns the node, so edge-1 meets node-1 running along its side; at most one hexagon
  // per node has one. Otherwise the first in TURN_ORDER does. That hexagon owns the node, however many it joins.
  for (const node of byKey.values()) {
    const rank = (j) => (j.edge ? -1 : TURN_ORDER.indexOf(j.hexFrame));
    const lead = node.joints.reduce((a, b) => (rank(b) < rank(a) ? b : a));
    node.rotation = lat.turnFor[lead.hexFrame];
    node.hexId = lead.hexId;
    for (const j of node.joints) {
      j.nodeFrame = nearestFrame(lat.nodeAngles, node.rotation, lat.frameOffset[j.hexFrame]);
      delete j.edge;
    }
  }

  const nodes = [...byKey.values()].sort((a, b) => b.z - a.z || a.x - b.x);
  const allNodeFrames = Object.keys(lat.nodeAngles).sort();
  nodes.forEach((n, i) => {
    n.id = `N${i + 1}`;
    n.kind = n.joints.length === 3 ? '3-way' : n.joints.length === 2 ? '2-way' : 'edge';
    const used = new Set(n.joints.map((j) => j.nodeFrame));
    n.spare = allNodeFrames.filter((f) => !used.has(f));
  });
  return nodes;
}

export function buildEdges(hexes, nodes, lat) {
  if (!lat.edge) return [];
  const { R, r, pitch } = lat;
  const keyOf = (x, z) => `${Math.round(x * 1e4)},${Math.round(z * 1e4)}`;
  const hexAt = new Set(hexes.map((h) => keyOf(h.x, h.z)));
  const nodeAt = new Map(nodes.map((n) => [keyOf(n.x, n.z), n]));
  const corner = (h, a) => ({ x: h.x + R * Math.cos(rad(a)), z: h.z + R * Math.sin(rad(a)) });
  const edges = [];

  for (const h of hexes) {
    for (const side of BORROWED_SIDES) {
      if (hexAt.has(keyOf(h.x + pitch * Math.cos(rad(side)), h.z + pitch * Math.sin(rad(side))))) continue;
      const from = corner(h, side - 30);
      const to = corner(h, side + 30);
      const n = nodeAt.get(keyOf(from.x, from.z));
      if (!n) continue;
      const angle = norm(deg(Math.atan2(to.z - from.z, to.x - from.x)));
      const ux = Math.cos(rad(angle));
      const uz = Math.sin(rad(angle));
      const edge = {
        id: `E${edges.length + 1}`,
        hexId: h.id,
        nodeId: n.id,
        edgeFrame: EDGE_FRAME,
        nodeFrame: nearestFrame(lat.nodeAngles, n.rotation, angle),
        x: n.x + r * ux,
        z: n.z + r * uz,
        angle,
        rotation: norm(angle - lat.edge.axisAngle),
        tipX: n.x + (r + lat.edge.length) * ux,
        tipZ: n.z + (r + lat.edge.length) * uz,
      };
      edges.push(edge);
      n.edges = [...(n.edges ?? []), edge.id];
      n.spare = n.spare.filter((f) => f !== edge.nodeFrame);
    }
  }
  return edges;
}

export function countGroups(hexes, nodes) {
  const parent = new Map(hexes.map((h) => [h.id, h.id]));
  const find = (id) => (parent.get(id) === id ? id : find(parent.get(id)));
  for (const n of nodes) {
    for (let i = 1; i < n.joints.length; i++) {
      parent.set(find(n.joints[i].hexId), find(n.joints[0].hexId));
    }
  }
  return new Set(hexes.map((h) => find(h.id))).size;
}

// What one model carries by itself: a node plate stack per middle plate, and its LED channels.
export function partsOf(visuals) {
  return {
    nodes: visuals.filter((v) => v.part === 'middle_plate').length,
    leds: visuals.filter((v) => v.part.startsWith('led')).length,
  };
}

// Every node and LED on the wall: the joining nodes between hexagons plus those built into each hexagon and Edge.
export function summarize(hexes, nodes, lat, edges = []) {
  const kind = (k) => nodes.filter((n) => n.kind === k).length;
  const counts = {
    edge: kind('edge'),
    '2way': kind('2-way'),
    '3way': kind('3-way'),
    normal: hexes.length * lat.perHex.nodes + edges.length * lat.perEdge.nodes,
    led: hexes.length * lat.perHex.leds,
    edgeled: edges.length * lat.perEdge.leds,
  };
  counts.nodes = nodes.length + counts.normal;
  counts.leds = counts.led + counts.edgeled;
  return { counts, hexagons: hexes.length, groups: countGroups(hexes, nodes) };
}

// Outline of the hexagons as closed loops of corners, each run with the hexagons on its left: the outer boundary
// goes counter-clockwise and the edge of any hole left by excluded hexagons clockwise.
export function buildOutline(hexes, lat) {
  const { R, pitch } = lat;
  const keyOf = (x, z) => `${Math.round(x * 1e4)},${Math.round(z * 1e4)}`;
  const hexAt = new Set(hexes.map((h) => keyOf(h.x, h.z)));
  const corner = (h, a) => ({ x: h.x + R * Math.cos(rad(a)), z: h.z + R * Math.sin(rad(a)) });
  const next = new Map();
  for (const h of hexes) {
    for (let side = 0; side < 360; side += 60) {
      if (hexAt.has(keyOf(h.x + pitch * Math.cos(rad(side)), h.z + pitch * Math.sin(rad(side))))) continue;
      const from = corner(h, side - 30);
      next.set(keyOf(from.x, from.z), { from, to: corner(h, side + 30) });
    }
  }
  // three hexagons meet at every corner, so no corner is on the outline twice
  const loops = [];
  while (next.size) {
    let [key, seg] = next.entries().next().value;
    const loop = [];
    while (seg) {
      next.delete(key);
      loop.push(seg.from);
      key = keyOf(seg.to.x, seg.to.z);
      seg = next.get(key);
    }
    loops.push(loop);
  }
  return loops;
}

// positive for a counter-clockwise loop
export function loopArea(loop) {
  return loop.reduce((s, p, i) => {
    const q = loop[(i + 1) % loop.length];
    return s + (p.x * q.z - q.x * p.z) / 2;
  }, 0);
}

// Moves every side of an outline loop d away from the hexagons (toward them when d is negative), mitring the corners.
export function offsetLoop(loop, d) {
  const normal = (a, b) => {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    return { x: (b.z - a.z) / len, z: -(b.x - a.x) / len };
  };
  return loop.map((p, i) => {
    const n1 = normal(loop[(i + loop.length - 1) % loop.length], p);
    const n2 = normal(p, loop[(i + 1) % loop.length]);
    const k = d / (1 + n1.x * n2.x + n1.z * n2.z);
    return { x: p.x + (n1.x + n2.x) * k, z: p.z + (n1.z + n2.z) * k };
  });
}
