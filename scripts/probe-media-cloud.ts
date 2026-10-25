import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {builtinModules} from 'node:module';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {generateDeviceKeys,unlockPrivateKey,encryptObject,canonicalJson} from '../packages/crypto/src/index.js';
import {withOperatorR2} from './r2-operator-bridge.js';

const local=process.argv.includes('--local');
const validOnly=process.argv.includes('--valid-only');
let phase='prepare';
function progress(value:string){phase=value;if(!local)console.log(JSON.stringify({probePhase:value,at:new Date().toISOString()}));}
if(!local&&!process.argv.includes('--run'))throw Error('EXPLICIT_RUN_OR_LOCAL_REQUIRED');
const maximum=22_020_096,runId=randomUUID().replaceAll('-','').slice(0,12),names={journal:'porchday-media-probe-'+runId+'-journal',media:'porchday-media-probe-'+runId+'-source',backup:'porchday-media-probe-'+runId+'-backup'};
const checksum=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const bundle=await build({entryPoints:[new URL('./probe-media-cloud.worker.ts',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'neutral',mainFields:['browser','module','main'],conditions:['workerd','browser'],external:['node:*','cloudflare:*'],target:'es2022',logLevel:'silent',banner:{js:"import { createRequire } from 'node:module'; const require = createRequire('/probe.js');"},plugins:[{name:'node-builtins',setup(builder){builder.onResolve({filter:/.*/},args=>builtinModules.includes(args.path)?{path:args.path.startsWith('node:')?args.path:'node:'+args.path,external:true}:undefined);}}]});
const member=randomUUID(),device=randomUUID(),mediaId=randomUUID(),keys=await generateDeviceKeys(member,device),privateKey=await unlockPrivateKey(keys.encryptedPrivateKey,keys.recoverySecret);
const envelope=await encryptObject({context:{id:mediaId,kind:'media',authorId:member,authorDeviceId:device,audience:'only_me',parentId:randomUUID(),groupId:null,epoch:1,createdAt:new Date().toISOString(),expiresAt:null,revision:1},payload:{mime:'image/jpeg',bytes:randomBytes(11_900_000).toString('base64'),alt:'Synthetic provider memory probe',width:2400,height:2400},signingKey:privateKey,recipients:[{memberId:member,deviceId:device,publicKey:keys.publicKey}]});
const encoded=JSON.stringify(envelope);assert(Buffer.byteLength(encoded)<maximum);const bytes=Buffer.from(encoded+' '.repeat(maximum-Buffer.byteLength(encoded))),key='media/'+member+'/'+mediaId;
// Intentionally mismatched ciphertext: a large two-byte UTF-16 result plus one
// million escaped lone surrogates exercises accumulator amplification defenses.
// It keeps the valid routing/reservation, and must fail with a controlled 409.
const adversarialEncoded=JSON.stringify({...envelope,ciphertext:'-----BEGIN PGP MESSAGE-----\n'+'A'.repeat(15_500_000)+'\ud800'.repeat(1_000_000)+'\ufeff'});
assert(Buffer.byteLength(adversarialEncoded)<maximum);const adversarialBytes=Buffer.from(adversarialEncoded+' '.repeat(maximum-Buffer.byteLength(adversarialEncoded)));
const wideEncoded=JSON.stringify({...envelope,ciphertext:'-----BEGIN PGP MESSAGE-----\n'+'A'.repeat(21_990_000)+'\ufeff'});
assert(Buffer.byteLength(wideEncoded)<maximum);const wideBytes=Buffer.from(wideEncoded+' '.repeat(maximum-Buffer.byteLength(wideEncoded)));
const adversarialCases=[{name:'escaped_lone_surrogates',bytes:adversarialBytes},{name:'almost_all_ascii_with_one_non_latin1',bytes:wideBytes}];
const item={object_key:key,canonical_sha256:checksum(canonicalJson(envelope)),sha256:checksum(bytes),byte_size:maximum},items=[item];for(let n=1;n<8;n++)items.push({...item,object_key:'media/'+member+'/'+randomUUID()});items.sort((a,b)=>a.object_key.localeCompare(b.object_key));
const started=new Date(),run={id:randomUUID(),restore_at:started.toISOString(),generation:randomUUID(),base_sequence:'0',expires_at:new Date(+started+7*86400000).toISOString()},fixture={member,mediaId,items,run,trace:true};
type Transport={request:(path:string,body?:unknown,method?:'POST'|'PUT')=>Promise<Response>;verify:()=>Promise<void>;remove:()=>Promise<void>;restore:()=>Promise<void>};
async function exercise(transport:Transport){
 const deadline=Date.now()+180000,results:any[]=[];
 async function step(path:string,body?:unknown,method?:'POST'|'PUT',expectedStatus?:number){
  if(Date.now()>deadline)throw Error('PROBE_RUNTIME_BUDGET_EXCEEDED');progress(path.split('/').at(-1)!);const start=performance.now(),response=await transport.request(path,body,method),value=await response.json();
  if(expectedStatus?response.status!==expectedStatus:!response.ok)throw Error('PROBE_STEP_FAILED_'+path.split('/').at(-1)+'_'+response.status+(typeof (value as any)?.error==='string'&&/^[A-Z_]+$/.test((value as any).error)?'_'+(value as any).error:''));const record={step:path.split('/').at(-1),elapsedMs:Math.round(performance.now()-start),status:response.status,result:value};results.push(record);if(!local)console.log(JSON.stringify({probeStep:record.step,elapsedMs:record.elapsedMs,status:record.status,at:new Date().toISOString()}));return value as any;
 }
 try{
  const initialized=await step('/probe/init',fixture);assert(initialized.productionRoutesLoaded>=100);
  if(validOnly){
   await step('/probe/reserve',{id:mediaId,envelope,byte_size:maximum},'POST',201);await step('/probe/upload',bytes,'PUT');await step('/probe/upload-check');await step('/probe/diagnostics');await transport.verify();
   return {passed:true,scope:local?'local native-R2 genuine-only fixture':'deployed Cloudflare Workers genuine-only diagnostic',actualMediaHandlers:true,fullApplicationModuleLoaded:true,sqlAndAuthenticationVerified:false,maximumUploadBytes:maximum,repeatedMaximumUploads:1,backupObjects:0,nativeRestoreVerified:false,nativeObjectVerified:true,bundleBytes:Buffer.byteLength(bundle.outputFiles[0].text),bindings:['JOURNAL','MEDIA','BACKUP'],compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],requestedCpuLimitMs:30000,largeRequestWallDeadlineMs:120000,exerciseBudgetMs:180000,capabilityMinutes:10,memoryLimitOverride:false,fixturePhaseTracing:true,results};
  }
  for(let round=0;round<3;round++){
   if(round)await step('/probe/reset-media');
   const overlap=await step('/probe/reserve-overlap',{id:mediaId,envelope,byte_size:maximum});assert.deepEqual(overlap.results.map((r:any)=>r.status).sort(),[201,429]);
   if(!round)for(const fixture of adversarialCases){assert.equal((await step('/probe/upload',fixture.bytes,'PUT',409)).error,'MEDIA_UPLOAD_MISMATCH');const check=await step('/probe/adversarial-check');assert.equal(check.temporaryObjectRemoved,true);results.at(-1).fixture=fixture.name;}
   await step('/probe/upload',bytes,'PUT');await step('/probe/upload-check');
  }
  await step('/probe/backup-start');assert.equal((await step('/probe/backup-page')).status,'more');assert.equal((await step('/probe/backup-page')).status,'complete');const checked=await step('/probe/backup-check');assert.equal(checked.objects,8);assert.equal(checked.bytes,8*maximum);
  progress('operator-verify-source');await transport.verify();progress('operator-remove-source');await transport.remove();progress('operator-restore');await transport.restore();progress('operator-verify-restored');await transport.verify();
  return {passed:true,scope:local?'local native-R2 fixture for hosted probe':'deployed Cloudflare Workers and private native R2',actualMediaHandlers:true,fullApplicationModuleLoaded:true,sqlAndAuthenticationVerified:false,maximumUploadBytes:maximum,repeatedMaximumUploads:3,adversarialMaximumUploads:[{fixture:adversarialCases[0].name,escapedLoneSurrogates:1000000,expectedStatus:409},{fixture:adversarialCases[1].name,asciiCharacters:21990000,nonLatin1Characters:1,expectedStatus:409}],temporaryInvalidObjectsRemoved:true,sameIsolateGuaranteedAcrossRequests:false,backupObjects:8,backupBytes:8*maximum,overlapStatuses:[201,429],nativeRestoreVerified:true,bundleBytes:Buffer.byteLength(bundle.outputFiles[0].text),bindings:['JOURNAL','MEDIA','BACKUP'],compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],requestedCpuLimitMs:30000,largeRequestWallDeadlineMs:120000,exerciseBudgetMs:180000,fixturePhaseTracing:true,capabilityMinutes:10,memoryLimitOverride:false,results};
 }catch(error){
  try{const response=await transport.request('/probe/diagnostics'),value=await response.json() as any;if(response.ok&&typeof value.phase==='string'&&/^[a-z_]+$/.test(value.phase)&&typeof value.at==='string')console.log(JSON.stringify({lastFixturePhase:value.phase,at:value.at}));}catch{}
  throw error;
 }finally{
  const lastPhase=phase;progress('cleanup-objects');const response=await transport.request('/probe/cleanup');if(!response.ok||(await response.json() as any).empty!==true)throw Error('PROBE_OBJECT_CLEANUP_FAILED');phase=lastPhase;
 }
}

