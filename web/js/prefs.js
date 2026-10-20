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
