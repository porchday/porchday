import {it,expect,vi} from 'vitest';
import {withRoutingRecovery} from './release-routing-controller.ts';
import {recoverDeployment,deploymentPlanHash,type DeploymentPlan,type RecoveryState,type DeploymentObservation} from './deployment-recovery.ts';
import type {RoutingState,RoutingPorts} from './domain-routing-recovery.ts';
const uuid=(n:number)=>n.toString().padStart(8,'0')+'-0000-0000-0000-000000000000';
const before={hostname:'staging.porchday.com',service:'porchday-staging',environment:'production',zoneId:'a'.repeat(32)},after={...before,service:'porchday-staging-edge'};
const plan:DeploymentPlan={operationId:uuid(1),worker:after.service,candidateVersion:uuid(2),baselineVersion:uuid(3),baselineDeploymentId:uuid(4),candidateSource:'a'.repeat(40),compatibleRollbackVersions:[uuid(3)],evidenceDigest:'b'.repeat(64),backendVersion:uuid(8),backendReaderFloor:uuid(9),routing:{operationId:uuid(1),moves:[{before,after}]}};
it.each(['forward','rollback'] as const)('does not dispatch routing work after cancellation during %s authorization',async direction=>{
 const controller=new AbortController(),events:string[]=[];
 const ports=withRoutingRecovery(plan,{authorize:async()=>{},observe:async()=>({version:plan.candidateVersion,deploymentId:uuid(5),operationId:plan.operationId}),deploy:async()=>{},verify:async()=> 'healthy'}, {
  read:async()=>null,write:async()=>{events.push('write');},authorize:async()=>{await Promise.resolve();controller.abort(Error('cancelled'));},observe:async()=>{events.push('observe');return before;},assign:async()=>{events.push('assign');}
 });
 const operation=direction==='forward'?ports.verify(plan.candidateVersion,controller.signal):ports.authorize(plan,'rollback',controller.signal);
 await expect(operation).rejects.toThrow('cancelled');expect(events).toEqual([]);
});
it('rejects a trial marker outside a pinned API/domain operation',()=>{
 expect(()=>deploymentPlanHash({...plan,placementTrial:true})).toThrow('TRIAL_SCOPE_INVALID');
 const api:DeploymentPlan={...plan,worker:before.service,backendVersion:undefined,backendReaderFloor:undefined,routingFrontendVersion:uuid(20),placementTrial:true};
 expect(()=>deploymentPlanHash({...api,placementTrial:false as true})).toThrow('TRIAL_SCOPE_INVALID');
 expect(()=>deploymentPlanHash({...api,routingFrontendVersion:undefined})).toThrow('TRIAL_SCOPE_INVALID');
 expect(deploymentPlanHash(api)).not.toBe(deploymentPlanHash({...api,placementTrial:undefined}));
});
it.each(['healthy','unhealthy','unknown'] as const)('holds API and routing outcome through the %s placement trial',async outcome=>{
 const p:DeploymentPlan={...plan,worker:before.service,backendVersion:undefined,backendReaderFloor:undefined,routingFrontendVersion:uuid(20),placementTrial:true};
 let deployment:RecoveryState|null=null,routingState:RoutingState|null=null,target=before;
 let observed:DeploymentObservation={version:p.baselineVersion,deploymentId:p.baselineDeploymentId,operationId:null};
 const events:string[]=[];
 const ports=withRoutingRecovery(p,{authorize:async()=>{},observe:async()=>observed,deploy:async(v,id)=>{events.push('worker:'+v);observed={version:v,operationId:id,deploymentId:uuid(v===p.candidateVersion?5:6)};},verify:async()=> 'healthy',trial:async()=>{
  expect(deployment?.phase).toBe('candidate-observed');expect(target.service).toBe(after.service);events.push('trial');return outcome;
 }},{read:async()=>routingState,write:async(_p,n)=>{routingState=n;},authorize:async()=>{},observe:async()=>target,assign:async t=>{target=t;events.push('domain:'+t.service);}});
 expect(await recoverDeployment(p,{read:async()=>deployment,write:async(_p,n)=>{deployment=n;}},ports)).toBe(outcome==='healthy'?'complete':outcome==='unhealthy'?'rolled-back':'verification-unavailable');
 expect(events).toEqual(['worker:'+p.candidateVersion,'domain:'+after.service,'trial',...(outcome==='unhealthy'?['domain:'+before.service,'worker:'+p.baselineVersion]:[])]);
 expect(deployment?.planHash).toBe(deploymentPlanHash(p));
});
it.each([false,true])('coordinates Worker activation and domain recovery (unhealthy=%s)',async unhealthy=>{
 let deployment:RecoveryState|null=null,routingState:RoutingState|null=null,target=before;
 let observed:DeploymentObservation={version:plan.baselineVersion,deploymentId:plan.baselineDeploymentId,operationId:null};
 const events:string[]=[];
 const routing:RoutingPorts={read:async()=>routingState,write:async(_p,n)=>{routingState=n;},authorize:async()=>{},observe:async()=>target,assign:async t=>{target=t;events.push('domain:'+t.service);}};
 const ports=withRoutingRecovery(plan,{authorize:async()=>{},observe:async()=>observed,deploy:async(v,id)=>{events.push('worker:'+v);observed={version:v,operationId:id,deploymentId:uuid(v===plan.candidateVersion?5:6)};},verify:async v=>{expect(target.service).toBe(v===plan.candidateVersion?after.service:before.service);return unhealthy&&v===plan.candidateVersion?'unhealthy':'healthy';}},routing);
 const result=await recoverDeployment(plan,{read:async()=>deployment,write:async(_p,n)=>{deployment=n;}},ports);
 expect(result).toBe(unhealthy?'rolled-back':'complete');
 expect(events).toEqual(['worker:'+plan.candidateVersion,'domain:'+after.service,...(unhealthy?['domain:'+before.service,'worker:'+plan.baselineVersion]:[])]);
});
it('resumes interrupted domain rollback without returning to forward routing',async()=>{
 let deployment:RecoveryState|null=null,routingState:RoutingState|null=null,target=before,interrupt=true;
 let observed:DeploymentObservation={version:plan.baselineVersion,deploymentId:plan.baselineDeploymentId,operationId:null};
 const assignments:string[]=[];
 const routing:RoutingPorts={read:async()=>routingState,write:async(_p,n)=>{routingState=n;},authorize:async()=>{},observe:async()=>{if(target.service===before.service&&assignments.length===2&&interrupt){interrupt=false;throw Error('interruption');}return target;},assign:async t=>{target=t;assignments.push(t.service);}};
 const ports=withRoutingRecovery(plan,{authorize:async()=>{},observe:async()=>observed,deploy:async(v,id)=>{observed={version:v,operationId:id,deploymentId:uuid(v===plan.candidateVersion?5:6)};},verify:async v=>v===plan.candidateVersion?'unhealthy':'healthy'},routing);
 const journal={read:async()=>deployment,write:async(_p:RecoveryState|null,n:RecoveryState)=>{deployment=n;}};
 await expect(recoverDeployment(plan,journal,ports)).rejects.toThrow('interruption');
 expect(await recoverDeployment(plan,journal,ports)).toBe('rolled-back');expect(assignments).toEqual([after.service,before.service]);
});

