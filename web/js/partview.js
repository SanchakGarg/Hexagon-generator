import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { toonRamp, outlineMaterial, smoothed } from './viewer.js';

// The assembly guide's 3D figures: a row of models in one canvas, each turning slowly by itself and spun by dragging
// across it. The node's layers and the LED channel are cel shaded with the wall model's ink line; the circuit boards
// keep the colours KiCad exported them in.
export const NODE_LAYERS = [
  { key: 'bottom', parts: ['bottom_plate', 'bottom_plate_cover'], color: '--peach' },
  { key: 'middle', parts: ['middle_plate'], color: '--c-hex' },
  { key: 'top', parts: ['top_plate'], color: '--sky' },
];

const stl = new STLLoader();
const gltf = new GLTFLoader();

// a URDF visual's mesh, placed where its robot puts it
async function placed(v) {
  const g = await stl.loadAsync(v.url);
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(v.rpy[0], v.rpy[1], v.rpy[2], 'ZYX'));
  g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...v.xyz), q, new THREE.Vector3(1, 1, 1)));
  return g;
}

function lights(scene, strong = false) {
  scene.add(new THREE.AmbientLight(0xffffff, (strong ? 0.9 : 0.62) * Math.PI));
  const key = new THREE.DirectionalLight(0xffffff, (strong ? 0.9 : 0.42) * Math.PI);
  key.position.set(2, 5, 3);
  scene.add(key);
}

// One canvas, one camera, a scissored viewport per model. Each view is { scene, spin, radius, yaw, tilt, tick? }.
function turntable(views, { pitch = 0.6, className = 'pb-parts-canvas' } = {}) {
  // preserveDrawingBuffer so a still can be taken for the printed book at any moment
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.setScissorTest(true);
  const canvas = renderer.domElement;
  canvas.className = className;
  const camera = new THREE.PerspectiveCamera(30, 1, 0.001, 10);
  const inks = [];
  const themed = [];

  let host = null;
  let visible = false;
  let raf = 0;
  let drag = null;
  let last = performance.now();
  let clock = 0;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function size() {
    if (!host) return false;
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return false;
    const pr = renderer.getPixelRatio();
    if (canvas.width !== Math.round(w * pr) || canvas.height !== Math.round(h * pr)) {
      renderer.setSize(w, h, false);
      for (const ink of inks) {
        renderer.getDrawingBufferSize(ink.uniforms.resolution.value);
        ink.uniforms.width.value = 1.3 * pr;
      }
    }
    return true;
  }

  function draw() {
    const w = host.clientWidth;
    const h = host.clientHeight;
    const cell = w / views.length;
    camera.aspect = cell / h;
    // far enough that the widest model fits the narrower side of its cell, looking down at the pitch
    // each model framed to its own size
    const fov = THREE.MathUtils.degToRad(camera.fov / 2);
    const reach = Math.sin(Math.min(fov, Math.atan(Math.tan(fov) * camera.aspect)));
    views.forEach((v, i) => {
      const dist = (v.radius * 1.08) / reach;
      camera.position.set(0, Math.sin(pitch) * dist, Math.cos(pitch) * dist);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
      v.tick?.(clock);
      v.spin.rotation.set(v.tilt, v.yaw, 0);
      renderer.setViewport(cell * i, 0, cell, h);
      renderer.setScissor(cell * i, 0, cell, h);
      renderer.render(v.scene, camera);
    });
  }

  function frame(now) {
    raf = 0;
    if (!visible || !canvas.isConnected) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!reduced) clock += dt;
    if (size()) {
      views.forEach((v, i) => {
        if (!reduced && drag?.i !== i) v.yaw += dt * 0.35;
      });
      draw();
    }
    raf = requestAnimationFrame(frame);
  }
  const play = () => {
    if (!raf && visible) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  };

  const seen = new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    play();
  });

  canvas.addEventListener('pointerdown', (e) => {
    const r = canvas.getBoundingClientRect();
    const i = Math.min(views.length - 1, Math.floor(((e.clientX - r.left) / r.width) * views.length));
    drag = { i, x: e.clientX, y: e.clientY, yaw: views[i].yaw, tilt: views[i].tilt };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const v = views[drag.i];
    v.yaw = drag.yaw + (e.clientX - drag.x) * 0.012;
    v.tilt = Math.max(-0.9, Math.min(0.9, drag.tilt + (e.clientY - drag.y) * 0.008));
  });
  const release = () => (drag = null);
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  function setTheme() {
    const css = getComputedStyle(document.querySelector('.app') ?? document.documentElement);
    const color = (name) => new THREE.Color(css.getPropertyValue(name).trim() || '#cccccc');
    for (const t of themed) t.material.color.copy(color(t.color));
    for (const ink of inks) ink.uniforms.color.value.copy(color('--c-outline'));
    if (host && size()) draw();
  }

  return {
    canvas,
    // a toon material in one of the page's colours, kept in step with the theme
    toon(color, gradientMap) {
      const material = new THREE.MeshToonMaterial({ gradientMap, color: 0xffffff });
      themed.push({ material, color });
      return material;
    },
    ink() {
      const ink = outlineMaterial();
      inks.push(ink);
      return ink;
    },
    // the guide is redrawn whole when the wall changes; the canvas moves into the new box
    mount(el) {
      if (host) seen.unobserve(host);
      host = el;
      el.append(canvas);
      seen.observe(el);
      play();
    },
    setTheme,
    // the view as it is now, as a PNG, for the printed book
    still() {
      if (!host || !size()) return null;
      draw();
      return canvas.toDataURL('image/png');
    },
  };
}

