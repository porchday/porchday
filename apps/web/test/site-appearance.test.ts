import {describe,expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {BackgroundControls} from '../src/BackgroundControls';
import {createSiteAppearanceStore,generateSitePattern,parseSiteAppearance,siteAppearanceStyle,type SiteAppearance,type SiteAppearanceEnvironment} from '../src/site-appearance';

function browser(saved: string | null = null) {
  let receive: ((value: string | null) => void) | undefined;
  const state = {saved, deniedRead: false, deniedWrite: false, reads: 0, listens: 0, stops: 0, seed: 27, writes: [] as string[], applied: [] as SiteAppearance[]};
  const environment: SiteAppearanceEnvironment = {
    read() { state.reads++; if (state.deniedRead) throw Error('Storage denied'); return state.saved; },
    write(value) { if (state.deniedWrite) throw Error('Storage denied'); state.saved = value; state.writes.push(value); },
    apply(preference) { state.applied.push(preference); },
    listen(listener) { state.listens++; receive = listener; return () => { state.stops++; receive = undefined; }; },
    randomSeed() { return state.seed; },
  };
  return {state,environment,storageEvent(value: string | null) { state.saved = value; receive?.(value); }};
}

describe('Browser-local site appearance',()=>{
  it('initializes synchronously once with the exact original autumn tile and no storage write',()=>{
    const tab=browser(),store=createSiteAppearanceStore(tab.environment);let updates=0;
    store.subscribe(()=>updates++);store.init();store.init();
    expect(tab.state.applied).toEqual([{v:1,mode:'autumn'}]);expect(tab.state.reads).toBe(1);expect(tab.state.listens).toBe(1);
    expect(tab.state.writes).toEqual([]);expect(updates).toBe(1);
    expect(siteAppearanceStyle(store.getSnapshot().preference)).toEqual({color:'#281b13',image:'url("/porch-pattern.svg")'});
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });
  it('persists a choice and reproduces the same generated pattern on a later load',()=>{
    const first=browser(),store=createSiteAppearanceStore(first.environment);store.choose('pattern');
    expect(JSON.parse(first.state.saved!)).toEqual({v:1,mode:'pattern',seed:27});expect(first.state.saved).not.toContain('svg');
    const later=browser(first.state.saved),reloaded=createSiteAppearanceStore(later.environment);reloaded.init();
    expect(siteAppearanceStyle(reloaded.getSnapshot().preference)).toEqual(siteAppearanceStyle(store.getSnapshot().preference));
    expect(later.state.writes).toEqual([]);
    reloaded.choose('clean');expect(siteAppearanceStyle(reloaded.getSnapshot().preference).image).toBe('none');
    reloaded.choose('autumn');expect(siteAppearanceStyle(reloaded.getSnapshot().preference).image).toBe('url("/porch-pattern.svg")');
  });
  it('generates a new seed and visible SVG when the random source repeats, including wraparound',()=>{
    const tab=browser(),store=createSiteAppearanceStore(tab.environment);tab.state.seed=0xffffffff;
    store.choose('pattern');const first=store.getSnapshot().preference,image=siteAppearanceStyle(first).image;
    const announcement=store.getSnapshot().announcement;
    store.choose('pattern');const second=store.getSnapshot().preference;
    expect(first).toEqual({v:1,mode:'pattern',seed:0xffffffff});expect(second).toEqual({v:1,mode:'pattern',seed:0});
    expect(siteAppearanceStyle(second).image).not.toBe(image);
    expect(store.getSnapshot().announcement).not.toBe(announcement);
    store.choose('clean');tab.state.seed=0;store.choose('pattern');expect(store.getSnapshot().preference).toEqual({v:1,mode:'pattern',seed:1});
  });
  it('still applies choices if storage is blocked and reports that they were not saved',()=>{
    const tab=browser(),store=createSiteAppearanceStore(tab.environment);tab.state.deniedRead=true;tab.state.deniedWrite=true;
    expect(()=>store.init()).not.toThrow();expect(store.getSnapshot().preference.mode).toBe('autumn');expect(store.getSnapshot().storageAvailable).toBe(false);
    store.choose('clean');expect(tab.state.applied.at(-1)?.mode).toBe('clean');expect(store.getSnapshot()).toMatchObject({storageAvailable:false,announcement:'Clean background. This browser could not save the preference.'});
    expect(tab.state.writes).toEqual([]);
    tab.state.deniedWrite=false;store.choose('autumn');expect(store.getSnapshot().storageAvailable).toBe(true);
  });
  it('handles unavailable or invalid random sources without repeating the prior pattern',()=>{
    const tab=browser();tab.environment.randomSeed=()=>{throw Error('Unavailable');};const store=createSiteAppearanceStore(tab.environment);
    store.choose('pattern');expect(store.getSnapshot().preference).toEqual({v:1,mode:'pattern',seed:1});
    tab.environment.randomSeed=()=>Number.NaN;store.choose('pattern');expect(store.getSnapshot().preference).toEqual({v:1,mode:'pattern',seed:2});
  });
  it('synchronizes valid choices and storage clears without writing them back',()=>{
    const tab=browser(),store=createSiteAppearanceStore(tab.environment);store.init();let updates=0;const unsubscribe=store.subscribe(()=>updates++);
    tab.storageEvent('{"v":1,"mode":"pattern","seed":83}');expect(store.getSnapshot().preference).toEqual({v:1,mode:'pattern',seed:83});
    expect(store.getSnapshot().announcement).toBe('Background updated in this browser.');expect(updates).toBe(1);
    tab.storageEvent(null);expect(store.getSnapshot().preference.mode).toBe('autumn');expect(tab.state.writes).toEqual([]);
    unsubscribe();tab.storageEvent('{"v":1,"mode":"clean"}');expect(updates).toBe(2);expect(store.getSnapshot().preference.mode).toBe('clean');
  });
  it('disposes the storage listener and reinitializes from the latest stored preference',()=>{
    const tab=browser(),store=createSiteAppearanceStore(tab.environment);store.init();store.dispose();
    tab.storageEvent('{"v":1,"mode":"clean"}');expect(store.getSnapshot().preference.mode).toBe('autumn');expect(tab.state.stops).toBe(1);
    store.init();expect(store.getSnapshot().preference.mode).toBe('clean');expect(tab.state.listens).toBe(2);
  });
  it.each([
    '', 'invalid', 'null', '[]', '{"v":2,"mode":"clean"}', '{"v":1,"mode":"https://example.test/tile"}',
    '{"v":1,"mode":"clean","image":"url(https://example.test)"}', '{"v":1,"mode":"pattern","seed":"1"}',
    '{"v":1,"mode":"pattern","seed":-1}', '{"v":1,"mode":"pattern","seed":1.5}',
    '{"v":1,"mode":"pattern","seed":4294967296}', '{"v":1,"mode":"pattern","seed":1,"css":"red"}',
    ' '.repeat(201),
  ])('uses the original background for malformed or untrusted stored input: %s',value=>{
    expect(parseSiteAppearance(value)).toEqual({v:1,mode:'autumn'});
    const tab=browser(value),store=createSiteAppearanceStore(tab.environment);store.init();expect(store.getSnapshot().preference.mode).toBe('autumn');
    tab.storageEvent(value);expect(tab.state.applied.at(-1)?.mode).toBe('autumn');expect(tab.state.writes).toEqual([]);
  });
  it('renders an accessible footer control group with native buttons and a polite status',()=>{
    const html=renderToStaticMarkup(createElement(BackgroundControls));
    expect(html).toContain('role="group" aria-label="Background"');expect(html.match(/type="button"/g)).toHaveLength(3);
    expect(html).toContain('aria-pressed="true">Autumn');expect(html).toContain('aria-pressed="false">Clean');expect(html).toContain('aria-pressed="false">New pattern');
    expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"');
  });
});

describe('Trusted local autumn pattern generation',()=>{
  it('is deterministic, visibly varied and encodes the exact SVG into the CSS image',()=>{
    const images=new Set<string>(),sizes=new Set<string>(),colors=new Set<string>();
    for(let seed=0;seed<40;seed++){
      const pattern=generateSitePattern(seed);expect(generateSitePattern(seed)).toEqual(pattern);
      expect(pattern.image.startsWith('url("data:image/svg+xml,')).toBe(true);
      expect(decodeURIComponent(pattern.image.slice('url("data:image/svg+xml,'.length,-2))).toBe(pattern.svg);
      expect(pattern.svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="\d+"/);
      expect(pattern.svg).not.toMatch(/<script|<foreignObject|<image|href=|onload=|onerror=|javascript:|https:|<style/i);
      expect(pattern.svg.length).toBeLessThan(5000);expect(pattern.image).not.toContain('#');
      images.add(pattern.image);colors.add(pattern.color);sizes.add(pattern.svg.match(/viewBox="([^"]+)"/)![1]);
    }
    expect(images.size).toBe(40);expect(colors.size).toBeGreaterThan(2);expect(sizes.size).toBeGreaterThan(4);
  });
  it.each([-1,0.5,4294967296,Number.NaN,Infinity])('refuses an invalid direct generator seed: %s',seed=>{
    expect(()=>generateSitePattern(seed)).toThrow('Invalid background seed');
  });
});
