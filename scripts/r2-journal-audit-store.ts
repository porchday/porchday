import {createHash} from 'node:crypto';
import type {JournalStore} from '../apps/api/src/privacy-journal.js';

type Options={accountId:string;apiToken:string;bucket:string;signal:AbortSignal;fetch?:typeof fetch};
const limit=1024*1024;

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
  const signal=AbortSignal.any([this.options.signal,AbortSignal.timeout(10000)]);
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  let onAbort:(()=>void)|undefined;
  const stopped=new Promise<never>((_,reject)=>{onAbort=()=>reject(Error('R2_AUDIT_READ_FAILED'));signal.addEventListener('abort',onAbort,{once:true});});
  try{
   signal.throwIfAborted();
   const response=await Promise.race([(this.options.fetch??fetch)(`https://api.cloudflare.com/client/v4/accounts/${this.options.accountId}/r2/buckets/${this.options.bucket}/objects/${encodeURIComponent(key)}`,{method:'GET',headers:{Authorization:'Bearer '+this.options.apiToken},redirect:'error',signal}),stopped]);
   signal.throwIfAborted();
   if(response.status===404){void response.body?.cancel().catch(()=>{});return null;}
   if(response.status!==200||!response.body){void response.body?.cancel().catch(()=>{});throw Error('R2_AUDIT_READ_FAILED');}
   reader=response.body.getReader();
   const declared=response.headers.get('content-length');
   if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>limit))throw Error('R2_AUDIT_OBJECT_LIMIT');
   const chunks:Uint8Array[]=[];let bytes=0;
   for(;;){
    const result=await Promise.race([reader.read(),stopped]);signal.throwIfAborted();
    if(result.done)break;
    bytes+=result.value.byteLength;if(bytes>limit)throw Error('R2_AUDIT_OBJECT_LIMIT');chunks.push(result.value);
   }
   const content=Buffer.concat(chunks),text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(content);
   return{etag:'audit-content-sha256:'+createHash('sha256').update(content).digest('hex'),text:async()=>text};
  }catch(error){
   // Never propagate a provider response, URL, key, credential or fetch error.
   if(error instanceof Error&&error.message==='R2_AUDIT_OBJECT_LIMIT')throw error;
   throw Error('R2_AUDIT_READ_FAILED');
  }finally{
   if(onAbort)signal.removeEventListener('abort',onAbort);
   // Cancellation is cleanup, not permission to exceed the caller's deadline.
   if(reader)void reader.cancel().catch(()=>{});
  }
 }
}
