// Per-browser preferences: the theme and which panel sections are open. Light is the default, so nothing is
// stored until the theme is switched. Storage can be missing or blocked, and then the page simply forgets.
const THEME_KEY = 'hexwall-theme';
const SECTIONS_KEY = 'hexwall-sections';

function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // remembered for this visit only
  }
}

export const currentTheme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');

// wires the sun/moon button; onChange runs after the new colours apply
export function initTheme(onChange) {
  const button = document.getElementById('theme-toggle');
  const label = () => button.setAttribute('aria-label', `Switch to ${currentTheme() === 'dark' ? 'light' : 'dark'} theme`);
  label();
  button.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    if (next === 'dark') document.documentElement.dataset.theme = 'dark';
    else delete document.documentElement.dataset.theme;
    write(THEME_KEY, next);
    label();
    onChange?.(next);
  });
}

// each <details data-section> keeps its open/closed state
export function initSections() {
  let saved = {};
  try {
    saved = JSON.parse(read(SECTIONS_KEY) ?? '{}') ?? {};
  } catch {
    saved = {};
  }
  const sections = [...document.querySelectorAll('details[data-section]')];
  for (const d of sections) {
    if (typeof saved[d.dataset.section] === 'boolean') d.open = saved[d.dataset.section];
    d.addEventListener('toggle', () => {
      saved[d.dataset.section] = d.open;
      write(SECTIONS_KEY, JSON.stringify(saved));
    });
  }
}

// Named designs, newest first. Each one holds the inputs as typed, in the unit they were typed in.
const SAVES_KEY = 'hexwall-saves';

export function loadSaves() {
  try {
    const list = JSON.parse(read(SAVES_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((s) => s && typeof s.name === 'string' && s.config) : [];
  } catch {
    return [];
  }
}

// false when the browser would not store it
export function storeSaves(list) {
  try {
    localStorage.setItem(SAVES_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}
