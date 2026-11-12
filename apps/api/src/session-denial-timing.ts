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
 /** Measure a successful bounded read group. Scheduling stays with the caller.
  * Available time is group wall time times its configured worker count; occupied
  * time sums individual reads. Both share one point and sampling weight.
  * A failed group's late reads only touch local counters, never flushed totals. */
 async authorityBatch<T>(slots:number,work:(measure:<R>(read:()=>Promise<R>)=>Promise<R>)=>Promise<T>):Promise<T>{
  if(!Number.isInteger(slots)||slots<1||slots>6)throw Error('AUTHORITY_TIMING_SLOTS_INVALID');
  return this.run('authority_batches',async()=>{
   const started=Date.now();let busyMs=0,reads=0;
   const result=await work(async read=>{
    const start=Date.now();
    try{return await read();}
    finally{busyMs+=Math.max(0,Date.now()-start);reads++;}
   });
   if(reads){
    this.authority.slotsMs+=Math.max(busyMs,Math.max(0,Date.now()-started)*slots);
    this.authority.busyMs+=busyMs;this.authority.reads+=reads;
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
