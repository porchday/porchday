import {describe,it,expect,vi,afterEach} from 'vitest';
import {mkdtempSync,rmSync,writeFileSync,statSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {recoverDeployment,observeDeployment,RetryableObservationError,deploymentPlanHash,validateRecoveryTransition,type RecoveryState,type DeploymentPlan,type DeploymentPorts,type DeploymentObservation,type RecoveryJournal} from './deployment-recovery.ts';
import {FileRecoveryJournal} from './deployment-recovery-journal.ts';
const uuid=(n:number)=>n.toString(16).padStart(8,'0')+'-0000-0000-0000-000000000000';
const plan:DeploymentPlan={operationId:uuid(1),worker:'porchday-staging',candidateVersion:uuid(2),baselineVersion:uuid(3),baselineDeploymentId:uuid(4),candidateSource:'a'.repeat(40),compatibleRollbackVersions:[uuid(3)],evidenceDigest:'b'.repeat(64)};
class MemoryJournal implements RecoveryJournal{
 state:RecoveryState|null=null;
 async read(){return this.state?{...this.state}:null;}
 async write(expected:RecoveryState|null,next:RecoveryState){validateRecoveryTransition(expected,next);expect(this.state).toEqual(expected);this.state={...next};}
}
function fixture(){
 const journal=new MemoryJournal();let current:DeploymentObservation={version:plan.baselineVersion,deploymentId:plan.baselineDeploymentId,operationId:null};
 const ports:DeploymentPorts={authorize:vi.fn(async()=>{}),observe:vi.fn(async()=>({...current})),deploy:vi.fn(async(version,operationId)=>{current={version,operationId,deploymentId:uuid(version===plan.candidateVersion?5:6)};}),verify:vi.fn(async()=> 'healthy')};
 return{journal,ports,set:(x:DeploymentObservation)=>{current=x;},current:()=>current,run:()=>recoverDeployment(plan,journal,ports,{sleep:async()=>{}})};
}
afterEach(()=>vi.useRealTimers());
describe('deployment recovery',()=>{
 it('snapshots nested asset pins before asynchronous authorization',async()=>{
  const f=fixture(),input={...plan,assetManifests:{candidate:'c'.repeat(64),baseline:'d'.repeat(64)}},originalHash=deploymentPlanHash(input);
  f.ports.authorize=vi.fn(async received=>{input.assetManifests.candidate='e'.repeat(64);expect(received.assetManifests?.candidate).toBe('c'.repeat(64));});
  expect(await recoverDeployment(input,f.journal,f.ports)).toBe('complete');expect(f.journal.state?.planHash).toBe(originalHash);
 });
 it('reconciles an acknowledged activation through transient GET failures',async()=>{
  const f=fixture();let failures=2;const read=f.ports.observe;f.ports.observe=vi.fn(async signal=>{if(f.current().version===plan.candidateVersion&&failures-->0)throw new RetryableObservationError();return read(signal);});
  expect(await f.run()).toBe('complete');expect(f.ports.deploy).toHaveBeenCalledTimes(1);expect(f.journal.state?.phase).toBe('complete');
 });
 it('does not repeat a POST whose reply was lost after commitment',async()=>{
  const f=fixture(),deploy=f.ports.deploy;f.ports.deploy=vi.fn(async(...args)=>{await deploy(...args);throw Error('lost reply');});
  expect(await f.run()).toBe('complete');expect(f.ports.deploy).toHaveBeenCalledTimes(1);
 });
 it('resumes an uncertain activation by reading, including a late commitment',async()=>{
  const f=fixture();f.ports.deploy=vi.fn(async()=>{throw Error('unknown');});expect(await f.run()).toBe('activation-unconfirmed');
  expect(await f.run()).toBe('activation-unconfirmed');expect(f.ports.deploy).toHaveBeenCalledTimes(1);
  f.set({version:plan.candidateVersion,deploymentId:uuid(5),operationId:plan.operationId});expect(await f.run()).toBe('complete');expect(f.ports.deploy).toHaveBeenCalledTimes(1);
 });
 it('rolls back failed user journeys and verifies the restored version',async()=>{
  const f=fixture();f.ports.verify=vi.fn(async version=>version===plan.candidateVersion?'unhealthy':'healthy');
  expect(await f.run()).toBe('rolled-back');expect(f.ports.deploy).toHaveBeenCalledTimes(2);expect(f.ports.authorize).toHaveBeenLastCalledWith(plan,'rollback',expect.any(AbortSignal));expect(f.ports.verify).toHaveBeenLastCalledWith(plan.baselineVersion,expect.any(AbortSignal));
 });
 it('does not repeat an uncertain rollback and verifies a late restoration',async()=>{
  const f=fixture(),deploy=f.ports.deploy;let rollbackOperation='';f.ports.verify=vi.fn(async version=>version===plan.candidateVersion?'unhealthy':'healthy');
  f.ports.deploy=vi.fn(async(version,operation,signal)=>{if(version===plan.baselineVersion){rollbackOperation=operation;throw Error('unknown');}await deploy(version,operation,signal);});
  expect(await f.run()).toBe('rollback-unconfirmed');expect(await f.run()).toBe('rollback-unconfirmed');expect(f.ports.deploy).toHaveBeenCalledTimes(2);
  f.set({version:plan.baselineVersion,deploymentId:uuid(6),operationId:rollbackOperation});expect(await f.run()).toBe('rolled-back');expect(f.ports.deploy).toHaveBeenCalledTimes(2);
 });
 it('does not overwrite another deployment that changes during verification',async()=>{
  const f=fixture();f.ports.verify=vi.fn(async()=>{f.set({version:uuid(10),deploymentId:uuid(11),operationId:uuid(12)});return 'unhealthy';});
  expect(await f.run()).toBe('concurrent-change');expect(f.ports.deploy).toHaveBeenCalledTimes(1);
 });
 it('rejects the same candidate deployed by an unrelated operation',async()=>{
  const f=fixture();f.ports.deploy=vi.fn(async()=>{f.set({version:plan.candidateVersion,deploymentId:uuid(5),operationId:uuid(99)});});
  expect(await f.run()).toBe('concurrent-change');expect(f.ports.verify).not.toHaveBeenCalled();
 });
 it('rechecks compatibility and lease before rollback',async()=>{
  const f=fixture();f.ports.verify=vi.fn(async()=> 'unhealthy');f.ports.authorize=vi.fn(async(_p,direction)=>{if(direction==='rollback')throw Error('READER_FLOOR_CHANGED');});
  await expect(f.run()).rejects.toThrow('READER_FLOOR_CHANGED');expect(f.ports.deploy).toHaveBeenCalledTimes(1);expect(f.journal.state?.phase).toBe('candidate-observed');
 });
 it('refuses a plan below the reader floor before any mutation',async()=>{
  const f=fixture();await expect(recoverDeployment({...plan,compatibleRollbackVersions:[]},f.journal,f.ports)).rejects.toThrow('ROLLBACK_FLOOR_INVALID');expect(f.journal.state).toBeNull();expect(f.ports.deploy).not.toHaveBeenCalled();
 });
 it('never sends when durable intent persistence fails',async()=>{
  const f=fixture(),write=f.journal.write.bind(f.journal);f.journal.write=async(expected,next)=>{if(next.phase==='activation-intent')throw Error('disk failed');await write(expected,next);};
  await expect(f.run()).rejects.toThrow('disk failed');expect(f.ports.deploy).not.toHaveBeenCalled();
 });
 it('does not infer failure from unknown verification or invalid verifier output',async()=>{
  for(const result of ['unknown',undefined]){const f=fixture();f.ports.verify=vi.fn(async()=>result as 'unknown');expect(await f.run()).toBe('verification-unavailable');expect(f.ports.deploy).toHaveBeenCalledTimes(1);}
 });
 it('bounds an uncertain POST and resumes a late commit without another POST',async()=>{
  vi.useFakeTimers();const f=fixture();let signal:AbortSignal|undefined;f.ports.deploy=vi.fn(async(_version,_operation,s)=>{signal=s;return new Promise(()=>{});});
  const pending=f.run();await vi.runAllTimersAsync();expect(await pending).toBe('activation-unconfirmed');expect(signal?.aborted).toBe(true);
  f.set({version:plan.candidateVersion,deploymentId:uuid(5),operationId:plan.operationId});expect(await f.run()).toBe('complete');expect(f.ports.deploy).toHaveBeenCalledTimes(1);
 });
 it('bounds and aborts a hung verifier without claiming recovery',async()=>{
  vi.useFakeTimers();const f=fixture();let signal:AbortSignal|undefined;f.ports.verify=vi.fn(async(_version,s)=>{signal=s;return new Promise(()=>{});});
  const pending=f.run();await vi.runAllTimersAsync();expect(await pending).toBe('verification-unavailable');expect(signal?.aborted).toBe(true);expect(f.ports.deploy).toHaveBeenCalledTimes(1);
 });
 it('bounds a hung authorization before any deployment intent',async()=>{
  vi.useFakeTimers();const f=fixture();let signal:AbortSignal|undefined;f.ports.authorize=vi.fn(async(_plan,_direction,s)=>{signal=s;return new Promise(()=>{});});
  const pending=expect(f.run()).rejects.toThrow('OBSERVATION_RETRYABLE');await vi.runAllTimersAsync();await pending;expect(signal?.aborted).toBe(true);expect(f.journal.state?.phase).toBe('prepared');expect(f.ports.deploy).not.toHaveBeenCalled();
 });
 it('rejects a changed plan on resume',async()=>{
  const f=fixture();expect(await f.run()).toBe('complete');await expect(recoverDeployment({...plan,candidateSource:'c'.repeat(40)},f.journal,f.ports)).rejects.toThrow('PLAN_CHANGED');expect(f.ports.deploy).toHaveBeenCalledTimes(1);
 });
 it('snapshots plan inputs before asynchronous authorization',async()=>{
  const f=fixture(),input={...plan};f.ports.authorize=vi.fn(async()=>{input.candidateVersion=uuid(20);});
  expect(await recoverDeployment(input,f.journal,f.ports,{sleep:async()=>{}})).toBe('complete');expect(f.ports.deploy).toHaveBeenCalledWith(plan.candidateVersion,plan.operationId,expect.any(AbortSignal));
 });
});
describe('bounded read-only observation',()=>{
 it('does not retry permanent or malformed responses',async()=>{
  for(const error of [Error('HTTP_403'),null]){const observe=vi.fn(async()=>{if(error)throw error;return{} as DeploymentObservation;});await expect(observeDeployment({observe},undefined,async()=>{})).rejects.toThrow();expect(observe).toHaveBeenCalledTimes(1);}
 });
 it('bounds hung reads and aborts each attempt',async()=>{
  vi.useFakeTimers();const signals:AbortSignal[]=[];const pending=observeDeployment({observe:signal=>{signals.push(signal);return new Promise(()=>{});}},undefined,async()=>{});const result=expect(pending).rejects.toThrow('OBSERVATION_RETRYABLE');await vi.runAllTimersAsync();await result;expect(signals).toHaveLength(3);expect(signals.every(x=>x.aborted)).toBe(true);
 });
});
describe('private durable journal',()=>{
 it('allows one concurrent intent append and persists private records',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'porchday-recovery-'));
  try{const a=new FileRecoveryJournal(directory),b=new FileRecoveryJournal(directory),first:RecoveryState={v:1,revision:1,phase:'prepared',planHash:deploymentPlanHash(plan)};await a.write(null,first);const next:RecoveryState={...first,revision:2,phase:'activation-intent'};const result=await Promise.allSettled([a.write(first,next),b.write(first,next)]);expect(result.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(await a.read()).toEqual(next);expect(statSync(join(directory,'00002.json')).mode&0o777).toBe(0o600);expect(readFileSync(join(directory,'00002.json'),'utf8')).not.toContain('Bearer');}
  finally{rmSync(directory,{recursive:true,force:true});}
 });
 it('refuses a torn intent rather than resending a deployment',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'porchday-recovery-'));
  try{const journal=new FileRecoveryJournal(directory);writeFileSync(join(directory,'00001.json'),'{"v":1,',{mode:0o600});await expect(journal.read()).rejects.toThrow('JOURNAL_INVALID');}
  finally{rmSync(directory,{recursive:true,force:true});}
 });
});

