import {beforeEach,describe,expect,it,vi} from 'vitest';
import {Hono} from 'hono';
import {prepareMemberAuth,requireMember,requireAppealMember} from '../src/session';
import {persistSessionDenial} from '../src/session-denial';
import type {Env,Variables} from '../src/types';
const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
const f=vi.hoisted(()=>({id:'',status:vi.fn(),close:vi.fn(),verified:true,authenticated:true}));
vi.mock('../src/auth',()=>({
 authPool:()=>({query:f.status,end:f.close}),
 createAuth:()=>({$context:Promise.resolve({checkSchema:async()=>{}}),api:{getSession:async()=>f.authenticated?{user:{id:'33333333-3333-4333-8333-333333333333',emailVerified:f.verified},session:{id:f.id,createdAt:new Date()}}:null}}),
}));
beforeEach(()=>{f.id=first;f.verified=true;f.authenticated=true;f.status.mockReset().mockResolvedValue({rows:[{status:'active'}]});f.close.mockReset().mockResolvedValue(undefined);});
function setup(path:string,environment:Env['ENVIRONMENT']='production',bound=true){
 const rows=new Map<string,string>();
 const store={get:vi.fn(async(key:string)=>rows.has(key)?{etag:'record',text:async()=>rows.get(key)!}:null),put:vi.fn(async(key:string,text:string)=>{if(rows.has(key))return null;rows.set(key,text);return {etag:'record'};})};
 const env={ENVIRONMENT:environment,...(bound?{RECOVERY_JOURNAL:store}:{})} as unknown as Env;
 const app=new Hono<{Bindings:Env;Variables:Variables}>(),pending:Promise<unknown>[]=[];
 app.use('*',prepareMemberAuth);
 app.get('/api/v1/me',requireMember,c=>c.json({id:c.get('sessionId')}));
 app.get('/api/v1/feed',requireMember,c=>c.json({id:c.get('sessionId')}));
 app.get('/appeals',requireAppealMember,c=>c.json({id:c.get('sessionId')}));
 app.onError((_,c)=>c.json({error:{code:'SERVICE_UNAVAILABLE'}},503));
 const request=async()=>{const response=await app.request('https://example.test'+path,{},env,{waitUntil:(p:Promise<unknown>)=>pending.push(p)} as ExecutionContext);await Promise.all(pending.splice(0));return response;};
 return {request,store,rows};
}
describe.each(['/api/v1/me','/api/v1/feed','/appeals'])('independent denial reader at %s',path=>{
 it('denies an otherwise valid SQL session, while another session remains usable',async()=>{
  const s=setup(path);
  expect((await s.request()).status).toBe(200);
  await persistSessionDenial(s.store,first);
  f.status.mockClear();expect((await s.request()).status).toBe(401);expect(f.status).not.toHaveBeenCalled();
  f.id=second;expect((await s.request()).status).toBe(200);
  // The SDK still returns the original row: no reliance on SQL deletion,
  // previous positive authorization, or a process-local denial cache.
  f.id=first;expect((await s.request()).status).toBe(401);
  expect(f.close).toHaveBeenCalledTimes(4);
 });
 it('fails closed on storage transport errors and conflicting records',async()=>{
  const s=setup(path);s.store.get.mockRejectedValueOnce(Error('private provider detail'));
  const response=await s.request();expect(response.status).toBe(503);expect(await response.text()).not.toContain('private');
  await persistSessionDenial(s.store,first);s.rows.set([...s.rows.keys()][0],'{}');
  expect((await s.request()).status).toBe(503);expect(f.status).not.toHaveBeenCalled();expect(f.close).toHaveBeenCalledTimes(2);
 });
 it.each(['production','staging'] as const)('rejects a missing hosted binding in %s',async environment=>{
  const s=setup(path,environment,false);expect((await s.request()).status).toBe(503);expect(f.status).not.toHaveBeenCalled();
 });
 it('preserves unbound local development, but honors a bound development denial',async()=>{
  expect((await setup(path,'development',false).request()).status).toBe(200);
  const s=setup(path,'development');await persistSessionDenial(s.store,first);expect((await s.request()).status).toBe(401);
 });
 it('does not consult storage for missing or unverified sessions',async()=>{
  const s=setup(path);f.authenticated=false;expect((await s.request()).status).toBe(401);
  f.authenticated=true;f.verified=false;expect((await s.request()).status).toBe(401);expect(s.store.get).not.toHaveBeenCalled();
 });
});
