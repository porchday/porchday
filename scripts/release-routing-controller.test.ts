import {it,expect} from 'vitest';
import {withRoutingRecovery} from './release-routing-controller.ts';
import {recoverDeployment,type DeploymentPlan,type RecoveryState,type DeploymentObservation} from './deployment-recovery.ts';
import type {RoutingState,RoutingPorts} from './domain-routing-recovery.ts';
const uuid=(n:number)=>n.toString().padStart(8,'0')+'-0000-0000-0000-000000000000';
const before={hostname:'staging.porchday.com',service:'porchday-staging',environment:'production',zoneId:'a'.repeat(32)},after={...before,service:'porchday-staging-edge'};
const plan:DeploymentPlan={operationId:uuid(1),worker:after.service,candidateVersion:uuid(2),baselineVersion:uuid(3),baselineDeploymentId:uuid(4),candidateSource:'a'.repeat(40),compatibleRollbackVersions:[uuid(3)],evidenceDigest:'b'.repeat(64),backendVersion:uuid(8),backendReaderFloor:uuid(9),routing:{operationId:uuid(1),moves:[{before,after}]}};
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
