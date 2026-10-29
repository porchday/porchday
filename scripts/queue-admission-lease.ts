import {DatabaseSync} from 'node:sqlite';
import {constants,closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,realpathSync,renameSync,writeFileSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {deploymentTarget} from './deployment-recovery.ts';

type CreatedQueueKey=`${'staging'|'production'}-denial-${0|1|2}`;
export interface QueueAdmissionPlan{operationId:string;worker:string;source:string;canonicalSha256:string;expectedSnapshotSha256:string;targetCanonicalSha256:string;requestSha256:string;creation?:{key:CreatedQueueKey;baselineSnapshotSha256:string};consumerCreation?:{key:CreatedQueueKey;baselineSnapshotSha256:string}}
const protocol='porchday-queue-admission-v1',uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,digest=/^[a-f0-9]{64}$/;
export const queueAdmissionHash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
function ordered(value:unknown):unknown{if(Array.isArray(value))return value.map(ordered);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,ordered(item)]));return value;}
export const queueSnapshotHash=(value:unknown)=>queueAdmissionHash(JSON.stringify(ordered(value)));
function planHash(plan:QueueAdmissionPlan){deploymentTarget(plan.worker);if(Object.keys(plan).sort().join(',')!==(plan.creation?'canonicalSha256,creation,expectedSnapshotSha256,operationId,requestSha256,source,targetCanonicalSha256,worker':plan.consumerCreation?'canonicalSha256,consumerCreation,expectedSnapshotSha256,operationId,requestSha256,source,targetCanonicalSha256,worker':'canonicalSha256,expectedSnapshotSha256,operationId,requestSha256,source,targetCanonicalSha256,worker')||!uuid.test(plan.operationId)||!/^[a-f0-9]{40}$/.test(plan.source)||![plan.canonicalSha256,plan.expectedSnapshotSha256,plan.targetCanonicalSha256,plan.requestSha256].every(value=>digest.test(value)))throw Error('QUEUE_ADMISSION_PLAN_INVALID');
 if(plan.creation&&(Object.keys(plan.creation).sort().join(',')!=='baselineSnapshotSha256,key'||!digest.test(plan.creation.baselineSnapshotSha256)||!new RegExp('^'+plan.worker.replace(/^porchday-/,'')+'-denial-[012]$').test(plan.creation.key)||!/^porchday-(staging|production)$/.test(plan.worker)))throw Error('QUEUE_CREATION_PLAN_INVALID');
 if(plan.consumerCreation&&(Object.keys(plan.consumerCreation).sort().join(',')!=='baselineSnapshotSha256,key'||!digest.test(plan.consumerCreation.baselineSnapshotSha256)||!new RegExp('^'+plan.worker.replace(/^porchday-/, '')+'-denial-[012]$').test(plan.consumerCreation.key)||!/^porchday-(staging|production)$/.test(plan.worker)||plan.requestSha256!==queueAdmissionHash(JSON.stringify(queueConsumerCreationRequest(plan.consumerCreation.key)))))throw Error('QUEUE_CONSUMER_CREATION_PLAN_INVALID');return queueSnapshotHash(plan);}
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('QUEUE_CREATION_SNAPSHOT_INVALID');return value as Record<string,unknown>;}
/** The only variable after creation is its provider-assigned ID. No consumer,
 * producer or settings change is admitted by this creation protocol. */
