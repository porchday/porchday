export const SITE_APPEARANCE_KEY = 'porchday.site-appearance.v1';

export type SiteAppearance =
  | {v: 1; mode: 'autumn' | 'clean'}
  | {v: 1; mode: 'pattern'; seed: number};
export type SiteAppearanceSnapshot = {
  preference: SiteAppearance;
  storageAvailable: boolean;
  announcement: string;
};
const original: SiteAppearance = {v: 1, mode: 'autumn'};
const initial: SiteAppearanceSnapshot = {
  preference: original,
  storageAvailable: true,
  announcement: '',
};
const validSeed = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

/** Persist only an allowlisted choice and integer seed, never SVG or CSS. */
export function parseSiteAppearance(value: string | null): SiteAppearance {
  if (value === null || value.length > 200) return original;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return original;
    const item = parsed as Record<string, unknown>;
    if (item.v !== 1) return original;
    if ((item.mode === 'autumn' || item.mode === 'clean') && Object.keys(item).length === 2)
      return {v: 1, mode: item.mode};
    if (item.mode === 'pattern' && Object.keys(item).length === 3 && validSeed(item.seed))
      return {v: 1, mode: 'pattern', seed: item.seed};
  } catch { /* Malformed or old preferences use the original background. */ }
  return original;
}

const palettes = [
  ['#281b13', '#653919', '#df762b', '#ffd16d', '#ffecd1'],
  ['#302016', '#704322', '#e38a36', '#e7b85f', '#f5dfba'],
  ['#251b16', '#5f3928', '#ca652d', '#efbb64', '#f5e2c8'],
  ['#302018', '#76422b', '#d87a32', '#f6c376', '#fff0d8'],
] as const;

/** Trusted local SVG only: all markup is fixed, all variable values are numbers
 * or colors from this palette. No stored text, external resources, or scripts. */
