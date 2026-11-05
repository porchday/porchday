import {describe, expect, it} from 'vitest';
import {probe, type ProbeConfig} from './external-monitor-probe';

const id='00000000-0000-4000-8000-000000000001';
const config:ProbeConfig={environment:'production',healthToken:'h'.repeat(32),synthetic:{id,email:id+'@example.test',password:'p'.repeat(32)}};
const now=Date.parse('2026-10-28T21:00:00Z');
const response=(body:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(body),{status,headers});
function fixture(override?:(url:string,init:RequestInit)=>Response|undefined){
 const calls:{url:string;init:RequestInit}[]=[];let revoked=false;
 const fetcher=async(input:RequestInfo|URL,init:RequestInit={})=>{
  const url=String(input);calls.push({url,init});const replaced=override?.(url,init);if(replaced)return replaced;
  if(url.endsWith('/health'))return response({status:'ok',issues:[]});
  if(url.endsWith('/get-session'))return response(null);
  if(url.endsWith('/status'))return response({last_checked_at:new Date(now).toISOString()});
  if(url.endsWith('/sign-in/email'))return response({user:{id} },200,{'set-cookie':'__Secure-better-auth.session_token=synthetic-session; Secure; HttpOnly'});
  if(url.includes('/me?'))return revoked?response({},401):response({id},200,{'cache-control':'no-store'});
  if(url.includes('/feed?'))return response({items:[]},200,{'cache-control':'private, no-store'});
  if(url.endsWith('/sign-out')){revoked=true;return response({success:true});}
  throw Error('UNEXPECTED_REQUEST');
 };
 return {fetch:fetcher as typeof fetch,calls,now:()=>now};
}
describe('external synthetic account readiness',()=>{
 it('checks both origins, identity, private reads, logout and revocation without retaining credentials',async()=>{
  const f=fixture(),result=await probe(config,f);
  expect(result.healthy).toBe(true);expect(result.checks).toHaveLength(9);
  expect(f.calls.filter(c=>c.url.endsWith('/sign-out'))).toHaveLength(1);
  expect(f.calls.every(c=>c.init.redirect==='manual')).toBe(true);
  const serialized=JSON.stringify(result);
  for(const value of [config.healthToken,config.synthetic.email,config.synthetic.password,'synthetic-session',id])expect(serialized).not.toContain(value);
 });
 it('detects protected quarantine despite healthy anonymous requests',async()=>{
  const result=await probe(config,fixture(url=>url.endsWith('/health')?response({status:'unavailable',issues:['private detail']},503):undefined));
  expect(result.healthy).toBe(false);expect(result.checks.find(c=>c.name==='protected_readiness')).toMatchObject({name:'protected_readiness',ok:false,status:503});
  expect(JSON.stringify(result)).not.toContain('private detail');
 });
 it('never reads an account whose identity does not match the synthetic fixture',async()=>{
  const f=fixture(url=>url.endsWith('/sign-in/email')?response({user:{id:'other-member'}},200,{'set-cookie':'better-auth.session_token=private'}):undefined);
  expect((await probe(config,f)).healthy).toBe(false);
  expect(f.calls.some(c=>c.url.includes('/api/v1/'))).toBe(false);
 });
 it.each([now-90001,now+30001])('detects stale or impossible future monitor timestamps (%s)',async timestamp=>{
  const result=await probe(config,fixture(url=>url.endsWith('/status')?response({last_checked_at:new Date(timestamp).toISOString()}):undefined));
  expect(result.checks.find(c=>c.name==='monitor_freshness')?.ok).toBe(false);
 });
 it.each(['wrong identity','unexpected content','cached response','failed revocation'])('detects incorrect authorized outcomes: %s',async failure=>{
  let reads=0;
  const f=fixture(url=>{
   if(url.includes('/me?')){
    reads++;
    if(failure==='wrong identity'&&reads===1)return response({id:'wrong'},200,{'cache-control':'no-store'});
    if(failure==='cached response'&&reads===1)return response({id});
    if(failure==='failed revocation'&&reads===2)return response({id});
   }
   if(failure==='unexpected content'&&url.includes('/feed?'))return response({items:[{body:'private member data'}]},200,{'cache-control':'no-store'});
  });
  const result=await probe(config,f);expect(result.healthy).toBe(false);expect(JSON.stringify(result)).not.toContain('private member data');
 });
 it('does not forward credentials to redirects or retry ambiguous logout',async()=>{
  const f=fixture(url=>url.endsWith('/sign-out')?response({},302,{location:'https://untrusted.example'}):undefined);
  const result=await probe(config,f);expect(result.healthy).toBe(false);
  expect(f.calls.filter(c=>c.url.endsWith('/sign-out'))).toHaveLength(1);
  expect(f.calls.some(c=>c.url.includes('untrusted'))).toBe(false);
 });
 it('bounds response sizes and omits server-controlled error text',async()=>{
  const result=await probe(config,fixture(url=>url.endsWith('/health')?response({secret:'x'.repeat(20000)}):undefined));
  expect(result.healthy).toBe(false);expect(JSON.stringify(result)).not.toContain('xxx');
 });
 it('bounds a hung transport and sanitizes rejection reasons',async()=>{
  const f=fixture();
  const result=await probe(config,{...f,timeoutMs:5,fetch:((input:RequestInfo|URL,init:RequestInit={})=>String(input).endsWith('/health')?
   new Promise<Response>((_,reject)=>init.signal!.addEventListener('abort',()=>reject(Error('secret token')),{once:true})):f.fetch(input,init)) as typeof fetch});
  expect(result.healthy).toBe(false);expect(JSON.stringify(result)).not.toContain('secret token');
  expect(result.checks.find(c=>c.name==='protected_readiness')?.failure).toBe('deadline');
 });
 it('rejects ordinary member credentials before network access',async()=>{
  const f=fixture();await expect(probe({...config,synthetic:{...config.synthetic,email:'member@example.com'}},f)).rejects.toThrow('SYNTHETIC_CONFIGURATION_REQUIRED');
  expect(f.calls).toHaveLength(0);
 });
});
