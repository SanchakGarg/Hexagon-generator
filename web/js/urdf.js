async function fetchOk(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  return res;
}

export function parseFrames(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const frames = {};
  for (const joint of doc.querySelectorAll('joint[type="fixed"]')) {
    const child = joint.querySelector('child')?.getAttribute('link');
    const xyz = joint.querySelector('origin')?.getAttribute('xyz');
    if (!child || !xyz) continue;
    const [x, , z] = xyz.trim().split(/\s+/).map(Number);
    frames[child] = { x, z };
  }
  return frames;
}

// Largest XZ distance from the mesh origin; independent of the in-plane rotation.
export function stlRadiusXZ(buffer) {
  const view = new DataView(buffer);
  const count = view.getUint32(80, true);
  let max = 0;
  for (let i = 0; i < count; i++) {
    const base = 84 + i * 50 + 12;
    for (let v = 0; v < 3; v++) {
      const o = base + v * 12;
      const x = view.getFloat32(o, true);
      const z = view.getFloat32(o + 8, true);
      max = Math.max(max, Math.hypot(x, z));
    }
  }
  return max;
}

export async function loadGeometry(root) {
  const [hexRes, nodeRes, stlRes] = await Promise.all([
    fetchOk(`${root}/hexagon/robot.urdf`),
    fetchOk(`${root}/Node/robot.urdf`),
    fetchOk(`${root}/Node/assets/middle_plate.stl`),
  ]);
  return {
    hexFrames: parseFrames(await hexRes.text()),
    nodeFrames: parseFrames(await nodeRes.text()),
    nodeBodyRadius: stlRadiusXZ(await stlRes.arrayBuffer()),
  };
}
