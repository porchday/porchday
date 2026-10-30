import {constants,closeSync,fsyncSync,lstatSync,openSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {verifyUploadPreparation,assertPreparationBundle,type UploadPreparation} from './release-upload-preparation.ts';
import {uploadTarget} from './release-upload-target.ts';
import {FileUploadLease,uploadPlanHash,type UploadPlan} from './release-upload-lease.ts';
import {CloudflareReleaseReader,assertInactiveUploadSnapshot} from './cloudflare-release-reader.ts';
import {assertReleaseSchema,captureReleaseSchema,type ReleaseSchemaFingerprint} from './release-schema.ts';
import {verifyReleaseCi,type ReleaseCiPin} from './release-ci.ts';
import {verifyWorkerArtifacts,verifyWorkerSourceProvenance} from './release-worker-artifacts.ts';
import {registeredQueueInventory,type QueueProducerRegistration} from './release-queue-producers.ts';

export type UploadReconciliationEvidence={
 queueProducerRegistration?:QueueProducerRegistration;
 preparation?:UploadPreparation;
 version:1;worker:string;source:string;before:unknown;settings:unknown;
 resources:{script:Record<string,unknown>;script_runtime:Record<string,unknown>;bindings:unknown[]};
 databaseBranchId:string;schema:ReleaseSchemaFingerprint;ci:Record<'verify'|'history',ReleaseCiPin>;
 artifacts:{directory:string;entry:'index.js'|'edge.js';hashes:Record<string,string>;sourcePaths:string[];allowObservedMapNormalization?:boolean;allowObservedPathNormalization?:boolean};
};
function canonical(value:unknown):string{
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';
 throw Error('UPLOAD_EVIDENCE_INVALID');
}
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export function uploadReconciliationEvidenceHash(value:UploadReconciliationEvidence):string{return hash(canonical(value));}
/** Validate optional registration before dispatch as well as on recovery. */
export function validateUploadQueueRegistration(evidence:UploadReconciliationEvidence){
 if(!evidence.queueProducerRegistration)return;
 const key=uploadTarget(evidence.worker).key,before=evidence.before as {queues:unknown;workers:Record<string,{settings:{bindings:unknown};resources:{bindings:unknown}}>},settings=evidence.settings as {bindings:unknown};
 const sorted=(value:unknown)=>{if(!Array.isArray(value))throw Error('QUEUE_PRODUCER_REGISTRATION_INVALID');return [...value].sort((a,b)=>canonical(a).localeCompare(canonical(b)));};
 if(!isDeepStrictEqual(sorted(before.workers[key].settings.bindings),sorted(before.workers[key].resources.bindings))||!isDeepStrictEqual(sorted(settings.bindings),sorted(evidence.resources.bindings)))throw Error('QUEUE_PRODUCER_REGISTRATION_INVALID');
 registeredQueueInventory({before:before.queues,observed:before.queues,worker:key,beforeBindings:before.workers[key].resources.bindings,afterBindings:evidence.resources.bindings,registration:evidence.queueProducerRegistration,phase:'upload'});
}
function privateDirectory(path:string){const s=lstatSync(path);if(!isAbsolute(path)||!s.isDirectory()||s.isSymbolicLink()||realpathSync(path)!==path||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)throw Error('UPLOAD_EVIDENCE_PERMISSIONS');}
function privateBytes(path:string):Buffer{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||s.size>16*1024*1024)throw Error('UPLOAD_EVIDENCE_PERMISSIONS');const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{return readFileSync(fd);}finally{closeSync(fd);}}
export function comparableReleaseResources(value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('UPLOAD_RESOURCES_INVALID');
 const input=value as UploadReconciliationEvidence['resources'];
 if(Object.keys(input).sort().join(',')!=='bindings,script,script_runtime'||!input.script||typeof input.script!=='object'||!input.script_runtime||typeof input.script_runtime!=='object'||!Array.isArray(input.bindings))throw Error('UPLOAD_RESOURCES_INVALID');
 const {etag,...script}=input.script;if(typeof etag!=='string'||!etag)throw Error('UPLOAD_RESOURCES_INVALID');
 return{script,script_runtime:input.script_runtime,bindings:[...input.bindings].sort((a,b)=>canonical(a)<canonical(b)?-1:canonical(a)>canonical(b)?1:0)};
}
function persist(directory:string,name:string,body:string){
 privateDirectory(directory);const path=join(directory,name);let fd:number;
 try{fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
 catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(privateBytes(path).toString()!==body)throw Error('UPLOAD_PROOF_CHANGED');return;}
 try{writeFileSync(fd,body);fsyncSync(fd);}finally{closeSync(fd);}
 const parent=openSync(directory,constants.O_RDONLY);try{fsyncSync(parent);}finally{closeSync(parent);}
}
/** Concrete read-only reconciliation; call through lease.reconcile to record its durable result. */
export function createUploadReconciler(options:{workspace:string;proofDirectory:string;evidence:UploadReconciliationEvidence;lease:FileUploadLease;reader:Pick<CloudflareReleaseReader,'snapshot'|'uploadedVersion'|'script'>;database:{connection:string;branchId:string};checks?:{ci:typeof verifyReleaseCi;schema:typeof captureReleaseSchema}}){
 const evidence=structuredClone(options.evidence),digest=uploadReconciliationEvidenceHash(evidence),checks=options.checks??{ci:verifyReleaseCi,schema:captureReleaseSchema},database={...options.database};
 validateUploadQueueRegistration(evidence);
 const {workspace,proofDirectory,lease,reader}=options,target=uploadTarget(evidence.worker),key=target.key;
 if(evidence.version!==1||!isAbsolute(workspace)||!isAbsolute(proofDirectory)||!/^[a-z0-9]+$/.test(evidence.databaseBranchId)||database.branchId!==evidence.databaseBranchId||evidence.artifacts.entry!==(target.frontend?'edge.js':'index.js'))throw Error('UPLOAD_EVIDENCE_INVALID');
 return async(plan:Readonly<UploadPlan>,signal:AbortSignal)=>{
  const assert=()=>lease.assertPlan(plan,signal);assert();
  if(plan.evidenceDigest!==digest||plan.worker!==evidence.worker||plan.source!==evidence.source)throw Error('UPLOAD_EVIDENCE_PLAN_CHANGED');
  const preparation=evidence.preparation?await verifyUploadPreparation(workspace,evidence.preparation,signal):null;assert();
  if(evidence.preparation)assertPreparationBundle(evidence.preparation,evidence.artifacts);
  const ci=await checks.ci({workspace,source:plan.source,pins:evidence.ci,signal});assert();
  const schema=async()=>{const observed=await checks.schema({...database,expectedMigrations:evidence.schema.migrations,signal});assertReleaseSchema(observed,evidence.schema);assert();return observed;};
  await schema();const candidate=await reader.uploadedVersion(key,plan.operationId,signal);assert();
  if(!isDeepStrictEqual(comparableReleaseResources(candidate.resources),comparableReleaseResources(evidence.resources)))throw Error('UPLOAD_CANDIDATE_RESOURCES_CHANGED');
  const before=await reader.snapshot(signal);assert();assertInactiveUploadSnapshot(evidence.before,before,key,candidate.version,evidence.settings,evidence.queueProducerRegistration);
  const actual=await reader.script(key,signal);assert();
  const identity=await reader.uploadedVersion(key,plan.operationId,signal);assert();
  const after=await reader.snapshot(signal);assert();assertInactiveUploadSnapshot(evidence.before,after,key,candidate.version,evidence.settings,evidence.queueProducerRegistration);
  if(!isDeepStrictEqual(candidate,identity)||!isDeepStrictEqual(before,after))throw Error('UPLOAD_CHANGED_DURING_ARTIFACT_READ');
  privateDirectory(evidence.artifacts.directory);
  const expected=Object.fromEntries([evidence.artifacts.entry,evidence.artifacts.entry+'.map'].map(name=>[name,privateBytes(join(evidence.artifacts.directory,name))]));
  const artifacts=verifyWorkerArtifacts({...evidence.artifacts,expected,actual});
  const provenance=await verifyWorkerSourceProvenance({workspace,source:plan.source,application:target.application,map:actual[evidence.artifacts.entry+'.map'],expectedPaths:evidence.artifacts.sourcePaths,signal});assert();
  const finalSchema=await schema();
  const proof=canonical({version:1,planHash:uploadPlanHash(plan),candidate,inventory:after,artifacts,provenance,schema:finalSchema,ci,...(preparation?{preparation}:{})})+'\n';
  if(Buffer.byteLength(proof)>16*1024*1024)throw Error('UPLOAD_PROOF_TOO_LARGE');
  assert();persist(proofDirectory,'upload-proof-'+plan.operationId+'.json',proof);assert();
  return{version:candidate.version,evidenceDigest:hash(proof)};
 };
}
