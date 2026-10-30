/** Provider-neutral rollout control. No network, credentials, or writes on import. */
import {createHash} from 'node:crypto';
export type ReaderFloorPromotion=Readonly<{protocol:'privacy-commit-v1';previousVersion:string}>;
export type DeploymentPlan={readerFloorPromotion?:ReaderFloorPromotion;operationId:string;worker:string;candidateVersion:string;candidateSource:string;baselineVersion:string;baselineDeploymentId:string;compatibleRollbackVersions:readonly string[];evidenceDigest:string;backendVersion?:string;backendReaderFloor?:string;assetManifests?:Readonly<{candidate:string;baseline:string}>};
export type DeploymentObservation={version:string;deploymentId:string;operationId:string|null};
export type Phase='prepared'|'activation-intent'|'candidate-observed'|'rollback-intent'|'complete'|'rolled-back';
export type RecoveryState={v:1;revision:number;planHash:string;phase:Phase;candidateDeploymentId?:string;rollbackDeploymentId?:string};
export interface RecoveryJournal{
 read():Promise<RecoveryState|null>;
 /** Atomic compare-and-set; success means the record is durable before returning. */
 write(expected:RecoveryState|null,next:RecoveryState):Promise<void>;
}
export interface DeploymentPorts{
 /** Must check exclusive lease, source/schema/resource evidence and current reader floor. */
 authorize(plan:DeploymentPlan,direction:'activate'|'rollback',signal:AbortSignal):Promise<void>;
 /** GET only. Honor the signal; classify retryable read failures explicitly. */
 observe(signal:AbortSignal):Promise<DeploymentObservation>;
 /** Exactly one POST per durable intent. Include operationId in provider metadata. */
 deploy(version:string,operationId:string,signal:AbortSignal):Promise<void>;
 /** Required user journeys and artifact checks, not merely /health. Never replay an ambiguous user write. */
 verify(version:string,signal:AbortSignal):Promise<'healthy'|'unhealthy'|'unknown'>;
}
export class RetryableObservationError extends Error{constructor(){super('DEPLOYMENT_OBSERVATION_RETRYABLE');}}
export class RecoveryError extends Error{constructor(code:string){super(code);}}
export type RecoveryResult='complete'|'rolled-back'|'activation-unconfirmed'|'rollback-unconfirmed'|'verification-unavailable'|'observation-unavailable'|'concurrent-change';
const id=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function deploymentTarget(worker:string){
 const match=/^porchday-(staging|production)(-edge)?$/.exec(worker);if(!match)throw new RecoveryError('DEPLOYMENT_TARGET_INVALID');
 return{environment:match[1] as 'staging'|'production',frontend:!!match[2],key:match[1]+(match[2]??'')};
}
/** Low-level recovery includes monitors; application entry points continue to
 * call deploymentTarget and cannot activate a monitor with API-only evidence. */
