import {Hono} from 'hono';
import type {Env,Variables} from './types';
/** Mounted behind Cloudflare Access and active builder staff role. No member
 * recordings, SQL text, payloads or credentials are returned by this surface. */
export function createCausalInspector(){
 const app=new Hono<{Bindings:Env;Variables:Variables}>();
 app.use('*',async(c,next)=>{c.header('Cache-Control','private, no-store');if(c.env.OPERATIONAL_TRACING!=='true'||!c.env.TRACES)return c.json({error:{code:'OBSERVABILITY_UNAVAILABLE'}},503);await next();});
 app.get('/recent',async c=>{
  const db=c.env.TRACES!,now=Date.now();
  await db.prepare('INSERT INTO diagnostic_access(id,operator,session_id,action,at) VALUES(?1,?2,?3,?4,?5)').bind(crypto.randomUUID(),c.get('staffSubject'),'operational','list',now).run();
  const [recent,summary]=await db.batch([
   db.prepare(`SELECT trace_id,root_id,started_at,route,status,reason,json_extract(payload,'$.duration') AS duration,json_extract(payload,'$.service') AS service,json_extract(payload,'$.kind') AS kind FROM operational_traces WHERE started_at>?1 AND expires_at>?2 ORDER BY started_at DESC LIMIT 100`).bind(now-86400000,now),
   db.prepare(`SELECT reason,count(*) AS retained,max(updated_at) AS latest,sum(json_extract(payload,'$.droppedSpans')) AS dropped_spans FROM operational_traces WHERE started_at>?1 AND expires_at>?2 GROUP BY reason`).bind(now-86400000,now)
  ]);
  return c.json({at:now,retentionDays:7,normalSamplePercent:5,summary:summary.results,items:recent.results});
 });
 app.get('/trace/:id',async c=>{
  const id=c.req.param('id');if(!/^[a-f0-9]{32}$/.test(id))return c.json({error:{code:'INVALID_TRACE_ID'}},400);
  const db=c.env.TRACES!,now=Date.now();
  await db.prepare('INSERT INTO diagnostic_access(id,operator,session_id,action,at) VALUES(?1,?2,?3,?4,?5)').bind(crypto.randomUUID(),c.get('staffSubject'),id,'operational-trace',now).run();
  const rows=await db.prepare(`SELECT payload FROM operational_traces WHERE expires_at>?1 AND (trace_id=?2 OR root_id IN (SELECT root_id FROM operational_trace_links WHERE linked_trace=?2 AND expires_at>?1)) ORDER BY started_at LIMIT 100`).bind(now,id).all<{payload:string}>();
  const client=await db.prepare(`SELECT e.at,e.kind,json_extract(e.payload,'$.operation') AS operation,json_extract(e.payload,'$.duration') AS duration,json_extract(e.payload,'$.status') AS status,json_extract(e.payload,'$.outcome') AS outcome,json_extract(e.payload,'$.span') AS span,json_extract(e.payload,'$.parent') AS parent FROM diagnostic_events e JOIN diagnostic_sessions s ON s.id=e.session_id WHERE json_extract(e.payload,'$.trace')=?1 AND s.delete_at>?2 AND (e.kind='request' OR (e.kind='operation' AND json_extract(e.payload,'$.operation') IN ('decrypt','encrypt','media decode'))) ORDER BY e.at LIMIT 250`).bind(id,now).all();
  const performance=await db.prepare(`SELECT s.kind,s.start_ms,s.duration_ms,s.attrs FROM trace_spans s JOIN traces t USING(trace_id) WHERE json_extract(s.attrs,'$.trace_id')=?1 AND t.received_at>?2 AND s.kind IN ('resource','measure') ORDER BY s.start_ms LIMIT 250`).bind(id,now-14*86400000).all();
  // Do not disclose unbounded client attribute bags through the operator view.
  const performanceSpans=performance.results.map((s:any)=>{const a=JSON.parse(s.attrs||'{}');return {kind:s.kind,start:s.start_ms,duration:s.duration_ms,span:a.span_id,parent:a.parent_span_id,status:a.status};});
  return c.json({at:now,items:rows.results.map(row=>JSON.parse(row.payload)),client:client.results,performance:performanceSpans,coverage:'Stored observations only; missing or pending spans are unknown, not successful.'});
 });
 return app;
}