async function main(){
 if(local){
  const bearer='local-synthetic-probe-only',mf=new Miniflare(convertV4MiniflareOptions({name:'full-app-media-cloud-probe',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],r2Buckets:['JOURNAL','MEDIA','BACKUP'],bindings:{OPERATOR_BEARER:bearer,OPERATOR_EXPIRES_AT:String(Date.now()+10*60000)}}));
  const request=(path:string,body?:unknown,method:'POST'|'PUT'='POST')=>mf.dispatchFetch('https://probe.test'+path,{method,headers:{Authorization:'Bearer '+bearer,'Content-Type':body instanceof Uint8Array?'application/octet-stream':'application/json'},body:body instanceof Uint8Array?body:JSON.stringify(body??{})});
  const call=async(path:string,body:unknown)=>{assert((await request(path,body)).ok);};
  try{const denied=await mf.dispatchFetch('https://probe.test/probe/init',{method:'POST',body:JSON.stringify(fixture)});assert.equal(denied.status,401);assert.equal((await(await mf.getR2Bucket('JOURNAL')).list()).objects.length,0);
   const probeKey='probes/'+randomUUID()+'.json',first=await request('/journal/put',{key:probeKey,value:'{}',ifNoneMatch:'*'});assert.equal(first.status,200);const firstValue=await first.json() as any;
   assert.equal((await request('/journal/put',{key:probeKey,value:'{}',ifNoneMatch:'*'})).status,412);
   assert.equal((await request('/journal/put',{key:probeKey,value:'{"updated":true}',ifMatch:firstValue.etag})).status,200);
   assert.equal((await request('/journal/put',{key:probeKey,value:'{}',ifMatch:firstValue.etag})).status,412);
   assert.equal((await request('/probe/delete',{key:probeKey})).status,200);
   const result=await exercise({request,verify:()=>call('/media/verify',{key,sha256:item.sha256,byteSize:maximum}),remove:()=>call('/media/delete',{key}),restore:()=>call('/backup/restore',{snapshotId:run.id,key,sha256:item.sha256,byteSize:maximum})});
   for(const name of['JOURNAL','MEDIA','BACKUP'])assert.equal((await(await mf.getR2Bucket(name)).list()).objects.length,0);console.log(JSON.stringify({...result,privateBucketsEmptied:true}));
  }finally{await mf.dispose();}return;
 }
 const account=process.env.CLOUDFLARE_ACCOUNT_ID,token=process.env.CLOUDFLARE_API_TOKEN??process.env.CF_API_TOKEN;if(!account||!token)throw Error('CLOUDFLARE_CREDENTIALS_REQUIRED');
 const base='/accounts/'+account;const attempted=new Set<string>();
 async function api(path:string,method='GET',body?:unknown):Promise<any>{
  const response=await fetch('https://api.cloudflare.com/client/v4'+base+path,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();if(response.ok&&!text)return null;let value:any;try{value=JSON.parse(text);}catch{throw Error('PROBE_PROVIDER_RESPONSE_INVALID');}if(!response.ok||value.success!==true)throw Error('PROBE_PROVIDER_REQUEST_FAILED_'+response.status);return value.result;
 }
 let result:unknown,cleaned=false;
 try{
  progress('create-private-buckets');
  const existing=new Set((await api('/r2/buckets')).buckets.map((b:any)=>b.name));if(Object.values(names).some(name=>existing.has(name)))throw Error('PROBE_BUCKET_COLLISION');
  for(const name of Object.values(names)){
   attempted.add(name);await api('/r2/buckets','POST',{name,locationHint:'wnam'});await api('/r2/buckets/'+name+'/domains/managed','PUT',{enabled:false});assert.equal((await api('/r2/buckets/'+name+'/domains/custom')).domains.length,0);
   // Process-crash fallback contains only disposable synthetic ciphertext.
   await api('/r2/buckets/'+name+'/lifecycle','PUT',{rules:[{id:'expire-synthetic-probe-objects',enabled:true,conditions:{prefix:''},deleteObjectsTransition:{condition:{type:'Age',maxAge:86400}}}]});
  }
  progress('operator-setup');result=await withOperatorR2({journalBucket:names.journal,mediaBucket:names.media,backupBucket:names.backup,hostname:'ops-'+runId.slice(0,8)+'.porchday.com',probeModule:{source:bundle.outputFiles[0].text,largeRequestTimeoutMs:120000},onProgress:value=>console.log(JSON.stringify({probeTransportPhase:value,at:new Date().toISOString()}))},async bridge=>exercise({request:bridge.probeRequest!,verify:()=>bridge.verifyMediaObject({key,sha256:item.sha256,byteSize:maximum}),remove:()=>bridge.deleteMediaObject(key),restore:()=>bridge.restoreMediaObject({snapshotId:run.id,key,sha256:item.sha256,byteSize:maximum})}));
 }finally{
  let failed=false;try{const current=new Set((await api('/r2/buckets')).buckets.map((b:any)=>b.name));for(const name of attempted)if(current.has(name))try{await api('/r2/buckets/'+name,'DELETE');}catch{failed=true;}
   const remaining=new Set((await api('/r2/buckets')).buckets.map((b:any)=>b.name));if([...attempted].some(name=>remaining.has(name)))failed=true;
  }catch{failed=true;}
  if(failed){console.error('Synthetic probe bucket cleanup requires attention for run '+runId);throw Error('PROBE_BUCKET_TEARDOWN_REQUIRED');}cleaned=true;
 }
 console.log(JSON.stringify({...result as object,temporaryWorkerAndDomainRemoved:true,privateBucketsRemoved:cleaned,probeRun:runId}));
}
main().catch(error=>{console.error(JSON.stringify({passed:false,phase,code:error instanceof Error&&/^[A-Za-z0-9_-]+$/.test(error.message)?error.message:'MEDIA_CLOUD_PROBE_FAILED',probeRun:runId}));process.exitCode=1;});
