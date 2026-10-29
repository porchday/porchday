import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtempSync,realpathSync,rmSync,readFileSync,writeFileSync,symlinkSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBrowserGate,withBrowserAcceptance} from './release-browser-gate.ts';
import {recoverDeployment,type DeploymentPlan,type DeploymentPorts,type DeploymentObservation,type RecoveryState} from './deployment-recovery.ts';
const uuid=(n:number)=>n.toString(16).padStart(8,'0')+'-0000-0000-0000-000000000000';
const plan:DeploymentPlan={operationId:uuid(1),worker:'porchday-staging-edge',candidateVersion:uuid(2),baselineVersion:uuid(3),baselineDeploymentId:uuid(4),candidateSource:'a'.repeat(40),compatibleRollbackVersions:[uuid(3)],evidenceDigest:'b'.repeat(64),backendVersion:uuid(7),backendReaderFloor:uuid(7)};
let root:string;const signal=()=>new AbortController().signal;
const path=(kind:string)=>join(root,`browser-gate-${plan.operationId}-${kind}.json`);
beforeEach(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),'browser-gate-')));});
afterEach(()=>rmSync(root,{recursive:true,force:true}));
it('requires durable enrollment for a supplied browser while preserving legacy verification',async()=>{
 const gate=createBrowserGate(root,plan),accept=vi.fn(async()=> 'healthy' as const);
 expect(await gate.verify(signal(),accept)).toBe('unknown');expect(accept).not.toHaveBeenCalled();expect(await gate.verify(signal())).toBe('healthy');
});
it('requires and claims evidence durably, once, and reuses its pinned result on resume',async()=>{
 const gate=createBrowserGate(root,plan),accept=vi.fn(async()=> 'healthy' as const);gate.require();
 expect(await gate.verify(signal(),accept)).toBe('healthy');expect(await createBrowserGate(root,plan).verify(signal())).toBe('healthy');expect(accept).toHaveBeenCalledOnce();
 expect(()=>gate.require()).toThrow();
});
it('cannot manufacture acceptance when the original browser or claimed observation is lost',async()=>{
 const gate=createBrowserGate(root,plan);gate.require();expect(await gate.verify(signal())).toBe('unknown');
 const started=JSON.parse(readFileSync(path('required'),'utf8'));started.status='claimed';writeFileSync(path('claimed'),JSON.stringify(started),{mode:0o600});
 const accept=vi.fn(async()=> 'healthy' as const);expect(await createBrowserGate(root,plan).verify(signal(),accept)).toBe('unknown');expect(accept).not.toHaveBeenCalled();
});
it('retains unknown for exceptions and cancellation without retry or exception text',async()=>{
 const gate=createBrowserGate(root,plan);gate.require();const accept=vi.fn(async()=>{throw Error('private exception');});
 expect(await gate.verify(signal(),accept)).toBe('unknown');expect(readFileSync(path('result'),'utf8')).not.toContain('private');expect(await gate.verify(signal(),accept)).toBe('unknown');expect(accept).toHaveBeenCalledOnce();
});
it('does not accept a result returned after cancellation',async()=>{
 const controller=new AbortController(),gate=createBrowserGate(root,plan);gate.require();
 expect(await gate.verify(controller.signal,async()=>{controller.abort();return 'healthy';})).toBe('unknown');
});
it.each(['wrong-plan','permissions','symlink'])('rejects %s records without browser work',async kind=>{
 const gate=createBrowserGate(root,plan);gate.require();
 if(kind==='wrong-plan'){const data=JSON.parse(readFileSync(path('required'),'utf8'));data.planHash='f'.repeat(64);writeFileSync(path('required'),JSON.stringify(data));}
 if(kind==='permissions')chmodSync(path('required'),0o644);
 if(kind==='symlink'){const data=readFileSync(path('required'));rmSync(path('required'));writeFileSync(join(root,'other'),data,{mode:0o600});symlinkSync(join(root,'other'),path('required'));}
 const accept=vi.fn();await expect(gate.verify(signal(),accept)).rejects.toThrow();expect(accept).not.toHaveBeenCalled();
});
it('does not upgrade an unhealthy API or gate rollback/backend/monitor verification',async()=>{
 const accept=vi.fn(async()=> 'healthy' as const);createBrowserGate(root,plan).require();
 expect(await withBrowserAcceptance(plan,root,async()=> 'unhealthy',accept)(plan.candidateVersion,signal())).toBe('unhealthy');
 expect(await withBrowserAcceptance(plan,root,async()=> 'healthy',accept)(plan.baselineVersion,signal())).toBe('healthy');
 for(const worker of ['porchday-staging','porchday-monitor-staging'])expect(await withBrowserAcceptance({...plan,worker},root,async()=> 'healthy',accept)(plan.candidateVersion,signal())).toBe('healthy');
 expect(accept).not.toHaveBeenCalled();
});
it.each(['healthy','unhealthy','unknown'] as const)('integrates %s browser evidence before the real recovery controller commits completion',async health=>{
 createBrowserGate(root,plan).require();let state:RecoveryState|null=null,current:DeploymentObservation={version:plan.baselineVersion,deploymentId:plan.baselineDeploymentId,operationId:null};
 const accept=vi.fn(async()=>{expect(state?.phase).toBe('candidate-observed');return health;});
 const ports:DeploymentPorts={authorize:vi.fn(async()=>{}),observe:async()=>({...current}),deploy:vi.fn(async(version,operationId)=>{current={version,operationId,deploymentId:uuid(version===plan.candidateVersion?5:6)};}),verify:withBrowserAcceptance(plan,root,async()=> 'healthy',accept)};
 const journal={read:async()=>state,write:async(_old:RecoveryState|null,next:RecoveryState)=>{state=next;}};
 const expected={healthy:'complete',unhealthy:'rolled-back',unknown:'verification-unavailable'};
 expect(await recoverDeployment(plan,journal,ports,{sleep:async()=>{}})).toBe(expected[health]);
 expect(ports.deploy).toHaveBeenCalledTimes(health==='unhealthy'?2:1);expect(accept).toHaveBeenCalledOnce();
 ports.verify=withBrowserAcceptance(plan,root,async()=> 'healthy');
 expect(await recoverDeployment(plan,journal,ports,{sleep:async()=>{}})).toBe(expected[health]);expect(ports.deploy).toHaveBeenCalledTimes(health==='unhealthy'?2:1);
 if(health==='unhealthy')expect(ports.authorize).toHaveBeenLastCalledWith(plan,'rollback',expect.any(AbortSignal));
});
