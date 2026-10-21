import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { loopArea, offsetLoop } from './layout.js';

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);

const loader = new STLLoader();
const stlCache = new Map();
function loadStl(url) {
  if (!stlCache.has(url)) stlCache.set(url, loader.loadAsync(url));
  return stlCache.get(url);
}

// Bakes every <visual> of a URDF link into merged geometries: LED channels, the MCU node (the plate stack a
// hexagon carries at its centre) and everything else.
async function buildTemplate(visuals, isMcu = () => false) {
  const parts = await Promise.all(
    visuals.map(async (v) => {
      const geometry = (await loadStl(v.url)).clone();
      const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(v.rpy[0], v.rpy[1], v.rpy[2], 'ZYX'));
      geometry.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...v.xyz), rotation, ONE));
      const led = v.part.startsWith('led');
      return { led, mcu: !led && isMcu(v), geometry, rgba: v.rgba, xyz: v.xyz };
    }),
  );
  const merge = (list) => (list.length ? mergeGeometries(list.map((p) => p.geometry)) : null);
  return {
    body: merge(parts.filter((p) => !p.led && !p.mcu)),
    mcu: merge(parts.filter((p) => p.mcu)),
    all: merge(parts.filter((p) => !p.led)),
    led: merge(parts.filter((p) => p.led)),
    rgba: parts.find((p) => !p.led)?.rgba ?? [0.4, 0.4, 0.4, 1],
    parts,
  };
}

// Part colours come from the page's CSS variables, so the drawing follows the light or dark theme.
function readPalette() {
  const css = getComputedStyle(document.documentElement);
  const color = (name) => new THREE.Color(css.getPropertyValue(name).trim() || '#ff00ff');
  return {
    hex: color('--c-hex'),
    mcu: color('--c-mcu'),
    led: color('--c-led'),
    select: color('--c-select'),
    board: color('--c-board'),
    outline: color('--c-outline'),
    node: { '3-way': color('--c-3way'), '2-way': color('--c-2way'), edge: color('--c-edge') },
  };
}

// Three flat bands of light (shade, side, lit) instead of smooth shading: the cel look.
function toonRamp() {
  const texture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255, 140, 140, 140, 255, 255, 255, 255, 255]), 3, 1);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

// Ink outline by the inverted hull: back faces drawn again, pushed out along the normal by a fixed number of
// pixels so the line stays the same weight at any zoom. Works on instanced and plain meshes alike.
function outlineMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color() }, width: { value: 1.5 }, resolution: { value: new THREE.Vector2(1, 1) } },
    side: THREE.BackSide,
    vertexShader: /* glsl */ `
      uniform float width;
      uniform vec2 resolution;
      void main() {
        vec4 p = vec4(position, 1.0);
        vec3 n = normal;
        #ifdef USE_INSTANCING
          p = instanceMatrix * p;
          n = mat3(instanceMatrix) * n;
        #endif
        vec4 clip = projectionMatrix * modelViewMatrix * p;
        vec2 dir = (projectionMatrix * vec4(mat3(modelViewMatrix) * n, 0.0)).xy * resolution;
        float len = length(dir);
        if (len > 1e-6) clip.xy += dir / len * width * 2.0 / resolution * clip.w;
        gl_Position = clip;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 color;
      void main() {
        gl_FragColor = vec4(color, 1.0);
        #include <colorspace_fragment>
      }`,
  });
}

// The hull needs one normal per corner, averaged over the faces that meet there, or it splits open at every edge
// of a flat-shaded STL.
const smoothCache = new WeakMap();
function smoothed(geometry) {
  let g = smoothCache.get(geometry);
  if (!g) {
    const bare = new THREE.BufferGeometry();
    bare.setAttribute('position', geometry.getAttribute('position'));
    if (geometry.index) bare.setIndex(geometry.index);
    g = mergeVertices(bare, 1e-5);
    g.computeVertexNormals();
    smoothCache.set(geometry, g);
  }
  return g;
}

// In-plane angles grow from +X toward +Z, which is a negative turn about +Y.
const inPlane = (q, degrees) => q.setFromAxisAngle(Y_AXIS, -THREE.MathUtils.degToRad(degrees));

