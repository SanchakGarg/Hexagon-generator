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

  function fitPerspective(W, H) {
    const aspect = perspective.aspect || 1;
    const fov = THREE.MathUtils.degToRad(perspective.fov);
    const dist = (Math.max(H, W / aspect) / 2 / Math.tan(fov / 2)) * 1.2;
    controls.target.set(W / 2, H / 2, 0);
    perspective.position.set(W / 2 + dist * 0.18, H / 2 - dist * 0.12, dist);
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

  function update({ W, H, hexes, nodes, edges, lat }) {
    clear();
    wallSize = { W, H };

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

    const hc = lat.hexCenter;
    const hexBody = instanced(hexTpl.body, materials.hexBody, hexes.length);
    const hexLed = hexTpl.led && instanced(hexTpl.led, materials.led, hexes.length);
    hexes.forEach((h, i) => {
      m.makeTranslation(h.x - hc.x, 0, h.z - hc.z);
      hexBody.setMatrixAt(i, m);
      hexLed?.setMatrixAt(i, m);
    });

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

    const size = `${W}x${H}`;
    if (size !== fittedSize) {
      fittedSize = size;
      fitPerspective(W, H);
    }
    fitOrtho();
    render();
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

  let running = false;
  function loop() {
    if (!running) return;
    controls.update();
    render();
    requestAnimationFrame(loop);
  }

  function setMode(next) {
    mode = next;
    controls.enabled = next === '3d';
    renderer.domElement.style.cursor = next === '3d' ? 'grab' : '';
    if (next === '3d' && !running) {
      running = true;
      requestAnimationFrame(loop);
    } else if (next !== '3d') {
      running = false;
    }
    resize();
  }

  return { update, setViewBox, setMode };
}