export function recoveryTarget(worker:string){
 const match=/^porchday-monitor-(staging|production)$/.exec(worker);
 if(match)return {environment:match[1] as 'staging'|'production',frontend:false,monitor:true,key:'monitor-'+match[1]};
 return {...deploymentTarget(worker),monitor:false};
}
export function deploymentPlanHash(plan:DeploymentPlan):string{
 const target=recoveryTarget(plan.worker);
 if(plan.readerFloorPromotion!==undefined){const floor=plan.readerFloorPromotion;if(target.frontend||target.monitor||!floor||Object.keys(floor).sort().join(',')!=='previousVersion,protocol'||floor.protocol!=='privacy-commit-v1'||!id.test(floor.previousVersion)||floor.previousVersion===plan.candidateVersion||!Array.isArray(plan.compatibleRollbackVersions)||!plan.compatibleRollbackVersions.includes(floor.previousVersion))throw new RecoveryError('DEPLOYMENT_READER_FLOOR_PROMOTION_INVALID');}
 if(target.monitor&&plan.assetManifests!==undefined)throw new RecoveryError('DEPLOYMENT_MONITOR_ASSETS_FORBIDDEN');
 if(plan.assetManifests!==undefined&&(!plan.assetManifests||Object.keys(plan.assetManifests).sort().join(',')!=='baseline,candidate'||![plan.assetManifests.candidate,plan.assetManifests.baseline].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value))))throw new RecoveryError('DEPLOYMENT_ASSET_PLAN_INVALID');
 if(!id.test(plan.operationId)||![plan.candidateVersion,plan.baselineVersion,plan.baselineDeploymentId].every(x=>id.test(x))||plan.candidateVersion===plan.baselineVersion||! /^[a-f0-9]{40}$/.test(plan.candidateSource)||! /^[a-f0-9]{64}$/.test(plan.evidenceDigest)||!Array.isArray(plan.compatibleRollbackVersions)||!plan.compatibleRollbackVersions.every(x=>id.test(x))||!plan.compatibleRollbackVersions.includes(plan.baselineVersion)
  ||(target.frontend?typeof plan.backendVersion!=='string'||!id.test(plan.backendVersion)||typeof plan.backendReaderFloor!=='string'||!id.test(plan.backendReaderFloor):plan.backendVersion!==undefined||plan.backendReaderFloor!==undefined))throw new RecoveryError('DEPLOYMENT_PLAN_OR_ROLLBACK_FLOOR_INVALID');
 return createHash('sha256').update(JSON.stringify({operationId:plan.operationId,worker:plan.worker,candidateVersion:plan.candidateVersion,candidateSource:plan.candidateSource,baselineVersion:plan.baselineVersion,baselineDeploymentId:plan.baselineDeploymentId,compatibleRollbackVersions:[...new Set(plan.compatibleRollbackVersions)].sort(),evidenceDigest:plan.evidenceDigest,...(plan.readerFloorPromotion?{readerFloorPromotion:{protocol:plan.readerFloorPromotion.protocol,previousVersion:plan.readerFloorPromotion.previousVersion}}:{}),...(target.frontend?{backendVersion:plan.backendVersion,backendReaderFloor:plan.backendReaderFloor}:{}),...(plan.assetManifests?{assetManifests:{candidate:plan.assetManifests.candidate,baseline:plan.assetManifests.baseline}}:{})})).digest('hex');
}
export const phaseTransitions:Record<Phase,readonly Phase[]>={prepared:['activation-intent'],'activation-intent':['candidate-observed'],'candidate-observed':['complete','rollback-intent'],'rollback-intent':['rolled-back'],complete:[],'rolled-back':[]};
export function validateRecoveryState(value:unknown):asserts value is RecoveryState{
 const x=value as RecoveryState;
 if(!x||x.v!==1||!Number.isSafeInteger(x.revision)||x.revision<1||! /^[a-f0-9]{64}$/.test(x.planHash)||!Object.hasOwn(phaseTransitions,x.phase)||Object.keys(x).some(k=>!['v','revision','planHash','phase','candidateDeploymentId','rollbackDeploymentId'].includes(k))||x.candidateDeploymentId!==undefined&&!id.test(x.candidateDeploymentId)||x.rollbackDeploymentId!==undefined&&!id.test(x.rollbackDeploymentId))throw new RecoveryError('DEPLOYMENT_JOURNAL_INVALID');
 const candidateRequired=['candidate-observed','rollback-intent','complete','rolled-back'].includes(x.phase);
 if(candidateRequired!==!!x.candidateDeploymentId||(x.phase==='rolled-back')!==!!x.rollbackDeploymentId)throw new RecoveryError('DEPLOYMENT_JOURNAL_INVALID');
}
export function validateRecoveryTransition(previous:RecoveryState|null,next:RecoveryState):void{
 validateRecoveryState(next);
 if(previous)validateRecoveryState(previous);
 if(next.revision!==(previous?.revision??0)+1||previous&&(next.planHash!==previous.planHash||!phaseTransitions[previous.phase].includes(next.phase))||!previous&&next.phase!=='prepared'||previous?.candidateDeploymentId&&next.candidateDeploymentId!==previous.candidateDeploymentId)throw new RecoveryError('DEPLOYMENT_JOURNAL_TRANSITION_INVALID');
}
async function bounded<T>(milliseconds:number,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([Promise.resolve().then(()=>work(controller.signal)),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new RetryableObservationError());},milliseconds);})]);}
 finally{if(timer!==undefined)clearTimeout(timer);}
}
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
/** Retry only safe observations, including post-write propagation. Never retry a deployment POST. */
export async function observeDeployment(ports:Pick<DeploymentPorts,'observe'>,accept:(value:DeploymentObservation)=>boolean=()=>true,sleep:(ms:number)=>Promise<void>=pause):Promise<DeploymentObservation>{
 let last:DeploymentObservation|undefined;
 for(let attempt=0;attempt<3;attempt++){
  try{
   const value=await bounded(5000,signal=>ports.observe(signal));
   if(!value||!id.test(value.version)||!id.test(value.deploymentId)||value.operationId!==null&&!id.test(value.operationId))throw new RecoveryError('DEPLOYMENT_OBSERVATION_INVALID');
   last=value;if(accept(value)||attempt===2)return value;
  }catch(error){if(!(error instanceof RetryableObservationError)||attempt===2)throw error;}
  await sleep(attempt===0?250:750);
 }
 if(last)return last;throw new RecoveryError('DEPLOYMENT_OBSERVATION_UNAVAILABLE');
}

