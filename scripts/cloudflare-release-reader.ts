import {constants,closeSync,fsyncSync,lstatSync,openSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {registeredQueueInventory,type QueueProducerRegistration} from './release-queue-producers.ts';

const workers=['staging','staging-edge','monitor-staging','production','monitor-production','production-edge'] as const;
type Worker=typeof workers[number];
type ObjectValue=Record<string,unknown>;
type QueueEnvironment='staging'|'production';
type ExtraQueueKey=`${QueueEnvironment}-denial-${0|1|2}`|`${QueueEnvironment}-dead-letter`;
export type ReleaseQueues=Record<QueueEnvironment,{id:string;name:string}>&Partial<Record<ExtraQueueKey,{id:string;name:string}>>;
/** Explicit identities only. Partial registration permits guarded resource
 * creation one queue at a time; it is not permission to enable the topology. */
export function validateReleaseQueues(value:ReleaseQueues){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('RELEASE_QUEUE_CONFIGURATION_INVALID');
 const names:Record<string,string>={};
 for(const environment of ['staging','production']){
  names[environment]=`porchday-${environment}-jobs`;
  names[`${environment}-dead-letter`]=`porchday-${environment}-jobs-dead-letter`;
  for(const partition of [0,1,2])names[`${environment}-denial-${partition}`]=`porchday-${environment}-denial-${partition}`;
 }
 if(!value.staging||!value.production)throw Error('RELEASE_QUEUE_CONFIGURATION_INVALID');
 const ids=new Set<string>();
 for(const [key,entry] of Object.entries(value)){
  if(!Object.hasOwn(names,key)||!entry||Object.keys(entry).sort().join(',')!=='id,name'||!/^[a-f0-9]{32}$/.test(entry.id)||entry.name!==names[key]||ids.has(entry.id))throw Error('RELEASE_QUEUE_CONFIGURATION_INVALID');
  ids.add(entry.id);
 }
}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const policyKeys=['placement','compatibility_date','compatibility_flags','usage_model','tail_consumers','streaming_tail_consumers','logpush','limits','observability','cache_options','tags'];
function object(value:unknown):ObjectValue{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('RELEASE_PROVIDER_SHAPE_INVALID');return value as ObjectValue;}
function bindings(value:unknown):ObjectValue[]{
 if(!Array.isArray(value))throw Error('RELEASE_BINDINGS_INVALID');const names=new Set<string>();
 return value.map(item=>{const binding=object(item);if(typeof binding.name!=='string'||!binding.name||names.has(binding.name)||typeof binding.type!=='string')throw Error('RELEASE_BINDINGS_INVALID');names.add(binding.name);
  if(['secret_text','secret_key'].includes(binding.type)&&Object.keys(binding).some(key=>!['name','type'].includes(key)))throw Error('RELEASE_SECRET_REPRESENTATION_UNSUPPORTED');
  return binding;
 });
}
export function releaseSettings(value:unknown):ObjectValue{
 const input=object(value),result=Object.fromEntries(policyKeys.map(key=>[key,input[key]??null]));
 const placement=result.placement;
 if(placement&&typeof placement==='object'&&!Array.isArray(placement)&&(Object.keys(placement).length===0||JSON.stringify(placement)==='{"mode":"off"}'))result.placement=null;
 return{...result,bindings:bindings(input.bindings).sort((a,b)=>String(a.name)<String(b.name)?-1:String(a.name)>String(b.name)?1:0)};
}
function canonical(value:unknown):string{
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';
 throw Error('RELEASE_INVENTORY_INVALID');
}
/** Resource isolation check, not executable or asset verification. */
export function assertInactiveUploadSnapshot(before:unknown,after:unknown,worker:Worker,version:string,expectedSettings:unknown,registration?:QueueProducerRegistration):void{
 if(!workers.includes(worker)||!uuid.test(version))throw Error('RELEASE_UPLOAD_TARGET_INVALID');
 const prior=object(before),observed=object(after),priorWorkers=object(prior.workers),observedWorkers=object(observed.workers);
 for(const snapshot of [prior,observed])if(Object.keys(snapshot).sort().join(',')!=='domains,queues,schedules,workers'||!Array.isArray(snapshot.domains))throw Error('RELEASE_INVENTORY_INVALID');
 for(const inventory of [priorWorkers,observedWorkers])if(Object.keys(inventory).sort().join(',')!==[...workers].sort().join(','))throw Error('RELEASE_INVENTORY_INVALID');
 const target=object(priorWorkers[worker]);
 if(typeof target.active!=='string'||!uuid.test(target.active)||typeof target.latest!=='string'||!uuid.test(target.latest)||version===target.active||version===target.latest)throw Error('RELEASE_UPLOAD_NOT_NEW_INACTIVE_VERSION');
 const settings=releaseSettings(expectedSettings),queues=registration?registeredQueueInventory({before:prior.queues,observed:observed.queues,worker,beforeBindings:object(target.settings).bindings,afterBindings:settings.bindings,registration,phase:'upload'}):prior.queues;
 const expected={...prior,queues,workers:{...priorWorkers,[worker]:{...target,latest:version,settings}}};
 if(canonical(observed)!==canonical(expected))throw Error('RELEASE_UPLOAD_INVENTORY_CHANGED');
}
class RetryableRead extends Error{}

/** Read-only provider inventory. No API for mutations; credentials never enter errors or snapshots. */
export class CloudflareReleaseReader{
 private endpoint:string;private token:string;private transport:typeof fetch;
 private queues:ReleaseQueues;
 private active=0;private waiting:(()=>void)[]=[];
 constructor(options:{accountId:string;apiToken:string;queues:ReleaseQueues;fetch?:typeof fetch}){
  if(!/^[a-f0-9]{32}$/.test(options.accountId)||typeof options.apiToken!=='string'||options.apiToken.length<20)throw Error('RELEASE_READER_CONFIGURATION_INVALID');
  validateReleaseQueues(options.queues);
  this.endpoint='https://api.cloudflare.com/client/v4/accounts/'+options.accountId;this.token=options.apiToken;this.transport=options.fetch??fetch;this.queues=structuredClone(options.queues);
 }
 private async slot(signal:AbortSignal){
  signal.throwIfAborted();
  if(this.active<4){this.active++;return;}
  await new Promise<void>((done,reject)=>{
   const start=()=>{signal.removeEventListener('abort',abort);done();};
   const abort=()=>{this.waiting=this.waiting.filter(entry=>entry!==start);reject(Error('RELEASE_READ_CANCELLED'));};
   this.waiting.push(start);signal.addEventListener('abort',abort,{once:true});
  });
 }
 private release(){const next=this.waiting.shift();if(next)next();else this.active--;}
 private async raw(path:string,signal:AbortSignal,limit:number):Promise<{body:Buffer;contentType:string}>{
  for(let attempt=0;attempt<3;attempt++){
   await this.slot(signal);
   try{
    signal.throwIfAborted();const deadline=AbortSignal.any([signal,AbortSignal.timeout(5000)]);let response:Response;
    try{response=await this.transport(this.endpoint+path,{method:'GET',headers:{Authorization:'Bearer '+this.token},redirect:'error',signal:deadline});}catch{throw new RetryableRead();}
    if([408,429,500,502,503,504].includes(response.status)){await response.body?.cancel().catch(()=>{});throw new RetryableRead();}
    if(!response.ok){await response.body?.cancel().catch(()=>{});throw Error('RELEASE_PROVIDER_READ_REJECTED');}
    const reader=response.body?.getReader();if(!reader)throw Error('RELEASE_PROVIDER_BODY_INVALID');const chunks:Uint8Array[]=[];let length=0;
    try{
     for(;;){let item:ReadableStreamReadResult<Uint8Array>;try{item=await reader.read();}catch{throw new RetryableRead();}if(deadline.aborted)throw new RetryableRead();if(item.done)break;length+=item.value.byteLength;if(length>limit)throw Error('RELEASE_PROVIDER_BODY_LIMIT');chunks.push(item.value);}
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    return{body:Buffer.concat(chunks),contentType:response.headers.get('content-type')??''};
   }catch(error){
    if(signal.aborted)throw Error('RELEASE_READ_CANCELLED');
    if(!(error instanceof RetryableRead)||attempt===2)throw error instanceof RetryableRead?Error('RELEASE_PROVIDER_READ_UNAVAILABLE'):error;
   }finally{this.release();}
   await sleep(attempt===0?250:750,undefined,{signal});
  }
  throw Error('RELEASE_PROVIDER_READ_UNAVAILABLE');
 }
 private async envelope(path:string,signal:AbortSignal):Promise<ObjectValue>{
  const {body}=await this.raw(path,signal,2*1024*1024);let value:ObjectValue;
  try{value=object(JSON.parse(body.toString('utf8')));}catch{throw Error('RELEASE_PROVIDER_RESPONSE_INVALID');}
  if(value.success!==true||!Object.hasOwn(value,'result'))throw Error('RELEASE_PROVIDER_READ_REJECTED');return value;
 }
 private async get(path:string,signal:AbortSignal):Promise<unknown>{return (await this.envelope(path,signal)).result;}
 /** Bounded account catalogue for admission and unknown-create reconciliation.
  * Never infer absence from a partial page. Callers compare before/after reads
  * around their scoped inventory; pagination is not an atomic provider snapshot. */
 async queueCatalogue(signal:AbortSignal){
  const result:ObjectValue[]=[],ids=new Set<string>(),names=new Set<string>();let total:number|undefined,pages:number|undefined,pageSize:number|undefined;
  for(let page=1;page<=100;page++){
   const envelope=await this.envelope('/queues?page='+page,signal),info=object(envelope.result_info),rows=envelope.result;
   if(!Array.isArray(rows)||!Number.isSafeInteger(info.total_count)||Number(info.total_count)<0||Number(info.total_count)>10000||!Number.isSafeInteger(info.total_pages)||Number(info.total_pages)<1||Number(info.total_pages)>100||!Number.isSafeInteger(info.per_page)||Number(info.per_page)<1||Number(info.per_page)>1000||info.page!==page||info.count!==rows.length||rows.length>Number(info.per_page))throw Error('RELEASE_QUEUE_CATALOGUE_INCOMPLETE');
   if(total!==undefined&&(info.total_count!==total||info.total_pages!==pages||info.per_page!==pageSize))throw Error('RELEASE_QUEUE_CATALOGUE_CHANGED');
   total=Number(info.total_count);pages=Number(info.total_pages);pageSize=Number(info.per_page);
   for(const row of rows){const value=object(row),id=value.queue_id,name=value.queue_name;
    if(typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id)||typeof name!=='string'||!name||name.length>256||ids.has(id)||names.has(name))throw Error('RELEASE_QUEUE_CATALOGUE_INVALID');
    for(const kind of ['consumers','producers'])if(!Array.isArray(value[kind])||value[kind+'_total_count']!==value[kind].length)throw Error('RELEASE_QUEUE_INVENTORY_INCOMPLETE');
    ids.add(id);names.add(name);result.push(Object.fromEntries(['queue_id','queue_name','settings','consumers','consumers_total_count','producers','producers_total_count'].map(key=>[key,value[key]??null])));
   }
   if(page===pages){if(result.length!==total)throw Error('RELEASE_QUEUE_CATALOGUE_INCOMPLETE');return result.sort((a,b)=>String(a.queue_name).localeCompare(String(b.queue_name)));}
   if(rows.length!==pageSize)throw Error('RELEASE_QUEUE_CATALOGUE_INCOMPLETE');
  }
  throw Error('RELEASE_QUEUE_CATALOGUE_INCOMPLETE');
 }
 /** The script endpoint is not version-addressed. Surround this read with identity/inventory checks. */
 async script(worker:Worker,signal:AbortSignal):Promise<Record<string,Uint8Array>>{
  const {body,contentType}=await this.raw(this.base(worker),signal,16*1024*1024);
  if(contentType.length>512||!/^multipart\/form-data\s*;/i.test(contentType))throw Error('RELEASE_SCRIPT_CONTENT_TYPE_INVALID');
  let data:FormData;try{data=await new Response(new Uint8Array(body),{headers:{'content-type':contentType}}).formData();}catch{throw Error('RELEASE_SCRIPT_MULTIPART_INVALID');}
  const parts:Record<string,Uint8Array>=Object.create(null);
  for(const [field,value] of data){
   if(typeof value==='string'&&!/^(index|edge)\.js$/.test(field))throw Error('RELEASE_SCRIPT_MODULE_INVALID');const name=typeof value==='string'?field:value.name||field;
   if(!/^[a-zA-Z0-9_.-]+$/.test(name)||Object.hasOwn(parts,name)||Object.keys(parts).length>=16)throw Error('RELEASE_SCRIPT_MODULE_INVALID');
   parts[name]=typeof value==='string'?new TextEncoder().encode(value):new Uint8Array(await value.arrayBuffer());
  }
  if(!Object.keys(parts).length)throw Error('RELEASE_SCRIPT_MODULE_INVALID');signal.throwIfAborted();return parts;
 }
 private base(worker:Worker){if(!workers.includes(worker))throw Error('RELEASE_WORKER_INVALID');return '/workers/scripts/porchday-'+worker;}
 async version(worker:Worker,version:string,signal:AbortSignal):Promise<ObjectValue>{
  if(!uuid.test(version))throw Error('RELEASE_VERSION_INVALID');const value=object(await this.get(this.base(worker)+'/versions/'+version,signal)),resources=object(value.resources);
  if(value.id!==version)throw Error('RELEASE_VERSION_MISMATCH');bindings(resources.bindings);object(resources.script);object(resources.script_runtime);return resources;
 }
 /** Bounded discovery only. An absent/ambiguous operation never authorizes another POST. */
 async uploadedVersion(worker:Worker,operationId:string,signal:AbortSignal):Promise<{version:string;resources:ObjectValue}>{
  if(!uuid.test(operationId))throw Error('RELEASE_UPLOAD_OPERATION_INVALID');
  const message='porchday-upload:'+operationId;
  const listed=object(await this.get(this.base(worker)+'/versions',signal)).items;
  if(!Array.isArray(listed)||listed.length>100)throw Error('RELEASE_UPLOAD_LIST_INVALID');
  const matches=listed.filter(item=>{
   const value=object(item);if(typeof value.id!=='string'||!uuid.test(value.id))throw Error('RELEASE_UPLOAD_LIST_INVALID');
   return value.annotations!==undefined&&object(value.annotations)['workers/message']===message;
  });
  if(matches.length!==1)throw Error('RELEASE_UPLOAD_UNRESOLVED');
  const version=object(matches[0]).id as string,value=object(await this.get(this.base(worker)+'/versions/'+version,signal));
  if(value.id!==version||object(value.annotations)['workers/message']!==message)throw Error('RELEASE_UPLOAD_IDENTITY_CHANGED');
  const resources=object(value.resources);bindings(resources.bindings);object(resources.script);object(resources.script_runtime);
  return{version,resources};
 }
 async snapshot(signal:AbortSignal){
  const scope=new AbortController();signal=AbortSignal.any([signal,scope.signal]);
  try{
  const entries=await Promise.all(workers.map(async worker=>{
   const base=this.base(worker),[deployments,versions,settings]=await Promise.all([this.get(base+'/deployments',signal),this.get(base+'/versions',signal),this.get(base+'/settings',signal)]);
   const list=object(deployments).deployments,items=object(versions).items;
   if(!Array.isArray(list)||!list.length||!Array.isArray(items)||!items.length)throw Error('RELEASE_VERSIONS_INVALID');
   const deployed=object(list[0]).versions,latest=object(items[0]).id;
   if(!Array.isArray(deployed)||deployed.length!==1||object(deployed[0]).percentage!==100)throw Error('RELEASE_DEPLOYMENT_UNSUPPORTED');
   const active=object(deployed[0]).version_id;if(typeof active!=='string'||!uuid.test(active)||typeof latest!=='string'||!uuid.test(latest))throw Error('RELEASE_VERSIONS_INVALID');
   return[worker,{active,latest,settings:releaseSettings(settings),resources:await this.version(worker,active,signal)}] as const;
  }));
  const [rawDomains,queues,schedules]=await Promise.all([
   this.get('/workers/domains',signal),
   Promise.all(Object.entries(this.queues).sort(([a],[b])=>a.localeCompare(b)).map(async ([key,expected])=>{
    const value=object(await this.get('/queues/'+expected.id,signal));if(value.queue_id!==expected.id||value.queue_name!==expected.name)throw Error('RELEASE_QUEUE_MISMATCH');
    for(const kind of ['consumers','producers'])if(!Array.isArray(value[kind])||value[kind+'_total_count']!==value[kind].length)throw Error('RELEASE_QUEUE_INVENTORY_INCOMPLETE');
    return[key,Object.fromEntries(['queue_id','queue_name','settings','consumers','consumers_total_count','producers','producers_total_count'].map(key=>[key,value[key]??null]))];
   })),
   Promise.all((['staging','production','monitor-staging','monitor-production'] as const).map(async worker=>[worker,await this.get(this.base(worker)+'/schedules',signal)])),
  ]);
  if(!Array.isArray(rawDomains)||rawDomains.some(value=>typeof object(value).hostname!=='string'))throw Error('RELEASE_DOMAINS_INVALID');
  const registered=new Set(Object.values(this.queues).map(queue=>queue.name));
  for(const [,worker] of entries)for(const state of [worker.settings,worker.resources])for(const binding of bindings(state.bindings)){
   if(binding.type==='queue'&&(typeof binding.queue_name!=='string'||!registered.has(binding.queue_name)))throw Error('RELEASE_QUEUE_BINDING_UNREGISTERED');
  }
  return{workers:Object.fromEntries(entries),domains:rawDomains.sort((a,b)=>a.hostname<b.hostname?-1:a.hostname>b.hostname?1:0),queues:Object.fromEntries(queues),schedules:Object.fromEntries(schedules)};
  }finally{scope.abort();}
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const [output,registry,...extra]=process.argv.slice(2);if(!output||!isAbsolute(output)||extra.length)throw Error('RELEASE_READER_ARGUMENTS');
  const parent=dirname(output),stat=lstatSync(parent);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.())throw Error('RELEASE_READER_OUTPUT_INVALID');
  const resources=JSON.parse(readFileSync('infra/resources.json','utf8'));
  let queues=Object.fromEntries(['staging','production'].map(environment=>[environment,{id:resources.environments[environment].queue_id,name:resources.environments[environment].queue}])) as ReleaseQueues;
  if(registry){const stat=lstatSync(registry);if(!isAbsolute(registry)||!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.()||stat.size>16384)throw Error('RELEASE_QUEUE_REGISTRY_INVALID');queues=JSON.parse(readFileSync(registry,'utf8'));}
  const reader=new CloudflareReleaseReader({accountId:process.env.CLOUDFLARE_ACCOUNT_ID??'',apiToken:process.env.CLOUDFLARE_API_TOKEN??'',queues});
  const value=await reader.snapshot(AbortSignal.timeout(120000)),fd=openSync(output,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  const directory=openSync(parent,constants.O_RDONLY);try{fsyncSync(directory);}finally{closeSync(directory);}
  console.log(JSON.stringify({saved:true,workers:6,providerWrites:0}));
 }catch{console.error('RELEASE_PROVIDER_READ_FAILED');process.exitCode=1;}
}
