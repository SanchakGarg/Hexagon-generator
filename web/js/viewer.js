import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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
    wall: new THREE.MeshStandardMaterial({ color: 0x1d2229, roughness: 1 }),
    wallEdge: new THREE.LineBasicMaterial({ color: 0xe7e2d4, transparent: true, opacity: 0.5 }),
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
  const LIFT = 0.05; // meters toward the viewer at full raise
  const GROW = { stack: 0.45, channel: 0.1 }; // extra scale of each part about its own centre, which is what shows in 2D
  const RING_DELAY = 0.075; // seconds between rings
  const EASE = 12; // per-second easing rate of each part
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

  function buildHexParts(hc) {
    const parts = hexTpl.parts.map((p) => {
      const box = new THREE.Box3().setFromBufferAttribute(p.geometry.attributes.position);
      return { geometry: p.geometry, led: p.led, center: box.getCenter(new THREE.Vector3()), d: Math.hypot(p.xyz[0] - hc.x, p.xyz[2] - hc.z) };
    });
    // 2 cm buckets: centre stack, inner channels, inner stacks, mid channels, outer stacks, outer channels
    const bucket = (d) => Math.round(d * 50);
    const levels = [...new Set(parts.map((p) => bucket(p.d)))].sort((x, y) => x - y);
    for (const p of parts) p.ring = levels.indexOf(bucket(p.d));
    return { parts, rings: levels.length };
  }

  function openSession(h) {
    const hc = lattice.hexCenter;
    const group = new THREE.Group();
    group.position.set(h.x - hc.x, 0, h.z - hc.z);
    const items = hexParts.parts.map((part) => {
      const material = (part.led ? materials.led : materials.hexBody).clone();
      const mesh = new THREE.Mesh(part.geometry, material);
      mesh.userData.hexId = h.id;
      group.add(mesh);
      return { mesh, part, v: 0, target: 0 };
    });
    hoverRoot.add(group);
    const session = { h, group, items, t0: performance.now(), leaveAt: null };
    sessions.push(session);
    return session;
  }

  function closeSession(session) {
    hoverRoot.remove(session.group);
    for (const { mesh } of session.items) mesh.material.dispose();
  }

  const tint = (id) => (selected.has(id) ? SELECTED : WHITE);

  function applySession(session) {
    const bodyBase = materials.hexBody.color.clone().multiply(tint(session.h.id));
    for (const { mesh, part, v } of session.items) {
      const k = 1 + (part.led ? GROW.channel : GROW.stack) * v;
      const c = part.center;
      mesh.scale.setScalar(k);
      // grow about the part's own centre, then lift it off the wall toward the viewer (URDF -Y)
      mesh.position.set(c.x * (1 - k), c.y * (1 - k) - LIFT * v, c.z * (1 - k));
      if (part.led) mesh.material.emissiveIntensity = materials.led.emissiveIntensity * (1 + 2.5 * v);
      else mesh.material.color.copy(bodyBase).multiplyScalar(1 + 1.1 * v);
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
        const ring = item.part.ring;
        // both ways run centre first: centre stack, its channels, the next stacks, and so on
        const delay = still ? 0 : ring * RING_DELAY;
        if (elapsed >= delay) item.target = leaving ? 0 : 1;
        else settled = false;
        item.v += (item.target - item.v) * ease;
        if (Math.abs(item.target - item.v) < 0.001) item.v = item.target;
        else settled = false;
      }
      applySession(session);
      if (!settled) moving = true;
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

  function update({ W, H, hexes, nodes, edges, lat }) {
    clear();
    wallSize = { W, H };
    lattice = lat;

    const wall = new THREE.Mesh(new THREE.PlaneGeometry(W, H), materials.wall);
    wall.position.set(W / 2, H / 2, -0.03);
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(wall.geometry), materials.wallEdge);
    outline.position.copy(wall.position);
    scene.add(wall, outline);
    wallObjects = [wall, outline];

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const color = new THREE.Color();

    hexParts ??= buildHexParts(lat.hexCenter);
    hexList = hexes;
    const byId = new Map(hexes.map((h) => [h.id, h]));
    if (!byId.has(hoverId)) hoverId = null;
    // drop parts of hexagons that left the layout; follow the rest if they moved
    for (const session of sessions.filter((s) => !byId.has(s.h.id))) closeSession(session);
    sessions = sessions.filter((s) => byId.has(s.h.id));
    for (const session of sessions) {
      session.h = byId.get(session.h.id);
      session.group.position.set(session.h.x - lat.hexCenter.x, 0, session.h.z - lat.hexCenter.z);
      applySession(session);
    }
    hexMeshes = {
      body: instanced(hexTpl.body, materials.hexBody, hexes.length),
      led: hexTpl.led && instanced(hexTpl.led, materials.led, hexes.length),
    };
    writeHexes();

    const nc = new THREE.Vector3(lat.nodeCenter.x, 0, lat.nodeCenter.z);
    const nodeBody = instanced(nodeTpl.body, materials.nodeBody, nodes.length);
    nodes.forEach((n, i) => {
      inPlane(q, n.rotation);
      pos.set(n.x, lat.nodeYOffset, n.z).sub(nc.clone().applyQuaternion(q));
      nodeBody.setMatrixAt(i, m.compose(pos, q, ONE));
      nodeBody.setColorAt(i, color.setHex(NODE_COLORS[n.kind]));
    });
    if (nodeBody.instanceColor) nodeBody.instanceColor.needsUpdate = true;

    // each Edge is turned in-plane and slid so its edge-1 frame lands on the node frame it mates
    const anchor = new THREE.Vector3(lat.edge.anchor.x, 0, lat.edge.anchor.z);
    const edgeBody = edgeTpl.body && instanced(edgeTpl.body, materials.edgeBody, edges.length);
    const edgeLed = edgeTpl.led && instanced(edgeTpl.led, materials.led, edges.length);
    edges.forEach((e, i) => {
      inPlane(q, e.rotation);
      pos.set(e.x, lat.edge.yOffset, e.z).sub(anchor.clone().applyQuaternion(q));
      m.compose(pos, q, ONE);
      edgeBody?.setMatrixAt(i, m);
      edgeLed?.setMatrixAt(i, m);
    });

    // frame the wall plus any Edges that overhang it
    const bounds = { minX: 0, maxX: W, minZ: 0, maxZ: H };
    for (const e of edges) {
      bounds.minX = Math.min(bounds.minX, e.tipX);
      bounds.maxX = Math.max(bounds.maxX, e.tipX);
      bounds.minZ = Math.min(bounds.minZ, e.tipZ);
      bounds.maxZ = Math.max(bounds.maxZ, e.tipZ);
    }
    const size = Object.values(bounds).map((v) => v.toFixed(4)).join(',');
    if (size !== fittedSize) {
      fittedSize = size;
      fitPerspective(bounds);
    }
    fitOrtho();
    render();
    kick();
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

  // hexagon under a screen point, for the 3D view where the SVG overlay is hidden
  function pick(clientX, clientY) {
    const { body } = hexMeshes;
    if (!body || !hexList.length) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, mode === '3d' ? perspective : ortho);
    const hit = raycaster.intersectObjects([body, hoverRoot], true)[0];
    if (!hit) return null;
    return hit.object === body ? hexList[hit.instanceId].id : hit.object.userData.hexId ?? null;
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

  return { canvas: renderer.domElement, update, setViewBox, setMode, setHover, setSelected, pick };
}
