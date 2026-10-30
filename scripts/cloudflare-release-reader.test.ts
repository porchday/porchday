import {describe,it,expect} from 'vitest';
import {CloudflareReleaseReader,releaseSettings,assertInactiveUploadSnapshot,validateReleaseQueues,type ReleaseQueues} from './cloudflare-release-reader.ts';
const active='11111111-0000-4000-8000-000000000000',latest='22222222-0000-4000-8000-000000000000';
const token='synthetic-only-provider-test-token',queues={staging:{id:'b'.repeat(32),name:'porchday-staging-jobs'},production:{id:'c'.repeat(32),name:'porchday-production-jobs'}};
const options={accountId:'a'.repeat(32),apiToken:token,queues};
const reply=(result:unknown)=>Response.json({success:true,result});
function fixture(registered:ReleaseQueues=queues){
 const calls:{url:string;init:RequestInit|undefined}[]=[];let inFlight=0,maximum=0;
 const transport:typeof fetch=async(input,init)=>{
  calls.push({url:String(input),init});inFlight++;maximum=Math.max(maximum,inFlight);await new Promise(done=>setTimeout(done,1));inFlight--;
  const path=new URL(String(input)).pathname;
  if(path.endsWith('/domains'))return reply([{hostname:'z.example',service:'porchday-production'},{hostname:'a.example',service:'porchday-staging-edge'}]);
  if(path.includes('/queues/')){const queue=Object.values(registered).find(value=>path.endsWith(value.id))!;return reply({queue_id:queue.id,queue_name:queue.name,settings:{},consumers:[],consumers_total_count:0,producers:[],producers_total_count:0});}
  if(path.endsWith('/deployments'))return reply({deployments:[{versions:[{version_id:active,percentage:100}]}]});
  if(path.endsWith('/versions'))return reply({items:[{id:latest},{id:active}]});
  if(path.endsWith('/settings'))return reply({placement:{mode:'off'},bindings:[{name:'APP_URL',type:'plain_text',text:'https://inactive.invalid'}]});
  if(path.endsWith('/versions/'+active))return reply({id:active,resources:{script:{etag:'active-code'},script_runtime:{compatibility_date:'2026-10-24'},bindings:[{name:'APP_URL',type:'plain_text',text:'https://active.example'},{name:'TOKEN',type:'secret_text'}]}});
  if(path.endsWith('/schedules'))return reply({schedules:[]});
  throw Error('UNEXPECTED_PATH');
 };
 return{transport,calls,maximum:()=>maximum};
}
describe('read-only release provider inventory',()=>{
 it('reads every catalogue page and preserves consumer evidence for unregistered queues',async()=>{
  const calls:string[]=[],values=Object.values(queues).map(q=>({queue_id:q.id,queue_name:q.name,consumers:[],consumers_total_count:0,producers:[],producers_total_count:0}));
  const reader=new CloudflareReleaseReader({...options,fetch:async(input,init)=>{expect(init?.method).toBe('GET');calls.push(String(input));const page=Number(new URL(String(input)).searchParams.get('page'));return Response.json({success:true,result:[values[page-1]],result_info:{page,per_page:1,count:1,total_count:2,total_pages:2}});}});
  const result=await reader.queueCatalogue(AbortSignal.timeout(5000));expect(result).toHaveLength(2);expect(calls.map(url=>new URL(url).search)).toEqual(['?page=1','?page=2']);expect(result[0].queue_name).toBe('porchday-production-jobs');
 });
 it.each(['missing metadata','truncated','duplicate','changed total','too many pages','hidden consumer'])('rejects %s rather than claiming queue absence',async kind=>{
  let calls=0;const reader=new CloudflareReleaseReader({...options,fetch:async()=>{
   const page=++calls,q=page===1||kind==='duplicate'?queues.staging:queues.production,row={queue_id:q.id,queue_name:q.name,consumers:[],consumers_total_count:kind==='hidden consumer'?1:0,producers:[],producers_total_count:0};
   return Response.json({success:true,result:kind==='truncated'?[]:[row],result_info:kind==='missing metadata'?undefined:{page,per_page:1,count:kind==='truncated'?0:1,total_count:kind==='changed total'&&page===2?3:2,total_pages:kind==='too many pages'?101:2}});
  }});
  await expect(reader.queueCatalogue(AbortSignal.timeout(5000))).rejects.toThrow(/QUEUE_CATALOGUE|QUEUE_INVENTORY|PROVIDER_SHAPE/);expect(calls).toBeLessThanOrEqual(2);
 });
 it('observes each explicitly registered range and dead-letter queue without writes',async()=>{
  const registry:ReleaseQueues={...queues,'staging-denial-0':{id:'d'.repeat(32),name:'porchday-staging-denial-0'},'staging-denial-1':{id:'e'.repeat(32),name:'porchday-staging-denial-1'},'staging-denial-2':{id:'f'.repeat(32),name:'porchday-staging-denial-2'},'staging-dead-letter':{id:'1'.repeat(32),name:'porchday-staging-jobs-dead-letter'}};
  const f=fixture(registry),snapshot=await new CloudflareReleaseReader({...options,queues:registry,fetch:f.transport}).snapshot(AbortSignal.timeout(5000));
  expect(Object.keys(snapshot.queues).sort()).toEqual(Object.keys(registry).sort());expect(f.calls.every(call=>call.init?.method==='GET')).toBe(true);
  for(const queue of Object.values(registry))expect(f.calls.filter(call=>call.url.endsWith('/queues/'+queue.id))).toHaveLength(1);
  const candidate='44444444-0000-4000-8000-000000000000',after=structuredClone(snapshot);after.workers.staging.latest=candidate;
  assertInactiveUploadSnapshot(snapshot,after,'staging',candidate,after.workers.staging.settings);
  after.queues['staging-denial-1'].consumers_total_count=1;
  expect(()=>assertInactiveUploadSnapshot(snapshot,after,'staging',candidate,after.workers.staging.settings)).toThrow('INVENTORY_CHANGED');
 });
 it('rejects arbitrary registry keys, wrong names, duplicate IDs and unexpected fields',()=>{
  for(const registry of [
   {...queues,other:{id:'d'.repeat(32),name:'arbitrary'}},
   {...queues,'staging-denial-0':{id:'d'.repeat(32),name:'porchday-production-denial-0'}},
   {...queues,'staging-denial-0':{id:queues.staging.id,name:'porchday-staging-denial-0'}},
   {...queues,'staging-denial-0':{id:'d'.repeat(32),name:'porchday-staging-denial-0',extra:true}},
   {staging:queues.staging},
  ])expect(()=>validateReleaseQueues(registry as ReleaseQueues)).toThrow('QUEUE_CONFIGURATION_INVALID');
 });
 it.each(['settings','active'])('rejects an unregistered queue binding in %s inventory',async location=>{
  const f=fixture(),transport:typeof fetch=async(input,init)=>{
   const response=await f.transport(input,init),body=await response.json() as {result:Record<string,unknown>};
   if(String(input).includes('scripts/porchday-staging/')&&String(input).endsWith(location==='settings'?'/settings':'/versions/'+active)){
    const target=location==='settings'?body.result:body.result.resources as Record<string,unknown>;
    target.bindings=[{name:'DENIAL_RANGE_0',type:'queue',queue_name:'porchday-staging-denial-0'}];
   }
   return reply(body.result);
  };
  await expect(new CloudflareReleaseReader({...options,fetch:transport}).snapshot(AbortSignal.timeout(5000))).rejects.toThrow('QUEUE_BINDING_UNREGISTERED');
 });
 it.each(['consumers','producers'])('rejects truncated %s evidence',async kind=>{
  const f=fixture(),transport:typeof fetch=async(input,init)=>{
   const response=await f.transport(input,init),body=await response.json() as {result:Record<string,unknown>};
   if(String(input).includes('/queues/'))body.result[kind+'_total_count']=1;
   return reply(body.result);
  };
  await expect(new CloudflareReleaseReader({...options,fetch:transport}).snapshot(AbortSignal.timeout(5000))).rejects.toThrow('QUEUE_INVENTORY_INCOMPLETE');
 });
 it('downloads bounded multipart modules using GET without treating a script as version-addressed',async()=>{
  const data=new FormData();data.append('index.js','executable');data.append('map',new Blob(['map']),'index.js.map');
  const reader=new CloudflareReleaseReader({...options,fetch:async(input,init)=>{expect(String(input)).toMatch(/scripts\/porchday-staging$/);expect(init?.method).toBe('GET');return new Response(data);}});
  const parts=await reader.script('staging',AbortSignal.timeout(5000));expect(Object.keys(parts).sort()).toEqual(['index.js','index.js.map']);expect(Buffer.from(parts['index.js']).toString()).toBe('executable');
 });
 it('rejects malformed, duplicate and non-file script modules',async()=>{
  for(const kind of ['duplicate','text','type']){
   const data=new FormData();data.append('one',new Blob(['code']),'index.js');
   if(kind==='duplicate')data.append('two',new Blob(['code']),'index.js');if(kind==='text')data.append('text','unexpected');
   const reader=new CloudflareReleaseReader({...options,fetch:async()=>kind==='type'?new Response('code',{headers:{'content-type':'text/plain'}}):new Response(data)});
   await expect(reader.script('staging',AbortSignal.timeout(5000))).rejects.toThrow(/SCRIPT_MODULE_INVALID|SCRIPT_CONTENT_TYPE_INVALID/);
  }
 });
 it('rejects malformed multipart bodies and script payloads beyond the independent 16 MiB cap',async()=>{
  for(const body of ['not multipart','x'.repeat(16*1024*1024+1)]){
   let calls=0;const reader=new CloudflareReleaseReader({...options,fetch:async()=>{calls++;return new Response(body,{headers:{'content-type':'multipart/form-data; boundary=test'}});}});
   await expect(reader.script('staging',AbortSignal.timeout(5000))).rejects.toThrow(/SCRIPT_MULTIPART_INVALID|BODY_LIMIT/);expect(calls).toBe(1);
  }
 });
 it('discovers exactly one operation-annotated upload and confirms identity on the detail read',async()=>{
  const operation='33333333-0000-4000-8000-000000000000',annotations={'workers/message':'porchday-upload:'+operation};let calls=0;
  const fetcher:typeof fetch=async(input,init)=>{calls++;expect(init?.method).toBe('GET');return String(input).endsWith('/versions')?reply({items:[{id:active,annotations:{}},{id:latest,annotations}]}):reply({id:latest,annotations,resources:{script:{etag:'candidate'},script_runtime:{},bindings:[]}});};
  const result=await new CloudflareReleaseReader({...options,fetch:fetcher}).uploadedVersion('staging',operation,AbortSignal.timeout(5000));expect(result.version).toBe(latest);expect(calls).toBe(2);
 });
 it('never guesses a version when an upload is absent, duplicated or changes identity',async()=>{
  const operation='33333333-0000-4000-8000-000000000000',annotations={'workers/message':'porchday-upload:'+operation};
  for(const items of [[],[{id:latest,annotations:{} }],[{id:latest,annotations},{id:active,annotations}]]){
   let calls=0;const reader=new CloudflareReleaseReader({...options,fetch:async()=>{calls++;return reply({items});}});
   await expect(reader.uploadedVersion('staging',operation,AbortSignal.timeout(5000))).rejects.toThrow('UPLOAD_UNRESOLVED');expect(calls).toBe(1);
  }
  const reader=new CloudflareReleaseReader({...options,fetch:async input=>String(input).endsWith('/versions')?reply({items:[{id:latest,annotations}]}):reply({id:latest,annotations:{'workers/message':'different operation'}})});
  await expect(reader.uploadedVersion('staging',operation,AbortSignal.timeout(5000))).rejects.toThrow('UPLOAD_IDENTITY_CHANGED');
 });
 it('permits only the reviewed latest-version/settings change and preserves all active and unrelated resources',async()=>{
  const f=fixture(),before=await new CloudflareReleaseReader({...options,fetch:f.transport}).snapshot(AbortSignal.timeout(5000));
  const candidate='44444444-0000-4000-8000-000000000000',settings=releaseSettings({bindings:[{name:'APP_URL',type:'plain_text',text:'https://reviewed.example'}]});
  const after=structuredClone(before);after.workers.staging.latest=candidate;after.workers.staging.settings=settings;
  assertInactiveUploadSnapshot(before,after,'staging',candidate,settings);
  for(const mutate of [
   (value:typeof after)=>{value.workers.staging.active=candidate;},
   (value:typeof after)=>{value.workers.production.latest=candidate;},
   (value:typeof after)=>{value.domains=[];},
   (value:typeof after)=>{value.queues={};},
   (value:typeof after)=>{value.schedules={};},
   (value:typeof after)=>{value.workers.staging.resources.script={etag:'unexpected'};},
   (value:typeof after)=>{value.workers.staging.settings=releaseSettings({bindings:[]});},
  ]){const changed=structuredClone(after);mutate(changed);expect(()=>assertInactiveUploadSnapshot(before,changed,'staging',candidate,settings)).toThrow('INVENTORY_CHANGED');}
  expect(()=>assertInactiveUploadSnapshot(before,after,'staging',active,settings)).toThrow('NOT_NEW_INACTIVE_VERSION');
  const missing=structuredClone(after);delete missing.workers.production;expect(()=>assertInactiveUploadSnapshot(before,missing,'staging',candidate,settings)).toThrow('INVENTORY_INVALID');
 });
 it('cancels the rest of an inventory after a permanent failure',async()=>{
  let calls=0,cancelled=0;
  const transport:typeof fetch=async(_input,init)=>{
   if(++calls===1)return new Response('private denial',{status:403});
   return new Promise<Response>((_done,reject)=>init!.signal!.addEventListener('abort',()=>{cancelled++;reject(Error('cancelled'));},{once:true}));
  };
  await expect(new CloudflareReleaseReader({...options,fetch:transport}).snapshot(AbortSignal.timeout(5000))).rejects.toThrow('RELEASE_PROVIDER_READ_REJECTED');
  await new Promise(done=>setTimeout(done,1));expect(calls).toBeLessThanOrEqual(5);expect(cancelled).toBe(calls-1);
 });
 it('keeps active resources distinct from latest upload settings and bounds GET concurrency',async()=>{
  const f=fixture(),snapshot=await new CloudflareReleaseReader({...options,fetch:f.transport}).snapshot(AbortSignal.timeout(5000));
  expect(Object.keys(snapshot.workers)).toHaveLength(6);expect(snapshot.workers.staging.active).toBe(active);expect(snapshot.workers.staging.latest).toBe(latest);
  expect(snapshot.workers.staging.settings.bindings).toEqual([{name:'APP_URL',type:'plain_text',text:'https://inactive.invalid'}]);
  expect(snapshot.workers.staging.resources.bindings).toContainEqual({name:'APP_URL',type:'plain_text',text:'https://active.example'});
  expect(snapshot.domains.map(value=>value.hostname)).toEqual(['a.example','z.example']);expect(f.maximum()).toBe(4);
  expect(f.calls.every(call=>call.init?.method==='GET'&&call.init.redirect==='error'&&call.init.body===undefined)).toBe(true);expect(JSON.stringify(snapshot)).not.toContain(token);
 });
 it('retries only transient reads and rejects authorization failures without exposing response text',async()=>{
  const f=fixture();let attempts=0;const transient:typeof fetch=async(...args)=>++attempts<3?new Response('private provider detail',{status:503}):f.transport(...args);
  expect((await new CloudflareReleaseReader({...options,fetch:transient}).version('staging',active,AbortSignal.timeout(5000))).script).toEqual({etag:'active-code'});expect(attempts).toBe(3);
  attempts=0;const permanent:typeof fetch=async()=>{attempts++;return new Response('private provider detail',{status:403});};
  await expect(new CloudflareReleaseReader({...options,fetch:permanent}).version('staging',active,AbortSignal.timeout(5000))).rejects.toThrow('RELEASE_PROVIDER_READ_REJECTED');expect(attempts).toBe(1);
 });
 it('rejects mixed deployments and an incorrect requested version',async()=>{
  const f=fixture(),mixed:typeof fetch=async(input,init)=>String(input).endsWith('/deployments')?reply({deployments:[{versions:[{version_id:active,percentage:50}]}]}):f.transport(input,init);
  await expect(new CloudflareReleaseReader({...options,fetch:mixed}).snapshot(AbortSignal.timeout(5000))).rejects.toThrow('DEPLOYMENT_UNSUPPORTED');
  await expect(new CloudflareReleaseReader({...options,fetch:async()=>reply({id:latest,resources:{}})}).version('staging',active,AbortSignal.timeout(5000))).rejects.toThrow('VERSION_MISMATCH');
 });
 it('rejects secret values and malformed or duplicated bindings',()=>{
  for(const value of [[{name:'TOKEN',type:'secret_text',text:'private credential'}],[{name:'A',type:'plain_text'},{name:'A',type:'plain_text'}],{}])expect(()=>releaseSettings({bindings:value})).toThrow();
  expect(releaseSettings({placement:{},bindings:[]}).placement).toBeNull();
 });
 it('cancels queued reads before they can start and sanitizes transport errors',async()=>{
  const controller=new AbortController();let calls=0;
  const transport:typeof fetch=async(_input,init)=>{calls++;return new Promise<Response>((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(Error('private network detail')),{once:true}));};
  const result=new CloudflareReleaseReader({...options,fetch:transport}).snapshot(controller.signal);const rejected=expect(result).rejects.toThrow('RELEASE_READ_CANCELLED');
  await new Promise(done=>setTimeout(done,1));controller.abort();await rejected;expect(calls).toBe(4);
 });
 it('rejects oversized bodies and invalid provider JSON without a write or retry',async()=>{
  for(const body of ['x'.repeat(2*1024*1024+1),'{not-json']){
   let calls=0;const reader=new CloudflareReleaseReader({...options,fetch:async()=>{calls++;return new Response(body);}});
   await expect(reader.version('staging',active,AbortSignal.timeout(5000))).rejects.toThrow(/BODY_LIMIT|RESPONSE_INVALID/);expect(calls).toBe(1);
  }
 });
});
