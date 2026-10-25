// A small .xlsx reader for parts.xlsx: every sheet's cells as rows of { v, f } (a number or text, and the formula
// when the cell holds one). Enough for a sheet saved by Excel, Numbers, LibreOffice or Google Sheets.
import { inflateRawSync } from 'node:zlib';

// the files inside the zip, by name
function unzip(buf) {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not an .xlsx file (no zip directory)');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('broken zip directory');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    files.set(name, () => (method === 0 ? raw : inflateRawSync(raw)).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unescape = (s) =>
  s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (_, hex, dec, named) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : dec ? String.fromCodePoint(+dec) : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[named.toLowerCase()],
  );
// all the text runs inside a string item, rich text included, but not phonetic hints
const textOf = (xml) => unescape([...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const colIndex = (ref) => [...ref.replace(/\d+$/, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

export function readWorkbook(buf) {
  const files = unzip(buf);
  const read = (name) => {
    const f = files.get(name);
    if (!f) throw new Error(`the workbook has no ${name}`);
    return f();
  };
  const shared = files.has('xl/sharedStrings.xml') ? [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1])) : [];
  const rels = new Map([...read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map(([t]) => [attr(t, 'Id'), attr(t, 'Target')]));
  const sheets = {};
  for (const [tag] of read('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)) {
    const target = rels.get(attr(tag, 'r:id'));
    if (!target) continue;
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const rows = [];
    for (const [, rowAttrs, body] of read(path).matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const r = attr(rowAttrs, 'r') ? +attr(rowAttrs, 'r') - 1 : rows.length;
      const cells = [];
      for (const [, cAttrs, inner = ''] of (body ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const type = attr(cAttrs, 't');
        const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const f = inner.match(/<f\b[^>]*>([\s\S]*?)<\/f>/)?.[1];
        let value = null;
        if (type === 's') value = shared[+v];
        else if (type === 'inlineStr') value = textOf(inner);
        else if (type === 'str' || type === 'e') value = v == null ? null : unescape(v);
        else if (type === 'b') value = v === '1';
        else if (v != null) value = Number(v);
        const ref = attr(cAttrs, 'r');
        cells[ref ? colIndex(ref) : cells.length] = { v: value, ...(f ? { f: unescape(f) } : {}) };
      }
      rows[r] = cells;
    }
    sheets[unescape(attr(tag, 'name'))] = Array.from(rows, (row) => row ?? []);
  }
  return sheets;
}