export function queueCreationExpectedSnapshot(before:unknown,key:CreatedQueueKey){
 if(!/^(staging|production)-denial-[012]$/.test(key))throw Error('QUEUE_CREATION_PLAN_INVALID');
 const snapshot=object(before),queues=object(snapshot.queues),name='porchday-'+key;
 if(Object.hasOwn(queues,key)||Object.values(queues).some(q=>object(q).queue_name===name))throw Error('QUEUE_CREATION_ALREADY_EXISTS');
 return {...snapshot,queues:{...queues,[key]:{queue_id:'provider-assigned',queue_name:name,settings:{delivery_delay:0,delivery_paused:false,message_retention_period:345600},consumers:[],consumers_total_count:0,producers:[],producers_total_count:0}}};
}
/** Fixed consumer admission while delivery remains paused. */
export function queueConsumerCreationRequest(key:CreatedQueueKey){
 if(!/^(staging|production)-denial-[012]$/.test(key))throw Error('QUEUE_CONSUMER_CREATION_PLAN_INVALID');
 const environment=key.split('-')[0];
 return{type:'worker',script_name:'porchday-'+environment,dead_letter_queue:'porchday-'+environment+'-jobs-dead-letter',settings:{batch_size:1,max_concurrency:1,max_retries:8,max_wait_time_ms:5000,retry_delay:0}};
}
export function queueConsumerCreationExpectedSnapshot(before:unknown,key:CreatedQueueKey){
 const request=queueConsumerCreationRequest(key),snapshot=object(before),queues=object(snapshot.queues),queue=object(queues[key]),environment=key.split('-')[0],worker=object(object(snapshot.workers)[environment]);
 const empty={queue_id:queue.queue_id,queue_name:'porchday-'+key,settings:{delivery_delay:0,delivery_paused:true,message_retention_period:345600},consumers:[],consumers_total_count:0,producers:[{type:'worker',script:request.script_name}],producers_total_count:1};
 if(typeof queue.queue_id!=='string'||!/^[a-f0-9]{32}$/.test(queue.queue_id)||!isDeepStrictEqual(queue,empty))throw Error('QUEUE_CONSUMER_CREATION_BASELINE_INVALID');
 for(const state of [worker.resources,worker.settings]){
  const bindings=object(state).bindings;
  if(!Array.isArray(bindings)||bindings.filter(b=>object(b).name==='DENIAL_RANGE_'+key.at(-1)).length!==1||!bindings.some(b=>isDeepStrictEqual(b,{type:'queue',name:'DENIAL_RANGE_'+key.at(-1),queue_name:empty.queue_name}))||bindings.some(b=>object(b).name==='SESSION_DENIAL_QUEUE_TOPOLOGY_V1'&&object(b).text!=='shared'))throw Error('QUEUE_CONSUMER_CREATION_BINDINGS_INVALID');
  for(const [name,text] of [['SESSION_DENIAL_WRITER_V1','true'],['SESSION_DENIAL_CLEANUP_V1','true'],['SESSION_DENIAL_PARTITIONS_V1','active']])if(bindings.filter(b=>object(b).name===name).length!==1||!bindings.some(b=>isDeepStrictEqual(b,{type:'plain_text',name,text})))throw Error('QUEUE_CONSUMER_CREATION_BINDINGS_INVALID');
 }
 const consumer={consumer_id:'provider-assigned',type:request.type,script:request.script_name,dead_letter_queue:request.dead_letter_queue,settings:request.settings};
 return{...snapshot,queues:{...queues,[key]:{...queue,consumers:[consumer],consumers_total_count:1}}};
}
function directory(path:string){const s=lstatSync(path);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)throw Error('QUEUE_ADMISSION_PERMISSIONS');}
function text(path:string,limit=32*1024*1024){const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||s.size>limit)throw Error('QUEUE_ADMISSION_PERMISSIONS');return readFileSync(path,'utf8');}
function sync(path:string){const fd=openSync(path,constants.O_RDONLY);try{fsyncSync(fd);}finally{closeSync(fd);}}
function exclusive(path:string,bytes:string,parent:string){const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}sync(parent);}
export function queueSnapshotPath(root:string,id:string){if(!isAbsolute(root)||!uuid.test(id))throw Error('QUEUE_ADMISSION_PATH_INVALID');return join(root,'queue-admission-proof-'+id,'provider-after.json');}
/** Queue settings mutate provider inventory without activating a Worker version.
 * Use the SAME kernel/database and directory lock as upload/activation, with a
 * distinct protocol. A durable dispatch intent forbids every subsequent send.
 * The finalization receipt precedes atomic canonical replacement, so crashes
 * resume exact bytes instead of inventing or replaying a provider operation. */
