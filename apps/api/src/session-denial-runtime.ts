import {Pool} from 'pg';
import type {Env,DenialJob} from './types';
import type {JournalStore} from './privacy-journal';
import {trackPool} from './connection-metrics';
import {CandidateTimings} from './session-denial-timing';
import {denialDeliveryQueue,isolatedDenialDelivery} from './session-denial-delivery';
import {DenialCleanupError,deleteDeniedSession} from './session-denial-cleanup';
import {deleteDeniedSessionBatch} from './session-denial-batch';
import {drainSessionCandidates,readCandidateCleanupHealth,type CandidateSweepResult} from './session-denial-candidates';
import {denialPartitions,partitionProgressKey,partitionStore,parsePartitionProgress,partitionCleanupHealth,listPartitionCandidates,type DenialPartition} from './session-denial-partitions';

type ModeEnv=Partial<Pick<Env,'SESSION_DENIAL_CLEANUP_V1'|'SESSION_DENIAL_PARTITIONS_V1'|'SESSION_DENIAL_QUEUE_TOPOLOGY_V1'|'ENVIRONMENT'|'DENIAL_RANGE_0'|'DENIAL_RANGE_1'|'DENIAL_RANGE_2'>>;
export function denialCleanupMode(env:ModeEnv):'disabled'|'shadow'|'dual'|'active'{
 const mode=env.SESSION_DENIAL_PARTITIONS_V1??'disabled';
 if(!['disabled','shadow','dual','active'].includes(mode)||mode!=='disabled'&&env.SESSION_DENIAL_CLEANUP_V1!=='true')throw new DenialCleanupError();
 return mode as 'disabled'|'shadow'|'dual'|'active';
}
function partitionId(value:unknown):DenialPartition{if(!denialPartitions.includes(value as DenialPartition))throw new DenialCleanupError();return value as DenialPartition;}
function rawToken(partition:DenialPartition,token:string){
 const prefix=`v4:${partition}:`;
 if(typeof token!=='string'||!token.startsWith(prefix)||token.length<=prefix.length||token.length>prefix.length+256)throw new DenialCleanupError();
 return token.slice(prefix.length);
}
async function bounded<T>(work:()=>Promise<T>,ms:number):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new DenialCleanupError()),ms);})]);}
 finally{if(timer!==undefined)clearTimeout(timer);}
}
async function send(env:Pick<Env,'JOBS'>&ModeEnv&Partial<Pick<Env,'METRICS'>>,job:DenialJob){
 const queue=denialDeliveryQueue(env,job),timing=new CandidateTimings();try{await timing.run('enqueue',()=>bounded(()=>queue.send(job),5000));}finally{if(env.ENVIRONMENT)timing.flush({ENVIRONMENT:env.ENVIRONMENT,METRICS:env.METRICS});}
}
/** The deployed queue consumer cap must be verified before opting into any
 * partition mode. This fanout is fixed; arbitrary messages cannot add ranges. */
export async function scheduleDenialCleanup(env:Pick<Env,'JOBS'>&ModeEnv){
 const mode=denialCleanupMode(env);isolatedDenialDelivery(env);if(env.SESSION_DENIAL_CLEANUP_V1!=='true')return;
 const jobs:DenialJob[]=[];if(mode!=='active')jobs.push({kind:'session_denial_cleanup'});
 if(mode!=='disabled')for(const partition of denialPartitions)jobs.push({kind:'session_denial_cleanup_partition',denialPartition:partition});
 const outcomes=await Promise.allSettled(jobs.map(job=>send(env,job)));
 if(outcomes.some(value=>value.status==='rejected'))throw new DenialCleanupError();
}
export async function enqueuePartitionContinuation(env:Pick<Env,'JOBS'>&ModeEnv,partition:DenialPartition,token:string){
 partitionId(partition);rawToken(partition,token);if(denialCleanupMode(env)==='disabled')return;
 await send(env,{kind:'session_denial_cleanup_partition',denialPartition:partition,denialProgressEtag:token});
}
export async function cleanupDenialPartition(env:Env,value:unknown,token?:string):Promise<CandidateSweepResult>{
 if(denialCleanupMode(env)==='disabled')return {seen:0,deleted:0,invalid:0,advanced:false};
 const partition=partitionId(value),expected=token===undefined?undefined:rawToken(partition,token);
 if(!env.RECOVERY_JOURNAL)throw new DenialCleanupError();
 const timing=new CandidateTimings();
 try{return await timing.run('total',async()=>{
  const pool=trackPool(env,'auth',new Pool({connectionString:env.HYPERDRIVE_AUTH.connectionString,max:1,connectionTimeoutMillis:10000,idleTimeoutMillis:1000}));
  try{
   const result=await drainSessionCandidates(partitionStore(env.RECOVERY_JOURNAL as JournalStore,partition),after=>listPartitionCandidates(pool,partition,after),id=>deleteDeniedSession(pool,id),expected,timing,(ids,deadline)=>deleteDeniedSessionBatch(pool,ids,deadline));
   return {...result,...(result.continuation?{continuation:`v4:${partition}:${result.continuation}`}:{})};
  }finally{await timing.run('pool_close',()=>pool.end());}
 });}finally{timing.flush(env);}
}
export async function readManagedDenialCleanupHealth(env:ModeEnv&Partial<Pick<Env,'RECOVERY_JOURNAL'>>){
 try{
  const mode=denialCleanupMode(env);
  isolatedDenialDelivery(env);
  // Dual keeps legacy work running but shares active readiness, making it a
  // rollback target after v3 progress ages out. Never mix partial range proofs.
  if(mode==='disabled'||mode==='shadow')return await readCandidateCleanupHealth(env);
  if(!env.RECOVERY_JOURNAL)throw new DenialCleanupError();
  const progress=await bounded(()=>Promise.all(denialPartitions.map(async partition=>{
   const object=await env.RECOVERY_JOURNAL!.get(partitionProgressKey(partition));
   return object?parsePartitionProgress(await object.text(),partition):null;
  })),2000);
  return partitionCleanupHealth(progress);
 }catch{return {issues:['session_denial_cleanup_unavailable'],snapshot:null};}
}