export function generateSitePattern(seed: number): {svg: string; color: string; image: string} {
  if (!validSeed(seed)) throw new Error('Invalid background seed');
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 0x100000000;
  };
  const pick = (count: number) => Math.floor(next() * count);
  const [base, band, orange, gold, cream] = palettes[pick(palettes.length)];
  const width = 144 + pick(4) * 16, height = 112 + pick(3) * 16;
  const rows = [16 + pick(9), Math.floor(height / 2) + 12 + pick(9)];
  const thickness = 18 + pick(9), chevron = 10 + pick(6), spacing = 25 + pick(9);
  const shapes = [`<rect width="${width}" height="${height}" fill="${base}"/>`];
  rows.forEach((y, row) => {
    shapes.push(`<path d="M0 ${y}H${width}" stroke="${band}" stroke-width="${thickness}"/>`);
    const direction = (pick(2) + row) % 2 === 0 ? 1 : -1;
    for (let x = -spacing; x < width + spacing; x += spacing) {
      shapes.push(`<path d="M${x} ${y - chevron}l${direction * chevron} ${chevron}l${-direction * chevron} ${chevron}" fill="none" stroke="${orange}" stroke-width="${4 + pick(3)}"/>`);
    }
  });
  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < 4; column++) {
      const x = 10 + column * Math.floor(width / 4) + pick(12);
      const y = rows[row] + Math.floor(height / 4) + pick(5), size = 4 + pick(4);
      switch (pick(3)) {
        case 0:
          shapes.push(`<path d="M${x} ${y - size}l${size} ${size}l${-size} ${size}l${-size} ${-size}Z" fill="none" stroke="${cream}" stroke-width="2"/>`);
          break;
        case 1:
          shapes.push(`<path d="M${x} ${y - size}v${2 * size}m${-size} ${-size}h${2 * size}" fill="none" stroke="${gold}" stroke-width="3"/>`);
          break;
        default:
          shapes.push(`<circle cx="${x}" cy="${y}" r="${size}" fill="${gold}" stroke="${base}" stroke-width="2"/>`);
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${shapes.join('')}</svg>`;
  return {svg, color: base, image: `url("data:image/svg+xml,${encodeURIComponent(svg)}")`};
}

export function siteAppearanceStyle(preference: SiteAppearance): {color: string; image: string} {
  if (preference.mode === 'pattern') return generateSitePattern(preference.seed);
  if (preference.mode === 'clean') return {color: '#f4f0e8', image: 'none'};
  return {color: '#281b13', image: 'url("/porch-pattern.svg")'};
}

export interface SiteAppearanceEnvironment {
  read(): string | null;
  write(value: string): void;
  apply(preference: SiteAppearance): void;
  listen(receive: (value: string | null) => void): () => void;
  randomSeed(): number;
}

/** The store is browser-local and independent of member/profile/vault state. */
export function createSiteAppearanceStore(environment: SiteAppearanceEnvironment) {
  let snapshot = initial, initialized = false, stopListening: (() => void) | undefined;
  let lastSeed: number | undefined, patternChanges = 0;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const publish = (preference: SiteAppearance, storageAvailable: boolean, announcement: string) => {
    if (preference.mode === 'pattern') lastSeed = preference.seed;
    environment.apply(preference);
    snapshot = {preference, storageAvailable, announcement};
    notify();
  };
  const init = () => {
    if (initialized) return;
    initialized = true;
    let preference = original, available = true;
    try { preference = parseSiteAppearance(environment.read()); } catch { available = false; }
    publish(preference, available, '');
    stopListening = environment.listen(value => {
      publish(parseSiteAppearance(value), true, 'Background updated in this browser.');
    });
  };
  const choose = (mode: 'autumn' | 'clean' | 'pattern') => {
    init();
    let preference: SiteAppearance = {v: 1, mode: mode === 'clean' ? 'clean' : 'autumn'};
    if (mode === 'pattern') {
      let seed: number;
      try { seed = environment.randomSeed(); } catch { seed = ((lastSeed ?? 0) + 1) >>> 0; }
      if (!validSeed(seed)) seed = ((lastSeed ?? 0) + 1) >>> 0;
      if (seed === lastSeed) seed = (seed + 1) >>> 0;
      preference = {v: 1, mode: 'pattern', seed};
      patternChanges++;
    }
    let available = true;
    try { environment.write(JSON.stringify(preference)); } catch { available = false; }
    const label = mode === 'autumn' ? 'Autumn background.' : mode === 'clean' ? 'Clean background.' : `Background pattern ${patternChanges} selected.`;
    publish(preference, available, label + (available ? '' : ' This browser could not save the preference.'));
  };
  return {
    init,
    choose,
    getSnapshot: () => snapshot,
    getServerSnapshot: () => initial,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { stopListening?.(); stopListening = undefined; initialized = false; listeners.clear(); },
  };
}

export const siteAppearanceStore = createSiteAppearanceStore({
  read: () => window.localStorage.getItem(SITE_APPEARANCE_KEY),
  write: value => window.localStorage.setItem(SITE_APPEARANCE_KEY, value),
  apply(preference) {
    const {color, image} = siteAppearanceStyle(preference), root = document.documentElement;
    root.dataset.siteBackground = preference.mode;
    root.style.setProperty('--site-background-color', color);
    root.style.setProperty('--site-background-image', image);
  },
  listen(receive) {
    const listener = (event: StorageEvent) => {
      if (event.key !== SITE_APPEARANCE_KEY && event.key !== null) return;
      try { if (event.storageArea && event.storageArea !== window.localStorage) return; } catch { return; }
      receive(event.key === null ? null : event.newValue);
    };
    window.addEventListener('storage', listener);
    return () => window.removeEventListener('storage', listener);
  },
  randomSeed: () => crypto.getRandomValues(new Uint32Array(1))[0],
});

/** Call synchronously before React's first render; CSS keeps the original
 * autumn tile as its fallback before JavaScript is available. */
export function initSiteAppearance() { siteAppearanceStore.init(); }