// One scene, two cameras: a fixed orthographic front view ('2d') and an orbiting perspective view ('3d').
export async function createViewer(container, geo) {
  // the MCU node sits on the centre of the hexagon's corner frames
  const frames = Object.values(geo.hexFrames);
  const mid = { x: frames.reduce((t, f) => t + f.x, 0) / frames.length, z: frames.reduce((t, f) => t + f.z, 0) / frames.length };
  const [hexTpl, nodeTpl, edgeTpl] = await Promise.all([
    buildTemplate(geo.hexVisuals, (v) => Math.hypot(v.xyz[0] - mid.x, v.xyz[2] - mid.z) < 0.05),
    buildTemplate(geo.nodeVisuals),
    buildTemplate(geo.edgeVisuals),
  ]);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  container.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  // ambient sets the darkest band, the key light adds the rest (Lambert divides both by pi)
  scene.add(new THREE.AmbientLight(0xffffff, 0.62 * Math.PI));
  const key = new THREE.DirectionalLight(0xffffff, 0.42 * Math.PI);
  key.position.set(3, 5, 8);
  scene.add(key);

  const perspective = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
  const controls = new OrbitControls(perspective, renderer.domElement);
  controls.enableDamping = true;
  controls.enabled = false;

  // bodies are white and take their colour per instance, so a selected hexagon is a colour, not a tint
  let palette = readPalette();
  const gradientMap = toonRamp();
  const toon = (params) => new THREE.MeshToonMaterial({ gradientMap, ...params });
  const materials = {
    hexBody: toon({ color: 0xffffff }),
    edgeBody: toon({ color: 0xffffff }),
    led: toon({ color: palette.led, emissive: palette.led, emissiveIntensity: 0.25 }),
    nodeBody: toon({ color: 0xffffff }),
    mcu: toon({ color: palette.mcu }),
    // the backboard and its raised sides are one material
    board: toon({ color: palette.board }),
  };
  const ink = outlineMaterial();
  ink.uniforms.color.value.copy(palette.outline);
  const outlined = (mesh) => {
    const hull = new THREE.Mesh(smoothed(mesh.geometry), ink);
    hull.raycast = () => {};
    mesh.add(hull);
    return mesh;
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
      // instanced hulls share their parent's template geometry; the board's own geometry goes with it
      obj.traverse((o) => o.isInstancedMesh && o.dispose());
      if (!obj.isInstancedMesh) obj.geometry?.dispose();
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
    return Math.max(maxY(hexTpl.all), maxY(hexTpl.led), maxY(nodeTpl.body, lat.nodeYOffset), maxY(edgeTpl.body, lat.edge.yOffset), maxY(edgeTpl.led, lat.edge.yOffset));
  }

  // White backboard cut to the outline of the build, grown by the node-body radius so every node sits on it, with
  // side walls of the same material running round its edge and going back from it, which raise it off the wall.
  function buildBoard(outline, { t, raise }, backZ) {
    const margin = lattice.rho;
    const path = (loop, p) => {
      loop.forEach((q, i) => (i ? p.lineTo(q.x, q.z) : p.moveTo(q.x, q.z)));
      p.closePath();
      return p;
    };
    const inside = ({ x, z }, loop) =>
      loop.reduce((odd, p, i) => {
        const q = loop[(i + 1) % loop.length];
        return (p.z > z) !== (q.z > z) && x < p.x + ((z - p.z) * (q.x - p.x)) / (q.z - p.z) ? !odd : odd;
      }, false);
    const slab = (shapes, z0, depth) => {
      const mesh = outlined(new THREE.Mesh(new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false }), materials.board));
      mesh.position.z = z0;
      scene.add(mesh);
      return mesh;
    };

    // each hole goes in the smallest outer loop around it
    const outers = outline.filter((l) => loopArea(l) > 0).sort((a, b) => loopArea(a) - loopArea(b));
    const shapes = new Map(outers.map((l) => [l, path(offsetLoop(l, margin), new THREE.Shape())]));
    for (const hole of outline.filter((l) => loopArea(l) < 0)) {
      const owner = outers.find((l) => inside(hole[0], l));
      if (owner) shapes.get(owner).holes.push(path(offsetLoop(hole, margin), new THREE.Path()));
    }
    if (!shapes.size) return [];
    const meshes = [slab([...shapes.values()], backZ - t, t)];

    // a wall t thick just inside the board's edge, round the outside and round every hole
    if (raise > 0) {
      const rings = outline.map((l) => {
        const [big, small] = [offsetLoop(l, margin), offsetLoop(l, margin - t)].sort((a, b) => Math.abs(loopArea(b)) - Math.abs(loopArea(a)));
        const ring = path(big, new THREE.Shape());
        ring.holes.push(path(small, new THREE.Path()));
        return ring;
      });
      meshes.push(slab(rings, backZ - t - raise, raise));
    }
    return meshes;
  }

  // the hull reads its parent's instance matrices, so hover and pop animations carry the ink line along
  function instanced(geometry, material, count, { outline = true } = {}) {
    const mesh = new THREE.InstancedMesh(geometry, material, Math.max(count, 1));
    mesh.count = count;
    if (outline) {
      const hull = new THREE.InstancedMesh(smoothed(geometry), ink, Math.max(count, 1));
      hull.instanceMatrix = mesh.instanceMatrix;
      hull.count = count;
      hull.frustumCulled = false;
      hull.raycast = () => {};
      mesh.add(hull);
    }
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
    orbitPose = { pos: perspective.position.clone(), target: controls.target.clone() };
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

  let fly = null; // camera move between the front view and the orbit view
  let orbitPose = null; // where the orbit camera was, to return to it
  const camera = () => (mode === '3d' || fly ? perspective : ortho);
  const render = () => renderer.render(scene, camera());

  // --- hover ripple through one hexagon's own parts, and selection ------------------
  // On hover the hexagon's parts come out ring by ring from its centre: the centre plate stack, the
  // channels around it, the next plate stacks, the next channels, and so on. They stay out while hovered;
  // moving off sends them back in the same order. Other hexagons stay put.
  const LIFT = 0.16; // meters toward the viewer at full raise
  const GROW = { stack: 0.6, channel: 0.12 }; // extra scale of each part about its own centre, which is what shows in 2D
  const RING_DELAY = 0.075; // seconds between rings
  // each part rides a slightly underdamped spring, so it overshoots a touch and settles: the bouncy anime feel
  const SPRING = { k: 180, damping: 2 * Math.sqrt(180) * 0.5 };
  // whole hexagons pop onto the wall from the centre outward, and squash away when excluded
  const POP = { inMs: 520, outMs: 380, bumpMs: 320, stagger: 0.35 };
  const FLY_MS = 650;
  // while hovered the raised parts keep a gentle wave running outward through the rings, never dropping to the wall
  const RIPPLE = { depth: 0.3, period: 1.4 }; // fraction of the raise, seconds per cycle
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const raycaster = new THREE.Raycaster();

  // hover copies live outside `root`, which update() clears
  const hoverRoot = new THREE.Group();
  hoverRoot.rotation.x = -Math.PI / 2;
  scene.add(hoverRoot);

  let hexList = [];
  let hexMeshes = { body: null, mcu: null, led: null };
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
  // node plate stacks built into hexagons and Edges are 'normal' nodes; LEDs are 'led' in a hexagon, 'edgeled' in an Edge
  const partShown = (part) => shown(part.layer);

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
    return { geometry: p.geometry, led: p.led, src: 'edge', layer: p.led ? 'edgeled' : 'normal', center: box.getCenter(new THREE.Vector3()) };
  });

  function buildHexParts(hc) {
    const parts = hexTpl.parts.map((p) => {
      const box = new THREE.Box3().setFromBufferAttribute(p.geometry.attributes.position);
      return { geometry: p.geometry, led: p.led, src: 'hex', layer: p.led ? 'led' : p.mcu ? 'mcu' : 'normal', center: box.getCenter(new THREE.Vector3()), d: Math.hypot(p.xyz[0] - hc.x, p.xyz[2] - hc.z) };
    });
    // 2 cm buckets: centre stack, inner channels, inner stacks, mid channels, outer stacks, outer channels
    const bucket = (d) => Math.round(d * 50);
    const levels = [...new Set(parts.map((p) => bucket(p.d)))].sort((x, y) => x - y);
    for (const p of parts) p.ring = levels.indexOf(bucket(p.d));
    return { parts, rings: levels.length };
  }

  function partMesh(part, parent, hexId) {
    const body = { edge: materials.edgeBody, hex: materials.hexBody }[part.src] ?? materials.nodeBody;
    const material = (part.led ? materials.led : body).clone();
    const mesh = new THREE.Mesh(part.geometry, material);
    if (!part.led) outlined(mesh);
    mesh.userData.hexId = hexId;
    mesh.visible = partShown(part);
    parent.add(mesh);
    return mesh;
  }

  function openSession(h) {
    const hc = lattice.hexCenter;
    const group = new THREE.Group();
    group.position.set(h.x - hc.x, 0, h.z - hc.z);
    const items = hexParts.parts.map((part) => ({
      mesh: partMesh(part, group, h.id),
      part,
      ring: part.ring,
      base: part.layer === 'mcu' ? palette.mcu.clone() : undefined,
      v: 0,
      target: 0,
    }));
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
    session.items = session.items.filter((item) => item.part.src !== 'edge');
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
          item.kind = n.kind;
          item.base.copy(palette.node[n.kind]);
          item.mesh.visible = partShown(item.part);
        }
        continue;
      }
      const holder = new THREE.Group();
      holder.matrixAutoUpdate = false;
      holder.matrix.copy(nodeMatrix(n));
      hoverRoot.add(holder);
      for (const p of nodeParts) {
        const part = { ...p, src: 'node', layer: nodeLayer(n) };
        session.nodeItems.push({ key, holder, mesh: partMesh(part, holder, h.id), part, base: palette.node[n.kind].clone(), kind: n.kind, v: 0, target: 0 });
      }
    }
    for (const item of session.nodeItems) item.ring = hexParts.rings;
    session.items = [...session.items.filter((x) => x.part.src !== 'node'), ...session.nodeItems];
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

  const tint = (id) => (selected.has(id) ? palette.select : palette.hex);

  function applySession(session, now = performance.now()) {
    const bodyBase = tint(session.h.id);
    const still = reduceMotion.matches;
    const bump = bumpOf(session.h.id, now) ?? 1;
    for (const item of session.items) {
      const { mesh, part, ring, v: raise } = item;
      const phase = (now - session.t0) / 1000 - ring * RING_DELAY;
      const wave = still || phase < 0 ? 0 : RIPPLE.depth * Math.sin((2 * Math.PI * phase) / RIPPLE.period);
      const v = raise * (1 + wave);
      const k = (1 + (part.led ? GROW.channel : GROW.stack) * v) * bump;
      const c = part.center;
      mesh.scale.setScalar(k);
      // grow about the part's own centre, then lift it off the wall toward the viewer (URDF -Y)
      mesh.position.set(c.x * (1 - k), c.y * (1 - k) - LIFT * v, c.z * (1 - k));
      if (part.led) mesh.material.emissiveIntensity = materials.led.emissiveIntensity * (1 + 2.5 * v);
      else mesh.material.color.copy(item.base ?? bodyBase).multiplyScalar(1 + 1.1 * v);
    }
  }

  // --- pops: hexagons arriving, leaving and being picked ---------------------------
  const keyOf = (h) => `${h.row}:${h.col}`;
  let hexById = new Map();
  let placed = null; // where each grid position sat last update, to tell arrivals and departures apart
  const appear = new Map(); // grid key -> start time
  const bumps = new Map(); // hexagon id -> start time
  let leaving = []; // { x, z, start } of hexagons that just left the layout
  let leaveMeshes = null;
  const easeOutBack = (p) => 1 + 2.4 * (p - 1) ** 3 + 1.4 * (p - 1) ** 2;
  const popping = () => appear.size > 0 || bumps.size > 0;

  // scale and drop of a hexagon (and so of its nodes and Edges) this frame; null when at rest
  function popOf(h, now) {
    if (!h) return null;
    let s = 1;
    let drop = 0;
    const a = appear.get(keyOf(h));
    if (a !== undefined) {
      const p = (now - a) / POP.inMs;
      if (p <= 0) s = 0;
      else if (p < 1) {
        s = easeOutBack(p);
        drop = LIFT * 0.7 * (1 - p) ** 2;
      } else appear.delete(keyOf(h));
    }
    const b = bumpOf(h.id, now);
    if (b === null) bumps.delete(h.id);
    else s *= b;
    return s === 1 && drop === 0 ? null : { s, drop };
  }

  // a quick boing when a hexagon is picked; null once it is over
  function bumpOf(id, now) {
    const b = bumps.get(id);
    if (b === undefined) return 1;
    const p = (now - b) / POP.bumpMs;
    return p < 1 ? 1 + 0.12 * Math.sin(Math.PI * p) : null;
  }

  // scales a part placed at wall coordinates about its hexagon's centre
  const scratch = { t: new THREE.Matrix4(), s: new THREE.Matrix4() };
  function popAbout(h, pop, m) {
    scratch.t.makeTranslation(-h.x, 0, -h.z);
    scratch.s.makeScale(pop.s, pop.s, pop.s).multiply(scratch.t);
    scratch.t.makeTranslation(h.x, -pop.drop, h.z);
    return m.premultiply(scratch.t.multiply(scratch.s));
  }

  // diffs the new layout against the last one: new grid positions pop in, lost ones squash away
  function startPops(hexes) {
    const now = performance.now();
    const before = placed;
    placed = new Map(hexes.map((h) => [keyOf(h), h]));
    leaving = leaving.filter((l) => now - l.start < POP.outMs);
    if (reduceMotion.matches) {
      appear.clear();
      leaving = [];
      return;
    }
    const fresh = hexes.filter((h) => !before?.has(keyOf(h)));
    if (fresh.length) {
      const cx = fresh.reduce((t, h) => t + h.x, 0) / fresh.length;
      const cz = fresh.reduce((t, h) => t + h.z, 0) / fresh.length;
      const far = Math.max(...fresh.map((h) => Math.hypot(h.x - cx, h.z - cz)), 1e-9);
      for (const h of fresh) appear.set(keyOf(h), now + ((Math.hypot(h.x - cx, h.z - cz) / far) * POP.stagger * 1000 || 0));
    }
    // a big relayout reads better as one fresh build than as a cloud of departures
    if (before && fresh.length <= hexes.length / 2) {
      for (const [key, h] of before) if (!placed.has(key)) leaving.push({ x: h.x, z: h.z, start: now });
    }
  }

  function buildLeaving() {
    leaveMeshes = null;
    if (!leaving.length) return;
    leaveMeshes = {
      body: instanced(hexTpl.all, materials.hexBody, leaving.length),
      led: hexTpl.led && instanced(hexTpl.led, materials.led, leaving.length, { outline: false }),
    };
    leaving.forEach((_, i) => leaveMeshes.body.setColorAt(i, palette.hex));
  }

  // swell a little, then spin down to nothing
  function writeLeaving(now) {
    if (!leaveMeshes) return;
    const hc = lattice.hexCenter;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const shift = new THREE.Matrix4().makeTranslation(-hc.x, 0, -hc.z);
    leaving.forEach((l, i) => {
      const p = Math.min(1, (now - l.start) / POP.outMs);
      const s = p < 0.25 ? 1 + 0.18 * (p / 0.25) : 1.18 * (1 - ((p - 0.25) / 0.75) ** 2);
      inPlane(q, 40 * p * p);
      m.compose(new THREE.Vector3(l.x, -LIFT * 0.4 * Math.sin(Math.PI * p), l.z), q, new THREE.Vector3(s, s, s)).multiply(shift);
      if (p >= 1) m.makeScale(0, 0, 0);
      leaveMeshes.body.setMatrixAt(i, m);
      leaveMeshes.led?.setMatrixAt(i, m);
    });
    leaveMeshes.body.instanceMatrix.needsUpdate = true;
    if (leaveMeshes.led) leaveMeshes.led.instanceMatrix.needsUpdate = true;
    if (leaving.every((l) => now - l.start >= POP.outMs)) {
      leaving = [];
      leaveMeshes.body.visible = false;
      if (leaveMeshes.led) leaveMeshes.led.visible = false;
      leaveMeshes = null;
    }
  }

  // the static instance of a hexagon is hidden while its parts are out as separate meshes
  function writeHexes(now = performance.now()) {
    const { body, mcu, led } = hexMeshes;
    if (!body || !lattice) return;
    const hc = lattice.hexCenter;
    const out = new Set(sessions.map((s) => s.h.id));
    const m = new THREE.Matrix4();
    hexList.forEach((h, i) => {
      const pop = popOf(h, now);
      if (out.has(h.id)) m.makeScale(0, 0, 0);
      else {
        m.makeTranslation(h.x - hc.x, 0, h.z - hc.z);
        if (pop) popAbout(h, pop, m);
      }
      body.setMatrixAt(i, m);
      mcu?.setMatrixAt(i, m);
      led?.setMatrixAt(i, m);
      body.setColorAt(i, tint(h.id));
    });
    body.instanceMatrix.needsUpdate = true;
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    if (mcu) mcu.instanceMatrix.needsUpdate = true;
    if (led) led.instanceMatrix.needsUpdate = true;
    writeEdges(now);
    writeNodes(now);
  }

  // Edges belong to their hexagon: they share its selection tint and leave the wall with it
  function writeEdges(now = performance.now()) {
    const { body, led } = edgeMeshes;
    if (!lattice || (!body && !led)) return;
    const out = new Set(sessions.map((s) => s.h.id));
    const m = new THREE.Matrix4();
    edgeList.forEach((e, i) => {
      if (out.has(e.hexId)) m.makeScale(0, 0, 0);
      else {
        edgeMatrix(e, m);
        const h = hexById.get(e.hexId);
        const pop = popOf(h, now);
        if (pop) popAbout(h, pop, m);
      }
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
    let moving = popping();
    if (moving) writeHexes(now);
    writeLeaving(now);
    if (leaveMeshes) moving = true;
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
        item.vel ??= 0;
        if (still) {
          item.v = item.target;
          item.vel = 0;
        } else {
          item.vel += (SPRING.k * (item.target - item.v) - SPRING.damping * item.vel) * dt;
          item.v += item.vel * dt;
        }
        if (Math.abs(item.target - item.v) < 0.001 && Math.abs(item.vel) < 0.01) {
          item.v = item.target;
          item.vel = 0;
        } else settled = false;
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
    if (fly) stepFly(now);
    else if (mode === '3d') controls.update();
    render();
    if (moving || fly || mode === '3d') rafId = requestAnimationFrame(frame);
    else last = 0;
  }
  const kick = () => {
    if (!rafId) rafId = requestAnimationFrame(frame);
  };

  function update({ W, H, hexes, nodes, edges, lat, board, outline }) {
    clear();
    wallSize = { W, H };
    lattice = lat;

    // root turns URDF Y into world -Z
    wallObjects = board.on ? buildBoard(outline, board, -backOf(lat)) : [];

    hexParts ??= buildHexParts(lat.hexCenter);
    hexList = hexes;
    const byId = new Map(hexes.map((h) => [h.id, h]));
    hexById = byId;
    startPops(hexes);
    buildLeaving();
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
      mcu: hexTpl.mcu && instanced(hexTpl.mcu, materials.mcu, hexes.length),
      led: hexTpl.led && instanced(hexTpl.led, materials.led, hexes.length, { outline: false }),
    };
    edgeMeshes = {
      body: edgeTpl.body && instanced(edgeTpl.body, materials.edgeBody, edges.length),
      led: edgeTpl.led && instanced(edgeTpl.led, materials.led, edges.length, { outline: false }),
    };
    writeHexes();

    nodeMesh = instanced(nodeTpl.body, materials.nodeBody, nodes.length);
    paintNodes();
    writeNodes();

    // frame the wall and the board
    const bounds = { minX: 0, maxX: W, minZ: 0, maxZ: H };
    for (const p of outline.flatMap((l) => offsetLoop(l, lat.rho))) {
      bounds.minX = Math.min(bounds.minX, p.x);
      bounds.maxX = Math.max(bounds.maxX, p.x);
      bounds.minZ = Math.min(bounds.minZ, p.z);
      bounds.maxZ = Math.max(bounds.maxZ, p.z);
    }
    const size = [...Object.values(bounds), board.on ? board.raise : 0].map((v) => v.toFixed(4)).join(',');
    if (size !== fittedSize) {
      fittedSize = size;
      fitPerspective(bounds);
    }
    applyShow();
    fitOrtho();
    render();
    kick();
  }

  function paintNodes() {
    if (!nodeMesh) return;
    nodeList.forEach((n, i) => nodeMesh.setColorAt(i, palette.node[n.kind]));
    if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;
  }

  // all node kinds share one instanced mesh
  function writeNodes(now = performance.now()) {
    if (!nodeMesh || !lattice) return;
    const m = new THREE.Matrix4();
    const out = new Set(sessions.flatMap((s) => s.nodeItems.map((x) => x.key)));
    nodeList.forEach((n, i) => {
      // hidden kinds, and nodes that are out with a hovered hexagon, collapse to nothing
      if (!shown(nodeLayer(n)) || out.has(nodeKey(n))) m.makeScale(0, 0, 0);
      else {
        nodeMatrix(n, m);
        const h = hexById.get(n.hexId);
        const pop = popOf(h, now);
        if (pop) popAbout(h, pop, m);
      }
      nodeMesh.setMatrixAt(i, m);
    });
    nodeMesh.instanceMatrix.needsUpdate = true;
    // the cached bounds would otherwise cull nodes that come back after being hidden
    nodeMesh.computeBoundingSphere();
  }

  function applyShow() {
    if (hexMeshes.body) hexMeshes.body.visible = shown('normal');
    if (hexMeshes.mcu) hexMeshes.mcu.visible = shown('mcu');
    if (hexMeshes.led) hexMeshes.led.visible = shown('led');
    if (edgeMeshes.body) edgeMeshes.body.visible = shown('normal');
    if (edgeMeshes.led) edgeMeshes.led.visible = shown('edgeled');
    for (const session of sessions) for (const { mesh, part } of session.items) mesh.visible = partShown(part);
    // in 2D the overlay draws the wiring, so the model only carries it in 3D
    wiringRoot.visible = mode === '3d' && shown('wiring');
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
    const now = performance.now();
    if (!reduceMotion.matches) for (const id of ids) if (!selected.has(id)) bumps.set(id, now);
    selected = new Set(ids);
    writeHexes();
    sessions.forEach(applySession);
    render();
    if (popping()) kick();
  }

  // wall coordinates (URDF x, z) under a screen point, found on the plane of the hexagon frames
  const wallPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  function wallPoint(clientX, clientY) {
    if (!lattice) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera());
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
    renderer.getDrawingBufferSize(ink.uniforms.resolution.value);
    ink.uniforms.width.value = 1.4 * renderer.getPixelRatio();
    perspective.aspect = w / h;
    perspective.updateProjectionMatrix();
    fitOrtho();
    render();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  // --- 2D <-> 3D: fly the perspective camera between a front view that matches the flat drawing and the orbit view

  // the perspective view whose picture of the wall plane matches the orthographic frame
  function frontPose() {
    if (!lattice || !wallSize) return null;
    const zWall = -lattice.hexCenter.y;
    const target = new THREE.Vector3((ortho.left + ortho.right) / 2, (ortho.top + ortho.bottom) / 2, zWall);
    const dist = (ortho.top - ortho.bottom) / 2 / Math.tan(THREE.MathUtils.degToRad(perspective.fov) / 2);
    return { pos: target.clone().add(new THREE.Vector3(0, 0, dist)), target };
  }

  const flyTarget = new THREE.Vector3();
  function stepFly(now) {
    const p = Math.min(1, (now - fly.t0) / FLY_MS);
    const e = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
    perspective.position.lerpVectors(fly.from.pos, fly.to.pos, e);
    flyTarget.lerpVectors(fly.from.target, fly.to.target, e);
    perspective.lookAt(flyTarget);
    if (p < 1) return;
    const { done } = fly;
    fly = null;
    done();
  }

  // resolves once the camera has arrived, so the caller can bring the 2D overlay back in step
  function setMode(next) {
    const was = mode;
    const live = fly ? { pos: perspective.position.clone(), target: flyTarget.clone() } : null;
    if (was === '3d' && !fly) orbitPose = { pos: perspective.position.clone(), target: controls.target.clone() };
    mode = next;
    applyShow();
    controls.enabled = false;
    renderer.domElement.style.cursor = next === '3d' ? 'grab' : '';
    resize();
    const front = frontPose();
    const finish = () => {
      if (mode === '3d' && orbitPose) {
        perspective.position.copy(orbitPose.pos);
        controls.target.copy(orbitPose.target);
        controls.update();
      }
      controls.enabled = mode === '3d';
    };
    if (next === was && !fly) {
      finish();
      kick();
      return Promise.resolve();
    }
    if (reduceMotion.matches || !front || !orbitPose) {
      fly = null;
      finish();
      kick();
      return Promise.resolve();
    }
    const from = live ?? (was === '3d' ? orbitPose : front);
    const to = next === '3d' ? orbitPose : front;
    return new Promise((resolve) => {
      fly?.done();
      controls.enabled = false;
      fly = {
        from: { pos: from.pos.clone(), target: from.target.clone() },
        to,
        t0: performance.now(),
        done: () => {
          finish();
          resolve();
        },
      };
      kick();
    });
  }

  // --- wiring: the labels page's wires as soft tubes just in front of the LED channels ---
  // they live outside `root`, which update() clears, and are rebuilt by setWiring
  const wiringRoot = new THREE.Group();
  wiringRoot.rotation.x = -Math.PI / 2;
  wiringRoot.visible = false;
  scene.add(wiringRoot);
  const cssColor = (name) => new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#ff00ff');
  let wireFront = null;
  let wireFocus = null;

  function clearWiring() {
    for (const mesh of [...wiringRoot.children]) {
      wiringRoot.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }

  // a tube along wall-space points, arched a little off the panel toward the viewer between its ends
  function tube(points, y, radius, lift) {
    const curve = new THREE.CatmullRomCurve3(
      points.map((p, i) => new THREE.Vector3(p.x, y - lift * Math.sin((Math.PI * i) / (points.length - 1)), p.z)),
    );
    return new THREE.TubeGeometry(curve, Math.max(8, points.length * 2), radius, 6, false);
  }

  // cuts a polyline into dashes by length, for the runs on the FREE wire
  function dashes(points, on, off) {
    const out = [];
    let cur = [points[0]];
    let left = on;
    let drawing = true;
    for (let i = 1; i < points.length; i++) {
      let a = points[i - 1];
      const b = points[i];
      let seg = Math.hypot(b.x - a.x, b.z - a.z);
      while (seg > left) {
        const t = left / seg;
        const m = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
        if (drawing) {
          cur.push(m);
          out.push(cur);
        }
        cur = [m];
        drawing = !drawing;
        seg -= left;
        a = m;
        left = drawing ? on : off;
      }
      left -= seg;
      if (drawing) cur.push(b);
    }
    if (drawing && cur.length > 1) out.push(cur);
    return out;
  }

  // an arrow along each LED channel from DIN to DOUT: a thin rod and a cone at the DOUT end
  function arrowGeometries(a, y, r) {
    const head = lattice.rho * 1.1;
    const dir = new THREE.Vector3(a.u.x, 0, a.u.z);
    const q = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, dir);
    const len = Math.hypot(a.b.x - a.a.x, a.b.z - a.a.z) - head;
    const shaft = new THREE.CylinderGeometry(r, r, len, 8);
    shaft.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(a.a.x + a.u.x * len / 2, y, a.a.z + a.u.z * len / 2), q, ONE));
    const cone = new THREE.ConeGeometry(head * 0.5, head, 14);
    cone.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(a.b.x - a.u.x * head / 2, y, a.b.z - a.u.z * head / 2), q, ONE));
    // the rod has caps the cone lacks, so both lose their extra attributes before merging
    return [shaft.toNonIndexed(), cone.toNonIndexed()].map((g) => {
      for (const name of Object.keys(g.attributes)) if (!['position', 'normal'].includes(name)) g.deleteAttribute(name);
      return g;
    });
  }

  const touchVar = (g) => (g === 'M' ? '--t-m' : `--t-${g.slice(1)}`);

  function setWiring(paths, arrows = null, sensors = null) {
    clearWiring();
    if ((!paths && !arrows && !sensors) || !lattice) {
      render();
      return;
    }
    if (wireFront === null && hexTpl.led) {
      // in front of the channels and the plate stacks alike
      hexTpl.led.computeBoundingBox();
      hexTpl.all.computeBoundingBox();
      wireFront = Math.min(hexTpl.led.boundingBox.min.y, hexTpl.all.boundingBox.min.y);
    }
    const r = lattice.rho * 0.09;
    const y = (wireFront ?? lattice.hexCenter.y) - r * 2;
    const lift = lattice.rho * 0.6;
    const groups = new Map(); // one merged mesh per colour and chain, so a chain can be picked out
    const add = (key, cssVar, geometry) => {
      if (!groups.has(key)) groups.set(key, { cssVar, chain: key.split(':')[1], list: [] });
      groups.get(key).list.push(geometry);
    };
    for (const a of arrows ?? []) for (const g of arrowGeometries(a, y, r * 3.2)) add(`arrow:L${a.key}`, `--w-l${a.key}`, g);
    // touch sensor wires, and a ring round each node that takes its own sensor
    for (const t of sensors?.runs ?? []) add(`touch:${t.group}`, touchVar(t.group), tube(t.points, y, r * 1.1, lift));
    for (const ring of sensors?.rings ?? []) {
      const torus = new THREE.TorusGeometry(lattice.rho * 1.3, r, 6, 32);
      torus.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(ring.x, y, ring.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2), ONE));
      add(`touch:${ring.group}`, touchVar(ring.group), torus);
    }
    for (const p of paths?.power ?? []) add(`${p.which}:${p.chain}`, p.which === '5V' ? '--w-5v' : '--w-gnd', tube(p.points, y, r * 0.7, lift));
    for (const sgl of paths?.signals ?? []) {
      const pieces = sgl.wire === 'FREE' ? dashes(sgl.points, lattice.rho * 0.35, lattice.rho * 0.22) : [sgl.points];
      for (const piece of pieces) if (piece.length > 1) add(`sig:${sgl.chain}`, `--w-l${sgl.key}`, tube(piece, y, r, lift));
    }
    for (const [key, g] of groups) {
      const material = toon({ color: cssColor(g.cssVar), transparent: true });
      const mesh = new THREE.Mesh(mergeGeometries(g.list), material);
      g.list.forEach((geo) => geo.dispose());
      mesh.userData = { key, cssVar: g.cssVar, chain: g.chain };
      mesh.raycast = () => {};
      wiringRoot.add(mesh);
    }
    focusWiring(wireFocus);
  }

  function focusWiring(id) {
    wireFocus = id;
    for (const mesh of wiringRoot.children) {
      mesh.material.opacity = !id || mesh.userData.chain === id ? 1 : 0.22;
      mesh.material.depthWrite = mesh.material.opacity === 1;
    }
    applyShow();
    render();
  }

  // re-reads the CSS colours after the page switches theme
  function setTheme() {
    palette = readPalette();
    for (const mesh of wiringRoot.children) mesh.material.color.copy(cssColor(mesh.userData.cssVar));
    materials.led.color.copy(palette.led);
    materials.led.emissive.copy(palette.led);
    materials.board.color.copy(palette.board);
    materials.mcu.color.copy(palette.mcu);
    ink.uniforms.color.value.copy(palette.outline);
    for (const session of sessions) {
      for (const item of session.nodeItems) item.base.copy(palette.node[item.kind]);
      // lifted parts carry their own material copies
      for (const item of session.items) if (item.part.layer === 'mcu') item.base.copy(palette.mcu);
      for (const { mesh, part } of session.items) {
        if (part.led) mesh.material.color.copy(palette.led), mesh.material.emissive.copy(palette.led);
      }
    }
    paintNodes();
    writeHexes();
    sessions.forEach(applySession);
    render();
  }

  return { canvas: renderer.domElement, update, setViewBox, setMode, setHover, setSelected, setShow, setTheme, setWiring, focusWiring, wallPoint };
}
