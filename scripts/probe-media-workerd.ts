import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {canonicalJson,generateDeviceKeys,unlockPrivateKey,encryptObject} from '../packages/crypto/src/index.js';
import postgres,{type Sql} from 'postgres';
import {builtinModules} from 'node:module';

// No provider access or local application database; all keys, buckets and payloads are disposable.
if(process.argv[2]!=='--run')throw Error('USE_NPX_TSX_SCRIPTS_PROBE_MEDIA_WORKERD_TS_RUN');
const directory=await mkdtemp(join(tmpdir(),'porchday-media-workerd-')),maximum=22_020_096;
const copies=Number(process.argv.find(a=>a.startsWith('--copies='))?.slice(9)??1);assert(Number.isInteger(copies)&&copies>=1&&copies<=8);if(process.argv.includes('--upload'))assert.equal(copies,1);
let mf:Miniflare|undefined,socket:WebSocket|undefined,phase='fixture',admin:Sql|undefined,database:Sql|undefined,databaseName:string|undefined;
const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
try{
 const member=randomUUID(),device=randomUUID(),id=randomUUID(),keys=await generateDeviceKeys(member,device),privateKey=await unlockPrivateKey(keys.encryptedPrivateKey,keys.recoverySecret);
 let epoch=1,hyperdrive:string|undefined;
 if(process.argv.includes('--upload')){
  phase='isolated_database';admin=postgres('postgres://postgres:porchday-local@127.0.0.1:54329/postgres',{max:1,onnotice:()=>{}});databaseName='porchday_media_probe_'+randomUUID().replaceAll('-','');await admin.unsafe('create database '+databaseName);database=postgres('postgres://postgres:porchday-local@127.0.0.1:54329/'+databaseName,{max:1,onnotice:()=>{}});
  for(const name of(await readdir(new URL('../apps/api/migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await database.unsafe(await readFile(new URL('../apps/api/migrations/'+name,import.meta.url),'utf8'));
  await database`insert into public.auth_user(id,name,email,"emailVerified") values(${member},'Synthetic media probe',${member+'@example.test'},true)`;await database`insert into app.members(id,adult_attested_at,rules_accepted_at) values(${member},now(),now())`;
  await database`insert into app.profiles(member_id,handle) values(${member},'synthetic_media_probe')`;await database`insert into app.device_keys(id,member_id,public_key,fingerprint,authorization_proof) values(${device},${member},${keys.publicKey},${keys.fingerprint},'{}')`;
  epoch=Number((await database`select epoch from app.directory_epoch where id`)[0].epoch);hyperdrive='postgres://porchday_social:porchday-local-social@127.0.0.1:54329/'+databaseName;
 }
 // Large incompressible photo-shaped plaintext, encrypted and signed by the real package.
 const envelope=await encryptObject({context:{id,kind:'media',authorId:member,authorDeviceId:device,audience:'only_me',parentId:randomUUID(),groupId:null,epoch,createdAt:new Date().toISOString(),expiresAt:null,revision:1},payload:{mime:'image/jpeg',bytes:randomBytes(11_900_000).toString('base64'),alt:'Synthetic maximum envelope probe',width:2400,height:2400},signingKey:privateKey,recipients:[{memberId:member,deviceId:device,publicKey:keys.publicKey}]});
 const encoded=JSON.stringify(envelope);assert(Buffer.byteLength(encoded)<=maximum);const data=Buffer.from(encoded+' '.repeat(maximum-Buffer.byteLength(encoded))),key='media/'+member+'/'+id;
 const started=new Date(),run={id:randomUUID(),restore_at:started.toISOString(),generation:randomUUID(),base_sequence:'0',expires_at:new Date(+started+7*86400000).toISOString()},item={object_key:key,canonical_sha256:digest(canonicalJson(envelope)),sha256:digest(data),byte_size:data.byteLength};
 phase='bundle';const bundle=await build({entryPoints:[new URL('./probe-media-workerd.worker.ts',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'neutral',mainFields:['browser','module','main'],conditions:['workerd','browser'],external:['node:*','cloudflare:*'],target:'es2022',banner:{js:"import { createRequire } from 'node:module'; const require = createRequire('/probe.js');"},plugins:[{name:'node-builtins',setup(builder){builder.onResolve({filter:/.*/},args=>builtinModules.includes(args.path)?{path:'node:'+args.path,external:true}:undefined);}}]});
 mf=new Miniflare(convertV4MiniflareOptions({name:'media-load-probe',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],inspectorPort:0,resourcePersistencePath:directory,r2Buckets:['SOURCE','TARGET','BACKUP','JOURNAL','META'],...(hyperdrive?{hyperdrives:{HYPERDRIVE_SOCIAL:hyperdrive}}:{}),bindings:{PROBE_MEMBER:member,OPERATOR_BEARER:'local-synthetic-only',OPERATOR_EXPIRES_AT:String(Date.now()+600_000)}}));
 const items=[item];for(let n=1;n<copies;n++)items.push({...item,object_key:'media/'+member+'/'+randomUUID()});items.sort((a,b)=>a.object_key.localeCompare(b.object_key));
 await(await mf.getR2Bucket('META')).put('fixture.json',JSON.stringify({run,items}));if(!hyperdrive)for(const copy of items)await(await mf.getR2Bucket('SOURCE')).put(copy.object_key,data);
 phase='inspector';const inspector=await mf.getInspectorURL();inspector.protocol='http:';const targets=await(await fetch(new URL('/json/list',inspector))).json() as any[],target=targets.find(t=>t.title.includes('media-load-probe'))??targets[0];assert(target?.webSocketDebuggerUrl);
 socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('INSPECTOR_CONNECT_TIMEOUT')),10000);socket!.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});socket!.addEventListener('error',()=>{clearTimeout(timer);reject(Error('INSPECTOR_CONNECT_FAILED'));},{once:true});});
 let nextId=0;const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();socket.addEventListener('message',event=>{const message=JSON.parse(String(event.data));if(message.id){const waiting=pending.get(message.id);pending.delete(message.id);message.error?waiting?.reject(Error('INSPECTOR_COMMAND_FAILED')):waiting?.resolve(message.result);}});
 const cdp=(method:string)=>new Promise<any>((resolve,reject)=>{const id=++nextId,timer=setTimeout(()=>{pending.delete(id);reject(Error('INSPECTOR_COMMAND_TIMEOUT_'+method));},15000);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});socket!.send(JSON.stringify({id,method}));});
 await cdp('Runtime.enable');
 const baseline=await cdp('Runtime.getHeapUsage'),measurements:any[]=[];
 async function call(path:string,body?:unknown){return mf!.dispatchFetch('https://probe.test'+path,{method:body instanceof Uint8Array?'PUT':'POST',headers:{Authorization:'Bearer local-synthetic-only','Content-Type':body instanceof Uint8Array?'application/octet-stream':'application/json'},body:body instanceof Uint8Array?body:JSON.stringify(body??{})});}
 async function measure(name:string,path:string,body?:unknown,overlap=false){phase=name;const samples:any[]=[];let finished=false;const poll=(async()=>{while(!finished){samples.push(await cdp('Runtime.getHeapUsage'));await new Promise(resolve=>setTimeout(resolve,5));}})();const start=performance.now();let responses:Response[];try{responses=overlap?await Promise.all([call(path,body),call(path,body)]):[await call(path,body)];}finally{finished=true;await poll;}
  samples.push(await cdp('Runtime.getHeapUsage'));const values=await Promise.all(responses!.map(async response=>({status:response.status,retryAfter:response.headers.get('Retry-After'),body:await response.json()})));if(overlap){assert.deepEqual(values.map(v=>v.status).sort(),[201,429]);assert.equal(values.find(v=>v.status===429)?.retryAfter,'1');}else assert([200,201].includes(values[0].status),JSON.stringify(values[0]).slice(0,150));measurements.push({name,elapsedMs:Math.round(performance.now()-start),result:values,samples:samples.length,maximumSampledHeap:Math.max(...samples.map(s=>s.usedSize)),maximumSampledBackingStorage:Math.max(...samples.map(s=>s.backingStorageSize??0)),maximumSampledHeapPlusBacking:Math.max(...samples.map(s=>s.usedSize+(s.backingStorageSize??0)))});
 }
 await measure('full_application_module_loaded','/control/footprint');
 if(hyperdrive){await measure('actual_post_media_reservation','/api/media',{id,envelope,byte_size:maximum},process.argv.includes('--overlap'));await measure('actual_put_media_bytes','/api/media/'+id+'/bytes',data);const[row]=await database!`select raw_sha256,envelope_sha256 from app.media_assets where id=${id}`;assert.equal(row.raw_sha256,item.sha256);assert.equal(row.envelope_sha256,item.canonical_sha256);}
 await measure('backup_start','/backup/start');await measure('backup_copy_max_envelope','/backup/page');await measure('backup_complete','/backup/page');await measure('backup_verify','/backup/check');
 const verify={key,sha256:item.sha256,byteSize:maximum};await measure('operator_source_verify','/media/verify',verify);await measure('operator_restore','/backup/restore',{snapshotId:run.id,key,sha256:digest(data),byteSize:maximum});await measure('operator_target_verify','/target/verify',verify);
 // Empirical negative control: local workerd accepts a retained allocation ABOVE deployed limit.
 await measure('local_limit_negative_control','/control/allocate');await call('/control/release');
 console.log(JSON.stringify({passed:true,scope:'local workerd with native R2; synthetic fixture',encodedEnvelopeBytes:Buffer.byteLength(encoded),uploadedBytes:data.byteLength,copies,realOpenPGP:true,paddingBytes:data.byteLength-Buffer.byteLength(encoded),baseline,measurements,cloudflare128MiBLimitEnforced:false,peakMeasurement:'CDP samples; transient peaks may be missed; whole process RSS is not isolate memory'}));
}catch(error){console.error(JSON.stringify({passed:false,phase,error:error instanceof Error?error.message.slice(0,300):'LOCAL_PROBE_FAILED'}));process.exitCode=1;}
finally{socket?.close();await mf?.dispose().catch(()=>{});await database?.end({timeout:1});if(databaseName)await admin!.unsafe('drop database '+databaseName+' with (force)');await admin?.end({timeout:1});await rm(directory,{recursive:true,force:true});}
