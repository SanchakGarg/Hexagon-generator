// The parts list as parts.xlsx describes it. The server reads the workbook once at startup and hands the browser its
// cells as plain JSON; this module turns them into the list for a wall. The server also uses it to check every
// formula in the sheet before it serves it, so a typo shows up straight away rather than on some later wall.
//
// Formulas are a small Excel-like language: numbers, names, + - * / and brackets, and ROUNDUP, ROUNDDOWN, ROUND,
// MIN and MAX. Names are the wall's counts (WALL_INPUTS) and the Settings sheet's rows, any case. Text cells may
// carry {formula} placeholders, filled in with the worked-out number.

// the wall's counts, as the app works them out; Backboard is 1 when the backboard is on, Backboard_size its size
export const WALL_INPUTS = ['Hexagons', 'Nodes', 'Central_nodes', 'LED_channels', 'Sensors_left_out', 'Backboard', 'Backboard_size'];
// settings the rest of the app reads (the build guide's steps and channel drawing); the sheet must keep these
export const REQUIRED_SETTINGS = ['Channel_cm', 'Length_cm', 'Channels_per_length', 'LEDs_per_channel', 'LEDs_per_m', 'Node_grams'];

const FUNCS = {
  ROUNDUP: (x, n = 0) => Math.sign(x) * Math.ceil(Math.abs(x) * 10 ** n - 1e-9) / 10 ** n,
  ROUNDDOWN: (x, n = 0) => Math.sign(x) * Math.floor(Math.abs(x) * 10 ** n + 1e-9) / 10 ** n,
  ROUND: (x, n = 0) => Math.sign(x) * Math.round(Math.abs(x) * 10 ** n) / 10 ** n,
  MIN: (...xs) => Math.min(...xs),
  MAX: (...xs) => Math.max(...xs),
};

// parses a formula into a function of a scope (lower-cased name → value); throws on bad syntax
export function compile(src) {
  const text = String(src).trim().replace(/^=/, '');
  const toks = text.match(/\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|[-+*/(),]|\S/g) ?? [];
  let i = 0;
  const peek = () => toks[i];
  const take = (t) => {
    if (t && toks[i] !== t) throw new Error(`expected "${t}"${toks[i] ? ` before "${toks[i]}"` : ' at the end'}`);
    return toks[i++];
  };
  const expr = () => {
    let a = term();
    while (peek() === '+' || peek() === '-') {
      const op = take();
      const l = a, r = term();
      a = op === '+' ? (s) => l(s) + r(s) : (s) => l(s) - r(s);
    }
    return a;
  };
  const term = () => {
    let a = unary();
    while (peek() === '*' || peek() === '/') {
      const op = take();
      const l = a, r = unary();
      a = op === '*' ? (s) => l(s) * r(s) : (s) => l(s) / r(s);
    }
    return a;
  };
  const unary = () => {
    if (peek() === '-') {
      take();
      const a = unary();
      return (s) => -a(s);
    }
    if (peek() === '+') take();
    return atom();
  };
  const atom = () => {
    const t = take();
    if (t == null) throw new Error('formula ends too soon');
    if (/^\d/.test(t)) {
      const n = Number(t);
      return () => n;
    }
    if (t === '(') {
      const a = expr();
      take(')');
      return a;
    }
    if (!/^[A-Za-z_]/.test(t)) throw new Error(`unexpected "${t}"`);
    if (peek() === '(') {
      const fn = FUNCS[t.toUpperCase()];
      if (!fn) throw new Error(`no function ${t}; use ${Object.keys(FUNCS).join(', ')}`);
      take('(');
      const args = [];
      if (peek() !== ')') {
        args.push(expr());
        while (peek() === ',') take(',') && args.push(expr());
      }
      take(')');
      return (s) => fn(...args.map((a) => a(s)));
    }
    const key = t.toLowerCase();
    return (s) => {
      if (!(key in s)) throw new Error(`unknown name ${t}`);
      return s[key];
    };
  };
  if (!toks.length) throw new Error('empty formula');
  const f = expr();
  if (i < toks.length) throw new Error(`unexpected "${toks[i]}"`);
  return f;
}

