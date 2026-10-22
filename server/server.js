// Hexagon Wall Planner server: the app's static files, plus shared build guides kept as JSON files under DATA_DIR
// (a Docker volume, so they outlive the container). Node's standard library only.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const PORT = Number(process.env.PORT ?? 80);
const ROOT = resolve(process.env.PUBLIC_DIR ?? new URL('../public', import.meta.url).pathname);
const SHARES = join(resolve(process.env.DATA_DIR ?? '/data'), 'shares');
const MAX_BODY = 512 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.urdf': 'application/xml',
  '.xml': 'application/xml',
  '.stl': 'model/stl',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const send = (res, code, body, type = 'text/plain; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
  res.end(body);
};
const json = (res, code, value) => send(res, code, JSON.stringify(value), 'application/json');

function readBody(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    let size = 0;
    // past the limit the rest is read and dropped, so the client still gets its 413
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => (size > MAX_BODY ? fail(Object.assign(new Error('too large'), { code: 413 })) : ok(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', fail);
  });
}

async function createShare(req, res) {
  let doc;
  try {
    doc = JSON.parse(await readBody(req));
  } catch (err) {
    return json(res, err.code === 413 ? 413 : 400, { error: err.code === 413 ? 'Too large' : 'Not JSON' });
  }
  if (!doc || typeof doc !== 'object' || !doc.snapshot || typeof doc.snapshot !== 'object') return json(res, 400, { error: 'No design in it' });
  const id = randomUUID();
  const record = { v: 1, id, name: String(doc.name ?? 'Hexagon wall').slice(0, 60), sharedAt: new Date().toISOString(), snapshot: doc.snapshot, playbook: doc.playbook ?? null };
  await mkdir(SHARES, { recursive: true });
  // written whole, then moved into place, so a reader never sees half a file
  const tmp = join(SHARES, `.${id}.tmp`);
  await writeFile(tmp, JSON.stringify(record));
  await rename(tmp, join(SHARES, `${id}.json`));
  json(res, 201, { id });
}

async function getShare(res, id) {
  if (!UUID.test(id)) return json(res, 404, { error: 'Not found' });
  try {
    send(res, 200, await readFile(join(SHARES, `${id}.json`), 'utf8'), 'application/json');
  } catch {
    json(res, 404, { error: 'Not found' });
  }
}

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, 'Bad path');
  }
  let file = normalize(join(ROOT, rel));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) return send(res, 404, 'Not found');
  try {
    let st = await stat(file);
    if (st.isDirectory()) {
      if (!pathname.endsWith('/')) {
        res.writeHead(301, { Location: `${pathname}/` });
        return res.end();
      }
      file = join(file, 'index.html');
      st = await stat(file);
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  } catch {
    send(res, 404, 'Not found');
  }
}

createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://x');
    // the app is served at the site root; old /web/ links land on the same page (kept relative for mapped ports)
    if (pathname === '/web' || pathname.startsWith('/web/')) {
      res.writeHead(301, { Location: `/${pathname.replace(/^\/web\/?/, '')}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}` });
      return res.end();
    }
    if (pathname === '/api/share' && req.method === 'POST') return await createShare(req, res);
    const m = pathname.match(/^\/api\/share\/([^/]+)$/);
    if (m && req.method === 'GET') return await getShare(res, m[1]);
    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    await serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, 'Server error');
    else res.end();
  }
}).listen(PORT, () => console.log(`hexwall on :${PORT}, shares in ${SHARES}`));
