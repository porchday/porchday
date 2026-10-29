import {event,DENIAL_CLEANUP_PHASES} from './telemetry';
import type {Env} from './types';
type Phase=typeof DENIAL_CLEANUP_PHASES[number];
/** One fixed aggregate per phase per invocation, including failed work. No
 * identifiers, errors or individual-object measurements leave this collector.
 * Phase timing uses batch wall time; a separate paired occupancy point sums
 * available and occupied read-slot time across successful batches only. */
export class CandidateTimings{
 private authority={slotsMs:0,busyMs:0,reads:0};
 private readonly totals=new Map<Phase,{durationMs:number;count:number}>();
 async run<T>(phase:Phase,work:()=>Promise<T>):Promise<T>{
  const start=Date.now();
  try{return await work();}
  finally{
   const value=this.totals.get(phase)??{durationMs:0,count:0};
   value.durationMs+=Math.max(0,Date.now()-start);value.count++;
   this.totals.set(phase,value);
  }
 }
 /** Successful batches only: failed batches can leave bounded observations in
  * flight. Their late completions must never mutate an already flushed record.
  * Pair available and occupied slot time in one point so sampling weights match.
  * Partial batches count only their actual reads, not hypothetical unused slots. */
 async authorityBatch<T>(work:Array<()=>Promise<T>>):Promise<T[]>{
  return this.run('authority_batches',async()=>{
   const observations:Array<{start:number;duration:number}>=[];
   const result=await Promise.all(work.map(async(run,index)=>{
    const start=Date.now();
    try{return await run();}
    finally{observations[index]={start,duration:Math.max(0,Date.now()-start)};}
   }));
   const end=Date.now();
   for(const observation of observations){
    this.authority.slotsMs+=Math.max(observation.duration,end-observation.start,0);
    this.authority.busyMs+=observation.duration;
    this.authority.reads++;
   }
   return result;
  });
 }
 flush(env:Pick<Env,'ENVIRONMENT'|'METRICS'>):void{
  for(const phase of DENIAL_CLEANUP_PHASES){
   const value=this.totals.get(phase);
   if(value)event('denial_cleanup_phase',{code:phase,...value},env);
  }
  if(this.authority.reads)event('denial_cleanup_authority',{
   durationMs:this.authority.slotsMs,detailMs:this.authority.busyMs,count:this.authority.reads,
  },env);
  this.authority={slotsMs:0,busyMs:0,reads:0};
  this.totals.clear();
 }
}