/** Deterministic provider annotation, not an authorization token. */
export function rollbackOperationId(operationId:string):string{
 if(!id.test(operationId))throw new RecoveryError('DEPLOYMENT_OPERATION_INVALID');
 const value=createHash('sha256').update(operationId+':rollback').digest('hex');
 return value.slice(0,8)+'-'+value.slice(8,12)+'-'+value.slice(12,16)+'-'+value.slice(16,20)+'-'+value.slice(20,32);
}

/** Resume with the same plan/journal after interruption. An existing intent is never sent again. */
export async function recoverDeployment(plan:DeploymentPlan,journal:RecoveryJournal,ports:DeploymentPorts,options:{sleep?:(ms:number)=>Promise<void>;monitorRecoveryObservation?:boolean;promotionAllowed?:()=>boolean}={}):Promise<RecoveryResult>{
 if(options.monitorRecoveryObservation!==undefined&&(options.monitorRecoveryObservation!==true||!recoveryTarget(plan.worker).monitor))throw new RecoveryError('DEPLOYMENT_MONITOR_RECOVERY_SCOPE_INVALID');
 const monitorRecoveryObservation=options.monitorRecoveryObservation===true;
 const promotionAllowed=options.promotionAllowed??(()=>true);
 const assertPromotion=()=>{if(!promotionAllowed())throw new RecoveryError('DEPLOYMENT_CONTINUITY_FAILED');};
 const hash=deploymentPlanHash(plan);plan=Object.freeze({...plan,...(plan.readerFloorPromotion?{readerFloorPromotion:Object.freeze({...plan.readerFloorPromotion})}:{}),...(plan.assetManifests?{assetManifests:Object.freeze({...plan.assetManifests})}:{}),compatibleRollbackVersions:Object.freeze([...plan.compatibleRollbackVersions])});
 const rollbackId=rollbackOperationId(plan.operationId);
 let state=await journal.read();if(state){validateRecoveryState(state);if(state.planHash!==hash)throw new RecoveryError('DEPLOYMENT_PLAN_CHANGED');}
 const advance=async(phase:Phase,fields:Partial<RecoveryState>={})=>{const next:RecoveryState={...state,...fields,v:1,revision:(state?.revision??0)+1,planHash:hash,phase};validateRecoveryTransition(state,next);await journal.write(state,next);state=next;};
 const observe=async(accept?:(value:DeploymentObservation)=>boolean)=>{try{return await observeDeployment(ports,accept,options.sleep);}catch{return null;}};
 const candidate=(x:DeploymentObservation)=>x.version===plan.candidateVersion&&x.operationId===plan.operationId;
 const original=(x:DeploymentObservation)=>x.version===plan.baselineVersion&&x.deploymentId===plan.baselineDeploymentId;
 const restored=(x:DeploymentObservation)=>x.version===plan.baselineVersion&&x.operationId===rollbackId;
 if(!state)await advance('prepared');
 if(state!.phase==='prepared'){
  assertPromotion();
  await bounded(10000,signal=>ports.authorize(plan,'activate',signal));const before=await observe();if(!before)return 'observation-unavailable';if(!original(before))return 'concurrent-change';
  assertPromotion();
  await advance('activation-intent');
  try{await bounded(10000,signal=>{assertPromotion();return ports.deploy(plan.candidateVersion,plan.operationId,signal);});}catch{/* Outcome may be committed; only observation can reconcile it. */}
 }
 if(state!.phase==='activation-intent'){
  const observed=await observe(x=>!original(x));if(!observed)return 'observation-unavailable';
  if(original(observed))return 'activation-unconfirmed';if(!candidate(observed))return 'concurrent-change';
  await advance('candidate-observed',{candidateDeploymentId:observed.deploymentId});
 }
 if(state!.phase==='candidate-observed'){
  const observed=await observe();if(!observed)return 'observation-unavailable';if(!candidate(observed)||observed.deploymentId!==state!.candidateDeploymentId)return 'concurrent-change';
  let health:'healthy'|'unhealthy'|'unknown';try{health=promotionAllowed()?await bounded(monitorRecoveryObservation?120000:45000,signal=>ports.verify(plan.candidateVersion,signal)):'unhealthy';if(!promotionAllowed())health='unhealthy';}catch{health='unknown';}
  if(health!=='healthy'&&health!=='unhealthy')return 'verification-unavailable';
  if(health==='healthy'){
   const after=await observe();if(!after)return 'observation-unavailable';if(!candidate(after)||after.deploymentId!==state!.candidateDeploymentId)return 'concurrent-change';
   if(promotionAllowed()){await advance('complete');return 'complete';}
  }
  await bounded(10000,signal=>ports.authorize(plan,'rollback',signal));const before=await observe();if(!before)return 'observation-unavailable';if(!candidate(before)||before.deploymentId!==state!.candidateDeploymentId)return 'concurrent-change';
  await advance('rollback-intent');
  try{await bounded(10000,signal=>ports.deploy(plan.baselineVersion,rollbackId,signal));}catch{/* Never replay an uncertain rollback POST. */}
 }
 if(state!.phase==='rollback-intent'){
  const observed=await observe(x=>!candidate(x)||x.deploymentId!==state!.candidateDeploymentId);if(!observed)return 'observation-unavailable';
  if(candidate(observed)&&observed.deploymentId===state!.candidateDeploymentId)return 'rollback-unconfirmed';if(!restored(observed))return 'concurrent-change';
  let health:'healthy'|'unhealthy'|'unknown';try{health=await bounded(45000,signal=>ports.verify(plan.baselineVersion,signal));}catch{health='unknown';}
  if(health!=='healthy')return 'verification-unavailable';
  const after=await observe();if(!after)return 'observation-unavailable';if(!restored(after)||after.deploymentId!==observed.deploymentId)return 'concurrent-change';
  await advance('rolled-back',{rollbackDeploymentId:observed.deploymentId});return 'rolled-back';
 }
 const observed=await observe();if(!observed)return 'observation-unavailable';
 if(state!.phase==='complete')return candidate(observed)&&observed.deploymentId===state!.candidateDeploymentId?'complete':'concurrent-change';
 if(state!.phase==='rolled-back')return restored(observed)&&observed.deploymentId===state!.rollbackDeploymentId?'rolled-back':'concurrent-change';
 throw new RecoveryError('DEPLOYMENT_JOURNAL_INVALID');
}
