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
      return { led: v.part.startsWith('led'), geometry, rgba: v.rgba };
    }),
  );
  const merge = (list) => (list.length ? mergeGeometries(list.map((p) => p.geometry)) : null);
  return {
    body: merge(parts.filter((p) => !p.led)),
    led: merge(parts.filter((p) => p.led)),
    rgba: parts.find((p) => !p.led)?.rgba ?? [0.4, 0.4, 0.4, 1],
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

  // --- hover raise, ripple and selection ----------------------------------------
  const LIFT = 0.06; // meters toward the viewer at full raise
  const GROW = 0.05; // extra scale at full raise, which is what shows in the front view
  const WAVE = { delay: 0.11, length: 0.6, falloff: 0.5, height: 0.55 }; // s per pitch, pulse s, decay per pitch, peak
  const WHITE = new THREE.Color(0xffffff);
  const SELECTED = new THREE.Color(0xffc46b);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const raycaster = new THREE.Raycaster();
  const tmp = { m: new THREE.Matrix4(), s: new THREE.Matrix4(), t: new THREE.Matrix4() };

  let hexState = []; // { h, raise } per instance
  let hexMeshes = { body: null, led: null };
  let waves = []; // { x, z, t0 } ripples spreading from a hovered hexagon
  let hoverId = null;
  let selected = new Set();
  let lattice = null;

  function waveAt(h, now) {
    let amp = 0;
    for (const w of waves) {
      const d = Math.hypot(h.x - w.x, h.z - w.z) / lattice.pitch;
      const s = (now - w.t0) / 1000 - d * WAVE.delay;
      if (s > 0 && s < WAVE.length) amp += WAVE.height * Math.exp(-WAVE.falloff * d) * Math.sin((Math.PI * s) / WAVE.length);
    }
    return amp;
  }

  function writeHexes(now) {
    const { body, led } = hexMeshes;
    if (!body || !lattice) return;
    const hc = lattice.hexCenter;
    hexState.forEach(({ h, raise }, i) => {
      const amp = Math.max(raise, waveAt(h, now));
      const k = 1 + GROW * amp;
      // scale about the hexagon's own center, then lift it off the wall toward the viewer (URDF -Y)
      tmp.m.makeTranslation(-hc.x, -hc.y, -hc.z);
      tmp.m.premultiply(tmp.s.makeScale(k, k, k));
      tmp.m.premultiply(tmp.t.makeTranslation(h.x, hc.y - LIFT * amp, h.z));
      body.setMatrixAt(i, tmp.m);
      led?.setMatrixAt(i, tmp.m);
      body.setColorAt(i, selected.has(h.id) ? SELECTED : WHITE);
    });
    body.instanceMatrix.needsUpdate = true;
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    if (led) led.instanceMatrix.needsUpdate = true;
  }

  // eases each hexagon toward its hover target; true while anything is still moving
  function animate(now, dt) {
    const still = reduceMotion.matches;
    if (still) waves = [];
    const maxD = 40;
    waves = waves.filter((w) => (now - w.t0) / 1000 < maxD * WAVE.delay + WAVE.length);
    let moving = waves.length > 0;
    const ease = 1 - Math.exp(-dt * 10);
    for (const st of hexState) {
      const target = st.h.id === hoverId ? 1 : 0;
      st.raise = still ? target : st.raise + (target - st.raise) * ease;
      if (Math.abs(target - st.raise) > 0.001) moving = true;
      else st.raise = target;
    }
    writeHexes(now);
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

    const previous = new Map(hexState.map((st) => [st.h.id, st.raise]));
    hexState = hexes.map((h) => ({ h, raise: previous.get(h.id) ?? 0 }));
    if (!hexes.some((h) => h.id === hoverId)) hoverId = null;
    hexMeshes = {
      body: instanced(hexTpl.body, materials.hexBody, hexes.length),
      led: hexTpl.led && instanced(hexTpl.led, materials.led, hexes.length),
    };
    writeHexes(performance.now());

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
    if (id === hoverId) return;
    hoverId = id;
    const st = id && hexState.find((s) => s.h.id === id);
    if (st && !reduceMotion.matches) waves.push({ x: st.h.x, z: st.h.z, t0: performance.now() });
    kick();
  }

  function setSelected(ids) {
    selected = new Set(ids);
    writeHexes(performance.now());
    render();
  }

  // hexagon under a screen point, for the 3D view where the SVG overlay is hidden
  function pick(clientX, clientY) {
    const { body } = hexMeshes;
    if (!body || !hexState.length) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, mode === '3d' ? perspective : ortho);
    const hit = raycaster.intersectObject(body, false)[0];
    return hit ? hexState[hit.instanceId].h.id : null;
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
