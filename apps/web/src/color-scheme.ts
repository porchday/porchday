export const COLOR_SCHEME_KEY = 'porchday.color-scheme.v1';

export type ColorSchemePreference = 'light' | 'dark' | 'system';
export type ColorScheme = 'light' | 'dark';
export type ColorSchemeSnapshot = {
  preference: ColorSchemePreference;
  scheme: ColorScheme;
  storageAvailable: boolean;
  announcement: string;
};
const initial: ColorSchemeSnapshot = {preference: 'system', scheme: 'light', storageAvailable: true, announcement: ''};

/** Keep in sync with public/color-scheme.js, which applies the choice before first paint. */
export function parseColorScheme(value: string | null): ColorSchemePreference {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

export const resolveColorScheme = (preference: ColorSchemePreference, systemDark: boolean): ColorScheme =>
  preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;

export interface ColorSchemeEnvironment {
  read(): string | null;
  write(value: string): void;
  systemDark(): boolean;
  apply(preference: ColorSchemePreference, scheme: ColorScheme): void;
  listenStorage(receive: (value: string | null) => void): () => void;
  listenSystem(receive: () => void): () => void;
}

const labels: Record<ColorSchemePreference, string> = {
  light: 'Light mode.',
  dark: 'Dark mode.',
  system: 'Using the system color scheme.',
};

/** Browser-local display preference, independent of member/profile/vault state. */
export function createColorSchemeStore(environment: ColorSchemeEnvironment) {
  let snapshot = initial, initialized = false;
  let stops: Array<() => void> = [];
  const listeners = new Set<() => void>();
  const systemDark = () => { try { return environment.systemDark(); } catch { return false; } };
  const publish = (preference: ColorSchemePreference, storageAvailable: boolean, announcement: string) => {
    const scheme = resolveColorScheme(preference, systemDark());
    environment.apply(preference, scheme);
    snapshot = {preference, scheme, storageAvailable, announcement};
    for (const listener of listeners) listener();
  };
  const init = () => {
    if (initialized) return;
    initialized = true;
    let preference: ColorSchemePreference = 'system', available = true;
    try { preference = parseColorScheme(environment.read()); } catch { available = false; }
    publish(preference, available, '');
    stops = [
      environment.listenStorage(value => publish(parseColorScheme(value), true, 'Color scheme updated in this browser.')),
      environment.listenSystem(() => {
        if (snapshot.preference === 'system') publish('system', snapshot.storageAvailable, '');
      }),
    ];
  };
  const choose = (preference: ColorSchemePreference) => {
    init();
    let available = true;
    try { environment.write(preference); } catch { available = false; }
    publish(preference, available, labels[preference] + (available ? '' : ' This browser could not save the preference.'));
  };
  return {
    init,
    choose,
    getSnapshot: () => snapshot,
    getServerSnapshot: () => initial,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() { for (const stop of stops) stop(); stops = []; initialized = false; listeners.clear(); },
  };
}

const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)');

export const colorSchemeStore = createColorSchemeStore({
  read: () => window.localStorage.getItem(COLOR_SCHEME_KEY),
  write: value => window.localStorage.setItem(COLOR_SCHEME_KEY, value),
  systemDark: () => darkQuery().matches,
  apply(preference, scheme) {
    const root = document.documentElement;
    root.dataset.colorScheme = scheme;
    root.dataset.colorPreference = preference;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', scheme === 'dark' ? '#2a1a10' : '#974013');
  },
  listenStorage(receive) {
    const listener = (event: StorageEvent) => {
      if (event.key !== COLOR_SCHEME_KEY && event.key !== null) return;
      try { if (event.storageArea && event.storageArea !== window.localStorage) return; } catch { return; }
      receive(event.key === null ? null : event.newValue);
    };
    window.addEventListener('storage', listener);
    return () => window.removeEventListener('storage', listener);
  },
  listenSystem(receive) {
    const query = darkQuery();
    query.addEventListener('change', receive);
    return () => query.removeEventListener('change', receive);
  },
});

/** Call synchronously before React's first render. */
export function initColorScheme() { colorSchemeStore.init(); }