// The node: first the whole stack, its layers drifting apart and settling back together, then each layer alone.
export async function createNodeView(nodeVisuals) {
  const layers = await Promise.all(NODE_LAYERS.map((layer) => Promise.all(nodeVisuals.filter((v) => layer.parts.includes(v.part)).map(placed))));
  const views = [];
  const gradientMap = toonRamp();
  const pending = [];

  // the assembled stack; URDF -Y is the top of a plate stack, so the stack is turned to face up
  {
    const scene = new THREE.Scene();
    lights(scene);
    const spin = new THREE.Group();
    const flat = new THREE.Group();
    flat.rotation.x = Math.PI;
    spin.add(flat);
    scene.add(spin);
    const all = layers.flat().map((g) => g.clone());
    const box = new THREE.Box3();
    for (const g of all) {
      g.computeBoundingBox();
      box.union(g.boundingBox);
    }
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const groups = [];
    let k = 0;
    layers.forEach((list, i) => {
      const group = new THREE.Group();
      for (let j = 0; j < list.length; j++) {
        const g = all[k++];
        g.translate(-centre.x, -centre.y, -centre.z);
        pending.push({ g, group, color: NODE_LAYERS[i].color });
      }
      flat.add(group);
      groups.push(group);
    });
    const gap = size.y * 0.55;
    views.push({
      scene,
      spin,
      radius: (size.length() / 2) * 1.25,
      yaw: 0.4,
      tilt: 0,
      // apart and back together every few seconds; in the flipped stack local -Y is up
      tick: (t) => {
        const e = 0.5 - 0.5 * Math.cos(t * 0.9);
        groups.forEach((g, i) => (g.position.y = -(i - 1) * gap * e));
      },
    });
  }

  // each layer on its own
  layers.forEach((list, i) => {
    const scene = new THREE.Scene();
    lights(scene);
    const spin = new THREE.Group();
    const flat = new THREE.Group();
    flat.rotation.x = Math.PI;
    spin.add(flat);
    scene.add(spin);
    const box = new THREE.Box3();
    for (const g of list) {
      g.computeBoundingBox();
      box.union(g.boundingBox);
    }
    const centre = box.getCenter(new THREE.Vector3());
    for (const g of list) {
      g.translate(-centre.x, -centre.y, -centre.z);
      pending.push({ g, group: flat, color: NODE_LAYERS[i].color });
    }
    views.push({ scene, spin, radius: box.getSize(new THREE.Vector3()).length() / 2, yaw: (i + 1) * 0.7, tilt: 0 });
  });

  const table = turntable(views);
  const ink = table.ink();
  for (const { g, group, color } of pending) {
    const mesh = new THREE.Mesh(g, table.toon(color, gradientMap));
    mesh.add(new THREE.Mesh(smoothed(g), ink));
    group.add(mesh);
  }
  table.setTheme();
  return table;
}

// The two circuit boards as KiCad exports them (GLB, metres, Y up, components on top), side by side.
export async function createCircuitView(urls) {
  const models = await Promise.all(urls.map((url) => gltf.loadAsync(url)));
  const views = models.map((m, i) => {
    const scene = new THREE.Scene();
    lights(scene, true);
    const spin = new THREE.Group();
    const model = m.scene;
    const box = new THREE.Box3().setFromObject(model);
    model.position.sub(box.getCenter(new THREE.Vector3()));
    spin.add(model);
    scene.add(spin);
    return { scene, spin, radius: box.getSize(new THREE.Vector3()).length() / 2, yaw: 0.5 + i * 0.6, tilt: 0 };
  });
  const table = turntable(views, { pitch: 0.75 });
  table.setTheme();
  return table;
}

// One LED channel from the hexagon model, lying along its length.
export async function createChannelView(visual) {
  const g = await placed(visual);
  const gradientMap = toonRamp();
  g.computeBoundingBox();
  const size = g.boundingBox.getSize(new THREE.Vector3());
  g.translate(...g.boundingBox.getCenter(new THREE.Vector3()).negate().toArray());
  // its long side across the view
  const long = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z';
  if (long === 'y') g.rotateZ(Math.PI / 2);
  if (long === 'z') g.rotateY(Math.PI / 2);
  const scene = new THREE.Scene();
  lights(scene);
  const spin = new THREE.Group();
  scene.add(spin);
  const view = { scene, spin, radius: Math.max(size.x, size.y, size.z) / 2, yaw: 0, tilt: 0.25 };
  const table = turntable([view], { pitch: 0.35 });
  const mesh = new THREE.Mesh(g, table.toon('--c-led-base', gradientMap));
  mesh.add(new THREE.Mesh(smoothed(g), table.ink()));
  spin.add(mesh);
  table.setTheme();
  return table;
}
