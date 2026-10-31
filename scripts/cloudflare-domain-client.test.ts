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
 it('sends a single scoped PUT with previews disabled',async()=>{
  let calls=0;
  const c=client(async(url,init)=>{calls++;expect(String(url)).toMatch(/\/workers\/domains$/);expect(init?.method).toBe('PUT');expect(JSON.parse(init?.body as string)).toEqual({hostname:after.hostname,service:after.service,zone_id:after.zoneId,enabled:true,previews_enabled:false});return Response.json({success:true,result:{}});});
  await c.assign(after);expect(calls).toBe(1);
 });
 it('does not retry or disclose provider errors after uncertain writes',async()=>{
  let calls=0;const c=client(async()=>{calls++;throw Error('private provider detail');});
  await expect(c.assign(after)).rejects.toThrow(/^DOMAIN_WRITE_UNCONFIRMED$/);expect(calls).toBe(1);
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