export class QueueAdmissionLease{
 private held=true;private inFlight=false;private readonly owner:string;
 private root:string;private db:DatabaseSync;private plan:QueueAdmissionPlan;
 private constructor(root:string,db:DatabaseSync,plan:QueueAdmissionPlan){this.root=root;this.db=db;this.plan=Object.freeze({...plan,...(plan.creation?{creation:Object.freeze({...plan.creation})}:{}),...(plan.consumerCreation?{consumerCreation:Object.freeze({...plan.consumerCreation})}:{})});this.owner=JSON.stringify({v:1,protocol:plan.creation?'porchday-queue-creation-v1':plan.consumerCreation?'porchday-queue-consumer-creation-v1':protocol,operationId:plan.operationId,planHash:planHash(plan),source:plan.source})+'\n';}
 private path(name:string){return join(this.root,'deployment-lock',name);}
 private record(name:string){if(!existsSync(this.path(name)))return null;const value=JSON.parse(text(this.path(name)));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('QUEUE_ADMISSION_RECORD_INVALID');return value;}
 static acquire(root:string,plan:QueueAdmissionPlan){
  if(!isAbsolute(root)||realpathSync(root)!==root)throw Error('QUEUE_ADMISSION_PATH_INVALID');directory(root);planHash(plan);
  for(const state of ['completed','cancelled'])if(existsSync(join(root,'queue-admission-'+state+'-'+plan.operationId)))throw Error('QUEUE_ADMISSION_ALREADY_TERMINAL');
  const file=join(root,'deployment-recovery.lock.sqlite');if(!existsSync(file))try{exclusive(file,'',root);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  text(file,Number.MAX_SAFE_INTEGER);const db=new DatabaseSync(file);
  try{db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');}catch{db.close();throw Error('QUEUE_ADMISSION_LEASE_BUSY');}
  const lease=new QueueAdmissionLease(root,db,plan);try{
   const lock=join(root,'deployment-lock');if(!existsSync(lock)){if(queueAdmissionHash(text(join(root,'latest-verified-deployment.json')))!==plan.canonicalSha256)throw Error('QUEUE_ADMISSION_CANONICAL_CHANGED');if(plan.creation||plan.consumerCreation)lease.creationBaseline();mkdirSync(lock,{mode:0o700});sync(root);exclusive(lease.path('owner.json'),lease.owner,lock);}
   lease.assert();lease.validateRecords();return lease;
  }catch(error){db.exec('ROLLBACK');db.close();throw error;}
 }
 assert(signal?:AbortSignal){
  signal?.throwIfAborted();if(!this.held)throw Error('QUEUE_ADMISSION_LEASE_NOT_HELD');directory(this.root);directory(join(this.root,'deployment-lock'));
  if(text(this.path('owner.json'),4096)!==this.owner)throw Error('QUEUE_ADMISSION_OWNER_CHANGED');
  const current=queueAdmissionHash(text(join(this.root,'latest-verified-deployment.json'))),receipt=this.record('queue-finalization.json');
  if(current!==this.plan.canonicalSha256&&!(receipt&&current===this.plan.targetCanonicalSha256))throw Error('QUEUE_ADMISSION_CANONICAL_CHANGED');
 }
 private validateRecords(){
  const hash=planHash(this.plan),intent=this.record('queue-intent.json'),verified=this.record('queue-verified.json'),receipt=this.record('queue-finalization.json');
  if(intent&&(Object.keys(intent).sort().join(',')!=='at,planHash,v'||intent.v!==1||intent.planHash!==hash||!Number.isFinite(Date.parse(intent.at))))throw Error('QUEUE_ADMISSION_INTENT_INVALID');
  if(verified)directory(join(this.root,'queue-admission-proof-'+this.plan.operationId));
  if(verified){const snapshot=JSON.parse(text(queueSnapshotPath(this.root,this.plan.operationId)));
   if(!intent||Object.keys(verified).sort().join(',')!=='evidenceDigest,planHash,snapshotSha256,v'||verified.v!==1||verified.planHash!==hash||!digest.test(verified.evidenceDigest)||queueSnapshotHash(snapshot)!==verified.snapshotSha256)throw Error('QUEUE_ADMISSION_VERIFICATION_INVALID');
   this.validateSnapshot(snapshot);
  }
  if(receipt&&(!verified||Object.keys(receipt).sort().join(',')!=='beforeCanonical,canonical,planHash,v'||receipt.v!==1||receipt.planHash!==hash||typeof receipt.canonical!=='string'||queueAdmissionHash(receipt.canonical)!==this.plan.targetCanonicalSha256||typeof receipt.beforeCanonical!=='string'||queueAdmissionHash(receipt.beforeCanonical)!==this.plan.canonicalSha256||!isDeepStrictEqual(JSON.parse(receipt.canonical),{...JSON.parse(receipt.beforeCanonical),latestProviderSnapshot:queueSnapshotPath(this.root,this.plan.operationId)})))throw Error('QUEUE_ADMISSION_FINALIZATION_INVALID');
 }
 private creationBaseline(){
  const creation=(this.plan.creation??this.plan.consumerCreation)!;
  const receipt=this.record('queue-finalization.json'),canonical=receipt?.beforeCanonical??text(join(this.root,'latest-verified-deployment.json'));
  if(queueAdmissionHash(canonical)!==this.plan.canonicalSha256)throw Error('QUEUE_CREATION_BASELINE_CHANGED');
  const path=JSON.parse(canonical).latestProviderSnapshot;
  if(typeof path!=='string'||!path.startsWith(this.root+'/')||realpathSync(path)!==path)throw Error('QUEUE_CREATION_BASELINE_PATH_INVALID');
  const before=JSON.parse(text(path));
  if(queueSnapshotHash(before)!==creation.baselineSnapshotSha256)throw Error('QUEUE_CREATION_BASELINE_CHANGED');
  const expected=this.plan.consumerCreation?queueConsumerCreationExpectedSnapshot(before,creation.key):queueCreationExpectedSnapshot(before,creation.key);
  if(queueSnapshotHash(expected)!==this.plan.expectedSnapshotSha256)throw Error('QUEUE_CREATION_PLAN_INVALID');
  return {before,expected};
 }
 private validateSnapshot(value:unknown){
  if(this.plan.consumerCreation){
   const {expected}=this.creationBaseline(),key=this.plan.consumerCreation.key,snapshot=object(value),queues=object(snapshot.queues),queue=object(queues[key]),consumers=queue.consumers;
   if(!Array.isArray(consumers)||consumers.length!==1||typeof object(consumers[0]).consumer_id!=='string'||!/^[a-f0-9]{32}$/.test(object(consumers[0]).consumer_id as string))throw Error('QUEUE_CONSUMER_CREATION_ID_INVALID');
   const normalized={...snapshot,queues:{...queues,[key]:{...queue,consumers:[{...object(consumers[0]),consumer_id:'provider-assigned'}]}}};
   if(!isDeepStrictEqual(normalized,expected))throw Error('QUEUE_ADMISSION_PROVIDER_CHANGED');return;
  }
  if(!this.plan.creation){if(queueSnapshotHash(value)!==this.plan.expectedSnapshotSha256)throw Error('QUEUE_ADMISSION_PROVIDER_CHANGED');return;}
  const {before,expected}=this.creationBaseline(),creation=this.plan.creation,snapshot=object(value),queues=object(snapshot.queues),created=object(queues[creation.key]),id=created.queue_id;
  if(typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id)||Object.values(object(before.queues)).some(q=>object(q).queue_id===id))throw Error('QUEUE_CREATION_ID_INVALID');
  // The create API can omit an unset optional pause field. This is acceptable
  // only for the otherwise exact, unattached creation shape. Keep the omission
  // in the real proof/canonical snapshot; do not invent observed settings.
  // Explicit pause is a separate settings operation before consumer attachment.
  const settings=object(created.settings),comparisonSettings=Object.hasOwn(settings,'delivery_paused')?settings:{...settings,delivery_paused:false};
  const normalized={...snapshot,queues:{...queues,[creation.key]:{...created,settings:comparisonSettings,queue_id:'provider-assigned'}}};
  if(!isDeepStrictEqual(normalized,expected))throw Error('QUEUE_ADMISSION_PROVIDER_CHANGED');
 }
 async dispatchOnce(authorize:()=>Promise<void>,send:()=>Promise<void>,signal:AbortSignal):Promise<'dispatched'|'reconcile'>{
  this.assert(signal);this.validateRecords();if(this.inFlight)throw Error('QUEUE_ADMISSION_IN_PROGRESS');if(this.record('queue-intent.json'))return 'reconcile';this.inFlight=true;
  try{if(this.plan.creation||this.plan.consumerCreation)this.creationBaseline();await authorize();this.assert(signal);if(this.plan.creation||this.plan.consumerCreation)this.creationBaseline();exclusive(this.path('queue-intent.json'),JSON.stringify({v:1,planHash:planHash(this.plan),at:new Date().toISOString()})+'\n',join(this.root,'deployment-lock'));this.assert(signal);
   try{await send();this.assert(signal);return 'dispatched';}catch{return 'reconcile';}
  }finally{this.inFlight=false;}
 }
 async reconcile(observe:()=>Promise<{snapshot:unknown;evidenceDigest:string}>,signal:AbortSignal){
  this.assert(signal);this.validateRecords();if(this.inFlight)throw Error('QUEUE_ADMISSION_IN_PROGRESS');if(!this.record('queue-intent.json'))throw Error('QUEUE_ADMISSION_INTENT_REQUIRED');this.inFlight=true;
  try{const result=await observe();this.assert(signal);this.validateSnapshot(result.snapshot);if(!digest.test(result.evidenceDigest))throw Error('QUEUE_ADMISSION_PROVIDER_CHANGED');const snapshotSha256=queueSnapshotHash(result.snapshot);
   const proof=queueSnapshotPath(this.root,this.plan.operationId),parent=join(this.root,'queue-admission-proof-'+this.plan.operationId);if(!existsSync(parent)){mkdirSync(parent,{mode:0o700});sync(this.root);}directory(parent);
   if(existsSync(proof)){if(queueSnapshotHash(JSON.parse(text(proof)))!==snapshotSha256)throw Error('QUEUE_ADMISSION_PROOF_CHANGED');}else exclusive(proof,JSON.stringify(result.snapshot,null,2)+'\n',parent);
   if(!this.record('queue-verified.json'))exclusive(this.path('queue-verified.json'),JSON.stringify({v:1,planHash:planHash(this.plan),snapshotSha256,evidenceDigest:result.evidenceDigest})+'\n',join(this.root,'deployment-lock'));this.validateRecords();
  }finally{this.inFlight=false;}
 }
 async finalize(canonical:string,observe:()=>Promise<unknown>,signal:AbortSignal){
  this.assert(signal);this.validateRecords();if(this.inFlight)throw Error('QUEUE_ADMISSION_IN_PROGRESS');if(!this.record('queue-verified.json'))throw Error('QUEUE_ADMISSION_VERIFICATION_REQUIRED');
  if(queueAdmissionHash(canonical)!==this.plan.targetCanonicalSha256)throw Error('QUEUE_ADMISSION_TARGET_CHANGED');
  const path=join(this.root,'latest-verified-deployment.json'),current=text(path),target=JSON.parse(canonical);
  if(queueAdmissionHash(current)===this.plan.canonicalSha256&&!isDeepStrictEqual(target,{...JSON.parse(current),latestProviderSnapshot:queueSnapshotPath(this.root,this.plan.operationId)}))throw Error('QUEUE_ADMISSION_UNRELATED_CANONICAL_CHANGE');
  this.inFlight=true;try{
   if(queueSnapshotHash(await observe())!==this.record('queue-verified.json').snapshotSha256)throw Error('QUEUE_ADMISSION_PROVIDER_CHANGED');this.assert(signal);
   const receipt=this.record('queue-finalization.json');if(receipt&&receipt.canonical!==canonical)throw Error('QUEUE_ADMISSION_FINALIZATION_CHANGED');
   if(!receipt)exclusive(this.path('queue-finalization.json'),JSON.stringify({v:1,planHash:planHash(this.plan),beforeCanonical:current,canonical})+'\n',join(this.root,'deployment-lock'));
   if(queueAdmissionHash(text(path))!==this.plan.targetCanonicalSha256){const temporary=join(this.root,'.queue-canonical-'+randomUUID());exclusive(temporary,canonical,this.root);this.assert(signal);renameSync(temporary,path);sync(this.root);}
   this.assert(signal);this.validateRecords();
  }finally{this.inFlight=false;}
 }
 cancelBeforeDispatch(){this.assert();this.validateRecords();if(this.inFlight||this.record('queue-intent.json'))throw Error('QUEUE_ADMISSION_CANCELLATION_UNSAFE');this.archive('cancelled',['owner.json']);}
 release(){this.assert();this.validateRecords();if(this.inFlight||!this.record('queue-finalization.json')||queueAdmissionHash(text(join(this.root,'latest-verified-deployment.json')))!==this.plan.targetCanonicalSha256)throw Error('QUEUE_ADMISSION_FINALIZATION_REQUIRED');this.archive('completed',['owner.json','queue-intent.json','queue-verified.json','queue-finalization.json']);}
 private archive(state:string,files:string[]){const lock=join(this.root,'deployment-lock'),archive=join(this.root,'queue-admission-'+state+'-'+this.plan.operationId);if(readdirSync(lock).sort().join(',')!==files.sort().join(',')||existsSync(archive))throw Error('QUEUE_ADMISSION_DIRECTORY_CHANGED');renameSync(lock,archive);sync(this.root);this.close();}
 close(){if(this.inFlight)throw Error('QUEUE_ADMISSION_IN_PROGRESS');if(this.held){this.held=false;try{this.db.exec('ROLLBACK');}finally{this.db.close();}}}
}