it('allows bounded multi-step routing verification and restoration before Worker rollback',async()=>{
 vi.useFakeTimers();
 try{
  let deployment:RecoveryState|null=null,routingState:RoutingState|null=null,target=before;
  let observed:DeploymentObservation={version:plan.baselineVersion,deploymentId:plan.baselineDeploymentId,operationId:null};
  const assignments:string[]=[];
  const ports=withRoutingRecovery(plan,{authorize:async()=>{},observe:async()=>observed,deploy:async(v,id)=>{observed={version:v,operationId:id,deploymentId:uuid(v===plan.candidateVersion?5:6)};},verify:async v=>v===plan.candidateVersion?'unhealthy':'healthy'}, {
   read:async()=>routingState,write:async(_p,n)=>{routingState=n;},authorize:async()=>{},observe:async()=>target,
   assign:async(t,signal)=>{await new Promise(r=>setTimeout(r,t.service===after.service?50000:20000));signal?.throwIfAborted();target=t;assignments.push(t.service);}
  });
  const pending=recoverDeployment(plan,{read:async()=>deployment,write:async(_p,n)=>{deployment=n;}},ports);
  await vi.advanceTimersByTimeAsync(70001);
  expect(await pending).toBe('rolled-back');expect(assignments).toEqual([after.service,before.service]);
 }finally{vi.useRealTimers();}
});
