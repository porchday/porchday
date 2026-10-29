import {createContinuityGate} from './release-continuity-gate.ts';
import {constants,openSync,closeSync,fsyncSync,fstatSync,readFileSync,writeFileSync,linkSync,unlinkSync,realpathSync,lstatSync,mkdirSync,readdirSync,existsSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join,isAbsolute} from 'node:path';
import {deploymentPlanHash,validateRecoveryState,validateRecoveryTransition,type DeploymentPlan,type RecoveryState} from './deployment-recovery.ts';
import {FileDeploymentLease} from './deployment-recovery-lease.ts';
import {queueReleaseAlert,validateReleaseAlert,type ReleaseAlert} from './release-alerts.ts';
export type ReleaseWatch={v:1;plan:DeploymentPlan;root:string;journalDirectory:string;proofDirectory:string;registeredAt:string};
function directory(path:string){const s=lstatSync(path);if(!isAbsolute(path)||realpathSync(path)!==path||!s.isDirectory()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)throw Error('RELEASE_WATCH_DIRECTORY_INVALID');}
function read(path:string){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||s.size>16384)throw Error('RELEASE_WATCH_FILE_INVALID');return JSON.parse(readFileSync(fd,'utf8'));}finally{closeSync(fd);}}
function persist(path:string,value:unknown){const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}}
function validate(w:ReleaseWatch){
 if(!w||Object.keys(w).sort().join(',')!=='journalDirectory,plan,proofDirectory,registeredAt,root,v'||w.v!==1||typeof w.registeredAt!=='string'||!Number.isFinite(Date.parse(w.registeredAt))||new Date(w.registeredAt).toISOString()!==w.registeredAt)throw Error('RELEASE_WATCH_INVALID');
 deploymentPlanHash(w.plan);for(const p of [w.root,w.journalDirectory,w.proofDirectory])directory(p);
 if(w.journalDirectory===w.proofDirectory||w.journalDirectory===join(w.root,'deployment-lock')||w.proofDirectory===join(w.root,'deployment-lock'))throw Error('RELEASE_WATCH_DIRECTORY_INVALID');
}
/** Registered before acquiring a deployment lease. This registry is not authority to deploy. */
export function registerReleaseWatch(input:Omit<ReleaseWatch,'v'|'registeredAt'>,now=new Date()):ReleaseWatch{
 const w:ReleaseWatch={v:1,...structuredClone(input),registeredAt:now.toISOString()};validate(w);const registry=join(w.root,'release-watches');
 try{mkdirSync(registry,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}directory(registry);
 const path=join(registry,w.plan.operationId+'.json');
 const temp=join(w.root,'release-watch-tmp-'+randomUUID());persist(temp,w);
 try{linkSync(temp,path);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const previous=read(path) as ReleaseWatch;validate(previous);if(JSON.stringify({...previous,registeredAt:w.registeredAt})!==JSON.stringify(w))throw Error('RELEASE_WATCH_CHANGED');return previous;}finally{unlinkSync(temp);}
 for(const p of [registry,w.root]){const fd=openSync(p,constants.O_RDONLY);try{fsyncSync(fd);}finally{closeSync(fd);}}return w;
}
export function listReleaseWatches(root:string,onInvalid?:()=>void):ReleaseWatch[]{
 directory(root);const path=join(root,'release-watches');if(!existsSync(path))return [];directory(path);const files=readdirSync(path).sort();if(files.length>1000)throw Error('RELEASE_WATCH_ROTATION_REQUIRED');
 const watches:ReleaseWatch[]=[];for(const name of files){try{const w=read(join(path,name)) as ReleaseWatch;validate(w);if(name!==w.plan.operationId+'.json'||w.root!==root)throw Error('RELEASE_WATCH_SCOPE_CHANGED');watches.push(w);}catch(error){if(!onInvalid)throw error;onInvalid();}}return watches;
}
function journal(w:ReleaseWatch):RecoveryState|null{
 directory(w.journalDirectory);let previous:RecoveryState|null=null;
 for(const [i,name] of readdirSync(w.journalDirectory).sort().entries()){
  if(name!==String(i+1).padStart(5,'0')+'.json')throw Error('RELEASE_WATCH_JOURNAL_INVALID');
  const value=read(join(w.journalDirectory,name));validateRecoveryState(value);validateRecoveryTransition(previous,value);if(value.planHash!==deploymentPlanHash(w.plan))throw Error('RELEASE_WATCH_JOURNAL_CHANGED');previous=value;
 }return previous;
}
export type WatchObservation={status:'completed'|'cancelled'|'waiting'}|{status:'attention';event:ReleaseAlert};
/** Age raises attention only. No process-death inference, lease acquisition, cleanup or remote recovery. */
async function inspectState(input:ReleaseWatch,now:Date):Promise<WatchObservation>{
 const w=structuredClone(input);validate(w);const state=journal(w),hash=deploymentPlanHash(w.plan);
 if(await FileDeploymentLease.completed(w.root,w.plan,{read:async()=>state,write:async()=>{throw Error('RELEASE_WATCH_READ_ONLY');}})){
  if(createContinuityGate(w.proofDirectory,w.plan).failed())return{status:'attention',event:queueReleaseAlert(w.proofDirectory,w.plan,'command-failed',now)};
  return{status:'completed'};
 }
 const cancelled=join(w.root,'deployment-recovery-cancelled-'+w.plan.operationId);
 if(existsSync(cancelled)){
  directory(cancelled);const owner=read(join(cancelled,'owner.json'));
  if(owner.protocol!=='porchday-deployment-recovery-sqlite-v1'||owner.operationId!==w.plan.operationId||owner.planHash!==hash||owner.source!==w.plan.candidateSource||state&&state.phase!=='prepared')throw Error('RELEASE_WATCH_CANCELLATION_INVALID');
  return{status:'cancelled'};
 }
 const outbox=join(w.proofDirectory,'attention-'+w.plan.operationId+'.json');
 if(existsSync(outbox)){const event=read(outbox);validateReleaseAlert(event);if(event.operationId!==w.plan.operationId||event.planHash!==hash||event.worker!==w.plan.worker)throw Error('RELEASE_WATCH_ALERT_CHANGED');return{status:'attention',event};}
 const elapsed=now.getTime()-Date.parse(w.registeredAt);if(!Number.isFinite(elapsed)||elapsed<0)throw Error('RELEASE_WATCH_CLOCK_INVALID');
 if(elapsed<120000)return{status:'waiting'};
 return{status:'attention',event:queueReleaseAlert(w.proofDirectory,w.plan,'release-overdue',now)};
}

/** Broken local journal/receipt evidence must not make a registered overdue release disappear. */
export async function inspectReleaseWatch(input:ReleaseWatch,now=new Date()):Promise<WatchObservation>{
 const w=structuredClone(input);validate(w);const elapsed=now.getTime()-Date.parse(w.registeredAt);if(!Number.isFinite(elapsed)||elapsed<0)throw Error('RELEASE_WATCH_CLOCK_INVALID');
 try{return await inspectState(w,now);}catch{
  if(elapsed<120000)return{status:'waiting'};
  return{status:'attention',event:queueReleaseAlert(w.proofDirectory,w.plan,'release-state-unreadable',now)};
 }
}
