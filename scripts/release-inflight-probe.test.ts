import {it,expect,vi,afterEach} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,readdirSync,writeFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {withStagingInflightProbe,assertStagingInflightProbeComplete} from './release-inflight-probe.ts';
import {recoverDeployment,rollbackOperationId,validateRecoveryTransition,type DeploymentPlan,type DeploymentPorts,type DeploymentObservation,type RecoveryState} from './deployment-recovery.ts';
const uuid=(n:number)=>n.toString(16).padStart(8,'0')+'-0000-0000-0000-000000000000';
const plan:DeploymentPlan={operationId:uuid(1),worker:'porchday-staging',candidateVersion:uuid(2),baselineVersion:uuid(3),baselineDeploymentId:uuid(4),candidateSource:'a'.repeat(40),compatibleRollbackVersions:[uuid(3)],evidenceDigest:'b'.repeat(64)};
const directories:string[]=[];afterEach(()=>{vi.useRealTimers();for(const d of directories.splice(0))rmSync(d,{recursive:true,force:true});});
function fixture(){
 const proofDirectory=realpathSync(mkdtempSync(join(tmpdir(),'inflight-')));directories.push(proofDirectory);const controller=new AbortController();let state:RecoveryState|null=null;
 let current:DeploymentObservation={version:plan.baselineVersion,deploymentId:plan.baselineDeploymentId,operationId:null};let inflight=false;
 const journal={read:async()=>state,write:async(previous:RecoveryState|null,next:RecoveryState)=>{validateRecoveryTransition(previous,next);state=next;}};
 const base:DeploymentPorts={authorize:vi.fn(async()=>{}),observe:vi.fn(async()=>({...current})),verify:vi.fn(async version=>version===plan.candidateVersion?'unhealthy':'healthy'),deploy:vi.fn(async(version,operationId)=>{if(version===plan.baselineVersion){expect(inflight).toBe(true);expect(state?.phase).toBe('rollback-intent');}current={version,operationId,deploymentId:uuid(version===plan.baselineVersion?6:5)};})};
 const options={plan,ports:base,proofDirectory,assertScope:vi.fn(),start:vi.fn(async()=>{expect(state?.phase).toBe('rollback-intent');expect(readdirSync(proofDirectory)).toContain(`inflight-${plan.operationId}-intent.json`);inflight=true;return 'in-flight' as const;}),finish:vi.fn(async()=>{expect(current.operationId).toBe(rollbackOperationId(plan.operationId));expect(inflight).toBe(true);inflight=false;return 'verified' as const;})};
 const ports=withStagingInflightProbe(options,controller.signal);
 return{options,ports,base,controller,proofDirectory,journal,state:()=>state,set:(v:DeploymentObservation)=>{current=v;},run:()=>recoverDeployment(plan,journal,ports,{sleep:async()=>{}})};
}
it('coordinates a pending request across exact rollback before normal verification',async()=>{
 const f=fixture();expect(await f.run()).toBe('rolled-back');expect(f.options.start).toHaveBeenCalledTimes(1);expect(f.options.finish).toHaveBeenCalledTimes(1);expect(f.base.deploy).toHaveBeenCalledTimes(2);
 expect(await f.run()).toBe('rolled-back');expect(f.options.start).toHaveBeenCalledTimes(1);expect(f.options.finish).toHaveBeenCalledTimes(1);
 expect(JSON.parse(readFileSync(join(f.proofDirectory,`inflight-${plan.operationId}-result.json`),'utf8')).value.status).toBe('verified');
 expect(()=>withStagingInflightProbe(f.options,f.controller.signal)).toThrow('STAGING_INFLIGHT_PROBE_UNVERIFIED');
});
it('reconciles a committed rollback with a lost reply without repeating callbacks',async()=>{
 const f=fixture(),deploy=f.base.deploy;f.base.deploy=vi.fn(async(...args)=>{await deploy(...args);if(args[0]===plan.baselineVersion)throw Error('private provider reply');});
 expect(await f.run()).toBe('rolled-back');expect(f.base.deploy).toHaveBeenCalledTimes(2);expect(f.options.finish).toHaveBeenCalledTimes(1);
});
it.each(['throw','invalid','abort','scope','persistence'])('does not roll back when start is %s',async kind=>{
 const f=fixture();
 f.options.start.mockImplementation(async()=>{if(kind==='abort')f.controller.abort();if(kind==='scope')f.options.assertScope.mockImplementation(()=>{throw Error('private');});if(kind==='persistence')writeFileSync(join(f.proofDirectory,`inflight-${plan.operationId}-armed.json`),'existing');if(kind==='throw')throw Error('private');return(kind==='invalid'?'verified':'in-flight') as 'in-flight';});
 expect(await f.run()).toBe('observation-unavailable');expect(f.base.deploy).toHaveBeenCalledTimes(1);expect(f.options.finish).not.toHaveBeenCalled();expect(f.state()?.phase).toBe('rollback-intent');
 expect(readdirSync(f.proofDirectory)).not.toContain(`inflight-${plan.operationId}-result.json`);
});
it.each(['throw','invalid','abort','scope','persistence'])('does not finalize rollback when finish is %s',async kind=>{
 const f=fixture();f.options.finish.mockImplementation(async()=>{if(kind==='abort')f.controller.abort();if(kind==='scope')f.options.assertScope.mockImplementation(()=>{throw Error('private');});if(kind==='persistence')writeFileSync(join(f.proofDirectory,`inflight-${plan.operationId}-result.json`),'existing');if(kind==='throw')throw Error('private');return(kind==='invalid'?'in-flight':'verified') as 'verified';});
 expect(await f.run()).toBe('observation-unavailable');expect(f.state()?.phase).toBe('rollback-intent');expect(f.base.verify).toHaveBeenCalledTimes(1);expect(f.options.finish).toHaveBeenCalledTimes(1);
 expect(await f.run()).toBe('observation-unavailable');expect(f.options.finish).toHaveBeenCalledTimes(1);expect(f.base.deploy).toHaveBeenCalledTimes(2);
});
it('does not finish against an unrelated deployment',async()=>{
 const f=fixture(),deploy=f.base.deploy;f.base.deploy=vi.fn(async(...args)=>{await deploy(...args);if(args[0]===plan.baselineVersion)f.set({version:plan.baselineVersion,deploymentId:uuid(9),operationId:uuid(9)});});
 expect(await f.run()).toBe('concurrent-change');expect(f.options.finish).not.toHaveBeenCalled();
});
it('rejects malformed provider identity before invoking finish',async()=>{
 const f=fixture(),deploy=f.base.deploy;f.base.deploy=vi.fn(async(...args)=>{await deploy(...args);if(args[0]===plan.baselineVersion)f.set({version:plan.baselineVersion,deploymentId:'bad',operationId:rollbackOperationId(plan.operationId)});});
 expect(await f.run()).toBe('observation-unavailable');expect(f.options.finish).not.toHaveBeenCalled();
});
it('keeps unchanged candidate unconfirmed without finishing or replaying',async()=>{
 const f=fixture(),deploy=f.base.deploy;f.base.deploy=vi.fn(async(...args)=>{if(args[0]===plan.baselineVersion)throw Error('unknown');await deploy(...args);});
 expect(await f.run()).toBe('rollback-unconfirmed');expect(await f.run()).toBe('rollback-unconfirmed');expect(f.base.deploy).toHaveBeenCalledTimes(2);expect(f.options.start).toHaveBeenCalledTimes(1);expect(f.options.finish).not.toHaveBeenCalled();
});
it.each(['porchday-production','porchday-staging-edge','porchday-staging-monitor'])('rejects %s',worker=>{
 const f=fixture();expect(()=>withStagingInflightProbe({...f.options,plan:{...plan,worker}},f.controller.signal)).toThrow();expect(f.options.start).not.toHaveBeenCalled();
});
it('blocks a late start callback from dispatching after the controller deadline',async()=>{
 vi.useFakeTimers();const f=fixture();let release:()=>void=()=>{};f.options.start.mockImplementation(()=>new Promise(resolve=>{release=()=>resolve('in-flight');}));
 const running=f.run();await vi.advanceTimersByTimeAsync(10001);expect(await running).toBe('observation-unavailable');release();await vi.advanceTimersByTimeAsync(1);expect(f.base.deploy).toHaveBeenCalledTimes(1);expect(f.options.finish).not.toHaveBeenCalled();
});
it('does not certify a finish callback that outlives the observation deadline',async()=>{
 vi.useFakeTimers();const f=fixture();let release:()=>void=()=>{};f.options.finish.mockImplementation(()=>new Promise(resolve=>{release=()=>resolve('verified');}));
 const running=f.run();await vi.advanceTimersByTimeAsync(5001);expect(await running).toBe('observation-unavailable');release();await vi.advanceTimersByTimeAsync(1);
 expect(readdirSync(f.proofDirectory)).not.toContain(`inflight-${plan.operationId}-result.json`);expect(f.state()?.phase).toBe('rollback-intent');
});
it('cannot arm without observing the exact candidate',async()=>{
 const f=fixture();await expect(f.ports.deploy(plan.baselineVersion,rollbackOperationId(plan.operationId),f.controller.signal)).rejects.toThrow('STAGING_INFLIGHT_PROBE_UNVERIFIED');expect(f.options.start).not.toHaveBeenCalled();expect(f.base.deploy).not.toHaveBeenCalled();
});
it('does not arm when exclusive intent persistence fails',async()=>{
 const f=fixture();writeFileSync(join(f.proofDirectory,`inflight-${plan.operationId}-intent.json`),'existing');
 expect(await f.run()).toBe('observation-unavailable');expect(f.options.start).not.toHaveBeenCalled();expect(f.base.deploy).toHaveBeenCalledTimes(1);
});
it('does not retain callback errors or payloads',async()=>{
 const f=fixture();f.options.finish.mockRejectedValue(Error('private cookie and provider details'));
 expect(await f.run()).toBe('observation-unavailable');for(const name of readdirSync(f.proofDirectory))expect(readFileSync(join(f.proofDirectory,name),'utf8')).not.toContain('private cookie');
});
it('requires a complete operation-bound proof when requested',async()=>{
 const f=fixture();expect(()=>assertStagingInflightProbeComplete(plan,f.proofDirectory)).not.toThrow();expect(()=>assertStagingInflightProbeComplete(plan,f.proofDirectory,true)).toThrow();
 expect(await f.run()).toBe('rolled-back');expect(assertStagingInflightProbeComplete(plan,f.proofDirectory,true)).toBe(uuid(6));
});
it.each(['intent','armed','restored','result'])('rejects damaged %s evidence on generic resume',async kind=>{
 const f=fixture();expect(await f.run()).toBe('rolled-back');const path=join(f.proofDirectory,`inflight-${plan.operationId}-${kind}.json`);const row=JSON.parse(readFileSync(path,'utf8'));row.planHash='f'.repeat(64);writeFileSync(path,JSON.stringify(row));
 expect(()=>assertStagingInflightProbeComplete(plan,f.proofDirectory)).toThrow('STAGING_INFLIGHT_PROBE_UNVERIFIED');
});
it('rejects a partial probe instead of silently allowing generic finalization',async()=>{
 const f=fixture();f.options.finish.mockRejectedValue(Error('unknown'));expect(await f.run()).toBe('observation-unavailable');expect(()=>assertStagingInflightProbeComplete(plan,f.proofDirectory)).toThrow('STAGING_INFLIGHT_PROBE_UNVERIFIED');
});
