import {event} from './telemetry';
import type {Env} from './types';
import type {JournalPhase} from './journal-phases';
// Stable positional schema. Missing phases are -1, never invented zero duration.
export const LOGOUT_SUMMARY_PHASES=['rate_limit','initial_authorization','guard','registration','work','checkpoint','receipt','retirement','close','r2_read','r2_write','database_status','database_page'] as const;
export interface LogoutTiming extends JournalTiming {finish(confirmed:boolean):void}
export interface JournalTiming {record(phase:JournalPhase,durationMs:number):void}
export function logoutJournalTiming(env:Pick<Env,'ENVIRONMENT'|'METRICS'|'LOGOUT_PHASE_TIMING'>,request?:{method:string;path:string}):LogoutTiming|undefined {
 if(env.LOGOUT_PHASE_TIMING!=='true'||!['staging','production'].includes(env.ENVIRONMENT)||request?.method!=='POST'||request.path!=='/api/auth/sign-out')return;
 const durations=new Map<string,number>();let finished=false,start:number|undefined;
 try{start=performance.now();}catch{}
 return {record(phase,durationMs){
  event('journal_phase',{route:'/api/auth/sign-out',method:'POST',code:phase,durationMs},env);
  if(finished||!LOGOUT_SUMMARY_PHASES.includes(phase as typeof LOGOUT_SUMMARY_PHASES[number])||!Number.isFinite(durationMs)||durationMs<0||durationMs>3_600_000)return;
  durations.set(phase,Math.min(3_600_000,(durations.get(phase)??0)+durationMs));
 },finish(confirmed){
  if(finished)return;finished=true;
  try{
   if(typeof confirmed!=='boolean'||start===undefined)return;
   const elapsed=performance.now()-start;if(!Number.isFinite(elapsed)||elapsed<0||elapsed>3_600_000)return;
   const result:unknown=env.METRICS?.writeDataPoint({indexes:['logout_summary:/api/auth/sign-out'],blobs:['porchday_logout_summary_v1',env.ENVIRONMENT,'logout_summary','/api/auth/sign-out','POST'],doubles:[Math.round(elapsed),confirmed?1:0,...LOGOUT_SUMMARY_PHASES.map(phase=>durations.has(phase)?Math.round(durations.get(phase)!):-1)]});
   if(result&&typeof (result as PromiseLike<unknown>).then==='function')void Promise.resolve(result).catch(()=>{});
  }catch{/* A diagnostic must never change the logout outcome or add a retry. */}
 }};
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