const scopeOf = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]));
// a whole number as is, anything else to two places at most
const show = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(+v.toFixed(2))) : String(v ?? ''));
const fill = (text, s) => String(text ?? '').replace(/\{([^{}]+)\}/g, (_, f) => show(compile(f)(s)));
const slug = (t) => String(t).toLowerCase().replace(/\{[^}]*\}/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// a cell as read from the sheet: { v } with a number or text, and { f } when the cell holds an Excel formula
const isBlank = (c) => c == null || (c.f == null && (c.v == null || String(c.v).trim() === ''));
// a number cell is that number; text or an Excel formula is one of our formulas
const valueOf = (c, s) => (isBlank(c) ? null : c.f == null && typeof c.v === 'number' ? c.v : compile(c.f ?? c.v)(s));
const formulaOf = (c) => (isBlank(c) || (c.f == null && typeof c.v === 'number') ? null : String(c.f ?? c.v).trim().replace(/^=/, ''));

// Settings, worked out in order, so a row can use the rows above it.
export function settingsOf(parts) {
  const values = {};
  const rows = parts.settings.map((r) => {
    const value = valueOf(r.value, scopeOf(values));
    values[r.name] = value;
    return { name: r.name, value, f: formulaOf(r.value), note: r.note };
  });
  // the constants the build guide uses, by their old names in capitals
  const constants = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toUpperCase(), v]));
  return { rows, values, constants };
}

// The parts list for one wall: sections of items { key, label, qty, rate, note, f }, as the page and the Excel
// download expect them. inputs holds the wall's counts (WALL_INPUTS).
export function buildBom(parts, inputs) {
  const settings = settingsOf(parts);
  const s = scopeOf({ ...settings.values, ...inputs });
  const sections = parts.sections.map((sec) => ({
    title: fill(sec.title, s),
    note: fill(sec.note, s),
    items: sec.items
      .filter((it) => isBlank(it.onlyIf) || valueOf(it.onlyIf, s))
      .map((it) => ({
        key: it.key || slug(it.label),
        label: fill(it.label, s),
        qty: valueOf(it.qty, s),
        rate: valueOf(it.price, s),
        note: fill(it.note, s) || undefined,
        f: formulaOf(it.qty) ?? undefined,
      })),
  }));
  const numeric = Object.fromEntries(Object.entries(inputs).filter(([, v]) => typeof v === 'number'));
  return { sections, inputs: numeric, settings: settings.rows, constants: settings.constants };
}

