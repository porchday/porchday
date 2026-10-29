import {Hono} from 'hono';
import {z} from 'zod';
import {event,type TraceStoreCode} from './telemetry';
import {scrubMessage} from './tracing';
import type {Env,Variables} from './types';

/** Opt-in performance trace storage in D1 (docs/performance-tracing.md).
 * Write pressure is deliberately small: browsers batch spans, each upload is
 * one D1 batch round trip, and every isolate caps concurrent and per-second
 * writes. Every D1 call reports wall time, D1's own duration and row counts.
 */
export const TRACE_RETENTION_MS=14*24*60*60*1000;
export const MAX_SPANS_PER_UPLOAD=250;
export const MAX_SPANS_PER_TRACE=5000;
const MAX_UPLOAD_BYTES=256*1024;
const hex32=/^[0-9a-f]{32}$/;
const text=(max:number)=>z.string().max(max).transform(scrubControl);
const attrs=z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),z.union([z.string().max(300).transform(scrubControl),z.number().finite(),z.boolean()]))
 .refine(value=>Object.keys(value).length<=30,'TOO_MANY_ATTRIBUTES');
const span=z.object({
 seq:z.number().int().min(0).max(1_000_000),
 parent:z.number().int().min(0).max(1_000_000).nullable().optional(),
 kind:z.enum(['navigation','resource','server','mark','measure','paint','longtask','error']),
 name:text(300),
 start:z.number().finite().min(-60_000).max(86_400_000),
 dur:z.number().finite().min(0).max(3_600_000),
 attrs:attrs.optional(),
}).strict();
const upload=z.object({
 trace_id:z.string().regex(hex32),
 started_at:z.number().int().min(1_600_000_000_000).max(4_000_000_000_000),
 page:text(200),
 browser:text(60).optional(),
 connection:text(20).optional(),
 spans:z.array(span).max(MAX_SPANS_PER_UPLOAD),
}).strict();
export type TraceUpload=z.infer<typeof upload>;
function scrubControl(value:string):string {return value.replace(/[\u0000-\u001f\u007f]/g,' ');}

/** Per-isolate guard against write storms. A dropped upload is counted, never retried. */
export class WriteLimiter {
 private tokens:number;private updated:number;private inFlight=0;
 constructor(private readonly perSecond=10,private readonly burst=30,private readonly concurrency=4,private readonly now=()=>Date.now()){this.tokens=burst;this.updated=now();}
 acquire():boolean {
  const now=this.now();
  this.tokens=Math.min(this.burst,this.tokens+(now-this.updated)/1000*this.perSecond);this.updated=now;
  if(this.inFlight>=this.concurrency||this.tokens<1)return false;
  this.tokens--;this.inFlight++;return true;
 }
 release():void {this.inFlight=Math.max(0,this.inFlight-1);}
}
const limiter=new WriteLimiter();

type MetricsEnv=Pick<Env,'ENVIRONMENT'|'METRICS'|'FEED_PHASE_TIMING'>;
function report(env:MetricsEnv,code:TraceStoreCode,started:number,results:D1Result[]=[],count?:number):void {
 const storeMs=results.reduce((sum,result)=>sum+(Number(result.meta?.duration)||0),0);
 const rows=count??results.reduce((sum,result)=>sum+(Number(result.meta?.rows_written)||0)+(Number(result.meta?.rows_read)||0),0);
 event('trace_store',{route:'/api/v1/traces',code,durationMs:Date.now()-started,count:rows,...(results.length?{detailMs:storeMs}:{})},env);
}

