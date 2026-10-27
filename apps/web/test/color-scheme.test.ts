import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ColorSchemeControls} from '../src/ColorSchemeControls';
import {COLOR_SCHEME_KEY,createColorSchemeStore,parseColorScheme,type ColorSchemeEnvironment} from '../src/color-scheme';
import {buildDarkCss} from '../scripts/dark-css';

function browser(saved: string | null = null, systemDark = false) {
  let receiveStorage: ((value: string | null) => void) | undefined, receiveSystem: (() => void) | undefined;
  const state = {saved, systemDark, deniedRead: false, deniedWrite: false, writes: [] as string[], applied: [] as string[], stops: 0};
  const environment: ColorSchemeEnvironment = {
    read() { if (state.deniedRead) throw Error('Storage denied'); return state.saved; },
    write(value) { if (state.deniedWrite) throw Error('Storage denied'); state.saved = value; state.writes.push(value); },
    systemDark: () => state.systemDark,
    apply(preference, scheme) { state.applied.push(`${preference}:${scheme}`); },
    listenStorage(listener) { receiveStorage = listener; return () => { state.stops++; }; },
    listenSystem(listener) { receiveSystem = listener; return () => { state.stops++; }; },
  };
  return {state, environment,
    storageEvent(value: string | null) { state.saved = value; receiveStorage?.(value); },
    systemChange(dark: boolean) { state.systemDark = dark; receiveSystem?.(); }};
}

describe('Browser-local color scheme',()=>{
  it('follows the system by default without writing storage',()=>{
    const tab=browser(null,true),store=createColorSchemeStore(tab.environment);store.init();store.init();
    expect(tab.state.applied).toEqual(['system:dark']);expect(tab.state.writes).toEqual([]);
    expect(store.getSnapshot()).toMatchObject({preference:'system',scheme:'dark',announcement:''});
    tab.systemChange(false);expect(store.getSnapshot().scheme).toBe('light');
  });
  it('persists an explicit choice that ignores later system changes',()=>{
    const tab=browser(),store=createColorSchemeStore(tab.environment);store.choose('dark');
    expect(tab.state.saved).toBe('dark');expect(store.getSnapshot()).toMatchObject({preference:'dark',scheme:'dark',announcement:'Dark mode.'});
    tab.systemChange(false);expect(store.getSnapshot().scheme).toBe('dark');
    const later=browser(tab.state.saved),reloaded=createColorSchemeStore(later.environment);reloaded.init();
    expect(later.state.applied).toEqual(['dark:dark']);
    reloaded.choose('system');expect(reloaded.getSnapshot()).toMatchObject({preference:'system',scheme:'light'});
  });
  it('rejects unknown stored values',()=>{
    for(const value of [null,'','DARK','auto','{"v":1}']) expect(parseColorScheme(value)).toBe('system');
    expect(parseColorScheme('light')).toBe('light');
  });
  it('still applies choices when storage is blocked and says they were not saved',()=>{
    const tab=browser(null,true),store=createColorSchemeStore(tab.environment);tab.state.deniedRead=true;tab.state.deniedWrite=true;
    expect(()=>store.init()).not.toThrow();expect(store.getSnapshot()).toMatchObject({preference:'system',scheme:'dark',storageAvailable:false});
    store.choose('light');expect(tab.state.applied.at(-1)).toBe('light:light');
    expect(store.getSnapshot().announcement).toBe('Light mode. This browser could not save the preference.');
  });
  it('synchronizes other tabs and stops listening when disposed',()=>{
    const tab=browser(),store=createColorSchemeStore(tab.environment);store.init();
    tab.storageEvent('dark');expect(store.getSnapshot()).toMatchObject({preference:'dark',scheme:'dark'});expect(tab.state.writes).toEqual([]);
    tab.storageEvent(null);expect(store.getSnapshot().preference).toBe('system');
    store.dispose();expect(tab.state.stops).toBe(2);
  });
  it('renders labelled pressed-state controls',()=>{
    const html=renderToStaticMarkup(createElement(ColorSchemeControls));
    expect(html).toContain('aria-label="Color scheme"');
    for(const label of ['Light','Dark','System']) expect(html).toContain(`>${label}</button>`);
    expect(html).toContain('aria-pressed="true">System</button>');
  });
});

describe('Dark stylesheet',()=>{
  const web=resolve(import.meta.dirname,'..');
  it('mirrors light colors under a zero-specificity dark scope',()=>{
    const css=buildDarkCss(resolve(web,'src'));
    expect(css).toMatch(/:where\(\[data-color-scheme="dark"\]\) \.background-controls \{\n  color: #[0-9a-f]{6};\n  background-color: #[0-9a-f]{6};/);
    expect(css).toContain("background-image: var(--site-background-image, url('/porch-pattern.svg'));");
    expect(css).not.toMatch(/shadow:/);
  });
  it('is applied before first paint by a same-origin script using the same key',()=>{
    expect(readFileSync(resolve(web,'public/color-scheme.js'),'utf8')).toContain(`'${COLOR_SCHEME_KEY}'`);
    expect(readFileSync(resolve(web,'index.html'),'utf8')).toMatch(/<script src="\/color-scheme\.js"><\/script>\s*<link rel="icon"/);
  });
});
