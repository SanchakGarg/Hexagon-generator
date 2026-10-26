// The parts list as parts.xlsx describes it. The server reads the workbook once at startup and hands the browser its
// cells as plain JSON; this module turns them into the list for a wall. The server also uses it to check the sheet
// before it serves it, so a typo shows up straight away rather than on some later wall.
//
// The Parts sheet has one row per item: Item, Section, Price, Qty, Per, Vendor, Description. Qty is counted Per
// something on the wall (PER), and the total is rounded up: 3 per node, or 1 per 7 LED channels. With no Per, Qty
// is for the whole wall. An item that comes to 0 (the backboard, when it is off) is left off the list.
//
// The Settings sheet holds the build guide's numbers. A value there may be a small Excel-like formula on the rows
// above it: + - * / and brackets, and ROUNDUP, ROUNDDOWN, ROUND, MIN and MAX.

// what a Qty can be counted per, from the wall's counts; plurals and any case are fine
const PER = {
  wall: { of: () => 1, f: '1' },
  hexagon: { of: (w) => w.Hexagons, f: 'Hexagons' },
  node: { of: (w) => w.Nodes, f: 'Nodes' },
  'central node': { of: (w) => w.Central_nodes, f: 'Central_nodes' },
  'other node': { of: (w) => w.Nodes - w.Central_nodes, f: '(Nodes-Central_nodes)' },
  'touch sensor': { of: (w) => w.Nodes - w.Sensors_left_out, f: '(Nodes-Sensors_left_out)' },
  'led channel': { of: (w) => w.LED_channels, f: 'LED_channels' },
  backboard: { of: (w) => w.Backboard, f: 'Backboard' },
};
export const PER_NAMES = Object.keys(PER);
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
const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const isBlank = (c) => c == null || (c.f == null && (c.v == null || String(c.v).trim() === ''));
const text = (c) => (isBlank(c) ? '' : String(c.v ?? '').trim());
// a number cell, or text that reads as one (₹ signs and commas allowed); null when blank, NaN when not a number
const numberOf = (c) => (isBlank(c) ? null : typeof c.v === 'number' ? c.v : Number(String(c.v).replace(/[₹,\s]/g, '')));

// "7 LED channels" → { n: 7, unit: PER['led channel'] }; blank is per wall; undefined when not understood
function parsePer(raw) {
  const m = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ').match(/^(?:(\d+(?:\.\d+)?)\s*)?(.*)$/);
  const name = m[2] || 'wall';
  const key = PER[name] ? name : name.replace(/s$/, '');
  return PER[key] && !(m[1] && +m[1] <= 0) && { n: m[1] ? +m[1] : 1, unit: PER[key], name: key };
}

// Settings, worked out in order, so a row can use the rows above it.
export function settingsOf(parts) {
  const values = {};
  const rows = parts.settings.map((r) => {
    const c = r.value;
    const value = isBlank(c) ? null : c.f == null && typeof c.v === 'number' ? c.v : compile(c.f ?? c.v)(scopeOf(values));
    values[r.name] = value;
    return { name: r.name, value, note: r.note };
  });
  // the constants the build guide uses, by their old names in capitals
  const constants = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toUpperCase(), v]));
  return { rows, values, constants };
}

const plural = (n, word) => (n === 1 ? word : `${word}s`);
// the working shown under an item: "3 per node", "1 per 7 LED channels"
function noteOf(it, wall) {
  if (it.qty == null) return '';
  if (it.per.name === 'backboard') return wall.Backboard_size ?? '';
  if (it.per.name === 'wall') return '';
  const label = it.per.name.replace('led', 'LED');
  return `${it.qty} per ${it.per.n === 1 ? label : `${it.per.n} ${plural(it.per.n, label)}`}`;
}

// The parts list for one wall: sections of items { key, label, qty, rate, note, desc, link, f }, as the page and the
// Excel download expect them. wall holds the wall's counts: Hexagons, Nodes, Central_nodes, LED_channels,
// Sensors_left_out, Backboard (1 when on) and Backboard_size (text).
export function buildBom(parts, wall) {
  const settings = settingsOf(parts);
  const sections = [];
  for (const raw of parts.items) {
    const per = parsePer(raw.per);
    const it = { ...raw, per };
    const qty = it.qty == null ? null : Math.ceil((it.qty * per.unit.of(wall)) / per.n - 1e-9);
    if (qty === 0) continue;
    let sec = sections.find((x) => x.title === it.section);
    if (!sec) sections.push((sec = { title: it.section, note: '', items: [] }));
    const whole = Number.isInteger(it.qty / per.n);
    sec.items.push({
      key: slug(it.label),
      label: it.label,
      qty,
      rate: it.price,
      note: noteOf(it, wall) || undefined,
      desc: it.desc,
      link: it.vendor,
      // the same sum as an Excel formula on the wall's counts, for the download
      f: it.qty == null || per.name === 'wall' ? undefined : whole ? `${it.qty / per.n === 1 ? '' : `${it.qty / per.n}*`}${per.unit.f}` : `ROUNDUP(${it.qty === 1 ? '' : `${it.qty}*`}${per.unit.f}/${per.n},0)`,
    });
  }
  const inputs = Object.fromEntries(Object.entries(wall).filter(([, v]) => typeof v === 'number'));
  return { sections, inputs, settings: settings.rows, constants: settings.constants };
}

