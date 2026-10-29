import {constants,closeSync,fsyncSync,lstatSync,openSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';

const workers=['staging','staging-edge','monitor-staging','production','monitor-production','production-edge'] as const;
type Worker=typeof workers[number];
type ObjectValue=Record<string,unknown>;
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
class RetryableRead extends Error{}

/** Read-only provider inventory. No API for mutations; credentials never enter errors or snapshots. */
export class CloudflareReleaseReader{
 private endpoint:string;private token:string;private transport:typeof fetch;
 private queues:Record<'staging'|'production',{id:string;name:string}>;
 private active=0;private waiting:(()=>void)[]=[];
 constructor(options:{accountId:string;apiToken:string;queues:Record<'staging'|'production',{id:string;name:string}>;fetch?:typeof fetch}){
  if(!/^[a-f0-9]{32}$/.test(options.accountId)||typeof options.apiToken!=='string'||options.apiToken.length<20)throw Error('RELEASE_READER_CONFIGURATION_INVALID');
  for(const environment of ['staging','production'] as const)if(!/^[a-f0-9]{32}$/.test(options.queues?.[environment]?.id)||options.queues[environment].name!==`porchday-${environment}-jobs`)throw Error('RELEASE_QUEUE_CONFIGURATION_INVALID');
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
 private async get(path:string,signal:AbortSignal):Promise<unknown>{
  for(let attempt=0;attempt<3;attempt++){
   await this.slot(signal);
   try{
    signal.throwIfAborted();const deadline=AbortSignal.any([signal,AbortSignal.timeout(5000)]);let response:Response;
    try{response=await this.transport(this.endpoint+path,{method:'GET',headers:{Authorization:'Bearer '+this.token},redirect:'error',signal:deadline});}catch{throw new RetryableRead();}
    if([408,429,500,502,503,504].includes(response.status)){await response.body?.cancel().catch(()=>{});throw new RetryableRead();}
    if(!response.ok){await response.body?.cancel().catch(()=>{});throw Error('RELEASE_PROVIDER_READ_REJECTED');}
    const reader=response.body?.getReader();if(!reader)throw Error('RELEASE_PROVIDER_BODY_INVALID');const chunks:Uint8Array[]=[];let length=0;
    try{
     for(;;){let item:ReadableStreamReadResult<Uint8Array>;try{item=await reader.read();}catch{throw new RetryableRead();}if(deadline.aborted)throw new RetryableRead();if(item.done)break;length+=item.value.byteLength;if(length>2*1024*1024)throw Error('RELEASE_PROVIDER_BODY_LIMIT');chunks.push(item.value);}
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    let value:ObjectValue;try{value=object(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{throw Error('RELEASE_PROVIDER_RESPONSE_INVALID');}
    if(value.success!==true||!Object.hasOwn(value,'result'))throw Error('RELEASE_PROVIDER_READ_REJECTED');return value.result;
   }catch(error){
    if(signal.aborted)throw Error('RELEASE_READ_CANCELLED');
    if(!(error instanceof RetryableRead)||attempt===2)throw error instanceof RetryableRead?Error('RELEASE_PROVIDER_READ_UNAVAILABLE'):error;
   }finally{this.release();}
   await sleep(attempt===0?250:750,undefined,{signal});
  }
  throw Error('RELEASE_PROVIDER_READ_UNAVAILABLE');
 }
 private base(worker:Worker){if(!workers.includes(worker))throw Error('RELEASE_WORKER_INVALID');return '/workers/scripts/porchday-'+worker;}
 async version(worker:Worker,version:string,signal:AbortSignal):Promise<ObjectValue>{
  if(!uuid.test(version))throw Error('RELEASE_VERSION_INVALID');const value=object(await this.get(this.base(worker)+'/versions/'+version,signal)),resources=object(value.resources);
  if(value.id!==version)throw Error('RELEASE_VERSION_MISMATCH');bindings(resources.bindings);object(resources.script);object(resources.script_runtime);return resources;
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
   Promise.all((['staging','production'] as const).map(async environment=>{
    const expected=this.queues[environment],value=object(await this.get('/queues/'+expected.id,signal));if(value.queue_id!==expected.id||value.queue_name!==expected.name)throw Error('RELEASE_QUEUE_MISMATCH');
    return[environment,Object.fromEntries(['queue_id','queue_name','settings','consumers','consumers_total_count','producers','producers_total_count'].map(key=>[key,value[key]??null]))];
   })),
   Promise.all((['staging','production','monitor-staging','monitor-production'] as const).map(async worker=>[worker,await this.get(this.base(worker)+'/schedules',signal)])),
  ]);
  if(!Array.isArray(rawDomains)||rawDomains.some(value=>typeof object(value).hostname!=='string'))throw Error('RELEASE_DOMAINS_INVALID');
  return{workers:Object.fromEntries(entries),domains:rawDomains.sort((a,b)=>a.hostname<b.hostname?-1:a.hostname>b.hostname?1:0),queues:Object.fromEntries(queues),schedules:Object.fromEntries(schedules)};
  }finally{scope.abort();}
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const [output,...extra]=process.argv.slice(2);if(!output||!isAbsolute(output)||extra.length)throw Error('RELEASE_READER_ARGUMENTS');
  const parent=dirname(output),stat=lstatSync(parent);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.())throw Error('RELEASE_READER_OUTPUT_INVALID');
  const resources=JSON.parse(readFileSync('infra/resources.json','utf8'));
  const reader=new CloudflareReleaseReader({accountId:process.env.CLOUDFLARE_ACCOUNT_ID??'',apiToken:process.env.CLOUDFLARE_API_TOKEN??'',queues:Object.fromEntries(['staging','production'].map(environment=>[environment,{id:resources.environments[environment].queue_id,name:resources.environments[environment].queue}])) as Record<'staging'|'production',{id:string;name:string}>});
  const value=await reader.snapshot(AbortSignal.timeout(120000)),fd=openSync(output,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  const directory=openSync(parent,constants.O_RDONLY);try{fsyncSync(directory);}finally{closeSync(directory);}
  console.log(JSON.stringify({saved:true,workers:6,providerWrites:0}));
 }catch{console.error('RELEASE_PROVIDER_READ_FAILED');process.exitCode=1;}
}
