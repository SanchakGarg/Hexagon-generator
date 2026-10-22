import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { toonRamp, outlineMaterial, smoothed } from './viewer.js';

// The three layers of a node on the build guide, side by side in one canvas: each lies flat with its top up,
// turns slowly by itself, and can be spun by dragging across it. Same cel shading and ink line as the wall model.
export const NODE_LAYERS = [
  { key: 'bottom', parts: ['bottom_plate', 'bottom_plate_cover'], color: '--peach' },
  { key: 'middle', parts: ['middle_plate'], color: '--c-hex' },
  { key: 'top', parts: ['top_plate'], color: '--sky' },
];

const loader = new STLLoader();

export async function createPartView(nodeVisuals) {
  const geometries = await Promise.all(
    NODE_LAYERS.map(async (layer) => {
      const list = await Promise.all(
        nodeVisuals
          .filter((v) => layer.parts.includes(v.part))
          .map(async (v) => {
            const g = await loader.loadAsync(v.url);
            const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(v.rpy[0], v.rpy[1], v.rpy[2], 'ZYX'));
            g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...v.xyz), q, new THREE.Vector3(1, 1, 1)));
            return g;
          }),
      );
      return list;
    }),
  );

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.setScissorTest(true);
  const canvas = renderer.domElement;
  canvas.className = 'pb-parts-canvas';

  const gradientMap = toonRamp();
  const ink = outlineMaterial();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.001, 10);
  const views = geometries.map((list, i) => {
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.62 * Math.PI));
    const key = new THREE.DirectionalLight(0xffffff, 0.42 * Math.PI);
    key.position.set(2, 5, 3);
    scene.add(key);
    const material = new THREE.MeshToonMaterial({ gradientMap, color: 0xffffff });
    const spin = new THREE.Group();
    // URDF -Y is the top of a plate stack: turn it to face up
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
      const mesh = new THREE.Mesh(g, material);
      mesh.add(new THREE.Mesh(smoothed(g), ink));
      flat.add(mesh);
    }
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    return { scene, spin, material, radius, yaw: i * 0.7, tilt: 0, color: NODE_LAYERS[i].color };
  });
  const radius = Math.max(...views.map((v) => v.radius));

  function setTheme() {
    const css = getComputedStyle(document.querySelector('.app') ?? document.documentElement);
    const color = (name) => new THREE.Color(css.getPropertyValue(name).trim() || '#cccccc');
    for (const v of views) v.material.color.copy(color(v.color));
    ink.uniforms.color.value.copy(color('--c-outline'));
  }
  setTheme();

  let host = null;
  let visible = false;
  let raf = 0;
  let drag = null;
  let last = performance.now();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function size() {
    if (!host) return false;
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return false;
    const pr = renderer.getPixelRatio();
    if (canvas.width !== Math.round(w * pr) || canvas.height !== Math.round(h * pr)) {
      renderer.setSize(w, h, false);
      renderer.getDrawingBufferSize(ink.uniforms.resolution.value);
      ink.uniforms.width.value = 1.3 * pr;
    }
    return true;
  }

  function frame(now) {
    raf = 0;
    if (!visible || !canvas.isConnected) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (size()) {
      const w = host.clientWidth;
      const h = host.clientHeight;
      const third = w / 3;
      camera.aspect = third / h;
      // far enough that the widest part fits the narrower side of its third, looking down at 35°
      const fov = THREE.MathUtils.degToRad(camera.fov / 2);
      const dist = (radius * 1.15) / Math.sin(Math.min(fov, Math.atan(Math.tan(fov) * camera.aspect)));
      camera.position.set(0, Math.sin(0.6) * dist, Math.cos(0.6) * dist);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
      views.forEach((v, i) => {
        if (!reduced && drag?.i !== i) v.yaw += dt * 0.35;
        v.spin.rotation.set(v.tilt, v.yaw, 0);
        renderer.setViewport(third * i, 0, third, h);
        renderer.setScissor(third * i, 0, third, h);
        renderer.render(v.scene, camera);
      });
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
    const i = Math.min(2, Math.floor(((e.clientX - r.left) / r.width) * 3));
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

  // the guide is redrawn whole when the wall changes; the canvas moves into the new box
  function mount(el) {
    if (host) seen.unobserve(host);
    host = el;
    el.append(canvas);
    seen.observe(el);
    play();
  }

  return { mount, setTheme };
}
