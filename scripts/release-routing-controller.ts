import {recoverRouting,type RoutingPorts} from './domain-routing-recovery.ts';
import type {DeploymentPlan,DeploymentPorts} from './deployment-recovery.ts';

/** Restore domains before authorizing a Worker rollback intent. If interrupted,
 * the routing journal's rollback direction survives and cannot be promoted.
 */
export function withRoutingRecovery(plan:DeploymentPlan,ports:DeploymentPorts,routing:RoutingPorts):DeploymentPorts {
 if(!plan.routing)throw Error('ROUTING_PLAN_REQUIRED');
 const routePlan=structuredClone(plan.routing);
 const bounded=(signal:AbortSignal):RoutingPorts=>{
  const run=async<T>(work:()=>Promise<T>)=>{signal.throwIfAborted();const value=await work();signal.throwIfAborted();return value;};
  return{read:()=>run(()=>routing.read()),write:(p,n)=>run(()=>routing.write(p,n)),authorize:p=>run(()=>routing.authorize(p)),observe:h=>run(()=>routing.observe(h)),assign:t=>run(()=>routing.assign(t,signal))};
 };
 return {...ports,
  async verify(version,signal){
   if(version===plan.candidateVersion){
    signal.throwIfAborted();
    const state=await routing.read();
    if(state?.direction==='rollback')return 'unhealthy';
    const result=await recoverRouting(routePlan,bounded(signal));
    signal.throwIfAborted();
    if(result!=='complete')return 'unknown';
   }
   return ports.verify(version,signal);
  },
  async authorize(input,direction,signal){
   await ports.authorize(input,direction,signal);
   if(direction==='rollback'){
    signal.throwIfAborted();
    const result=await recoverRouting(routePlan,bounded(signal),true);
    if(result!=='rolled-back')throw Error('ROUTING_ROLLBACK_UNCONFIRMED');
    signal.throwIfAborted();
   }
  },
 };
}
