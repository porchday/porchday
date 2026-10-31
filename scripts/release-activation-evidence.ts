import {constants,closeSync,fstatSync,lstatSync,openSync,readFileSync,realpathSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {FileUploadLease,uploadPlanHash} from './release-upload-lease.ts';
import {comparableReleaseResources,uploadReconciliationEvidenceHash,validateUploadQueueRegistration} from './release-upload-reconcile.ts';
import {assertInactiveUploadSnapshot} from './cloudflare-release-reader.ts';
import {registeredQueueInventory} from './release-queue-producers.ts';
import {recoveryTarget,type DeploymentPlan} from './deployment-recovery.ts';
import type {UploadManifest} from './release-upload-cli.ts';

type Resource=UploadManifest['evidence']['resources'];
type WorkerState={active:string;latest:string;settings:unknown;resources:Resource};
type Inventory={workers:Record<string,WorkerState>;domains:unknown[];queues:unknown;schedules:unknown};
type UploadProof={version:1;planHash:string;candidate:{version:string;resources:Resource};inventory:Inventory;schema:unknown;ci:{source:string};provenance:{source:string;files:Record<string,string>};artifacts:{entry:string;hashes:Record<string,string>};preparation:{toolingCi:{source:string}}};
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function proofBytes(path:string){
 if(!isAbsolute(path)||realpathSync(path)!==path||lstatSync(path).isSymbolicLink())throw Error('ACTIVATION_PROOF_PATH_INVALID');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const s=fstatSync(fd);
  if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||s.size>16*1024*1024)throw Error('ACTIVATION_PROOF_PERMISSIONS');
  const bytes=readFileSync(fd);if(bytes.length!==s.size)throw Error('ACTIVATION_PROOF_CHANGED');return bytes;
 }finally{closeSync(fd);}
}

/** Historical upload evidence only. No activation, current-state authorization or lease acquisition. */
export function readCompletedUpload(manifest:UploadManifest,proofPath:string){
 const input=structuredClone(manifest),e=input.evidence,plan=input.plan;
 if(input.version!==1||!e?.preparation||plan.worker!==e.worker||plan.source!==e.source||plan.evidenceDigest!==uploadReconciliationEvidenceHash(e))throw Error('ACTIVATION_UPLOAD_EVIDENCE_CHANGED');
 validateUploadQueueRegistration(e);
 const completed=FileUploadLease.completed(input.root,plan);
 if(!completed)throw Error('ACTIVATION_UPLOAD_NOT_COMPLETED');
 const bytes=proofBytes(proofPath),digest=hash(bytes);
 if(digest!==completed.evidenceDigest)throw Error('ACTIVATION_UPLOAD_PROOF_CHANGED');
 let proof:UploadProof;try{proof=JSON.parse(bytes.toString());}catch{throw Error('ACTIVATION_UPLOAD_PROOF_INVALID');}
 if(proof?.version!==1||proof.planHash!==uploadPlanHash(plan)||proof.candidate?.version!==completed.version
  ||proof.ci?.source!==plan.source||proof.provenance?.source!==plan.source
  ||proof.preparation?.toolingCi?.source!==e.preparation.toolingSource
  ||proof.artifacts?.entry!==e.artifacts.entry||proof.artifacts.hashes?.[e.artifacts.entry]!==e.artifacts.hashes[e.artifacts.entry]
  ||!isDeepStrictEqual(proof.schema,e.schema)
  ||!proof.provenance.files||!isDeepStrictEqual(Object.keys(proof.provenance.files).sort(),[...e.artifacts.sourcePaths].sort()))throw Error('ACTIVATION_UPLOAD_PROOF_INVALID');
 const key=recoveryTarget(plan.worker).key as 'staging'|'production'|'staging-edge'|'production-edge'|'monitor-staging'|'monitor-production';
 assertInactiveUploadSnapshot(e.before,proof.inventory,key,completed.version,e.settings,e.queueProducerRegistration);
 const baseline=(e.before as Inventory).workers[key];
 if(!baseline?.resources||!proof.candidate.resources)throw Error('ACTIVATION_UPLOAD_PROOF_INVALID');
 if(!isDeepStrictEqual(comparableReleaseResources(proof.candidate.resources),comparableReleaseResources(e.resources)))throw Error('ACTIVATION_UPLOAD_RESOURCES_CHANGED');
 return{worker:plan.worker,source:plan.source,uploadPlanHash:uploadPlanHash(plan),proofSha256:digest,
  candidateVersion:completed.version,baselineVersion:baseline.active,
  baselineResources:structuredClone(baseline.resources),candidateResources:structuredClone(proof.candidate.resources),inventory:structuredClone(proof.inventory),
  ...(e.queueProducerRegistration?{queueProducerRegistration:structuredClone(e.queueProducerRegistration),queueProducerBaseline:structuredClone((e.before as Inventory).queues)}:{})};
}
export type CompletedUpload=ReturnType<typeof readCompletedUpload>;

/** Preserve every unrelated resource; only this Worker's active version/resources may change.
 * Latest-version settings remain pinned to the verified upload inventory, including on rollback.
 * This does not claim that an inactive candidate's settings became the restored runtime's settings.
 */
export function assertActivationInventory(upload:CompletedUpload,plan:DeploymentPlan,version:string,observed:unknown,routingCompleted?:number){
 const target=recoveryTarget(plan.worker);
 if(plan.worker!==upload.worker||plan.candidateSource!==upload.source||plan.candidateVersion!==upload.candidateVersion||plan.baselineVersion!==upload.baselineVersion
  ||![upload.candidateVersion,upload.baselineVersion].includes(version))throw Error('ACTIVATION_UPLOAD_PLAN_CHANGED');
 const expected=structuredClone(upload.inventory),worker=expected.workers[target.key];
 if(!worker)throw Error('ACTIVATION_UPLOAD_PROOF_INVALID');
 worker.active=version;worker.resources=structuredClone(version===upload.candidateVersion?upload.candidateResources:upload.baselineResources);
 if(upload.queueProducerRegistration)expected.queues=registeredQueueInventory({before:upload.queueProducerBaseline,observed:(observed as Inventory)?.queues,worker:target.key,beforeBindings:upload.baselineResources.bindings,afterBindings:upload.candidateResources.bindings,registration:upload.queueProducerRegistration,phase:version===upload.candidateVersion?'candidate':'baseline'});
 if(target.frontend&&expected.workers[target.environment]?.active!==plan.backendVersion)throw Error('ACTIVATION_BACKEND_CHANGED');
 if(plan.routing){
  const count=routingCompleted??(version===plan.candidateVersion?plan.routing.moves.length:0);
  if(!Number.isSafeInteger(count)||count<0||count>plan.routing.moves.length)throw Error('ACTIVATION_ROUTING_PROGRESS_INVALID');
  for(const [index,move] of plan.routing.moves.entries()){
   const rows=expected.domains.filter(d=>(d as Record<string,unknown>).hostname===move.before.hostname) as Record<string,unknown>[];
   if(rows.length!==1||rows[0].service!==move.before.service||rows[0].environment!==move.before.environment||rows[0].zone_id!==move.before.zoneId||rows[0].enabled!==true||rows[0].previews_enabled!==false)throw Error('ACTIVATION_ROUTING_BASELINE_CHANGED');
   if(index<count)rows[0].service=move.after.service;
  }
 }else if(routingCompleted!==undefined)throw Error('ACTIVATION_UNPLANNED_ROUTING');
 if(!isDeepStrictEqual(observed,expected))throw Error('ACTIVATION_INVENTORY_CHANGED');
}
