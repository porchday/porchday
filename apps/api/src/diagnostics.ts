import {createMiddleware} from 'hono/factory';
import {routePath} from 'hono/route';
import {diagnosticServerPhases} from './tracing';
import {event as metric} from './telemetry';
import {Hono} from 'hono';
import {z} from 'zod';
import type {Env,Variables} from './types';
export const DIAGNOSTIC_HOUR=3_600_000,DIAGNOSTIC_RETENTION=3*24*DIAGNOSTIC_HOUR;
const uuid=z.string().uuid();
export const diagnosticEvent=z.object({id:uuid,at:z.number().int(),kind:z.enum(['operation','request','error','navigation','interaction','content']),payload:z.record(z.string().max(40),z.union([z.string().max(24000),z.number().finite(),z.boolean()])).refine(p=>Object.keys(p).length<=12)}).strict().refine(e=>JSON.stringify(e).length<=32000);
const batch=z.object({events:z.array(diagnosticEvent).min(1).max(20)}).strict();
const fields:Record<string,string[]>={operation:['operation','stage','outcome','error','code','status','trace'],request:['method','route','status','duration','server_timing','trace'],error:['error','code','stack','trace'],navigation:['route'],interaction:['control','action'],content:['text','fields','thumbnail']};
export function validDiagnosticEvent(e:z.infer<typeof diagnosticEvent>,mode:string,start:number,end:number){
 if(e.at<start-60000||e.at>end||Object.keys(e.payload).some(k=>!fields[e.kind].includes(k)))return false;
 if(e.kind==='content'&&mode!=='content')return false;
 if(e.payload.thumbnail!==undefined&&!(typeof e.payload.thumbnail==='string'&&/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(e.payload.thumbnail)))return false;
 return true;
}
async function body(c:any){const raw=await c.req.text();if(new TextEncoder().encode(raw).length>256*1024)throw Error('TOO_LARGE');return JSON.parse(raw);}
export async function deleteDiagnostics(env:Pick<Env,'TRACES'>,member?:string,now=Date.now()){
 if(!env.TRACES)return;
 const predicate=member?'member_id=?1':'delete_at<=?1',arg=member??now;
 await env.TRACES.batch([
  env.TRACES.prepare(`DELETE FROM diagnostic_events WHERE session_id IN (SELECT id FROM diagnostic_sessions WHERE ${predicate})`).bind(arg),
  env.TRACES.prepare(`DELETE FROM diagnostic_sessions WHERE ${predicate}`).bind(arg),
  env.TRACES.prepare('DELETE FROM diagnostic_access WHERE at<?1').bind(now-30*24*DIAGNOSTIC_HOUR),
 ]);
}
export function createDiagnosticRoutes(){
 const app=new Hono<{Bindings:Env;Variables:Variables}>();
 app.use('/diagnostics/*',async(c,next)=>{c.header('Cache-Control','no-store');return c.env.TRACES?next():c.json({error:{code:'DIAGNOSTICS_UNAVAILABLE'}},503);});
 app.post('/diagnostics/sessions',async c=>{
  const schema=z.object({device_id:uuid,mode:z.enum(['details','content']),consent_version:z.literal(1),content_consent:z.boolean()}).strict();
  const parsed=schema.safeParse(await body(c).catch(()=>null));if(!parsed.success||parsed.data.mode==='content'&&!parsed.data.content_consent)return c.json({error:{code:'CONSENT_REQUIRED'}},400);
  const d=parsed.data,now=Date.now(),id=crypto.randomUUID();
  // Sessions are deliberately short, and repeated toggling cannot grow storage indefinitely.
  const count=await c.env.TRACES!.prepare('SELECT count(*) AS n FROM diagnostic_sessions WHERE member_id=?1 AND delete_at>?2').bind(c.get('memberId'),now).first<{n:number}>();
  if((count?.n??0)>=30)return c.json({error:{code:'DIAGNOSTIC_SESSION_LIMIT'}},429);
  const created=await c.env.TRACES!.prepare('INSERT INTO diagnostic_sessions(id,member_id,device_id,mode,consent_version,started_at,expires_at,delete_at,release) SELECT ?1,?2,?3,?4,1,?5,?6,?7,?8 WHERE (SELECT count(*) FROM diagnostic_sessions WHERE member_id=?2 AND delete_at>?5)<30').bind(id,c.get('memberId'),d.device_id,d.mode,now,now+24*DIAGNOSTIC_HOUR,now+DIAGNOSTIC_RETENTION,c.env.CF_VERSION_METADATA?.id??null).run();
  if(!created.meta.changes)return c.json({error:{code:'DIAGNOSTIC_SESSION_LIMIT'}},429);
  return c.json({id,mode:d.mode,started_at:now,expires_at:now+24*DIAGNOSTIC_HOUR});
 });
 app.post('/diagnostics/sessions/:id/events',async c=>{
  const parsed=batch.safeParse(await body(c).catch(()=>null));if(!parsed.success)return c.json({error:{code:'INVALID_DIAGNOSTICS'}},400);
  const db=c.env.TRACES!,now=Date.now();
  const s=await db.prepare('SELECT * FROM diagnostic_sessions WHERE id=?1 AND member_id=?2 AND delete_at>?3').bind(c.req.param('id'),c.get('memberId'),now).first<any>();
  if(!s||s.stopped_at||now>s.expires_at)return c.json({error:{code:'DIAGNOSTICS_EXPIRED'}},410);
  if(parsed.data.events.some(e=>!validDiagnosticEvent(e,s.mode,s.started_at,Math.min(now+60000,s.expires_at))))return c.json({error:{code:'INVALID_DIAGNOSTICS'}},400);
  // Idempotent, durable acknowledgment. Never acknowledge a queued background D1 write.
  await db.batch(parsed.data.events.map(e=>db.prepare(`INSERT OR IGNORE INTO diagnostic_events(session_id,id,at,kind,payload)
   SELECT ?1,?2,?3,?4,?5 WHERE EXISTS(SELECT 1 FROM diagnostic_sessions WHERE id=?1 AND member_id=?6 AND stopped_at IS NULL AND expires_at>?7)
   AND (SELECT count(*) FROM diagnostic_events WHERE session_id=?1)<2000
   AND (SELECT coalesce(sum(length(payload)),0) FROM diagnostic_events WHERE session_id=?1)+length(?5)<=5242880`).bind(s.id,e.id,e.at,e.kind,JSON.stringify(e.payload),c.get('memberId'),now)));
  const ids=parsed.data.events.map(e=>e.id);
  const saved=await db.prepare('SELECT id FROM diagnostic_events WHERE session_id=?1 AND id IN (SELECT value FROM json_each(?2))').bind(s.id,JSON.stringify(ids)).all<{id:string}>();
  return c.json({accepted:saved.results.map(r=>r.id),full:saved.results.length!==ids.length});
 });
 app.post('/diagnostics/sessions/:id/stop',async c=>{
  await c.env.TRACES!.prepare('UPDATE diagnostic_sessions SET stopped_at=?1 WHERE id=?2 AND member_id=?3').bind(Date.now(),c.req.param('id'),c.get('memberId')).run();return c.json({ok:true});
 });
 app.get('/diagnostics/sessions',async c=>c.json({items:(await c.env.TRACES!.prepare('SELECT id,mode,started_at,expires_at,stopped_at FROM diagnostic_sessions WHERE member_id=?1 AND delete_at>?2 ORDER BY started_at DESC LIMIT 30').bind(c.get('memberId'),Date.now()).all()).results}));
 app.get('/diagnostics/sessions/:id',async c=>{
  const db=c.env.TRACES!,s=await db.prepare('SELECT * FROM diagnostic_sessions WHERE id=?1 AND member_id=?2 AND delete_at>?3').bind(c.req.param('id'),c.get('memberId'),Date.now()).first();
  if(!s)return c.json({error:{code:'NOT_FOUND'}},404);
  return c.json({session:s,events:(await db.prepare('SELECT id,at,kind,payload FROM diagnostic_events WHERE session_id=?1 ORDER BY at,id LIMIT 2000').bind(c.req.param('id')).all()).results});
 });
 app.delete('/diagnostics/sessions',async c=>{await deleteDiagnostics(c.env,c.get('memberId'));return c.json({ok:true});});
 return app;
}
/** Mounted behind verified Cloudflare Access + active builder_chat staff role.
 * Explicit recording consent includes operator access; legacy traces are excluded. */
