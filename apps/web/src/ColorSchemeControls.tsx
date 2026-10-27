import {useEffect, useSyncExternalStore} from 'react';
import {colorSchemeStore, initColorScheme, type ColorSchemePreference} from './color-scheme';

const choices: Array<[ColorSchemePreference, string]> = [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']];

export function ColorSchemeControls() {
  const {preference, announcement} = useSyncExternalStore(
    colorSchemeStore.subscribe,
    colorSchemeStore.getSnapshot,
    colorSchemeStore.getServerSnapshot,
  );
  useEffect(initColorScheme, []);
  return <div className="background-controls color-scheme-controls" role="group" aria-label="Color scheme">
    <span className="background-controls-label">Colors</span>
    {choices.map(([value, label]) =>
      <button key={value} type="button" aria-pressed={preference === value} onClick={() => colorSchemeStore.choose(value)}>{label}</button>)}
    <span className="background-controls-status" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
  </div>;
}
