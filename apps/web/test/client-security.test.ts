import { describe,it,expect,vi,afterEach } from 'vitest';
import { deadline,unexpired,ApiError } from '../src/api';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {ExpiryWarning} from '../src/Social';
import {readFileSync} from 'node:fs';
afterEach(()=>vi.useRealTimers());
describe('client expiration and sharing semantics',()=>{
 it('inherits an absolute deadline instead of restarting a duration',()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-25T17:00:00Z'));const parent='2026-10-25T17:30:00.000Z';expect(deadline('inherit',parent)).toBe(parent);expect(deadline('3600',parent)).toBe(parent);expect(deadline('900',parent)).toBe('2026-10-25T17:15:00.000Z');});
 it('allows custom shorter times but never broadens a bounded deadline',()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-25T17:00:00Z'));const parent='2026-10-25T17:30:00.000Z';expect(deadline('custom:2026-10-25T17:05:00.000Z',parent)).toBe('2026-10-25T17:05:00.000Z');expect(deadline('custom:2026-10-26T17:05:00.000Z',parent)).toBe(parent);expect(deadline('',null)).toBeNull();});
 it('removes a loaded item at its effective ancestor deadline',()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-25T17:30:00Z'));expect(unexpired({expires_at:'2026-10-26T00:00:00.000Z',effective_expires_at:'2026-10-25T17:30:00.000Z'} as any)).toBe(false);expect(unexpired({expires_at:null} as any)).toBe(true);});
 it('warns about inherited reply expiry with the actual deadline and shorter option',()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-25T17:00:00Z'));const html=renderToStaticMarkup(createElement(ExpiryWarning,{expiry:'2026-10-25T17:30:00.000Z',reply:true,fromPost:true}));expect(html).toContain('reply');expect(html).toContain('deleted with the');expect(html).toContain('30 minutes remaining');expect(html).toContain('You can make its timeout shorter');expect(html).toContain('inherited from the original post');});
 it('explains reauthentication and changed audience without retrying silently',()=>{expect(new ApiError(403,{error:{code:'RECENT_AUTH_REQUIRED'}}).message).toContain('sign out and sign in again');expect(new ApiError(409,{error:{code:'AUDIENCE_CHANGED'}}).message).toContain('Review the audience');});
});
describe('PWA privacy boundaries',()=>{
 it('uses a protected start URL and real raster install icons',()=>{const manifest=JSON.parse(readFileSync('apps/web/public/manifest.webmanifest','utf8'));expect(manifest.start_url).toBe('/app');expect(manifest.display).toBe('standalone');for(const icon of manifest.icons){const file=readFileSync('apps/web/public'+icon.src);expect([...file.subarray(0,8)]).toEqual([137,80,78,71,13,10,26,10]);}});
 it('never intercepts private API fetches and keeps push generic',()=>{const sw=readFileSync('apps/web/public/sw.js','utf8');expect(sw).toContain("url.pathname.startsWith('/api')");expect(sw).toContain("event.request.method !== 'GET'");expect(sw).toContain("body:'You have a new update.'");expect(sw).not.toMatch(/event\.data\.(text|json)\(/);expect(sw).not.toContain('skipWaiting(); });\nself.addEventListener(\'activate\'');});
});