// Reads the workbook's cells (sheet name → rows of cells, header row first) into the parts list. Returns the parts
// and every problem found, each naming its cell, after trying every formula against a sample wall.
export function partsFromSheets(sheets) {
  const errors = [];
  const sheet = (name) => {
    const found = Object.keys(sheets).find((k) => k.trim().toLowerCase() === name.toLowerCase());
    if (!found) errors.push(`no sheet named ${name}`);
    return found ? sheets[found] : [];
  };
  const text = (c) => (isBlank(c) ? '' : String(c.v ?? '').trim());
  // the header row names the columns, so they can be moved about
  const columns = (rows, sheetName, wanted) => {
    const head = (rows[0] ?? []).map((c) => text(c).toLowerCase());
    const at = {};
    for (const [k, label] of Object.entries(wanted)) {
      at[k] = head.findIndex((h) => h === label || h.startsWith(`${label} `) || h.startsWith(`${label}(`));
      if (at[k] < 0 && k !== 'onlyIf' && k !== 'key' && k !== 'note') errors.push(`${sheetName}: no "${label}" column in row 1`);
    }
    return at;
  };
  const ref = (sheetName, row, col) => `${sheetName}!${String.fromCharCode(65 + col)}${row + 1}`;

  const setRows = sheet('Settings');
  const sc = columns(setRows, 'Settings', { name: 'name', value: 'value', note: 'note' });
  const settings = [];
  setRows.slice(1).forEach((row, i) => {
    const name = text(row[sc.name]);
    if (!name) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) errors.push(`${ref('Settings', i + 1, sc.name)}: "${name}" is not a usable name (letters, digits and _ only)`);
    settings.push({ name, value: row[sc.value] ?? null, note: text(row[sc.note]), at: i + 1 });
  });
  for (const n of REQUIRED_SETTINGS) if (!settings.some((r) => r.name.toLowerCase() === n.toLowerCase())) errors.push(`Settings: the app needs a row named ${n}`);

  const partRows = sheet('Parts');
  const pc = columns(partRows, 'Parts', { section: 'section', label: 'item', qty: 'qty', price: 'price', note: 'note', onlyIf: 'only if', key: 'key' });
  const sections = [];
  partRows.slice(1).forEach((row, i) => {
    const r = i + 1;
    const section = text(row[pc.section]);
    const label = text(row[pc.label]);
    if (section) sections.push({ title: section, note: text(row[pc.note]), items: [], at: r });
    if (!label) return;
    if (!sections.length) return errors.push(`${ref('Parts', r, pc.label)}: item "${label}" comes before any section`);
    const cell = (k) => (pc[k] >= 0 ? row[pc[k]] ?? null : null);
    sections[sections.length - 1].items.push({ label, qty: cell('qty'), price: cell('price'), note: text(cell('note')), onlyIf: cell('onlyIf'), key: text(cell('key')), at: r });
  });

  // try everything against a sample wall, cell by cell, so each problem names where it is
  const sample = { Hexagons: 2, Nodes: 30, Central_nodes: 2, LED_channels: 60, Sensors_left_out: 1, Backboard: 1, Backboard_size: '2 m × 1 m' };
  const values = {};
  for (const r of settings) {
    try {
      values[r.name] = valueOf(r.value, scopeOf(values));
      if (typeof values[r.name] !== 'number' || !Number.isFinite(values[r.name])) errors.push(`${ref('Settings', r.at, sc.value)}: ${r.name} needs a number`);
    } catch (err) {
      errors.push(`${ref('Settings', r.at, sc.value)}: ${err.message}`);
    }
  }
  const s = scopeOf({ ...values, ...sample });
  const check = (sheetName, r, col, fn) => {
    try {
      fn();
    } catch (err) {
      errors.push(`${ref(sheetName, r, col)}: ${err.message}`);
    }
  };
  for (const sec of sections) {
    check('Parts', sec.at, pc.section, () => fill(sec.title, s));
    check('Parts', sec.at, pc.note, () => fill(sec.note, s));
    for (const it of sec.items) {
      check('Parts', it.at, pc.label, () => fill(it.label, s));
      check('Parts', it.at, pc.qty, () => valueOf(it.qty, s));
      check('Parts', it.at, pc.price, () => valueOf(it.price, s));
      check('Parts', it.at, pc.note, () => fill(it.note, s));
      check('Parts', it.at, pc.onlyIf, () => valueOf(it.onlyIf, s));
    }
  }
  const keys = new Map();
  for (const it of sections.flatMap((x) => x.items)) {
    const k = it.key || slug(it.label);
    if (keys.has(k)) errors.push(`${ref('Parts', it.at, pc.key >= 0 ? pc.key : pc.label)}: key "${k}" is used twice (rows ${keys.get(k) + 1} and ${it.at + 1}); give one a different Key`);
    keys.set(k, it.at);
  }
  const strip = ({ at, ...rest }) => rest;
  return { parts: { settings: settings.map(strip), sections: sections.map(({ at, items, ...sec }) => ({ ...sec, items: items.map(strip) })) }, errors };
}
