import {deploymentPlanHash,type DeploymentPlan,type RecoveryJournal,type DeploymentObservation} from './deployment-recovery.ts';
import type {FileDeploymentLease} from './deployment-recovery-lease.ts';
import {routingPlanHash,type RoutingPorts,type RoutingState} from './domain-routing-recovery.ts';

/** Bind every domain PUT to the same exclusive lease and candidate deployment.
 * Inventory verification must check all collateral resources as well as the
 * exact prefix of moved domains. It is repeated after read-only observations.
 */
export function leasedRoutingPorts(options:{plan:DeploymentPlan;lease:Pick<FileDeploymentLease,'assert'>;deploymentJournal:RecoveryJournal;routingJournal:Pick<RoutingPorts,'read'|'write'>;observeDeployment:(signal:AbortSignal)=>Promise<DeploymentObservation>;verifyInventory:(completed:number,signal:AbortSignal)=>Promise<void>;provider:Pick<RoutingPorts,'observe'|'assign'>;signal:AbortSignal}):RoutingPorts {
 const plan=structuredClone(options.plan),hash=deploymentPlanHash(plan),routing=plan.routing;
 if(!routing)throw Error('ROUTING_PLAN_REQUIRED');
 const {lease,deploymentJournal,routingJournal,provider,signal}=options;
 const identity=async()=>{
  signal.throwIfAborted();lease.assert(plan,signal);
  const state=await deploymentJournal.read();
  if(state?.planHash!==hash||!['candidate-observed','rollback-intent'].includes(state.phase))throw Error('ROUTING_DEPLOYMENT_PHASE_INVALID');
  const observed=await options.observeDeployment(signal);
  if(observed.version!==plan.candidateVersion||observed.operationId!==plan.operationId||observed.deploymentId!==state.candidateDeploymentId)throw Error('ROUTING_DEPLOYMENT_CHANGED');
  lease.assert(plan,signal);signal.throwIfAborted();
 };
 const progress=async(state:RoutingState|null)=>{
  let count=state?.completed??0;
  if(state?.intent){
   const forward=state.direction==='forward',move=routing.moves[forward?count:count-1];
   if(!move)throw Error('ROUTING_PROGRESS_INVALID');
   const observed=await provider.observe(move.before.hostname),desired=forward?move.after:move.before;
   if(observed.service===desired.service)count+=forward?1:-1;
  }
  await options.verifyInventory(count,signal);
 };
 return {
  read:()=>routingJournal.read(),write:(previous,next)=>routingJournal.write(previous,next),
  authorize:async input=>{if(routingPlanHash(input)!==routingPlanHash(routing))throw Error('ROUTING_PLAN_CHANGED');await identity();await progress(await routingJournal.read());await identity();},
  observe:async hostname=>{await identity();return provider.observe(hostname);},
  assign:async target=>{
   await identity();const state=await routingJournal.read();
   if(!state?.intent||state.planHash!==routingPlanHash(routing))throw Error('ROUTING_INTENT_REQUIRED');
   const move=routing.moves[state.direction==='forward'?state.completed:state.completed-1],expected=state.direction==='forward'?move?.after:move?.before;
   if(!expected||JSON.stringify(target)!==JSON.stringify(expected))throw Error('ROUTING_WRITE_NOT_AUTHORIZED');
   await progress(state);await identity();await provider.assign(target);
  },
 };
}
