// All lengths in meters. Wall plane = URDF X (right) by Z (up).

// User-specified mating anchors; every other frame pairing follows from geometry.
const ANCHORS = {
  up: { hexFrame: '11', nodeFrame: 'node-1' },
  down: { hexFrame: '22', nodeFrame: 'node-1' },
};
const UP_CORNERS = new Set([30, 150, 270]);
// Edge nodes (one hexagon) get an Edge on their open side, mating its edge-1 frame to an odd node frame there.
const EDGE_FRAME = 'edge-1';
const ODD_FRAMES = ['node-1', 'node-3', 'node-5'];
// the frames the user's hexagon rule mates (11/22 to node-1, 31/12 to node-5)
const HEX_RULE_FRAMES = ['node-1', 'node-5'];

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
  const dz = (H - (2 * hh + (rows - 1) * rowPitch)) / 2;

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

// Which edge nodes of one hexagon carry an Edge. Two edge nodes at the ends of one side share it, so only one of
// them takes an Edge: along a run of neighbouring edge-node corners every other one does, picking the alternation
// that fits more Edges, then the one that keeps the top and bottom corners.
function edgeCorners(cornerAngles) {
  const has = new Set(cornerAngles);
  if (has.size === 6) return new Set([90, 210, 330]);
  const runs = [];
  for (const a of has) {
    if (has.has(norm(a - 60))) continue; // not the start of a run
    const run = [a];
    while (has.has(norm(run.at(-1) + 60))) run.push(norm(run.at(-1) + 60));
    runs.push(run);
  }
  const keep = new Set();
  for (const run of runs) {
    const pick = (start) => run.filter((_, i) => i % 2 === start);
    const score = (list) => list.length * 10 + list.filter((a) => a === 90 || a === 270).length;
    const [a, b] = [pick(0), pick(1)];
    for (const c of score(b) > score(a) ? b : a) keep.add(c);
  }
  return keep;
}

export function buildEdges(hexes, nodes, lat) {
  if (!lat.edge) return [];
  const { r } = lat;
  const hexById = new Map(hexes.map((h) => [h.id, h]));
  const allNodeFrames = Object.keys(lat.nodeAngles).sort();
  const keyOf = (x, z) => `${Math.round(x * 1e4)},${Math.round(z * 1e4)}`;
  const covered = new Set();
  const edges = [];

  const cornersByHex = new Map();
  for (const n of nodes) {
    if (n.kind !== 'edge') continue;
    const id = n.joints[0].hexId;
    cornersByHex.set(id, [...(cornersByHex.get(id) ?? []), lat.cornerOf[n.joints[0].hexFrame]]);
  }
  const keepByHex = new Map([...cornersByHex].map(([id, corners]) => [id, edgeCorners(corners)]));

  for (const n of nodes) {
    if (n.kind !== 'edge') continue;
    const joint = n.joints[0];
    if (!keepByHex.get(joint.hexId).has(lat.cornerOf[joint.hexFrame])) continue;
    const h = hexById.get(joint.hexId);
    // the open side points straight away from the node's only hexagon
    const open = norm(deg(Math.atan2(n.z - h.z, n.x - h.x)));

    // turning the node by 120° keeps its odd frames on the sides, so any odd frame can face the open side
    const options = [0, 1, 2]
      .map((k) => {
        const rotation = norm(n.rotation + 120 * k);
        return {
          k,
          rotation,
          edgeFrame: nearestFrame(lat.nodeAngles, rotation, open),
          hexFrame: nearestFrame(lat.nodeAngles, rotation, lat.frameOffset[joint.hexFrame]),
        };
      })
      .filter((o) => ODD_FRAMES.includes(o.edgeFrame));
    // prefer the standard turn, then a hexagon joint on node-1 or node-5, then the given Edge frame
    const rank = (o, frame) => (o.k === 0 ? 4 : 0) + (HEX_RULE_FRAMES.includes(o.hexFrame) ? 2 : 0) + (o.edgeFrame === frame ? 1 : 0);
    const best = (list, frame) => list.reduce((a, o) => (rank(o, frame) > rank(a, frame) ? o : a), list[0]);
    // the standard choice puts the Edge on node-1 or node-3; the user's rule swaps it, so an Edge that would
    // land on node-3 takes node-1 instead, and one that would land on node-1 takes node-3 or node-5
    const standard = best(options.filter((o) => o.edgeFrame !== 'node-5'), 'node-3');
    if (!standard) continue;
    const swapped = options.filter((o) => (standard.edgeFrame === 'node-1') !== (o.edgeFrame === 'node-1'));
    const pick = best(swapped, 'node-3');
    if (!pick) continue;

    // with hexagons excluded, two edge nodes can face each other across one side; one Edge fills it
    const side = keyOf(n.x + (lat.R / 2) * Math.cos(rad(open)), n.z + (lat.R / 2) * Math.sin(rad(open)));
    if (covered.has(side)) continue;
    covered.add(side);

    n.rotation = pick.rotation;
    joint.nodeFrame = pick.hexFrame;
    const ux = Math.cos(rad(open));
    const uz = Math.sin(rad(open));
    const edge = {
      id: `E${edges.length + 1}`,
      hexId: h.id,
      nodeId: n.id,
      edgeFrame: EDGE_FRAME,
      nodeFrame: pick.edgeFrame,
      x: n.x + r * ux,
      z: n.z + r * uz,
      angle: open,
      rotation: norm(open - lat.edge.axisAngle),
      tipX: n.x + (r + lat.edge.length) * ux,
      tipZ: n.z + (r + lat.edge.length) * uz,
    };
    edges.push(edge);
    n.edges = [edge.id];
    n.spare = allNodeFrames.filter((f) => f !== joint.nodeFrame && f !== edge.nodeFrame);
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
