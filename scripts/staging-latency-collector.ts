import {randomBytes} from 'node:crypto';
/** Bounded exploratory reads, not a load test or phone-performance claim. */
export const stagingOrigin='https://staging.porchday.com';
export type Plan={synthetic:true;origin:typeof stagingOrigin;cookie:string;memberId:string;postId:string;deployment:string;expiresAt:string;attempts:number;intervalMs:number;timeoutMs:number};
export type Sample={ordinal:number;operation:'read'|'feed';outcome:'success'|'error'|'timeout';elapsedMs:number;httpStatus:number|null;serverMs:number|null;phases:Record<string,number>};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const phaseNames=new Set(['worker','journal_check','journal_close','journal_r2','journal_db','auth_schema','auth_schema_wait','auth_session','auth_status','social_connect_begin','social_actor','social_query','social_commit','social_close']);
export function timing(header:string|null){
 const phases:Record<string,number>={},spans:Record<string,number>={};let total:number|null=null;
 // Accept only fixed numeric phases. Never retain trace IDs, routes or errors.
 for(const entry of (header??'').split(',')){
  const direct=/^\s*([a-z_-]+);dur=([0-9]+(?:\.[0-9]+)?)\s*$/.exec(entry);
  const span=/^\s*pd-span;dur=([0-9]+(?:\.[0-9]+)?);desc="([a-z_]+)@([0-9]+(?:\.[0-9]+)?)"\s*$/.exec(entry);
  const value=Number(direct?.[2]??span?.[1]);
  if(!Number.isFinite(value)||value>3_600_000)continue;
  if(direct?.[1]==='pd-total')total=value;
  else if(direct&&phaseNames.has(direct[1]))phases[direct[1]]=value;
  else if(span&&phaseNames.has(span[2]))spans[span[2]]=Math.min(3_600_000,(spans[span[2]]??0)+value);
 }
 // Summarized routes also emit spans: do not count the same work twice.
 for(const [name,value] of Object.entries(spans))if(!(name in phases))phases[name]=value;
 return {serverMs:total??phases.worker??null,phases};
}
export function validatePlan(plan:Plan,now:number){
 if(plan?.synthetic!==true||plan.origin!==stagingOrigin||typeof plan.cookie!=='string'||!plan.cookie||plan.cookie.length>8192||/[\r\n]/.test(plan.cookie)
  ||![plan.memberId,plan.postId,plan.deployment].every(id=>typeof id==='string'&&uuid.test(id))
  ||!Number.isFinite(Date.parse(plan.expiresAt))||Date.parse(plan.expiresAt)<=now||Date.parse(plan.expiresAt)>now+24*3600_000
  ||!Number.isInteger(plan.attempts)||plan.attempts<1||plan.attempts>100
  ||!Number.isInteger(plan.intervalMs)||plan.intervalMs<1000||plan.intervalMs>60000
  ||!Number.isInteger(plan.timeoutMs)||plan.timeoutMs<1000||plan.timeoutMs>15000)throw Error('INVALID_STAGING_LATENCY_PLAN');
}
export async function collect(plan:Plan,io:{fetch:typeof fetch;now:()=>number;monotonic:()=>number;sleep:(ms:number)=>Promise<void>;record:(sample:Sample)=>Promise<void>}){
 validatePlan(plan,io.now());
 const samples:Sample[]=[];const startedAt=new Date(io.now()).toISOString();
 let reason='complete',currentOperation:'read'|'feed'='read';
 const read=async(path:string,authenticated:boolean,onHeaders?:(response:Response)=>void)=>{
  const response=await io.fetch(stagingOrigin+path,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(plan.timeoutMs),headers:authenticated?{Cookie:plan.cookie,Origin:stagingOrigin,traceparent:`00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`}:{}});
  onHeaders?.(response);
  const reader=response.body?.getReader();if(!reader)throw Error('BODY');
  const chunks:Uint8Array[]=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>8*1024*1024){await reader.cancel();throw Error('BODY');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  const value=JSON.parse(new TextDecoder().decode(bytes));
  return {response,value};
 };
 const checkRelease=async()=>{const {response,value}=await read('/health',false);return response.status===200&&value.release===plan.deployment;};
 try{
  if(!await checkRelease())return {startedAt,endedAt:new Date(io.now()).toISOString(),expectedAttempts:plan.attempts,reason:'deployment-unverified',samples};
  for(let ordinal=0;ordinal<plan.attempts;ordinal++){
   if(io.now()>=Date.parse(plan.expiresAt)){reason='fixture-expired';break;}
   currentOperation=ordinal%2===0?'read':'feed';
   const start=io.monotonic();let outcome:Sample['outcome']='error',httpStatus:number|null=null,serverMs:number|null=null,phases:Record<string,number>={};
   try{
    const {response,value}=await read(currentOperation==='read'?'/api/v1/me?bootstrap=1':'/api/v1/feed',true,response=>{
     httpStatus=response.status;({serverMs,phases}=timing(response.headers.get('server-timing')));
    });
    const correctBody=currentOperation==='read'?value.id===plan.memberId&&typeof value.handle==='string'&&value.handle.startsWith('qa_'):Array.isArray(value.items)&&value.items.some((item:Record<string,unknown>)=>item.id===plan.postId);
    if(response.status===200&&response.headers.get('cache-control')?.includes('no-store')&&correctBody)outcome='success';
   }catch(error){if(['TimeoutError','AbortError'].includes((error as Error)?.name))outcome='timeout';}
   const sample={ordinal,operation:currentOperation,outcome,elapsedMs:Math.max(0,io.monotonic()-start),httpStatus,serverMs,phases};
   samples.push(sample);await io.record(sample);
   if(outcome!=='success'){reason='failed-attempt';break;}
   if(ordinal+1<plan.attempts)await io.sleep(Math.max(0,plan.intervalMs-(io.monotonic()-start)));
  }
  if(!await checkRelease())reason='deployment-changed';
 }catch{reason='probe-interrupted';}
 return {startedAt,endedAt:new Date(io.now()).toISOString(),expectedAttempts:plan.attempts,reason,samples};
}
