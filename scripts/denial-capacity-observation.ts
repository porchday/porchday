import {denialPartitions,partitionProgressKey,parsePartitionProgress,partitionCleanupHealth,type PartitionProgress} from '../apps/api/src/session-denial-partitions';

type ProgressReader={get:(key:string)=>Promise<{text:()=>Promise<string>}|null>};
/** Observation must not discard the failing range or mask healthy siblings.
 * These values are evidence, not acceptance. Existing runtime health decides
 * whether the complete set is healthy; no freshness threshold is duplicated. */
export async function observeDenialPartitions(store:ProgressReader,now?:number){
 const ranges=await Promise.all(denialPartitions.map(async partition=>{
  try{
   const object=await store.get(partitionProgressKey(partition));
   if(!object)return {partition,progress:null,error:'missing' as const};
   return {partition,progress:parsePartitionProgress(await object.text(),partition),error:null};
  }catch{return {partition,progress:null,error:'unavailable_or_invalid' as const};}
 }));
 const progress=ranges.map(value=>value.progress);
 const at=now??Date.now();
 try{return {at,ranges,health:partitionCleanupHealth(progress,at)};}
 catch{return {at,ranges,health:{issues:['session_denial_cleanup_unavailable'],snapshot:null}};}
}

export function allDenialPassesStartedAfter(progress:(PartitionProgress|null)[],at:number){
 if(progress.length!==3||!Number.isSafeInteger(at)||at<=0)return false;
 return progress.every((p,index)=>p?.partition===index&&p.lastPass!==null&&p.lastPass.completedAt-p.lastPass.durationMs>=at);
}

type Readers=Record<string,()=>Promise<unknown>>;
type Observations<T extends Readers>={[K in keyof T]:
 | {ok:true;startedAt:number;completedAt:number;value:Awaited<ReturnType<T[K]>>}
 | {ok:false;startedAt:number;completedAt:number;error:'observation_failed'}};
/** Each supplied operation runs exactly once, in order. Preserve successful
 * reads even if another fails. Callers supply bounded operations and persist
 * privately before asserting acceptance. Raw exception text can contain secrets
 * and must never enter the report. A failed save propagates and never retries. */
export async function captureDenialCapacitySample<T extends Readers>(readers:T,persist:(sample:{startedAt:number;completedAt:number;observations:Observations<T>})=>void|Promise<void>){
 const startedAt=Date.now(),observations={} as Observations<T>;
 for(const key of Object.keys(readers) as (keyof T)[]){
  const at=Date.now();
  try{const value=await readers[key]();observations[key]={ok:true,startedAt:at,completedAt:Date.now(),value} as Observations<T>[typeof key];}
  catch{observations[key]={ok:false,startedAt:at,completedAt:Date.now(),error:'observation_failed'};}
 }
 const sample={startedAt,completedAt:Date.now(),observations};await persist(sample);return sample;
}
