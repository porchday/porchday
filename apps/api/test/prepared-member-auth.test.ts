import {beforeEach,expect,test,vi} from 'vitest';
import {Hono} from 'hono';
import {prepareMemberAuth,requireMember} from '../src/session';
import {requestTimingMiddleware} from '../src/request-timing';
import type {Env,Variables} from '../src/types';
const f=vi.hoisted(()=>({events:[] as string[],schema:Promise.resolve(),verified:true}));
vi.mock('../src/auth',()=>({
 authPool:()=>({query:async()=>{f.events.push('status');return {rows:[{status:'active'}]};},end:async()=>{f.events.push('close');}}),
 createAuth:()=>({$context:Promise.resolve({checkSchema:()=>{f.events.push('schema');return f.schema;}}),api:{getSession:async()=>{f.events.push('session');return {user:{id:'11111111-1111-4111-8111-111111111111',emailVerified:f.verified},session:{id:'private',createdAt:new Date()}};}}}),
}));
beforeEach(()=>{f.events=[];f.schema=Promise.resolve();f.verified=true;});
function setup(guard:()=>Promise<boolean>){
 const app=new Hono<{Bindings:Env;Variables:Variables}>(),pending:Promise<unknown>[]=[];
 app.use('*',requestTimingMiddleware);app.use('*',prepareMemberAuth);
 app.use('*',async(c,next)=>{f.events.push('journal');if(!await guard())return c.text('denied',503);f.events.push('journal_pass');await next();});
 app.use('*',requireMember);app.get('*',c=>{f.events.push('handler');return c.json({ok:true});});app.onError((_,c)=>c.text('failed',503));
 const request=()=>app.request('https://example.test/api/v1/me',{}, {ENVIRONMENT:'production'} as Env,{waitUntil:(p:Promise<unknown>)=>pending.push(p)} as ExecutionContext);
 return {request,pending};
}
test('read-only schema overlaps the journal, while session/status/handler stay behind it',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 const {request,pending}=setup(async()=>{await gate;return true;});const result=request();
 await vi.waitFor(()=>expect(f.events).toContain('schema'));expect(f.events).not.toContain('session');
 release();const response=await result;await Promise.all(pending);
 expect(response.status).toBe(200);expect(f.events.indexOf('session')).toBeGreaterThan(f.events.indexOf('journal_pass'));
 expect(f.events.filter(e=>e==='schema')).toHaveLength(1);expect(f.events.filter(e=>e==='close')).toHaveLength(1);
 expect(response.headers.get('server-timing')).toContain('auth_schema;dur=');
});
test('journal denial never executes session renewal/status or handler, but closes after schema settles',async()=>{
 const {request,pending}=setup(async()=>false);const response=await request();await Promise.all(pending);
 expect(response.status).toBe(503);expect(f.events).not.toContain('session');expect(f.events).not.toContain('status');expect(f.events).not.toContain('handler');expect(f.events).toContain('close');
 expect(response.headers.has('server-timing')).toBe(false);
});
test('schema failure stays fail-closed and cannot be swallowed into a successful request',async()=>{
 f.schema=Promise.reject(Error('private schema details'));void f.schema.catch(()=>{});
 const {request,pending}=setup(async()=>true);expect((await request()).status).toBe(503);await Promise.all(pending);
 expect(f.events).not.toContain('session');expect(f.events).not.toContain('handler');expect(f.events).toContain('close');
});
