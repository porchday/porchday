import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import type {JournalStore} from '../apps/api/src/privacy-journal.js';

export type AuditReadAttempt={attempt:number;durationMs:number;outcome:'success'|'missing'|'failed';retry:boolean;stage?:'transport'|'headers'|'body'|'decode'|'deadline';status?:number};
type Options={accountId:string;apiToken:string;bucket:string;signal:AbortSignal;fetch?:typeof fetch;onReadAttempt?:(event:AuditReadAttempt)=>void};
const limit=1024*1024;
class ReadFailure extends Error {
 readonly retryable:boolean;readonly stage:AuditReadAttempt['stage'];readonly status:number|undefined;
 constructor(code:string,retryable:boolean,stage:AuditReadAttempt['stage'],status?:number){super(code);this.retryable=retryable;this.stage=stage;this.status=status;}
}

/** Content-only operator evidence reader. REST object responses need not have
 * strong ETags. The returned etag is a LOCAL content identifier for the legacy
 * JournalStore interface, never a provider precondition. Every write rejects.
 * Canonical ancestry/hash/intent validation remains the proof caller's job. */
export class R2JournalAuditStore implements JournalStore {
 private readonly options:Options;
 constructor(options:Options){
  if(!/^[a-f0-9]{32}$/i.test(options.accountId)||!options.apiToken||!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)||!options.signal)throw Error('R2_AUDIT_CONFIGURATION_INVALID');
  this.options={...options};
 }
 async put():Promise<never>{throw Error('R2_AUDIT_READ_ONLY');}
 async get(key:string):Promise<{etag:string;text():Promise<string>}|null>{
  if(!key||key.length>1024||key.split('/').some(p=>p==='.'||p==='..')||/[\x00-\x1f\x7f]/.test(key))throw Error('R2_AUDIT_KEY_INVALID');
  // Only GETs retry. Each attempt keeps its 10s deadline and the caller's
  // overall deadline remains authoritative. Never retry invalid proof bytes.
  const record=(event:AuditReadAttempt)=>{try{this.options.onReadAttempt?.({...event});}catch{throw Error('R2_AUDIT_EVIDENCE_FAILED');}};
  for(let attempt=1;attempt<=3;attempt++){
   const started=Date.now();let result;
   try{result=await this.readOnce(key);}catch(error){
    const failure=error instanceof ReadFailure?error:new ReadFailure('R2_AUDIT_READ_FAILED',false,'transport');
    const retry=failure.retryable&&attempt<3&&!this.options.signal.aborted;
    record({attempt,durationMs:Date.now()-started,outcome:'failed',retry,stage:failure.stage,...(failure.status===undefined?{}:{status:failure.status})});
    if(!retry)throw Error(failure.message);
    try{await sleep(250*attempt,undefined,{signal:this.options.signal});}catch{throw Error('R2_AUDIT_READ_FAILED');}
    continue;
   }
   record({attempt,durationMs:Date.now()-started,outcome:result?'success':'missing',retry:false});return result;
  }
  throw Error('R2_AUDIT_READ_FAILED');
 }
 private async readOnce(key:string):Promise<{etag:string;text():Promise<string>}|null>{
  const signal=AbortSignal.any([this.options.signal,AbortSignal.timeout(10000)]);
  let stage:AuditReadAttempt['stage']='transport',status:number|undefined;
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  let onAbort:(()=>void)|undefined;
  const stopped=new Promise<never>((_,reject)=>{onAbort=()=>reject(Error('R2_AUDIT_READ_FAILED'));signal.addEventListener('abort',onAbort,{once:true});});
  try{
   signal.throwIfAborted();
   const response=await Promise.race([(this.options.fetch??fetch)(`https://api.cloudflare.com/client/v4/accounts/${this.options.accountId}/r2/buckets/${this.options.bucket}/objects/${encodeURIComponent(key)}`,{method:'GET',headers:{Authorization:'Bearer '+this.options.apiToken},redirect:'error',signal}),stopped]);
   stage='headers';status=response.status;
   signal.throwIfAborted();
   if(response.status===404){void response.body?.cancel().catch(()=>{});return null;}
   if(response.status!==200||!response.body){void response.body?.cancel().catch(()=>{});throw Error('R2_AUDIT_READ_FAILED');}
   reader=response.body.getReader();
   const declared=response.headers.get('content-length');
   if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>limit))throw Error('R2_AUDIT_OBJECT_LIMIT');
   stage='body';const chunks:Uint8Array[]=[];let bytes=0;
   for(;;){
    const result=await Promise.race([reader.read(),stopped]);signal.throwIfAborted();
    if(result.done)break;
    bytes+=result.value.byteLength;if(bytes>limit)throw Error('R2_AUDIT_OBJECT_LIMIT');chunks.push(result.value);
   }
   stage='decode';const content=Buffer.concat(chunks),text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(content);
   return{etag:'audit-content-sha256:'+createHash('sha256').update(content).digest('hex'),text:async()=>text};
  }catch(error){
   // Never propagate a provider response, URL, key, credential or fetch error.
   const oversized=error instanceof Error&&error.message==='R2_AUDIT_OBJECT_LIMIT';
   const retryable=!oversized&&!this.options.signal.aborted&&(signal.aborted||stage==='transport'||stage==='body'||stage==='headers'&&status!==undefined&&[408,429,500,502,503,504].includes(status));
   throw new ReadFailure(oversized?'R2_AUDIT_OBJECT_LIMIT':'R2_AUDIT_READ_FAILED',retryable,signal.aborted?'deadline':stage,status);
  }finally{
   if(onAbort)signal.removeEventListener('abort',onAbort);
   // Cancellation is cleanup, not permission to exceed the caller's deadline.
   if(reader)void reader.cancel().catch(()=>{});
  }
 }
}
