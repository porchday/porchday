import {event} from './telemetry';
import type {Env} from './types';
import type {JournalPhase} from './journal-phases';
export interface JournalTiming {record(phase:JournalPhase,durationMs:number):void}
export function logoutJournalTiming(env:Pick<Env,'ENVIRONMENT'|'METRICS'|'LOGOUT_PHASE_TIMING'>,request?:{method:string;path:string}):JournalTiming|undefined {
 if(env.LOGOUT_PHASE_TIMING!=='true'||!['staging','production'].includes(env.ENVIRONMENT)||request?.method!=='POST'||request.path!=='/api/auth/sign-out')return;
 return {record:(phase,durationMs)=>event('journal_phase',{route:'/api/auth/sign-out',method:'POST',code:phase,durationMs},env)};
}
/** Diagnostic failures cannot replay work, change its value/error or delay it.
 * Nested I/O durations overlap enclosing phases; do not sum all dimensions.
 */
export async function measureJournalPhase<T>(timing:JournalTiming|undefined,phase:JournalPhase,work:()=>Promise<T>):Promise<T> {
 if(!timing)return work();
 let start:number|undefined;
 try{start=performance.now();}catch{}
 try{return await work();}
 finally{try{if(start!==undefined)timing.record(phase,performance.now()-start);}catch{}}
}
