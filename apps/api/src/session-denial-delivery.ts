import type {Env,DenialJob} from './types';
import {DenialCleanupError} from './session-denial-cleanup';
type DeliveryEnv=Partial<Pick<Env,'ENVIRONMENT'|'SESSION_DENIAL_QUEUE_TOPOLOGY_V1'|'SESSION_DENIAL_PARTITIONS_V1'|'SESSION_DENIAL_CLEANUP_V1'|'DENIAL_RANGE_0'|'DENIAL_RANGE_1'|'DENIAL_RANGE_2'>>;
const names=['DENIAL_RANGE_0','DENIAL_RANGE_1','DENIAL_RANGE_2'] as const;
export function isolatedDenialDelivery(env:DeliveryEnv){
 const topology=env.SESSION_DENIAL_QUEUE_TOPOLOGY_V1??'shared';
 if(topology==='shared')return false;
 if(topology!=='isolated'||!['development','staging','production'].includes(env.ENVIRONMENT??'')||env.SESSION_DENIAL_CLEANUP_V1!=='true'||!['shadow','dual','active'].includes(env.SESSION_DENIAL_PARTITIONS_V1??'')||names.some(name=>typeof env[name]?.send!=='function'))throw new DenialCleanupError();
 return true;
}
export function denialDeliveryQueue(env:DeliveryEnv&Pick<Env,'JOBS'>,job:DenialJob){
 const isolated=isolatedDenialDelivery(env);
 if(job.kind!=='session_denial_cleanup_partition')return env.JOBS;
 const partition=job.denialPartition;
 if(partition!==0&&partition!==1&&partition!==2)throw new DenialCleanupError();
 return isolated?env[names[partition]]!:env.JOBS;
}
/** Queue identity is provider metadata, never selected by a payload. Old
 * topology deliveries are obsolete: cron resumes the same persisted range.
 * Wrong-range or unrelated work on a range queue fails before opening SQL. */
export function denialDeliveryAction(env:DeliveryEnv,queue:string,job:DenialJob):'process'|'obsolete'{
 const isolated=isolatedDenialDelivery(env),range=[0,1,2].find(p=>queue===`porchday-${env.ENVIRONMENT}-denial-${p}`);
 if(range!==undefined){
  if(job.kind!=='session_denial_cleanup_partition'||job.denialPartition!==range)throw new DenialCleanupError();
  return isolated?'process':'obsolete';
 }
 if(!isolated)return 'process';
 if(queue!==`porchday-${env.ENVIRONMENT}-jobs`)throw new DenialCleanupError();
 return job.kind==='session_denial_cleanup_partition'?'obsolete':'process';
}
