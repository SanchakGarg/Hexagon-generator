// All lengths in meters. Wall plane = URDF X (right) by Z (up).

// User-specified mating anchors; every other frame pairing follows from geometry.
const ANCHORS = {
  up: { hexFrame: '11', nodeFrame: 'node-1' },
  down: { hexFrame: '22', nodeFrame: 'node-1' },
};
const UP_CORNERS = new Set([30, 150, 270]);
// A hexagon panel builds three of its six sides itself (right, upper-left, lower-left: side normals 0°, 120°, 240°);
// the neighbour across each of the other three builds that one. Where that neighbour is missing, an Edge completes
// the side, mating edge-1 to the node at its upper-pointing end (the 30°, 150° or 270° corner) on the node frame that
// runs along the side. Nodes keep their standard turn, so the hexagon joints are untouched.
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

  const nodeRotation = {};
  for (const [type, { hexFrame, nodeFrame }] of Object.entries(ANCHORS)) {
    nodeRotation[type] = norm(frameOffset[hexFrame] - nodeAngles[nodeFrame]);
  }

  const mating = {};
  for (const [name, a] of Object.entries(cornerOf)) {
    const rot = nodeRotation[UP_CORNERS.has(a) ? 'up' : 'down'];
    let best = null;
    for (const [nf, na] of Object.entries(nodeAngles)) {
      const d = angleDiff(na + rot, frameOffset[name]);
      if (!best || d < best.d) best = { nf, d };
    }
    mating[name] = best.nf;
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
    mating,
    nodeAngles,
    nodeRotation,
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

export function buildNodes(hexes, lat) {
  const byKey = new Map();
  for (const h of hexes) {
    for (const [frame, a] of Object.entries(lat.cornerOf)) {
      const x = h.x + lat.R * Math.cos(rad(a));
      const z = h.z + lat.R * Math.sin(rad(a));
      const key = `${Math.round(x * 1e4)},${Math.round(z * 1e4)}`;
      let node = byKey.get(key);
      if (!node) {
        const type = UP_CORNERS.has(a) ? 'up' : 'down';
        node = { x, z, type, rotation: lat.nodeRotation[type], joints: [] };
        byKey.set(key, node);
      }
      node.joints.push({ hexId: h.id, hexFrame: frame, nodeFrame: lat.mating[frame] });
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

const nearestFrame = (angles, rotation, target) => {
  let best = null;
  for (const [name, a] of Object.entries(angles)) {
    const d = angleDiff(a + rotation, target);
    if (!best || d < best.d) best = { name, d };
  }
  return best.name;
};

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

export function summarize(W, H, hexes, nodes, lat, edges = []) {
  const hexArea = ((3 * Math.sqrt(3)) / 2) * lat.R * lat.R;
  return {
    hexagons: hexes.length,
    nodes: nodes.length,
    threeWay: nodes.filter((n) => n.kind === '3-way').length,
    twoWay: nodes.filter((n) => n.kind === '2-way').length,
    edge: nodes.filter((n) => n.kind === 'edge').length,
    edges: edges.length,
    joints: nodes.reduce((s, n) => s + n.joints.length, 0) + edges.length,
    spareFrames: nodes.reduce((s, n) => s + n.spare.length, 0),
    coverage: (hexes.length * hexArea) / (W * H),
    groups: countGroups(hexes, nodes),
  };
}
