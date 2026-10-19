import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const NODE_COLORS = { '3-way': 0x67c4d8, '2-way': 0xb39ddb, edge: 0xec7c63 };
const BACKGROUND = 0x14171c;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

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
      geometry.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...v.xyz), rotation, new THREE.Vector3(1, 1, 1)));
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

export async function createView3D(container, geo) {
  const [hexTpl, nodeTpl] = await Promise.all([buildTemplate(geo.hexVisuals), buildTemplate(geo.nodeVisuals)]);

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND);
  scene.add(new THREE.HemisphereLight(0xe2e8f2, 0x1a1d22, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(3, 5, 8);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xbcd4ff, 0.7);
  rim.position.set(-5, -3, 4);
  scene.add(rim);

  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const bodyColor = new THREE.Color().setRGB(hexTpl.rgba[0], hexTpl.rgba[1], hexTpl.rgba[2], THREE.SRGBColorSpace);
  const materials = {
    hexBody: new THREE.MeshStandardMaterial({ color: bodyColor, metalness: 0.35, roughness: 0.5 }),
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
  let lastSize = '';

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

  function fitCamera(W, H) {
    const aspect = camera.aspect || 1;
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const dist = (Math.max(H, W / aspect) / 2 / Math.tan(fov / 2)) * 1.2;
    controls.target.set(W / 2, H / 2, 0);
    camera.position.set(W / 2 + dist * 0.18, H / 2 - dist * 0.12, dist);
    camera.near = dist / 200;
    camera.far = dist * 20;
    camera.updateProjectionMatrix();
    controls.update();
  }

  function update({ W, H, hexes, nodes, lat }) {
    clear();

    const wall = new THREE.Mesh(new THREE.PlaneGeometry(W, H), materials.wall);
    wall.position.set(W / 2, H / 2, -0.03);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(wall.geometry), materials.wallEdge);
    edge.position.copy(wall.position);
    scene.add(wall, edge);
    wallObjects = [wall, edge];

    const m = new THREE.Matrix4();
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
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const color = new THREE.Color();
    nodes.forEach((n, i) => {
      // in-plane angles grow from +X toward +Z, which is a negative turn about +Y
      q.setFromAxisAngle(Y_AXIS, -THREE.MathUtils.degToRad(n.rotation));
      pos.set(n.x, lat.nodeYOffset, n.z).sub(nc.clone().applyQuaternion(q));
      nodeBody.setMatrixAt(i, m.compose(pos, q, one));
      nodeBody.setColorAt(i, color.setHex(NODE_COLORS[n.kind]));
    });
    if (nodeBody.instanceColor) nodeBody.instanceColor.needsUpdate = true;

    const size = `${W}x${H}`;
    if (size !== lastSize) {
      lastSize = size;
      fitCamera(W, H);
    }
    renderer.render(scene, camera);
  }

  function resize() {
    const { clientWidth: w, clientHeight: h } = container;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  let running = false;
  function loop() {
    if (!running) return;
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }

  function setVisible(visible) {
    if (visible && !running) {
      running = true;
      resize();
      requestAnimationFrame(loop);
    } else if (!visible) {
      running = false;
    }
  }

  return { update, setVisible };
}
