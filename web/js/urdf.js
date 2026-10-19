async function fetchOk(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  return res;
}

const nums = (s, fallback) => (s ? s.trim().split(/\s+/).map(Number) : fallback);

export function parseFrames(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const frames = {};
  for (const joint of doc.querySelectorAll('joint[type="fixed"]')) {
    const child = joint.querySelector('child')?.getAttribute('link');
    const xyz = joint.querySelector('origin')?.getAttribute('xyz');
    if (!child || !xyz) continue;
    const [x, y, z] = nums(xyz);
    frames[child] = { x, y, z };
  }
  return frames;
}

// Visual meshes of the root link, with mesh URLs resolved against the robot folder.
export function parseVisuals(xmlText, folderUrl) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const visuals = [];
  for (const visual of doc.querySelectorAll('robot > link > visual')) {
    const file = visual.querySelector('geometry > mesh')?.getAttribute('filename');
    if (!file) continue;
    const origin = visual.querySelector('origin');
    visuals.push({
      part: file.split('/').pop().replace(/\.stl$/i, ''),
      url: `${folderUrl}/${file.replace(/^package:\/\//, '')}`,
      xyz: nums(origin?.getAttribute('xyz'), [0, 0, 0]),
      rpy: nums(origin?.getAttribute('rpy'), [0, 0, 0]),
      rgba: nums(visual.querySelector('material > color')?.getAttribute('rgba'), [0.4, 0.4, 0.4, 1]),
    });
  }
  return visuals;
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
  const hexXml = await hexRes.text();
  const nodeXml = await nodeRes.text();
  return {
    hexFrames: parseFrames(hexXml),
    nodeFrames: parseFrames(nodeXml),
    hexVisuals: parseVisuals(hexXml, `${root}/hexagon`),
    nodeVisuals: parseVisuals(nodeXml, `${root}/Node`),
    nodeBodyRadius: stlRadiusXZ(await stlRes.arrayBuffer()),
  };
}
