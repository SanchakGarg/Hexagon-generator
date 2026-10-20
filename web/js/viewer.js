import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildBounds } from './layout.js';

const NODE_COLORS = { '3-way': 0x67c4d8, '2-way': 0xb39ddb, edge: 0xec7c63 };
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);

const loader = new STLLoader();
const stlCache = new Map();
function loadStl(url) {
  if (!stlCache.has(url)) stlCache.set(url, loader.loadAsync(url));
  return stlCache.get(url);
}

// Bakes every <visual> of a URDF link into merged geometries: LED channels and everything else.
async function buildTemplate(visuals) {
  const parts = await Promise.all(
    visuals.map(async (v) => {
      const geometry = (await loadStl(v.url)).clone();
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(v.rpy[0], v.rpy[1], v.rpy[2], 'ZYX'));
      geometry.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...v.xyz), rotation, ONE));
      return { led: v.part.startsWith('led'), geometry, rgba: v.rgba, xyz: v.xyz };
    }),
  );
  const merge = (list) => (list.length ? mergeGeometries(list.map((p) => p.geometry)) : null);
  return {
    body: merge(parts.filter((p) => !p.led)),
    led: merge(parts.filter((p) => p.led)),
    rgba: parts.find((p) => !p.led)?.rgba ?? [0.4, 0.4, 0.4, 1],
    parts,
  };
}

// In-plane angles grow from +X toward +Z, which is a negative turn about +Y.
const inPlane = (q, degrees) => q.setFromAxisAngle(Y_AXIS, -THREE.MathUtils.degToRad(degrees));

