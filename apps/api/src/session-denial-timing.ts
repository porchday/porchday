import {event,DENIAL_CLEANUP_PHASES} from './telemetry';
import type {Env} from './types';
type Phase=typeof DENIAL_CLEANUP_PHASES[number];
/** One fixed aggregate per phase per invocation, including failed work. No
 * identifiers, errors or individual-object measurements leave this collector.
 * Concurrent authority reads are measured as batch wall time, not summed I/O. */
export class CandidateTimings{
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
 flush(env:Pick<Env,'ENVIRONMENT'|'METRICS'>):void{
  for(const phase of DENIAL_CLEANUP_PHASES){
   const value=this.totals.get(phase);
   if(value)event('denial_cleanup_phase',{code:phase,...value},env);
  }
  this.totals.clear();
 }
}