export async function storeTrace(env:Pick<Env,'TRACES'>&MetricsEnv,memberId:string,trace:TraceUpload,context:{edge?:string;release?:string},now=Date.now(),guard=limiter):Promise<'stored'|'throttled'|'failed'> {
 const db=env.TRACES;if(!db)return 'failed';
 if(!guard.acquire()){report(env,'trace_write_throttled',now,[],0);return 'throttled';}
 const started=Date.now();
 try{
  const spans=JSON.stringify(trace.spans.map(value=>({...value,attrs:value.attrs?scrubAttrs(value.attrs):undefined})));
  const results=await db.batch([
   db.prepare(`INSERT INTO traces(trace_id,member_id,started_at,received_at,page,browser,connection,edge,release,span_count)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
    ON CONFLICT(trace_id) DO UPDATE SET received_at=excluded.received_at,span_count=traces.span_count+excluded.span_count
    WHERE traces.member_id=excluded.member_id`)
    .bind(trace.trace_id,memberId,trace.started_at,now,trace.page,trace.browser??null,trace.connection??null,context.edge??null,context.release??null,trace.spans.length),
   // One statement inserts the whole batch; D1 allows only 100 bound
   // parameters, so the spans travel as one JSON parameter.
   db.prepare(`INSERT OR IGNORE INTO trace_spans(trace_id,seq,parent_seq,kind,name,start_ms,duration_ms,attrs)
    SELECT ?1,json_extract(value,'$.seq'),json_extract(value,'$.parent'),json_extract(value,'$.kind'),json_extract(value,'$.name'),
     json_extract(value,'$.start'),json_extract(value,'$.dur'),json_extract(value,'$.attrs')
    FROM json_each(?2)
    WHERE (SELECT span_count FROM traces WHERE trace_id=?1 AND member_id=?3)<=?4`)
    .bind(trace.trace_id,spans,memberId,MAX_SPANS_PER_TRACE),
  ]);
  report(env,'trace_write_ok',started,results);
  return 'stored';
 }catch{report(env,'trace_write_failed',started);return 'failed';}
 finally{guard.release();}
}
function scrubAttrs(value:Record<string,string|number|boolean>):Record<string,string|number|boolean> {
 // Error messages from the browser receive the same scrubbing as server errors.
 return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,key==='error'&&typeof item==='string'?scrubMessage(item):item]));
}

export async function listTraces(env:Pick<Env,'TRACES'>&MetricsEnv,memberId:string) {
 const started=Date.now();
 try{
  const result=await env.TRACES!.prepare(`SELECT trace_id,started_at,received_at,page,browser,connection,edge,release,span_count
   FROM traces WHERE member_id=?1 ORDER BY started_at DESC LIMIT 50`).bind(memberId).all();
  report(env,'trace_read_ok',started,[result]);
  return result.results;
 }catch(error){report(env,'trace_read_failed',started);throw error;}
}
export async function readTrace(env:Pick<Env,'TRACES'>&MetricsEnv,memberId:string,traceId:string) {
 const started=Date.now(),db=env.TRACES!;
 try{
  const [meta,spans]=await db.batch<Record<string,unknown>>([
   db.prepare(`SELECT trace_id,started_at,received_at,page,browser,connection,edge,release,span_count FROM traces WHERE trace_id=?1 AND member_id=?2`).bind(traceId,memberId),
   db.prepare(`SELECT s.seq,s.parent_seq,s.kind,s.name,s.start_ms,s.duration_ms,s.attrs FROM trace_spans s
    JOIN traces t ON t.trace_id=s.trace_id WHERE s.trace_id=?1 AND t.member_id=?2 ORDER BY s.start_ms,s.seq LIMIT ?3`).bind(traceId,memberId,MAX_SPANS_PER_TRACE),
  ]);
  report(env,'trace_read_ok',started,[meta,spans]);
  if(!meta.results.length)return null;
  return {...meta.results[0],spans:spans.results.map(row=>({...row,attrs:typeof row.attrs==='string'?JSON.parse(row.attrs):null}))};
 }catch(error){report(env,'trace_read_failed',started);throw error;}
}
/** Bounds one summary read; at most 14 days of one member's traces. */
export const MAX_SUMMARY_ROWS=20_000;
const uuidSegment=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** Nearest-rank tail percentile (p95), as in scripts/query-traces.ts. */
function percentile(sorted:number[],p:number):number|null {return sorted.length?sorted[Math.min(sorted.length-1,Math.floor(p*sorted.length))]:null;}
/** The median averages the two middle values of an even-sized sample. */
function median(sorted:number[]):number|null {
 if(!sorted.length)return null;
 const middle=Math.floor(sorted.length/2);
 return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;
}
type RequestRow={name:string;route:string|null;duration_ms:number;server_total:number|null;status:number|null;error:string|null};
/** Route and server step percentiles across a member's retained traces.
 * Times are for successful requests; failures are counted separately. */
