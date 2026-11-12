import {syntheticJournalRecords} from './records';
/** Isolated single-use diagnostic controller. Never an application entry point. */
export {JournalStoreProbe} from './worker';
type Env={PROBE:DurableObjectNamespace;PROBE_TOKEN:string;PROBE_RUN:string;PROBE_EXPIRES:string};
type Span={operation:'read'|'write';durationMs:number;outcome:'success'|'error'};
export default {async fetch(request:Request,env:Env):Promise<Response>{
 const expiry=Date.parse(env.PROBE_EXPIRES);
 if(!/^[a-f0-9]{32}$/.test(env.PROBE_RUN??'')||!Number.isFinite(expiry)||Date.now()>=expiry||expiry>Date.now()+15*60000||!env.PROBE_TOKEN||env.PROBE_TOKEN.length<32)return new Response(null,{status:404});
 // Hash both fixed-size values before comparison; never echo credentials.
 const supplied=request.headers.get('authorization')??'';
 if(supplied.length>512)return new Response(null,{status:404});
 const hash=async(value:string)=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
 const [actual,wanted]=await Promise.all([hash(supplied),hash('Bearer '+env.PROBE_TOKEN)]);let difference=0;
 for(let i=0;i<actual.length;i++)difference|=actual[i]^wanted[i];
 if(difference)return new Response(null,{status:404});
 const path=new URL(request.url).pathname;
 if(!((request.method==='POST'&&path==='/run')||(request.method==='GET'&&path==='/result')))return new Response(null,{status:404});
 const stub=env.PROBE.get(env.PROBE.idFromName('single-use-'+env.PROBE_RUN));
 const prefix='synthetic/'+env.PROBE_RUN+'/';
 async function io(kind:'get'|'put',key:string,value?:string,etag?:string){
  const remaining=expiry-Date.now();if(remaining<=0)throw Error('PROBE_EXPIRED');
  const response=await stub.fetch('https://probe.invalid/'+kind,{method:'POST',signal:AbortSignal.timeout(Math.min(10000,remaining)),body:JSON.stringify(kind==='get'?{key:prefix+key}:{key:prefix+key,value,onlyIf:etag?{etagMatches:etag}:{etagDoesNotMatch:'*'}})});
  if(response.status!==200){await response.arrayBuffer();throw Error('PROBE_IO_FAILED');}
  return await response.json() as {value?:string;etag:string}|null;
 }
 try{
  if(path==='/result'){const result=await io('get','result');return result?.value?new Response(result.value,{headers:{'content-type':'application/json','cache-control':'no-store'}}):new Response(null,{status:409});}
  // Durable latch precedes setup and all measured work. Never retry an unknown run.
  const lease=await io('put','lease','started');if(!lease)return new Response(null,{status:409});
  const spans:Span[]=[];const startedAt=new Date().toISOString();let outcome='error',setupMs:number|null=null;
  const start=performance.now();let recordBytes:Record<string,number>|null=null;
  try{
   const setup=performance.now();const {records,bytes}=await syntheticJournalRecords();recordBytes=bytes;let expectedControl=records.root;let control=await io('put','control',records.root);if(!control)throw Error('PROBE_CONFLICT');setupMs=performance.now()-setup;
   const measured=async(kind:'get'|'put',key:string,value?:string,etag?:string)=>{
    const begin=performance.now();let result:Awaited<ReturnType<typeof io>>;let ok=false;
    try{result=await io(kind,key,value,etag);if(!result)throw Error('PROBE_CONFLICT');if(key==='control'){if(kind==='get'&&result.value!==expectedControl)throw Error('PROBE_BYTES_CHANGED');if(kind==='put')expectedControl=value!;}ok=true;return result;}
    finally{spans.push({operation:kind==='get'?'read':'write',durationMs:performance.now()-begin,outcome:ok?'success':'error'});}
   };
   await measured('get','control');
   await measured('put','intent',records.intent);
   control=await measured('get','control');
   control=await measured('put','control',records.registered,control.etag);
   control=await measured('get','control');
   await measured('put','batch',records.batch);
   control=await measured('put','control',records.checkpointed,control.etag);
   control=await measured('get','control');
   await measured('put','receipt',records.receipt);
   control=await measured('get','control');
   await measured('put','control',records.retired,control.etag);
   outcome='success';
  }catch{/* Preserve bounded numeric failure evidence, not provider diagnostics. */}
  const result={startedAt,endedAt:new Date().toISOString(),outcome,setupMs,recordBytes,totalWithSetupMs:performance.now()-start,spans,acceptanceClaim:false,shapeOnly:true};
  if(!await io('put','result',JSON.stringify(result)))throw Error('PROBE_RESULT_CONFLICT');
  return Response.json(result,{status:outcome==='success'?200:503,headers:{'cache-control':'no-store'}});
 }catch{return new Response(null,{status:503});}
}};
