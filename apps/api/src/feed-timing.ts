import {event,type FeedPhase} from './telemetry';
import type {Env} from './types';
import {activeTrace,recordTraceSpan} from './tracing';

export interface FeedTiming { record(phase:FeedPhase,durationMs:number):void }

/** No request objects, identities, correlation keys or response headers. */
export function feedTiming(env:Pick<Env,'ENVIRONMENT'|'FEED_PHASE_TIMING'|'METRICS'>,method:string,path:string):FeedTiming|undefined {
 if(env.ENVIRONMENT!=='staging'||env.FEED_PHASE_TIMING!=='true'||method!=='GET'||path!=='/api/v1/feed')return;
 return {record:(phase,durationMs)=>event('feed_phase',{route:'/api/v1/feed',method:'GET',code:phase,durationMs},env)};
}

export function recordFeedPhase(timing:FeedTiming|undefined,phase:FeedPhase,durationMs:number):void {
 try{timing?.record(phase,durationMs);}catch{/* Diagnostics are optional. */}
}

/** The operation, including its original error, always determines the result. */
export function measureFeedPhase<T>(timing:FeedTiming|undefined,phase:FeedPhase,work:()=>Promise<T>):Promise<T> {
 if(!timing)return work();
 const started=performance.now();
 return (async()=>{
  try{return await work();}
  finally{recordFeedPhase(timing,phase,performance.now()-started);}
 })();
}

/** Phase spans for an opted-in traced request when a caller supplies no timing. */
export function traceTiming():FeedTiming|undefined {
 return activeTrace()?{record:recordTraceSpan}:undefined;
}