export function summarizeTraces(requests:RequestRow[],steps:{name:string;duration_ms:number}[]) {
 const routes=new Map<string,RequestRow[]>();
 for(const row of requests){
  const [method,path='']=row.name.split(' ',2);
  const key=method+' '+(row.route??path.replace(uuidSegment,':id'));
  routes.set(key,[...(routes.get(key)??[]),row]);
 }
 const phases=new Map<string,number[]>();
 for(const step of steps)phases.set(step.name,[...(phases.get(step.name)??[]),Number(step.duration_ms)]);
 const sorted=(values:number[])=>values.slice().sort((x,y)=>x-y);
 return {
  routes:[...routes].map(([route,rows])=>{
   const ok=rows.filter(row=>row.error===null&&(row.status===null||row.status<400));
   const durations=sorted(ok.map(row=>Number(row.duration_ms))),server=sorted(ok.flatMap(row=>row.server_total===null?[]:[Number(row.server_total)]));
   return {route,count:rows.length,failed:rows.length-ok.length,p50_ms:median(durations),p95_ms:percentile(durations,0.95),max_ms:durations.at(-1)??null,server_p50_ms:median(server)};
  }).sort((x,y)=>(y.p95_ms??-1)-(x.p95_ms??-1)),
  phases:[...phases].map(([phase,values])=>{const v=sorted(values);return {phase,count:v.length,p50_ms:median(v)!,p95_ms:percentile(v,0.95)!,max_ms:v.at(-1)!};})
   .sort((x,y)=>y.p95_ms-x.p95_ms),
 };
}
export async function traceSummary(env:Pick<Env,'TRACES'>&MetricsEnv,memberId:string) {
 const started=Date.now(),db=env.TRACES!;
 try{
  // Two bounded reads; percentiles are computed here because SQLite has none.
  const [requests,steps]=await db.batch<Record<string,unknown>>([
   db.prepare(`SELECT s.name,json_extract(s.attrs,'$.route') AS route,s.duration_ms,json_extract(s.attrs,'$.server_total') AS server_total,
     json_extract(s.attrs,'$.status') AS status,json_extract(s.attrs,'$.error') AS error
    FROM trace_spans s JOIN traces t ON t.trace_id=s.trace_id
    WHERE t.member_id=?1 AND s.kind='resource' AND s.name GLOB '[A-Z]* /api/*' LIMIT ?2`).bind(memberId,MAX_SUMMARY_ROWS),
   db.prepare(`SELECT c.name,c.duration_ms FROM trace_spans c
    JOIN trace_spans p ON p.trace_id=c.trace_id AND p.seq=c.parent_seq
    JOIN traces t ON t.trace_id=c.trace_id
    WHERE t.member_id=?1 AND c.kind='server' AND c.name NOT IN ('server total','worker')
     AND json_extract(p.attrs,'$.error') IS NULL AND coalesce(json_extract(p.attrs,'$.status'),0)<400 LIMIT ?2`).bind(memberId,MAX_SUMMARY_ROWS),
  ]);
  report(env,'trace_read_ok',started,[requests,steps]);
  return summarizeTraces(requests.results as RequestRow[],steps.results as {name:string;duration_ms:number}[]);
 }catch(error){report(env,'trace_read_failed',started);throw error;}
}
export async function deleteMemberTraces(env:Pick<Env,'TRACES'>&MetricsEnv,memberId:string):Promise<void> {
 const db=env.TRACES;if(!db)return;
 const started=Date.now();
 try{
  const results=await db.batch([
   db.prepare('DELETE FROM trace_spans WHERE trace_id IN (SELECT trace_id FROM traces WHERE member_id=?1)').bind(memberId),
   db.prepare('DELETE FROM traces WHERE member_id=?1').bind(memberId),
  ]);
  report(env,'trace_cleanup_ok',started,results);
 }catch(error){report(env,'trace_cleanup_failed',started);throw error;}
}
/** Daily retention. Bounded passes keep each D1 write small. */
export async function cleanupTraces(env:Pick<Env,'TRACES'>&MetricsEnv,now=Date.now(),passes=20):Promise<number> {
 const db=env.TRACES;if(!db)return 0;
 const started=Date.now(),cutoff=now-TRACE_RETENTION_MS;
 let removed=0;const all:D1Result[]=[];
 try{
  for(let pass=0;pass<passes;pass++){
   const results=await db.batch([
    db.prepare(`DELETE FROM trace_spans WHERE trace_id IN (SELECT trace_id FROM traces WHERE received_at<?1 ORDER BY received_at LIMIT 200)`).bind(cutoff),
    db.prepare(`DELETE FROM traces WHERE trace_id IN (SELECT trace_id FROM traces WHERE received_at<?1 ORDER BY received_at LIMIT 200)`).bind(cutoff),
   ]);
   all.push(...results);
   const deleted=Number(results[1].meta?.changes)||0;removed+=deleted;
   if(deleted<200)break;
  }
  report(env,'trace_cleanup_ok',started,all);
  return removed;
 }catch(error){report(env,'trace_cleanup_failed',started,all);throw error;}
}