// One scene, two cameras: a fixed orthographic front view ('2d') and an orbiting perspective view ('3d').
export async function createViewer(container, geo) {
  const [hexTpl, nodeTpl, edgeTpl] = await Promise.all([
    buildTemplate(geo.hexVisuals),
    buildTemplate(geo.nodeVisuals),
    buildTemplate(geo.edgeVisuals),
  ]);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  container.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xe2e8f2, 0x1a1d22, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(3, 5, 8);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xbcd4ff, 0.7);
  rim.position.set(-5, -3, 4);
  scene.add(rim);

  const perspective = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
  const controls = new OrbitControls(perspective, renderer.domElement);
  controls.enableDamping = true;
  controls.enabled = false;

  const bodyColor = new THREE.Color().setRGB(hexTpl.rgba[0], hexTpl.rgba[1], hexTpl.rgba[2], THREE.SRGBColorSpace);
  const materials = {
    hexBody: new THREE.MeshStandardMaterial({ color: bodyColor, metalness: 0.35, roughness: 0.5 }),
    edgeBody: new THREE.MeshStandardMaterial({ color: bodyColor, metalness: 0.35, roughness: 0.5 }),
    led: new THREE.MeshStandardMaterial({ color: 0xfff1d0, emissive: 0xf0b84f, emissiveIntensity: 0.9, roughness: 0.4 }),
    nodeBody: new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.3, roughness: 0.45 }),
    // the backboard and its raised sides are one material
    board: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 }),
  };

  // URDF is Z-up with Y through the panel; turn it so URDF Z is screen-up and the top plates face the camera.
  const root = new THREE.Group();
  root.rotation.x = -Math.PI / 2;
  scene.add(root);
  let wallObjects = [];
  let wallSize = null;
  let fittedSize = '';
  let viewBox = null;
  let mode = '2d';

  function clear() {
    for (const obj of [...root.children, ...wallObjects]) {
      obj.parent.remove(obj);
      if (obj.isInstancedMesh) obj.dispose();
      else obj.geometry?.dispose();
    }
    wallObjects = [];
  }

  // deepest URDF Y any part reaches, i.e. the back of the build, which sits on the board
  function backOf(lat) {
    const maxY = (geometry, offset = 0) => {
      if (!geometry) return -Infinity;
      geometry.computeBoundingBox();
      return geometry.boundingBox.max.y + offset;
    };
    return Math.max(maxY(hexTpl.body), maxY(hexTpl.led), maxY(nodeTpl.body, lat.nodeYOffset), maxY(edgeTpl.body, lat.edge.yOffset), maxY(edgeTpl.led, lat.edge.yOffset));
  }

  // white backboard behind the whole build, with sides of the same material raised toward the viewer around it
  function buildBoard(inner, { t, raise }, backZ) {
    const box = (x0, x1, y0, y1, z0, z1) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), materials.board);
      mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      scene.add(mesh);
      return mesh;
    };
    const { minX, maxX, minZ: minY, maxZ: maxY } = inner;
    const meshes = [box(minX - t, maxX + t, minY - t, maxY + t, backZ - t, backZ)];
    if (raise > 0) {
      const z1 = backZ + raise;
      meshes.push(
        box(minX - t, maxX + t, maxY, maxY + t, backZ, z1),
        box(minX - t, maxX + t, minY - t, minY, backZ, z1),
        box(minX - t, minX, minY, maxY, backZ, z1),
        box(maxX, maxX + t, minY, maxY, backZ, z1),
      );
    }
    return meshes;
  }

  function instanced(geometry, material, count) {
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(count, 1));
    mesh.count = count;
    root.add(mesh);
    return mesh;
  }

  function fitPerspective({ minX, maxX, minZ, maxZ }) {
    const W = maxX - minX;
    const H = maxZ - minZ;
    const cx = (minX + maxX) / 2;
    const cy = (minZ + maxZ) / 2;
    const aspect = perspective.aspect || 1;
    const fov = THREE.MathUtils.degToRad(perspective.fov);
    const dist = (Math.max(H, W / aspect) / 2 / Math.tan(fov / 2)) * 1.2;
    controls.target.set(cx, cy, 0);
    perspective.position.set(cx + dist * 0.18, cy - dist * 0.12, dist);
    perspective.near = dist / 200;
    perspective.far = dist * 20;
    perspective.updateProjectionMatrix();
    controls.update();
  }

  // Match the SVG overlay exactly: its viewBox is in wall meters with y pointing down from the top edge,
  // and preserveAspectRatio="xMidYMid meet" letterboxes it the same way this frustum does.
  function fitOrtho() {
    const { clientWidth: w, clientHeight: h } = container;
    if (!viewBox || !wallSize || !w || !h) return;
    const scale = Math.min(w / viewBox.w, h / viewBox.h);
    const cx = viewBox.x + viewBox.w / 2;
    const cy = wallSize.H - (viewBox.y + viewBox.h / 2);
    const hw = w / scale / 2;
    const hh = h / scale / 2;
    Object.assign(ortho, { left: cx - hw, right: cx + hw, top: cy + hh, bottom: cy - hh });
    const depth = Math.max(wallSize.W, wallSize.H) * 4;
    ortho.position.set(0, 0, depth);
    ortho.near = depth / 100;
    ortho.far = depth * 2;
    ortho.updateProjectionMatrix();
  }

  const render = () => renderer.render(scene, mode === '3d' ? perspective : ortho);

  // --- hover ripple through one hexagon's own parts, and selection ------------------
  // On hover the hexagon's parts come out ring by ring from its centre: the centre plate stack, the
  // channels around it, the next plate stacks, the next channels, and so on. They stay out while hovered;
  // moving off sends them back in the same order. Other hexagons stay put.
  const LIFT = 0.16; // meters toward the viewer at full raise
  const GROW = { stack: 0.6, channel: 0.12 }; // extra scale of each part about its own centre, which is what shows in 2D
  const RING_DELAY = 0.075; // seconds between rings
  const EASE = 10; // per-second easing rate of each part
  // while hovered the raised parts keep a gentle wave running outward through the rings, never dropping to the wall
  const RIPPLE = { depth: 0.3, period: 1.4 }; // fraction of the raise, seconds per cycle
  const WHITE = new THREE.Color(0xffffff);
  const SELECTED = new THREE.Color(0xffc46b);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const raycaster = new THREE.Raycaster();

  // hover copies live outside `root`, which update() clears
  const hoverRoot = new THREE.Group();
  hoverRoot.rotation.x = -Math.PI / 2;
  scene.add(hoverRoot);

  let hexList = [];
  let hexMeshes = { body: null, led: null };
  let hexParts = null; // { parts: [{ geometry, led, center, ring }], rings }
  let sessions = []; // one per hexagon that is coming out or settling back
  let hoverId = null;
  let selected = new Set();
  let lattice = null;
  let show = {};
  let nodeList = [];
  let nodeMesh = null;
  let edgeMeshes = { body: null, led: null };
  let edgeList = [];
  const shown = (layer) => show[layer] !== false;
  // an Edge's LEDs follow both the LED and the Edge toggles
  const partShown = (part) => (part.led ? shown('led') : true) && shown(part.layer);

  // an Edge is turned in-plane and slid so its edge-1 frame lands on the node frame it mates
  function edgeMatrix(e, m = new THREE.Matrix4()) {
    const q = inPlane(new THREE.Quaternion(), e.rotation);
    const anchor = new THREE.Vector3(lattice.edge.anchor.x, 0, lattice.edge.anchor.z).applyQuaternion(q);
    const pos = new THREE.Vector3(e.x, lattice.edge.yOffset, e.z).sub(anchor);
    return m.compose(pos, q, ONE);
  }
  function nodeMatrix(n, m = new THREE.Matrix4()) {
    const q = inPlane(new THREE.Quaternion(), n.rotation);
    const nc = new THREE.Vector3(lattice.nodeCenter.x, 0, lattice.nodeCenter.z).applyQuaternion(q);
    const pos = new THREE.Vector3(n.x, lattice.nodeYOffset, n.z).sub(nc);
    return m.compose(pos, q, ONE);
  }
  const nodeKey = (n) => `${n.x.toFixed(4)},${n.z.toFixed(4)}`;
  const nodeLayer = (n) => n.kind.replace('-', '');
  const nodeParts = nodeTpl.parts.map((p) => {
    const box = new THREE.Box3().setFromBufferAttribute(p.geometry.attributes.position);
    return { geometry: p.geometry, led: p.led, center: box.getCenter(new THREE.Vector3()) };
  });
  const edgeParts = edgeTpl.parts.map((p) => {
    const box = new THREE.Box3().setFromBufferAttribute(p.geometry.attributes.position);
    return { geometry: p.geometry, led: p.led, layer: 'edges', center: box.getCenter(new THREE.Vector3()) };
  });

  function buildHexParts(hc) {
    const parts = hexTpl.parts.map((p) => {
      const box = new THREE.Box3().setFromBufferAttribute(p.geometry.attributes.position);
      return { geometry: p.geometry, led: p.led, layer: 'hex', center: box.getCenter(new THREE.Vector3()), d: Math.hypot(p.xyz[0] - hc.x, p.xyz[2] - hc.z) };
    });
    // 2 cm buckets: centre stack, inner channels, inner stacks, mid channels, outer stacks, outer channels
    const bucket = (d) => Math.round(d * 50);
    const levels = [...new Set(parts.map((p) => bucket(p.d)))].sort((x, y) => x - y);
    for (const p of parts) p.ring = levels.indexOf(bucket(p.d));
    return { parts, rings: levels.length };
  }

  function partMesh(part, parent, hexId) {
    const body = { edges: materials.edgeBody, hex: materials.hexBody }[part.layer] ?? materials.nodeBody;
    const material = (part.led ? materials.led : body).clone();
    const mesh = new THREE.Mesh(part.geometry, material);
    mesh.userData.hexId = hexId;
    mesh.visible = partShown(part);
    parent.add(mesh);
    return mesh;
  }

  function openSession(h) {
    const hc = lattice.hexCenter;
    const group = new THREE.Group();
    group.position.set(h.x - hc.x, 0, h.z - hc.z);
    const items = hexParts.parts.map((part) => ({ mesh: partMesh(part, group, h.id), part, ring: part.ring, v: 0, target: 0 }));
    hoverRoot.add(group);
    const session = { h, group, items, edgeItems: [], nodeItems: [], t0: performance.now(), leaveAt: null };
    attachEdges(session);
    attachNodes(session);
    sessions.push(session);
    return session;
  }

  // the hexagon's Edges come out with it, as the rings after its own outer channels; rebuilt whenever the layout
  // changes, keeping how far each part is already out
  function attachEdges(session) {
    const { h, group } = session;
    const before = new Map(session.edgeItems.map((item) => [item.key, item]));
    for (const item of session.edgeItems) {
      item.holder.removeFromParent();
      item.mesh.material.dispose();
    }
    session.items = session.items.filter((item) => item.part.layer !== 'edges');
    session.edgeItems = [];
    const offset = new THREE.Matrix4().makeTranslation(-group.position.x, 0, -group.position.z);
    const bucket = (d) => Math.round(d * 50);
    for (const e of edgeList.filter((x) => x.hexId === h.id)) {
      const m = edgeMatrix(e);
      const holder = new THREE.Group();
      holder.matrixAutoUpdate = false;
      holder.matrix.multiplyMatrices(offset, m);
      group.add(holder);
      const d = edgeParts.map((part) => {
        const c = part.center.clone().applyMatrix4(m);
        return bucket(Math.hypot(c.x - h.x, c.z - h.z));
      });
      const levels = [...new Set(d)].sort((x, y) => x - y);
      edgeParts.forEach((part, i) => {
        const key = `${Math.round(e.angle)}:${i}`;
        const prev = before.get(key);
        const item = {
          key,
          holder,
          mesh: partMesh(part, holder, h.id),
          part,
          ring: hexParts.rings + 1 + levels.indexOf(d[i]),
          v: prev?.v ?? 0,
          target: prev?.target ?? 0,
        };
        session.edgeItems.push(item);
        session.items.push(item);
      });
    }
  }

  // The nodes it owns come out with it too, just after its outer channels and before its Edges. Every node belongs
  // to one hexagon only, even a 2-way or 3-way one that joins others, so hovering a neighbour leaves it in place.
  function attachNodes(session) {
    const { h } = session;
    const wanted = new Map(nodeList.filter((n) => n.hexId === h.id).map((n) => [nodeKey(n), n]));
    for (const item of session.nodeItems.filter((x) => !wanted.has(x.key))) disposeItem(item);
    session.nodeItems = session.nodeItems.filter((x) => wanted.has(x.key));
    for (const [key, n] of wanted) {
      const own = session.nodeItems.filter((x) => x.key === key);
      if (own.length) {
        for (const item of own) {
          item.holder.matrix.copy(nodeMatrix(n));
          item.part = { ...item.part, layer: nodeLayer(n) };
          item.base.setHex(NODE_COLORS[n.kind]);
          item.mesh.visible = partShown(item.part);
        }
        continue;
      }
      const holder = new THREE.Group();
      holder.matrixAutoUpdate = false;
      holder.matrix.copy(nodeMatrix(n));
      hoverRoot.add(holder);
      for (const p of nodeParts) {
        const part = { ...p, layer: nodeLayer(n) };
        session.nodeItems.push({ key, holder, mesh: partMesh(part, holder, h.id), part, base: new THREE.Color(NODE_COLORS[n.kind]), v: 0, target: 0 });
      }
    }
    for (const item of session.nodeItems) item.ring = hexParts.rings;
    session.items = [...session.items.filter((x) => x.part.layer === 'hex' || x.part.layer === 'edges'), ...session.nodeItems];
  }

  function disposeItem(item) {
    item.mesh.material.dispose();
    if (item.holder && !item.holder.children.some((m) => m !== item.mesh)) item.holder.removeFromParent();
    else item.mesh.removeFromParent();
  }

  function closeSession(session) {
    hoverRoot.remove(session.group);
    for (const item of session.nodeItems) item.holder.removeFromParent();
    for (const { mesh } of session.items) mesh.material.dispose();
  }

  const tint = (id) => (selected.has(id) ? SELECTED : WHITE);

  function applySession(session, now = performance.now()) {
    const bodyBase = materials.hexBody.color.clone().multiply(tint(session.h.id));
    const still = reduceMotion.matches;
    for (const item of session.items) {
      const { mesh, part, ring, v: raise } = item;
      const phase = (now - session.t0) / 1000 - ring * RING_DELAY;
      const wave = still || phase < 0 ? 0 : RIPPLE.depth * Math.sin((2 * Math.PI * phase) / RIPPLE.period);
      const v = raise * (1 + wave);
      const k = 1 + (part.led ? GROW.channel : GROW.stack) * v;
      const c = part.center;
      mesh.scale.setScalar(k);
      // grow about the part's own centre, then lift it off the wall toward the viewer (URDF -Y)
      mesh.position.set(c.x * (1 - k), c.y * (1 - k) - LIFT * v, c.z * (1 - k));
      if (part.led) mesh.material.emissiveIntensity = materials.led.emissiveIntensity * (1 + 2.5 * v);
      else mesh.material.color.copy(item.base ?? bodyBase).multiplyScalar(1 + 1.1 * v);
    }
  }

  // the static instance of a hexagon is hidden while its parts are out as separate meshes
  function writeHexes() {
    const { body, led } = hexMeshes;
    if (!body || !lattice) return;
    const hc = lattice.hexCenter;
    const out = new Set(sessions.map((s) => s.h.id));
    const m = new THREE.Matrix4();
    hexList.forEach((h, i) => {
      if (out.has(h.id)) m.makeScale(0, 0, 0);
      else m.makeTranslation(h.x - hc.x, 0, h.z - hc.z);
      body.setMatrixAt(i, m);
      led?.setMatrixAt(i, m);
      body.setColorAt(i, tint(h.id));
    });
    body.instanceMatrix.needsUpdate = true;
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    if (led) led.instanceMatrix.needsUpdate = true;
    writeEdges();
    writeNodes();
  }

  // Edges belong to their hexagon: they share its selection tint and leave the wall with it
  function writeEdges() {
    const { body, led } = edgeMeshes;
    if (!lattice || (!body && !led)) return;
    const out = new Set(sessions.map((s) => s.h.id));
    const m = new THREE.Matrix4();
    edgeList.forEach((e, i) => {
      if (out.has(e.hexId)) m.makeScale(0, 0, 0);
      else edgeMatrix(e, m);
      body?.setMatrixAt(i, m);
      led?.setMatrixAt(i, m);
      body?.setColorAt(i, tint(e.hexId));
    });
    for (const mesh of [body, led]) {
      if (!mesh) continue;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }

  // advances every session; true while anything is still moving
  function animate(now, dt) {
    if (!hexParts) return false;
    const still = reduceMotion.matches;
    const ease = still ? 1 : 1 - Math.exp(-dt * EASE);
    let moving = false;
    const done = [];
    for (const session of sessions) {
      const leaving = session.leaveAt !== null;
      const elapsed = (now - (leaving ? session.leaveAt : session.t0)) / 1000;
      let settled = true;
      for (const item of session.items) {
        const ring = item.ring;
        // both ways run centre first: centre stack, its channels, the next stacks, and so on
        const delay = still ? 0 : ring * RING_DELAY;
        if (elapsed >= delay) item.target = leaving ? 0 : 1;
        else settled = false;
        item.v += (item.target - item.v) * ease;
        if (Math.abs(item.target - item.v) < 0.001) item.v = item.target;
        else settled = false;
      }
      applySession(session, now);
      if (!settled || (!leaving && !still)) moving = true;
      else if (leaving) done.push(session);
    }
    if (done.length) {
      done.forEach(closeSession);
      sessions = sessions.filter((s) => !done.includes(s));
      writeHexes();
    }
    return moving;
  }

  let rafId = 0;
  let last = 0;
  function frame(now) {
    rafId = 0;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    const moving = animate(now, dt);
    if (mode === '3d') controls.update();
    render();
    if (moving || mode === '3d') rafId = requestAnimationFrame(frame);
    else last = 0;
  }
  const kick = () => {
    if (!rafId) rafId = requestAnimationFrame(frame);
  };

  function update({ W, H, hexes, nodes, edges, lat, board }) {
    clear();
    wallSize = { W, H };
    lattice = lat;

    // root turns URDF Y into world -Z
    const inner = buildBounds(W, H, edges, lat.rho);
    wallObjects = buildBoard(inner, board, -backOf(lat));

    const color = new THREE.Color();

    hexParts ??= buildHexParts(lat.hexCenter);
    hexList = hexes;
    const byId = new Map(hexes.map((h) => [h.id, h]));
    if (!byId.has(hoverId)) hoverId = null;
    edgeList = edges;
    nodeList = nodes;
    nodeMesh = null; // clear() disposed it; rebuilt below
    // drop parts of hexagons that left the layout; follow the rest if they moved
    for (const session of sessions.filter((s) => !byId.has(s.h.id))) closeSession(session);
    sessions = sessions.filter((s) => byId.has(s.h.id));
    for (const session of sessions) {
      session.h = byId.get(session.h.id);
      session.group.position.set(session.h.x - lat.hexCenter.x, 0, session.h.z - lat.hexCenter.z);
      attachEdges(session);
      attachNodes(session);
      applySession(session);
    }
    hexMeshes = {
      body: instanced(hexTpl.body, materials.hexBody, hexes.length),
      led: hexTpl.led && instanced(hexTpl.led, materials.led, hexes.length),
    };
    edgeMeshes = {
      body: edgeTpl.body && instanced(edgeTpl.body, materials.edgeBody, edges.length),
      led: edgeTpl.led && instanced(edgeTpl.led, materials.led, edges.length),
    };
    writeHexes();

    nodeMesh = instanced(nodeTpl.body, materials.nodeBody, nodes.length);
    nodes.forEach((n, i) => nodeMesh.setColorAt(i, color.setHex(NODE_COLORS[n.kind])));
    if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;
    writeNodes();

    // frame the board, which wraps the wall and any Edges that overhang it
    const { t } = board;
    const bounds = { minX: inner.minX - t, maxX: inner.maxX + t, minZ: inner.minZ - t, maxZ: inner.maxZ + t };
    const size = [...Object.values(bounds), board.raise].map((v) => v.toFixed(4)).join(',');
    if (size !== fittedSize) {
      fittedSize = size;
      fitPerspective(bounds);
    }
    applyShow();
    fitOrtho();
    render();
    kick();
  }

  // all node kinds share one instanced mesh
  function writeNodes() {
    if (!nodeMesh || !lattice) return;
    const m = new THREE.Matrix4();
    const out = new Set(sessions.flatMap((s) => s.nodeItems.map((x) => x.key)));
    nodeList.forEach((n, i) => {
      // hidden kinds, and nodes that are out with a hovered hexagon, collapse to nothing
      if (!shown(nodeLayer(n)) || out.has(nodeKey(n))) m.makeScale(0, 0, 0);
      else nodeMatrix(n, m);
      nodeMesh.setMatrixAt(i, m);
    });
    nodeMesh.instanceMatrix.needsUpdate = true;
    // the cached bounds would otherwise cull nodes that come back after being hidden
    nodeMesh.computeBoundingSphere();
  }

  function applyShow() {
    if (hexMeshes.body) hexMeshes.body.visible = shown('hex');
    if (hexMeshes.led) hexMeshes.led.visible = shown('led');
    if (edgeMeshes.body) edgeMeshes.body.visible = shown('edges');
    if (edgeMeshes.led) edgeMeshes.led.visible = shown('edges') && shown('led');
    for (const session of sessions) for (const { mesh, part } of session.items) mesh.visible = partShown(part);
  }

  function setShow(next) {
    show = { ...next };
    applyShow();
    writeNodes();
    render();
  }

  function setHover(id) {
    if (id === hoverId || !hexParts) return;
    const now = performance.now();
    for (const session of sessions) if (session.h.id === hoverId && session.leaveAt === null) session.leaveAt = now;
    hoverId = id;
    const h = id && hexList.find((x) => x.id === id);
    if (h) {
      const existing = sessions.find((s) => s.h.id === id);
      if (existing) {
        existing.leaveAt = null;
        existing.t0 = now;
        attachNodes(existing);
        writeHexes();
      } else {
        applySession(openSession(h));
        writeHexes();
      }
    }
    kick();
  }

  function setSelected(ids) {
    selected = new Set(ids);
    writeHexes();
    sessions.forEach(applySession);
    render();
  }

  // wall coordinates (URDF x, z) under a screen point, found on the plane of the hexagon frames
  const wallPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  function wallPoint(clientX, clientY) {
    if (!lattice) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, mode === '3d' ? perspective : ortho);
    // root turns URDF -Y toward the viewer, so the frame plane sits at world z = -hexCenter.y
    wallPlane.constant = lattice.hexCenter.y;
    const hit = raycaster.ray.intersectPlane(wallPlane, new THREE.Vector3());
    return hit ? { x: hit.x, z: hit.y } : null;
  }

  function setViewBox(box) {
    viewBox = box;
    fitOrtho();
    if (mode === '2d') render();
  }

  function resize() {
    const { clientWidth: w, clientHeight: h } = container;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    perspective.aspect = w / h;
    perspective.updateProjectionMatrix();
    fitOrtho();
    render();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  function setMode(next) {
    mode = next;
    controls.enabled = next === '3d';
    renderer.domElement.style.cursor = next === '3d' ? 'grab' : '';
    resize();
    kick();
  }

  return { canvas: renderer.domElement, update, setViewBox, setMode, setHover, setSelected, setShow, wallPoint };
}
