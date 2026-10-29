import {setTimeout as sleep} from 'node:timers/promises';
export type ContinuityCheck={name:'authorized_profile'|'authorized_feed'|'denied_profile'|'protected_readiness';ok:boolean;status?:number;failure?:'transport_or_response';durationMs:number};
export type ContinuitySample={at:string;completedAt:string;healthy:boolean;checks:ContinuityCheck[];scope:'existing_session_reads_denial_and_readiness'};
type Target={environment:'staging'|'production';memberId:string;cookie:string;deniedCookie:string;healthToken:string};
function validate(target:Target){
 if(!target||!['staging','production'].includes(target.environment)||!/^[a-f0-9-]{36}$/i.test(target.memberId))throw Error('CONTINUITY_SCOPE_INVALID');
 for(const value of [target.cookie,target.deniedCookie,target.healthToken])if(typeof value!=='string'||!value||value.length>8192||/[\r\n]/.test(value))throw Error('CONTINUITY_CREDENTIAL_INVALID');
 if(target.cookie===target.deniedCookie)throw Error('CONTINUITY_SESSIONS_NOT_DISTINCT');
}
async function withinSignal<T>(signal:AbortSignal,work:()=>Promise<T>):Promise<T>{
 signal.throwIfAborted();let abort!:()=>void;
 const stopped=new Promise<never>((_,reject)=>{abort=()=>reject(Error('CONTINUITY_DEADLINE'));signal.addEventListener('abort',abort,{once:true});});
 try{return await Promise.race([work(),stopped]);}finally{signal.removeEventListener('abort',abort);}
}
async function boundedJson(response:Response,signal:AbortSignal,assert:()=>void):Promise<any>{
 if(!response.body)throw Error('CONTINUITY_RESPONSE_INVALID');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
 try{for(;;){assert();const {done,value}=await withinSignal(signal,()=>reader.read());assert();if(done)break;length+=value.length;if(length>65536)throw Error('CONTINUITY_RESPONSE_TOO_LARGE');chunks.push(value);}
  return JSON.parse(Buffer.concat(chunks).toString());
 }finally{void reader.cancel().catch(()=>{});}
}

/** Read-only sample for an already established isolated synthetic session.
 * The caller owns durable fixture/login/logout records, release coordination,
 * scheduling and append-only sample retention. Check the lease/fixture scope at
 * every I/O boundary through assertScope. Never use this as release authorization
 * or substitute it for exact source/schema/assets and new-login verification. */
export async function probeReleaseContinuity(options:{target:Target;assertScope:()=>void;fetch?:typeof fetch;timeoutMs?:number},signal:AbortSignal):Promise<ContinuitySample>{
 const target=structuredClone(options.target);validate(target);
 const timeout=options.timeoutMs??5000;if(!Number.isSafeInteger(timeout)||timeout<100||timeout>10000)throw Error('CONTINUITY_DEADLINE_INVALID');
 const assert=()=>{signal.throwIfAborted();options.assertScope();};assert();
 const at=new Date().toISOString(),bounded=AbortSignal.any([signal,AbortSignal.timeout(timeout)]),transport=options.fetch??fetch;
 const origin=target.environment==='staging'?'https://staging.porchday.com':'https://porchday.org';
 const read=async(name:ContinuityCheck['name'],path:string,headers:Record<string,string>,test:(response:Response,body:any)=>boolean):Promise<ContinuityCheck>=>{
  assert();const started=Date.now();let check:ContinuityCheck;
  try{
   const response=await withinSignal(bounded,async()=>{
    const response=await transport(origin+path,{method:'GET',headers,redirect:'error',signal:bounded});
    if(bounded.aborted){void response.body?.cancel().catch(()=>{});bounded.throwIfAborted();}
    return response;
   });assert();
   const body=await boundedJson(response,bounded,assert);assert();
   check={name,status:response.status,ok:test(response,body),durationMs:Date.now()-started};
  }catch{
   assert();check={name,ok:false,failure:'transport_or_response',durationMs:Date.now()-started};
  }
  return check;
 };
 const checks=await Promise.all([
  read('authorized_profile','/api/v1/me?bootstrap=1',{Cookie:target.cookie},(r,b)=>r.status===200&&b?.id===target.memberId&&!!r.headers.get('cache-control')?.includes('no-store')),
  read('authorized_feed','/api/v1/feed?limit=1',{Cookie:target.cookie},(r,b)=>r.status===200&&Array.isArray(b?.items)&&b.items.length===0&&!!r.headers.get('cache-control')?.includes('no-store')),
  read('denied_profile','/api/v1/me?bootstrap=1',{Cookie:target.deniedCookie},r=>r.status===401),
  read('protected_readiness','/api/operations/health',{Authorization:'Bearer '+target.healthToken},(r,b)=>r.status===200&&b?.status==='ok'&&Array.isArray(b.issues)&&b.issues.length===0),
 ]);
 assert();return {at,completedAt:new Date().toISOString(),healthy:checks.every(c=>c.ok),checks,scope:'existing_session_reads_denial_and_readiness'};
}

/** No overlapping samples, catch-up bursts, retries or discarded failed samples.
 * Stop is checked between samples; an in-flight sample finishes and is retained.
 * The caller must bracket activation/rollback with retained baseline and recovery
 * samples and preserve their release-journal milestones. A zero-failure summary
 * alone cannot establish that an activation occurred inside the observed window. */
export async function watchReleaseContinuity(options:{
 target:Target;assertScope:()=>void;fetch?:typeof fetch;timeoutMs?:number;
 stop:()=>boolean;retain:(index:number,sample:ContinuitySample)=>void|Promise<void>;
 intervalMs?:number;maxSamples?:number;
},signal:AbortSignal){
 const interval=options.intervalMs??2000,limit=options.maxSamples??120;
 if(!Number.isSafeInteger(interval)||interval<1000||interval>5000||!Number.isSafeInteger(limit)||limit<1||limit>120)throw Error('CONTINUITY_WATCH_SCOPE');
 let samples=0,failedSamples=0,maxStartGapMs=0,previous:number|undefined;
 for(;samples<limit;){
  signal.throwIfAborted();options.assertScope();if(options.stop())return {reason:'stopped' as const,samples,failedSamples,maxStartGapMs};
  const tick=performance.now();if(previous!==undefined)maxStartGapMs=Math.max(maxStartGapMs,tick-previous);previous=tick;
  const sample=await probeReleaseContinuity(options,signal);
  // Backpressure from the durable sink delays the next sample, never drops this one.
  await options.retain(samples,structuredClone(sample));samples++;if(!sample.healthy)failedSamples++;
  signal.throwIfAborted();options.assertScope();
  if(options.stop())return {reason:'stopped' as const,samples,failedSamples,maxStartGapMs};
  if(samples<limit)await sleep(Math.max(0,interval-(performance.now()-tick)),undefined,{signal});
 }
 return {reason:'sample_limit' as const,samples,failedSamples,maxStartGapMs};
}