export function createTraceRoutes() {
 const app=new Hono<{Bindings:Env;Variables:Variables}>();
 app.use('/traces/*',async(c,next)=>c.env.TRACES?next():c.json({error:{code:'TRACING_UNAVAILABLE'}},404));
 app.use('/traces',async(c,next)=>c.env.TRACES?next():c.json({error:{code:'TRACING_UNAVAILABLE'}},404));
 app.post('/traces',async c=>{
  const body=await c.req.text();
  if(body.length>MAX_UPLOAD_BYTES)return c.json({error:{code:'TOO_LARGE'}},413);
  let parsed:TraceUpload;
  try{parsed=upload.parse(JSON.parse(body));}catch{return c.json({error:{code:'INVALID_TRACE'}},400);}
  const cf=(c.req.raw as {cf?:{colo?:unknown}}).cf;
  const write=storeTrace(c.env,c.get('memberId'),parsed,{edge:typeof cf?.colo==='string'?cf.colo:undefined,release:c.env.CF_VERSION_METADATA?.id});
  // The browser does not wait for D1. Outcomes are visible in trace_store metrics.
  try{c.executionCtx.waitUntil(write);}catch{await write;}
  return c.json({ok:true},202);
 });
 app.get('/traces',async c=>c.json({items:await listTraces(c.env,c.get('memberId'))}));
 app.get('/traces/summary',async c=>c.json(await traceSummary(c.env,c.get('memberId'))));
 app.get('/traces/:id',async c=>{
  const id=c.req.param('id');
  if(!hex32.test(id))return c.json({error:{code:'NOT_FOUND'}},404);
  const trace=await readTrace(c.env,c.get('memberId'),id);
  return trace?c.json(trace):c.json({error:{code:'NOT_FOUND'}},404);
 });
 app.delete('/traces',async c=>{await deleteMemberTraces(c.env,c.get('memberId'));return c.json({ok:true});});
 return app;
}