// Reads the workbook's cells (sheet name → rows of cells, header row first) into the parts list. Returns the parts
// and every problem found, each naming its cell.
export function partsFromSheets(sheets) {
  const errors = [];
  const sheet = (name) => {
    const found = Object.keys(sheets).find((k) => k.trim().toLowerCase() === name.toLowerCase());
    if (!found) errors.push(`no sheet named ${name}`);
    return found ? sheets[found] : [];
  };
  // the header row names the columns, so they can be moved about
  const columns = (rows, sheetName, wanted, optional = []) => {
    const head = (rows[0] ?? []).map((c) => text(c).toLowerCase());
    const at = {};
    for (const [k, label] of Object.entries(wanted)) {
      at[k] = head.findIndex((h) => h === label || h.startsWith(`${label} `) || h.startsWith(`${label}(`));
      if (at[k] < 0 && !optional.includes(k)) errors.push(`${sheetName}: no "${label}" column in row 1`);
    }
    return at;
  };
  const ref = (sheetName, row, col) => `${sheetName}!${String.fromCharCode(65 + Math.max(0, col))}${row + 1}`;

  const setRows = sheet('Settings');
  const sc = columns(setRows, 'Settings', { name: 'name', value: 'value', note: 'note' }, ['note']);
  const settings = [];
  setRows.slice(1).forEach((row, i) => {
    const name = text(row[sc.name]);
    if (!name) return;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) errors.push(`${ref('Settings', i + 1, sc.name)}: "${name}" is not a usable name (letters, digits and _ only)`);
    settings.push({ name, value: row[sc.value] ?? null, note: text(row[sc.note]), at: i + 1 });
  });
  for (const n of REQUIRED_SETTINGS) if (!settings.some((r) => r.name.toLowerCase() === n.toLowerCase())) errors.push(`Settings: the app needs a row named ${n}`);
  const values = {};
  for (const r of settings) {
    try {
      const c = r.value;
      values[r.name] = isBlank(c) ? null : c.f == null && typeof c.v === 'number' ? c.v : compile(c.f ?? c.v)(scopeOf(values));
      if (typeof values[r.name] !== 'number' || !Number.isFinite(values[r.name])) errors.push(`${ref('Settings', r.at, sc.value)}: ${r.name} needs a number`);
    } catch (err) {
      errors.push(`${ref('Settings', r.at, sc.value)}: ${err.message}`);
    }
  }

  const partRows = sheet('Parts');
  const pc = columns(
    partRows,
    'Parts',
    { label: 'item', section: 'section', price: 'price', qty: 'qty', per: 'per', vendor: 'vendor', desc: 'description' },
    ['per', 'vendor', 'desc'],
  );
  const items = [];
  const seen = new Map();
  partRows.slice(1).forEach((row, i) => {
    const r = i + 1;
    const cell = (k) => (pc[k] >= 0 ? row[pc[k]] ?? null : null);
    const label = text(cell('label'));
    if (!label) return;
    const price = numberOf(cell('price'));
    const qty = numberOf(cell('qty'));
    if (Number.isNaN(price)) errors.push(`${ref('Parts', r, pc.price)}: the price of ${label} should be a number, or blank if not known yet`);
    if (Number.isNaN(qty) || qty < 0) errors.push(`${ref('Parts', r, pc.qty)}: the Qty of ${label} should be a number, or blank if not known yet`);
    const per = text(cell('per'));
    if (!parsePer(per)) errors.push(`${ref('Parts', r, pc.per)}: Per "${per}" for ${label} is not one of: ${PER_NAMES.join(', ')} (with a number in front if you like, e.g. 7 LED channels)`);
    const key = slug(label);
    if (seen.has(key)) errors.push(`${ref('Parts', r, pc.label)}: ${label} is listed twice (rows ${seen.get(key) + 1} and ${r + 1})`);
    seen.set(key, r);
    items.push({ label, section: text(cell('section')) || 'Other', price, qty, per, vendor: text(cell('vendor')), desc: text(cell('desc')) });
  });
  if (!items.length) errors.push('Parts: no items (one per row under the header row, with a name in the Item column)');
  return { parts: { settings: settings.map(({ at, ...rest }) => rest), items }, errors };
}

// A vendor cell may hold a shop's link; it is shown as the shop's name, taken from the link's site: robu.in → Robu,
// www.amazon.in/... → Amazon. Well-known shops keep their own spelling.
const SHOP_NAMES = {
  amazon: 'Amazon', amzn: 'Amazon', aliexpress: 'AliExpress', alibaba: 'Alibaba', flipkart: 'Flipkart', indiamart: 'IndiaMART',
  robu: 'Robu', robocraze: 'Robocraze', evelta: 'Evelta', thingbits: 'ThingBits', electronicscomp: 'ElectronicsComp',
  lcsc: 'LCSC', jlcpcb: 'JLCPCB', pcbway: 'PCBWay', digikey: 'DigiKey', mouser: 'Mouser', element14: 'element14',
  sparkfun: 'SparkFun', adafruit: 'Adafruit', meesho: 'Meesho', ebay: 'eBay', quartzcomponents: 'Quartz Components',
};
export const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s ?? '').trim());
export function vendorName(link) {
  if (!isUrl(link)) return String(link ?? '').trim();
  let host;
  try {
    host = new URL(String(link).trim()).hostname.toLowerCase();
  } catch {
    return String(link).trim();
  }
  const parts = host.replace(/^www\d*\./, '').split('.');
  // the name is the label before the public suffix, which may be two labels long (co.in, com.au)
  const two = parts.length > 2 && /^(co|com|net|org|gov|ac|edu)$/.test(parts.at(-2));
  const name = parts.at(two ? -3 : -2) ?? parts[0];
  return SHOP_NAMES[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
}
