import {deploymentTarget} from './deployment-recovery.ts';
/** Upload scope is intentionally broader than activation scope. Monitor
 * activation needs monitor-specific canonical-state and health verification. */
export function uploadTarget(worker:string){
 const match=/^porchday-monitor-(staging|production)$/.exec(worker);
 if(match){const environment=match[1] as 'staging'|'production';return {environment,frontend:false,application:'monitor' as const,key:('monitor-'+environment) as 'monitor-staging'|'monitor-production'};}
 const target=deploymentTarget(worker);
 return {...target,application:'api' as const,key:target.key as 'staging'|'production'|'staging-edge'|'production-edge'};
}
