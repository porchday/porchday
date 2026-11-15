import {it,expect,vi,afterEach} from 'vitest';
import {Hono} from 'hono';
import {recoveryAuthTime,recoveryConfirmationCookie} from '../src/recent-auth';
import type {Env,Variables} from '../src/types';
afterEach(()=>vi.useRealTimers());
it('confirmation is signed, session/member bound, short-lived and limited to recovery endpoints',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-15T10:00:00Z'));
 const app=new Hono<{Bindings:Env;Variables:Variables}>(),env={APP_URL:'https://example.test',BETTER_AUTH_SECRET:'synthetic-long-test-only-secret'} as Env;
 app.post('/issue',async c=>new Response('',{headers:{'Set-Cookie':await recoveryConfirmationCookie(c,'member','session')}}));
 app.get('*',async c=>c.json({at:await recoveryAuthTime(c,c.req.header('member')||'member',c.req.header('session')||'session',1)}));
 const response=await app.request('/issue',{method:'POST'},env),raw=response.headers.get('Set-Cookie')!,cookie=raw.split(';')[0];
 expect(raw).toContain('HttpOnly');expect(raw).toContain('Secure');expect(raw).toContain('SameSite=Strict');expect(raw).toContain('Path=/api/v1');
 const read=async(path='/api/v1/keys/backup',extra={})=>(await(await app.request(path,{headers:{Cookie:cookie,...extra}},env)).json()).at;
 expect(await read()).toBe(Date.now());expect(await read('/api/v1/devices')).toBe(Date.now());
 expect(await read('/api/v1/account')).toBe(1);expect(await read(undefined,{member:'other'})).toBe(1);expect(await read(undefined,{session:'other'})).toBe(1);
 expect(await read(undefined,{Cookie:cookie+'tampered'})).toBe(1);
 vi.setSystemTime(new Date('2026-11-15T10:15:00Z'));expect(await read()).toBe(1);
});