it('keeps the45-second bound for ordinary releases and permits only explicit monitor recovery a120-second candidate budget',async()=>{
 vi.useFakeTimers();
 for(const scoped of [false,true]){
  const f=fixture(),monitor={...plan,worker:'porchday-monitor-staging'};
  f.ports.verify=vi.fn((_version,signal)=>new Promise(resolve=>{const timer=setTimeout(()=>resolve('healthy'),60000);signal.addEventListener('abort',()=>clearTimeout(timer),{once:true});}));
  const pending=recoverDeployment(monitor,f.journal,f.ports,{sleep:async()=>{},...(scoped?{monitorRecoveryObservation:true}:{})});
  await vi.advanceTimersByTimeAsync(60001);expect(await pending).toBe(scoped?'complete':'verification-unavailable');expect(f.ports.deploy).toHaveBeenCalledTimes(1);
 }
 const f=fixture();await expect(recoverDeployment(plan,f.journal,f.ports,{monitorRecoveryObservation:true})).rejects.toThrow('MONITOR_RECOVERY_SCOPE_INVALID');expect(f.ports.deploy).not.toHaveBeenCalled();
});
it('snapshots the recovery budget option before asynchronous authorization',async()=>{
 vi.useFakeTimers();const f=fixture(),options:{monitorRecoveryObservation?:boolean}={};
 f.ports.authorize=vi.fn(async()=>{options.monitorRecoveryObservation=true;});
 f.ports.verify=vi.fn((_version,signal)=>new Promise(resolve=>{const timer=setTimeout(()=>resolve('healthy'),60000);signal.addEventListener('abort',()=>clearTimeout(timer),{once:true});}));
 const pending=recoverDeployment(plan,f.journal,f.ports,options);await vi.advanceTimersByTimeAsync(60001);expect(await pending).toBe('verification-unavailable');expect(f.ports.deploy).toHaveBeenCalledTimes(1);
});


it('binds an explicit reader floor promotion to the plan and rejects unrelated targets or malformed floors',()=>{
 const promotion={protocol:'privacy-commit-v1' as const,previousVersion:plan.baselineVersion};
 expect(deploymentPlanHash({...plan,readerFloorPromotion:promotion})).not.toBe(deploymentPlanHash(plan));
 for(const readerFloorPromotion of [{...promotion,previousVersion:plan.candidateVersion},{...promotion,previousVersion:uuid(99)},{...promotion,protocol:'unknown'},{...promotion,extra:true}])expect(()=>deploymentPlanHash({...plan,readerFloorPromotion} as DeploymentPlan)).toThrow('READER_FLOOR_PROMOTION_INVALID');
 for(const worker of ['porchday-staging-edge','porchday-monitor-staging'])expect(()=>deploymentPlanHash({...plan,worker,readerFloorPromotion:promotion})).toThrow('READER_FLOOR_PROMOTION_INVALID');
});