export function createStaffDiagnosticRoutes(){
 const app=new Hono<{Bindings:Env;Variables:Variables}>();
 app.get('/:id',async c=>{
  c.header('Cache-Control','no-store');const db=c.env.TRACES;if(!db)return c.json({error:{code:'DIAGNOSTICS_UNAVAILABLE'}},503);
  const s=await db.prepare('SELECT * FROM diagnostic_sessions WHERE id=?1 AND delete_at>?2').bind(c.req.param('id'),Date.now()).first();
  if(!s)return c.json({error:{code:'NOT_FOUND'}},404);
  // Audit succeeds before any content is released, including to operators.
  await db.prepare('INSERT INTO diagnostic_access(id,operator,session_id,action,at) VALUES(?1,?2,?3,?4,?5)').bind(crypto.randomUUID(),c.get('staffSubject'),c.req.param('id'),'read',Date.now()).run();
  return c.json({session:s,events:(await db.prepare('SELECT id,at,kind,payload FROM diagnostic_events WHERE session_id=?1 ORDER BY at,id LIMIT 2000').bind(c.req.param('id')).all()).results});
 });return app;
}

/** Stores server outcome even if the browser loses the response. Consent and
 * account ownership are checked in the INSERT, not inferred from a header. */
export const diagnosticServerMiddleware=createMiddleware<{Bindings:Env;Variables:Variables}>(async(c,next)=>{
 const id=c.req.header('X-Porchday-Diagnostic-Session');
 if(!id||!uuid.safeParse(id).success||!c.env.TRACES||c.req.path.includes('/diagnostics/')||c.req.path.includes('/traces'))return next();
 const began=Date.now();await next();
 const trace=diagnosticServerPhases();
 const payload=JSON.stringify({route:routePath(c)??'/api/*',status:c.res.status,duration:Date.now()-began,trace:trace?.trace??'',phases:JSON.stringify(trace?.phases??[]).slice(0,12000),release:c.env.CF_VERSION_METADATA?.id??'',error:trace?.error??''});
 const write=c.env.TRACES.prepare(`INSERT OR IGNORE INTO diagnostic_events(session_id,id,at,kind,payload)
 SELECT ?1,?2,?3,'server',?4 WHERE EXISTS(SELECT 1 FROM diagnostic_sessions WHERE id=?1 AND member_id=?5 AND stopped_at IS NULL AND expires_at>?3 AND delete_at>?3)
 AND (SELECT count(*) FROM diagnostic_events WHERE session_id=?1)<2000
 AND (SELECT coalesce(sum(length(payload)),0) FROM diagnostic_events WHERE session_id=?1)+length(?4)<=5242880`).bind(id,crypto.randomUUID(),began,payload,c.get('memberId')).run().catch(()=>{metric('trace_store',{code:'trace_write_failed'},c.env);});
 try{c.executionCtx.waitUntil(write);}catch{await write;}
});
