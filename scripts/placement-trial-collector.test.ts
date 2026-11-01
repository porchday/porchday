import {expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {createPlacementTrialCollector} from './placement-trial-collector.ts';
const id='12345678-1234-1234-1234-123456789abc',publicHeaders={'content-security-policy':"default-src 'self'",'x-content-type-options':'nosniff','strict-transport-security':'max-age=15552000'};
function fixture(change?:string){
 let windowReads=0;
 const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=new URL(String(input)).pathname;
  if(path==='/health')return Response.json({status:'ok',release:change==='version'?'old':id});
  if(path==='/asset.js')return new Response('module',{headers:{...publicHeaders,'cache-control':change==='cache'?'no-store':'public, max-age=60','content-type':'text/javascript'}});
  if(path==='/api/operations/health')return Response.json({status:'ok',issues:[]});
  const headers=init?.headers as Record<string,string>;
  if(headers.Cookie==='denied')return Response.json({}, {status:401});
  if(headers.Origin)windowReads++;
  if(path.includes('/feed'))return Response.json({items:change==='privacy'&&headers.Origin?[{private:'never retain'}]:[]},{headers:{'cache-control':'no-store'}});
  if(change==='request'&&headers.Origin)return Response.json({error:{code:'UNAVAILABLE'}},{status:503});
  return Response.json({id},{headers:{'cache-control':'no-store'}});
 });
 const collector=createPlacementTrialCollector({publicVersion:id,publicHeaders,publicCache:{'/asset.js':'public, max-age=60'},target:{environment:'staging',memberId:id,cookie:'allowed',deniedCookie:'denied',healthToken:'private'},assets:{source:'a'.repeat(40),files:{'asset.js':createHash('sha256').update('module').digest('hex')}},assertScope:()=>{},fetch:fetcher,
  readConnections:async()=>({at:Date.now(),total:10,usable:22,refused:false}),readMetrics:async()=>({allErrors:{requests:60,server_errors:0},refused:false,routes:[],coverage:'synthetic test'})});
 return{collector,fetcher,reads:()=>windowReads};
}
it('collects 30 attempts per route and retains neither credentials nor response bodies',async()=>{
 const f=fixture(),now=Date.now(),result=await f.collector.collect({at:now,startedAt:now,lastWindowAt:now,signal:new AbortController().signal});
 expect(f.reads()).toBe(60);expect(result.auth&&result.revocation&&result.privacy&&result.publicAssets).toBe(true);
 expect(Object.values(result.window!.routes).map(r=>[r.attempts,r.errors,r.durations.length])).toEqual([[30,0,30],[30,0,30]]);
 expect(JSON.stringify(result)).not.toMatch(/allowed|denied"|private"|12345678/);
 expect(f.fetcher.mock.calls.every(([,init])=>init?.method==='GET'||init?.method===undefined)).toBe(true);
});
it.each(['cache','version'])('rejects changed public %s despite matching asset bytes',async change=>{
 const f=fixture(change),now=Date.now();
 expect((await f.collector.collect({at:now,startedAt:now,lastWindowAt:now,signal:new AbortController().signal})).publicAssets).toBe(false);
});
it('preserves failed latency attempts and stops reading upon unexpected fixture content',async()=>{
 const bad=fixture('request'),now=Date.now();
 const result=await bad.collector.collect({at:now,startedAt:now,lastWindowAt:now,signal:new AbortController().signal});
 expect(result.window!.routes['/api/v1/me?bootstrap=1']).toMatchObject({attempts:30,errors:30,durations:[]});
 const privacy=fixture('privacy'),stopped=await privacy.collector.collect({at:now,startedAt:now,lastWindowAt:now,signal:new AbortController().signal});
 expect(stopped.privacy).toBe(false);expect(privacy.reads()).toBe(2);expect(JSON.stringify(stopped)).not.toContain('never retain');
});
