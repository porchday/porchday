import {Hono} from 'hono';
import {z} from 'zod';
import type {Env,Variables} from './types';
import {operationalSnapshotSchema,mediaBackupSnapshotSchema} from './operations-health';
const count=z.number().int().nonnegative();
const monitorSchema=z.object({status:z.enum(['operational','degraded','checking','unknown']),last_checked_at:z.string().datetime().nullable(),metrics_monitoring:z.enum(['not_configured','checking','ready','unavailable']).optional(),availability:z.object({status:z.enum(['unavailable','collecting','complete_window']),expected_minutes:count.optional(),passed_minutes:count.optional(),failed_minutes:count.optional(),unknown_minutes:count.optional(),conservative_pass_percent:z.number().min(0).max(100).optional(),observed_percent:z.number().min(0).max(100).optional()}).optional()});
const healthSchema=z.object({status:z.enum(['ok','degraded']),issues:z.array(z.string().regex(/^[a-z_]{1,64}$/)).max(32),snapshot:operationalSnapshotSchema,backup:mediaBackupSnapshotSchema});
const rowSchema=z.object({trace_id:z.string().regex(/^[a-f0-9]{32}$/),root_id:z.string().regex(/^[a-f0-9]{16}$/),started_at:z.number(),route:z.string().max(160),status:z.number().int().min(0).max(599),reason:z.enum(['error','slow','sample','linked','forced']).or(z.string().regex(/^[a-z_]{1,32}$/)),duration:z.number().min(0),service:z.string().regex(/^[a-z_-]{1,32}$/)});
export async function dashboardJson(url:string,headers:HeadersInit={},request:typeof fetch=fetch){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
 try{const r=await request(url,{headers,redirect:'error',signal:controller.signal});const reader=r.body?.getReader();if(!reader)throw Error('UNAVAILABLE');let text='',size=0;const decoder=new TextDecoder();try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>65536)throw Error('TOO_LARGE');text+=decoder.decode(part.value,{stream:true});}}finally{await reader.cancel().catch(()=>{});}return{status:r.status,value:JSON.parse(text+decoder.decode())};}finally{clearTimeout(timer);controller.abort();}
}
async function bounded<T>(work:Promise<T>){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('DASHBOARD_DEADLINE')),8000);})]);}finally{if(timer)clearTimeout(timer);}}
/** Mounted behind the privacy guard, Access and the active builder role.
 * No member content or recovery actions. Guard failures stay unavailable. */
export function createHealthDashboard(request:typeof fetch=fetch){
 const app=new Hono<{Bindings:Env;Variables:Variables}>();
 app.use('*',async(c,next)=>{c.header('Cache-Control','private, no-store');c.header('Vary','Cookie, Cf-Access-Jwt-Assertion');await next();});
 app.get('/',async c=>{
  const now=Date.now(),db=c.env.TRACES;
  if(!db)return c.json({error:{code:'HEALTH_DASHBOARD_UNAVAILABLE'}},503);
  await bounded(db.prepare('INSERT INTO diagnostic_access(id,operator,session_id,action,at) VALUES(?1,?2,?3,?4,?5)').bind(crypto.randomUUID(),c.get('staffSubject'),'operational','health-dashboard',now).run());
  const production=c.env.ENVIRONMENT==='production',origin=production?'https://porchday.org':'https://staging.porchday.com',monitor=production?'https://status.porchday.com':'https://staging-status.porchday.com';
  const settled=await Promise.allSettled([
   c.env.OPERATIONS_HEALTH_TOKEN?dashboardJson(origin+'/api/operations/health',{Authorization:'Bearer '+c.env.OPERATIONS_HEALTH_TOKEN},request):Promise.reject(Error('NOT_CONFIGURED')),
   dashboardJson(monitor+'/status',{},request),
   bounded(db.prepare(`SELECT trace_id,root_id,started_at,route,status,reason,json_extract(payload,'$.responseDuration') AS duration,json_extract(payload,'$.service') AS service FROM operational_traces WHERE started_at>?1 AND expires_at>?2 AND json_extract(payload,'$.kind')='http' ORDER BY started_at DESC LIMIT 5000`).bind(now-86400000,now).all()),
  ]);
  const [h,m,t]=settled;
  const parsedHealth=h.status==='fulfilled'?healthSchema.safeParse(h.value.value):null;
  const readiness=parsedHealth?.success?{state:parsedHealth.data.status==='ok'&&h.status==='fulfilled'&&h.value.status===200?'healthy':'degraded',...parsedHealth.data}: {state:h.status==='fulfilled'&&h.value.status===503?'degraded':'unknown',statusCode:h.status==='fulfilled'?h.value.status:null};
  const parsedMonitor=m.status==='fulfilled'&&m.value.status===200?monitorSchema.safeParse(m.value.value):null;
  const checked=parsedMonitor?.success?Date.parse(parsedMonitor.data.last_checked_at??''):NaN;
  const monitoring=parsedMonitor?.success?{...parsedMonitor.data,fresh:Number.isFinite(checked)&&now-checked<=90000&&checked<=now+30000}:{status:'unknown',fresh:false};
  let traces:unknown={state:'unknown'};
  if(t.status==='fulfilled'){
   const parsed=z.array(rowSchema).safeParse(t.value.results);
   if(parsed.success){const rows=parsed.data,durations=rows.map(r=>r.duration).sort((a,b)=>a-b),latest=rows[0]?.started_at??null;
    traces={state:latest!==null&&now-latest<=15*60000?'available':'stale',latest,retained:rows.length,limit:5000,capped:rows.length===5000,errors:rows.filter(r=>r.status>=500).length,p95Ms:durations.length?durations[Math.ceil(durations.length*.95)-1]:null,failures:rows.filter(r=>r.status>=500).slice(0,20),hourly:Array.from({length:24},(_,i)=>{const start=now-(24-i)*3600000,bucket=rows.filter(r=>r.started_at>=start&&r.started_at<start+3600000);return{start,retained:bucket.length,errors:bucket.filter(r=>r.status>=500).length};})};
   }
  }
  return c.json({at:now,environment:c.env.ENVIRONMENT,release:c.env.CF_VERSION_METADATA?.id??null,readiness,monitoring,traces,externalMonitor:{state:'not_connected',incidents:'https://github.com/porchday/porchday/issues/52'}});
 });
 return app;
}
