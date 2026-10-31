import {describe,it,expect} from 'vitest';
import {CloudflareDomainClient} from './cloudflare-domain-client.ts';
const before={hostname:'porchday.org',service:'porchday-production',environment:'production',zoneId:'a'.repeat(32)};
const after={...before,service:'porchday-production-edge'};
const plan={operationId:'11111111-1111-4111-8111-111111111111',moves:[{before,after}]};
const client=(request:typeof fetch)=>new CloudflareDomainClient({accountId:'b'.repeat(32),apiToken:'x'.repeat(32),plan,fetch:request});
describe('Cloudflare domain adapter',()=>{
 it('reads the exact existing enabled domain',async()=>{
  const c=client(async()=>Response.json({success:true,result:[{hostname:before.hostname,service:before.service,environment:'production',zone_id:before.zoneId,enabled:true,previews_enabled:false}]}));
  expect(await c.observe(before.hostname)).toEqual(before);
 });
 const record=(target:typeof before)=>({hostname:target.hostname,service:target.service,environment:target.environment,zone_id:target.zoneId,enabled:true,previews_enabled:false});
 const preview=()=>({added:[],removed:[],conflicting:[],updated:[{...record(after),modified:true}]});
 it('previews an existing origin move and sends one Worker-scoped PUT',async()=>{
  const methods:string[]=[];
  const c=client(async(url,init)=>{methods.push(init!.method!);
   if(init?.method==='GET')return Response.json({success:true,result:[record(before)]});
   expect(String(url)).toContain('/workers/scripts/porchday-production-edge/domains/');
   if(init?.method==='POST'){expect(String(url)).toMatch(/changeset\?replace_state=true$/);return Response.json({success:true,result:preview()});}
   expect(JSON.parse(init!.body as string)).toEqual({override_scope:true,override_existing_origin:true,override_existing_dns_record:false,origins:[{hostname:after.hostname,zone_id:after.zoneId,enabled:true,previews_enabled:false}]});return Response.json({success:true,result:{}});
  });await c.assign(after);expect(methods).toEqual(['GET','POST','PUT']);
 });
 it('does not retry or disclose provider errors after an uncertain PUT',async()=>{
  let writes=0;const c=client(async(_url,init)=>{
   if(init?.method==='GET')return Response.json({success:true,result:[record(before)]});
   if(init?.method==='POST')return Response.json({success:true,result:preview()});
   writes++;throw Error('private provider detail');
  });await expect(c.assign(after)).rejects.toThrow(/^DOMAIN_WRITE_UNCONFIRMED$/);expect(writes).toBe(1);
 });
 it('does not dispatch a PUT when cancelled while previewing',async()=>{
  const controller=new AbortController();let writes=0;
  const c=client(async(_url,init)=>{
   if(init?.method==='GET')return Response.json({success:true,result:[record(before)]});
   if(init?.method==='POST'){controller.abort(Error('cancelled'));return Response.json({success:true,result:preview()});}
   writes++;return Response.json({success:true,result:{}});
  });await expect(c.assign(after,controller.signal)).rejects.toThrow('cancelled');expect(writes).toBe(0);
 });
 it.each(['added','removed','conflicting','extra-change'] as const)('refuses an unsafe %s preview without a PUT',async kind=>{
  let writes=0;const value=preview();if(kind==='extra-change')value.updated.push({...record({...after,hostname:'www.porchday.org'}),modified:true});else (value[kind] as unknown[]).push({hostname:'unreviewed.example'});
  const c=client(async(_url,init)=>{if(init?.method==='GET')return Response.json({success:true,result:[record(before)]});if(init?.method==='PUT')writes++;return Response.json({success:true,result:value});});
  await expect(c.assign(after)).rejects.toThrow('DOMAIN_CHANGESET_UNSAFE');expect(writes).toBe(0);
 });
 it('preserves domains already owned by the destination',async()=>{
  const existing={...after,hostname:'www.porchday.org'},extended={...plan,moves:[...plan.moves,{before:{...before,hostname:existing.hostname},after:existing}]};let body:any;
  const c=new CloudflareDomainClient({accountId:'b'.repeat(32),apiToken:'x'.repeat(32),plan:extended,fetch:async(_url,init)=>{
   if(init?.method==='GET')return Response.json({success:true,result:[record(before),record(existing)]});
   if(init?.method==='POST')return Response.json({success:true,result:{...preview(),updated:[...preview().updated,{...record(existing),modified:false}]}});
   body=JSON.parse(init!.body as string);return Response.json({success:true,result:{}});
  }});await c.assign(after);expect(body.origins.map((x:any)=>x.hostname)).toEqual(['porchday.org','www.porchday.org']);
 });
 it.each(['zone','service','enabled','previews','duplicate'] as const)('rejects %s drift in an unchanged preview entry',async kind=>{
  const existing={...after,hostname:'www.porchday.org'},extended={...plan,moves:[...plan.moves,{before:{...before,hostname:existing.hostname},after:existing}]};let writes=0;
  const unchanged={...record(existing),modified:false};
  if(kind==='zone')unchanged.zone_id='c'.repeat(32);
  if(kind==='service')unchanged.service=before.service;
  if(kind==='enabled')unchanged.enabled=false;
  if(kind==='previews')unchanged.previews_enabled=true;
  const c=new CloudflareDomainClient({accountId:'b'.repeat(32),apiToken:'x'.repeat(32),plan:extended,fetch:async(_url,init)=>{
   if(init?.method==='GET')return Response.json({success:true,result:[record(before),record(existing)]});
   if(init?.method==='PUT')writes++;
   return Response.json({success:true,result:{...preview(),updated:[...preview().updated,unchanged,...(kind==='duplicate'?[unchanged]:[])]}});
  }});
  await expect(c.assign(after)).rejects.toThrow('DOMAIN_CHANGESET_UNSAFE');expect(writes).toBe(0);
 });
 it('refuses destination domains outside the plan before preview or write',async()=>{
  let calls=0;const c=client(async()=>{calls++;return Response.json({success:true,result:[record(before),record({...after,hostname:'other.porchday.org'})]});});
  await expect(c.assign(after)).rejects.toThrow('DOMAIN_DESTINATION_SCOPE_CHANGED');expect(calls).toBe(1);
 });
 it('rejects out-of-plan writes without network activity',async()=>{
  let calls=0;const c=client(async()=>{calls++;return Response.json({});});
  await expect(c.assign({...after,hostname:'status.porchday.com'})).rejects.toThrow('DOMAIN_OUTSIDE_PLAN');expect(calls).toBe(0);
 });
 it('refuses disabled or duplicate domains',async()=>{
  for(const result of [[{hostname:before.hostname,enabled:false}],[{hostname:before.hostname},{hostname:before.hostname}]]){
   const c=client(async()=>Response.json({success:true,result}));await expect(c.observe(before.hostname)).rejects.toThrow();
  }
 });
});
