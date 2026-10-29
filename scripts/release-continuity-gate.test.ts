import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,readdirSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createContinuityGate} from './release-continuity-gate';
import {recoverDeployment,validateRecoveryTransition,rollbackOperationId,type DeploymentPlan,type RecoveryState,type DeploymentPorts,type DeploymentObservation} from './deployment-recovery';
import type {ContinuityCommandEvent} from './release-continuity-command';
const id=(n:number)=>n.toString(16).padStart(8,'0')+'-0000-4000-8000-000000000000';
const plan:DeploymentPlan={operationId:id(1),worker:'porchday-staging',candidateVersion:id(2),baselineVersion:id(3),baselineDeploymentId:id(4),candidateSource:'a'.repeat(40),compatibleRollbackVersions:[id(3)],evidenceDigest:'b'.repeat(64)};
const paths:string[]=[];
afterEach(()=>{for(const path of paths.splice(0))rmSync(path,{recursive:true,force:true});});
function fixture(){
 const directory=realpathSync(mkdtempSync(join(tmpdir(),'continuity-gate-')));paths.push(directory);
 const gate=createContinuityGate(directory,plan);let state:RecoveryState|null=null,current:DeploymentObservation={version:plan.baselineVersion,deploymentId:plan.baselineDeploymentId,operationId:null};
 const journal={read:async()=>state,write:async(previous:RecoveryState|null,next:RecoveryState)=>{validateRecoveryTransition(previous,next);expect(state).toEqual(previous);state=next;}};
 const ports:DeploymentPorts={authorize:vi.fn(async()=>{}),observe:vi.fn(async()=>({...current})),deploy:vi.fn(async(version,operationId)=>{current={version,operationId,deploymentId:id(version===plan.candidateVersion?5:6)};}),verify:vi.fn(async()=> 'healthy')};
 const fail=()=>gate.retain({kind:'sample',index:1,phaseAtStart:'command-running',sample:{at:'2026-10-29T16:29:16.819Z',healthy:false,checks:[],scope:'existing_session_reads_denial_and_readiness'}} as unknown as ContinuityCommandEvent);
 const run=()=>recoverDeployment(plan,journal,ports,{sleep:async()=>{},promotionAllowed:()=>!createContinuityGate(directory,plan).failed()});
 return {directory,gate,fail,ports,journal,run,state:()=>state};
}
it('persists a scoped failure across process-style reconstruction and does not clear it on recovery samples',()=>{
 const f=fixture();f.fail();const original=readFileSync(join(f.directory,readdirSync(f.directory)[0]),'utf8');
 f.gate.retain({kind:'sample',sample:{healthy:true}} as ContinuityCommandEvent);f.fail();
 expect(readFileSync(join(f.directory,readdirSync(f.directory)[0]),'utf8')).toBe(original);
 expect(createContinuityGate(f.directory,plan).failed()).toBe(true);
 expect(()=>createContinuityGate(f.directory,{...plan,evidenceDigest:'c'.repeat(64)}).failed()).toThrow('RECORD_INVALID');
 expect(Object.keys(JSON.parse(original)).sort()).toEqual(['at','operationId','planHash','v']);
});
it('fails closed on unreadable or malformed continuity evidence',()=>{
 const f=fixture();f.fail();writeFileSync(join(f.directory,readdirSync(f.directory)[0]),'{}');expect(()=>f.gate.failed()).toThrow('RECORD_INVALID');
});
it('stops a failed prepared-phase observation after authorization before writing dispatch intent',async()=>{
 const f=fixture();f.ports.authorize=vi.fn(async()=>{f.fail();});
 await expect(f.run()).rejects.toThrow('DEPLOYMENT_CONTINUITY_FAILED');
 expect(f.state()?.phase).toBe('prepared');expect(f.ports.deploy).not.toHaveBeenCalled();
 await expect(f.run()).rejects.toThrow('DEPLOYMENT_CONTINUITY_FAILED');expect(f.ports.authorize).toHaveBeenCalledTimes(1);
});
it('also guards the last dispatch boundary after intent has been persisted',async()=>{
 const f=fixture(),write=f.journal.write;f.journal.write=async(p,n)=>{await write(p,n);if(n.phase==='activation-intent')f.fail();};
 expect(await f.run()).toBe('activation-unconfirmed');expect(f.state()?.phase).toBe('activation-intent');expect(f.ports.deploy).not.toHaveBeenCalled();
 expect(await f.run()).toBe('activation-unconfirmed');expect(f.ports.deploy).not.toHaveBeenCalled();
});
it('rolls back a failure arriving during candidate verification through the original operation',async()=>{
 const f=fixture();f.ports.verify=vi.fn(async version=>{if(version===plan.candidateVersion)f.fail();return 'healthy';});
 expect(await f.run()).toBe('rolled-back');expect(f.ports.deploy).toHaveBeenCalledTimes(2);
 expect(f.ports.deploy).toHaveBeenLastCalledWith(plan.baselineVersion,rollbackOperationId(plan.operationId),expect.any(AbortSignal));
 expect(f.ports.authorize).toHaveBeenLastCalledWith(plan,'rollback',expect.any(AbortSignal));
 expect(f.ports.verify).toHaveBeenLastCalledWith(plan.baselineVersion,expect.any(AbortSignal));
});
it('catches a failure during the last provider read after a healthy candidate verification',async()=>{
 const f=fixture(),observe=f.ports.observe;let verified=false;
 f.ports.verify=vi.fn(async version=>{if(version===plan.candidateVersion)verified=true;return 'healthy';});
 f.ports.observe=vi.fn(async signal=>{if(verified){verified=false;f.fail();}return observe(signal);});
 expect(await f.run()).toBe('rolled-back');expect(f.state()?.phase).toBe('rolled-back');
});
it('does not bypass rollback compatibility checks after a continuity failure',async()=>{
 const f=fixture();f.ports.verify=vi.fn(async()=>{f.fail();return 'healthy';});f.ports.authorize=vi.fn(async(_p,d)=>{if(d==='rollback')throw Error('READER_FLOOR_CHANGED');});
 await expect(f.run()).rejects.toThrow('READER_FLOOR_CHANGED');expect(f.ports.deploy).toHaveBeenCalledTimes(1);expect(f.state()?.phase).toBe('candidate-observed');
});
it('does not treat an unhealthy rollback as verified or replay its deployment on resume',async()=>{
 const f=fixture();f.ports.verify=vi.fn(async version=>{if(version===plan.candidateVersion)f.fail();return 'unhealthy';});
 expect(await f.run()).toBe('verification-unavailable');expect(f.state()?.phase).toBe('rollback-intent');
 expect(await f.run()).toBe('verification-unavailable');expect(f.ports.deploy).toHaveBeenCalledTimes(2);
});
it('reconciles an uncertain committed activation, then rolls back without replaying activation',async()=>{
 const f=fixture(),deploy=f.ports.deploy;f.ports.deploy=vi.fn(async(...args)=>{await deploy(...args);if(args[0]===plan.candidateVersion){f.fail();throw Error('lost reply');}});
 expect(await f.run()).toBe('rolled-back');expect(f.ports.deploy).toHaveBeenCalledTimes(2);
 expect(f.ports.verify).toHaveBeenCalledTimes(1);expect(f.ports.verify).toHaveBeenLastCalledWith(plan.baselineVersion,expect.any(AbortSignal));
});
it('retains a late failure without rewriting a terminal journal or replaying any deployment',async()=>{
 const f=fixture();expect(await f.run()).toBe('complete');const terminal=structuredClone(f.state());f.fail();
 expect(()=>f.gate.assertPromotion()).toThrow('DEPLOYMENT_CONTINUITY_FAILED');
 expect(await f.run()).toBe('complete');expect(f.state()).toEqual(terminal);expect(f.ports.deploy).toHaveBeenCalledTimes(1);
});
