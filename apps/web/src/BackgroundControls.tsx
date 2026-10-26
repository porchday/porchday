import {useEffect, useSyncExternalStore} from 'react';
import {initSiteAppearance, siteAppearanceStore} from './site-appearance';

export function BackgroundControls() {
  const {preference, announcement} = useSyncExternalStore(
    siteAppearanceStore.subscribe,
    siteAppearanceStore.getSnapshot,
    siteAppearanceStore.getServerSnapshot,
  );
  useEffect(initSiteAppearance, []);
  return <div className="background-controls" role="group" aria-label="Background">
    <span className="background-controls-label">Background</span>
    <button type="button" aria-pressed={preference.mode === 'autumn'} onClick={() => siteAppearanceStore.choose('autumn')}>Autumn</button>
    <button type="button" aria-pressed={preference.mode === 'clean'} onClick={() => siteAppearanceStore.choose('clean')}>Clean</button>
    <button type="button" aria-pressed={preference.mode === 'pattern'} onClick={() => siteAppearanceStore.choose('pattern')}>New pattern</button>
    <span className="background-controls-status" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
  </div>;
}
