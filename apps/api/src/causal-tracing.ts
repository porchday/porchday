import {AsyncLocalStorage} from 'node:async_hooks';
import type {Env} from './types';

/** Operational records contain no application identifiers, payloads or messages.
 * Incoming IDs are correlation hints, never authorization or sampling decisions. */
export type TraceContext={traceId:string;spanId:string};
export type CausalSpan={id:string;parent:string;name:string;start:number;duration?:number;outcome:'pending'|'ok'|'error'|'cancelled';code?:string;quantity?:number;frames?:string[]};
const names=new Set(['request','cron','queue','queue.send','queue.sendBatch','r2.get','r2.put','r2.head','r2.delete','r2.list','r2.body','r2.stream.handoff','d1.query','email.send','db.auth.query','db.social.query','db.jobs.query','db.auth.connect','db.social.connect','db.jobs.connect','db.auth.close','db.social.close','db.jobs.close','db.transaction','journal.r2.get','journal.r2.body','journal.r2.put','journal.db.status','journal.db.page','journal.db.prepare','journal.db.recover','journal.db.seal','journal.retry','journal.deadline','http.response','background','crypto','http.push','http.apns','http.email','http.other','http.backend','infra.snapshot']);
const phases=new Set(['journal_check','journal_close','auth_session','auth_status','social_connect_begin','social_actor','social_query','social_commit','social_close','journal_r2','journal_db','auth_schema','auth_schema_wait','operations_snapshot','operations_close','worker','read_guard','read_guard_close','rate_limit','initial_authorization','guard','registration','work','work_pool_acquire','work_begin','work_identity_lock','work_reauthorization','work_handler','work_commit','work_rollback','checkpoint','receipt','retirement','close','r2_read','r2_write','database_status','database_page','r2_media_get']);
const codeSet=new Set(['CONNECT_TIMEOUT','CONNECTION_CLOSED','CONNECTION_ENDED','ECONNRESET','ECONNREFUSED','ETIMEDOUT','ABORT_ERR','JOURNAL_IO_DEADLINE','PRIVACY_CHECKPOINT_REQUIRED','journal_unavailable','journal_begin_failed','journal_work_failed','journal_completion_failed','journal_close_failed','journal_io_deadline','journal_io_exhausted','request_failed','auth_failed','cleanup_journal_failed','cleanup_retry','cleanup_expiry_failed','cleanup_identity_failed','cleanup_auth_metadata_failed','cleanup_web_push_failed','cleanup_native_push_failed','cleanup_email_failed','cleanup_heartbeat_failed','cleanup_ack_failed','media_backup_retry','session_denial_cleanup_retry']);
export function causalError(error:unknown):string {
 const e=error as {code?:unknown;name?:unknown;message?:unknown}|null;
 if(e?.message==='JOURNAL_IO_DEADLINE')return 'JOURNAL_IO_DEADLINE';
 if(typeof e?.code==='string'&&(codeSet.has(e.code)||/^[0-9A-Z]{5}$/.test(e.code)))return e.code;
 if(e?.name==='AbortError')return 'ABORT_ERR';
 if(e?.name==='JournalDeadlineError')return 'JOURNAL_IO_DEADLINE';
 return 'OPERATION_FAILED';
}
export function parseTraceparent(value:string|undefined|null):TraceContext|undefined {
 const m=/^00-([a-f0-9]{32})-([a-f0-9]{16})-0[01]$/.exec(value??'');
 return m&&!/^0+$/.test(m[1])&&!/^0+$/.test(m[2])?{traceId:m[1],spanId:m[2]}:undefined;
}
function id(bytes:number){return Array.from(crypto.getRandomValues(new Uint8Array(bytes)),n=>n.toString(16).padStart(2,'0')).join('');}
export function safeRoute(route?:string){return route&&route.length<=120&&/^\/api(?:\/(?:v[0-9]{1,2}|[a-z]+(?:[-_][a-z]+)*|:[a-zA-Z_]+))+\/?$/.test(route)?route:route==='/health'?route:'/api/*';}
type TraceEnv=Pick<Env,'ENVIRONMENT'|'METRICS'|'TRACES'|'OPERATIONAL_TRACING'|'CF_VERSION_METADATA'>;
type Sink=(record:CausalRecord)=>Promise<void>;
export function traceSampled(traceId:string){return parseInt(traceId.slice(-8),16)%100<5;}
export type CausalRecord={v:1;traceId:string;rootId:string;parentId?:string;service:'api'|'edge';kind:'http'|'cron'|'queue';environment:string;release:string;started:number;duration:number;responseDuration:number;route:string;status:number;revision:number;reason:'error'|'slow'|'sample';droppedSpans:number;droppedLinks:number;links:TraceContext[];spans:CausalSpan[]};
type Scope={trace:OperationTrace;parent:string};
const local=new AsyncLocalStorage<Scope>();
const summarySuppression=new AsyncLocalStorage<boolean>();
export function withoutCausalSummary<T>(work:()=>T):T{return summarySuppression.run(true,work);}
export class OperationTrace {
 readonly traceId:string;readonly rootId=id(8);readonly started=Date.now();readonly origin=performance.now();
 readonly spans:CausalSpan[]=[];readonly links:TraceContext[]=[];
 private sampled:boolean;
 private observed=0;private dropped=0;private droppedLinks=0;private revision=0;private ended=false;private status=0;private responseDuration=0;private route='/api/*';private failed=false;private flushing=false;private dirty=false;
 constructor(readonly environment:string,readonly release:string,readonly parent:TraceContext|undefined,readonly sink:Sink,readonly retain:(task:Promise<unknown>)=>void,sampled:boolean|undefined=undefined,readonly service:'api'|'edge'='api',readonly kind:'http'|'cron'|'queue'='http'){this.traceId=parent?.traceId??id(16);this.sampled=sampled??traceSampled(this.traceId);}
 run<T>(work:()=>T):T{return local.run({trace:this,parent:this.rootId},work);}
 link(context:TraceContext){if(traceSampled(context.traceId))this.sampled=true;if(this.links.some(l=>l.traceId===context.traceId&&l.spanId===context.spanId))return;if(this.links.length>=32){this.droppedLinks++;return;}this.links.push(context);}
 add(name:string,parent:string,start=performance.now()):CausalSpan|undefined{
  if(!names.has(name)&&!name.startsWith('phase.'))return;
  if(name.startsWith('phase.')&&!phases.has(name.slice(6)))return;
  if(this.spans.length>=160){this.dropped++;return;}
  const span:CausalSpan={id:id(8),parent,name,start:Math.max(0,start-this.origin),outcome:'pending'};this.spans.push(span);if(this.ended)this.flush();return span;
 }
 complete(span:CausalSpan|undefined,error?:unknown,failed=false){
  this.observed=Math.max(this.observed,performance.now()-this.origin);
  if(span){span.duration=Math.max(0,performance.now()-this.origin-span.start);span.outcome=failed?'error':span.outcome==='cancelled'?'cancelled':'ok';if(failed){span.code=causalError(error);const stack=(error as {stack?:unknown})?.stack;if(typeof stack==='string')span.frames=[...new Set(stack.match(/\b(?:index|edge|worker)\.js:\d{1,7}:\d{1,7}/g)??[])].slice(0,5);}}
  if(failed)this.failed=true;
  if(this.ended)this.flush();
 }
 phase(name:string,duration:number){if(!phases.has(name)||!Number.isFinite(duration)||duration<0)return;const span=this.add('phase.'+name,local.getStore()?.parent??this.rootId,performance.now()-duration);this.complete(span);}
 finish(status:number,route?:string){this.responseDuration=performance.now()-this.origin;this.status=status;this.route=safeRoute(route);this.ended=true;this.flush();}
 private record():CausalRecord|undefined{
  const duration=Math.max(this.responseDuration,this.observed,this.spans.some(s=>s.outcome==='pending')?performance.now()-this.origin:0),reason=this.failed||this.status>=500?'error':duration>=2000?'slow':this.sampled?'sample':undefined;
  if(!reason)return;
  return {v:1,traceId:this.traceId,rootId:this.rootId,parentId:this.parent?.spanId,service:this.service,kind:this.kind,environment:this.environment,release:this.release,started:this.started,duration,responseDuration:this.responseDuration,route:this.route,status:this.status,revision:++this.revision,reason,droppedSpans:this.dropped,droppedLinks:this.droppedLinks,links:[...this.links],spans:this.spans.map(s=>({...s}))};
 }
 private flush(){
  this.dirty=true;if(this.flushing)return;this.flushing=true;
  const task=(async()=>{while(this.dirty){if(this.revision>0)await new Promise(resolve=>setTimeout(resolve,100));this.dirty=false;const record=this.record();if(record)try{await local.exit(()=>this.sink(record));}catch{/* Sink reports its own loss; never alter application work. */}}})().finally(()=>{this.flushing=false;});
  try{this.retain(task);}catch{void task.catch(()=>{});}
 }
}
export function causalContext():TraceContext|undefined {const scope=local.getStore();return scope?{traceId:scope.trace.traceId,spanId:scope.parent}:undefined;}
export function causalTraceparent(){const c=causalContext();return c?`00-${c.traceId}-${c.spanId}-01`:undefined;}
export function causalPhase(name:string,duration:number){try{if(!summarySuppression.getStore())local.getStore()?.trace.phase(name,duration);}catch{}}
export async function causalSpan<T>(name:string,work:()=>PromiseLike<T>|T):Promise<T>{
 const scope=local.getStore();if(!scope)return work();
 const span=scope.trace.add(phases.has(name)?'phase.'+name:name,scope.parent);
 try{const value=await local.run({trace:scope.trace,parent:span?.id??scope.parent},work);scope.trace.complete(span);return value;}
 catch(error){scope.trace.complete(span,error,true);throw error;}
}
/** Observe callback-style drivers without changing their return values. */
export function causalCallback<T>(name:string,invoke:(done:(error?:unknown)=>void)=>T):T{
 const scope=local.getStore();if(!scope)return invoke(()=>{});
 const span=scope.trace.add(name,scope.parent);let finished=false;
 const done=(error?:unknown)=>{if(finished)return;finished=true;scope.trace.complete(span,error,error!==undefined&&error!==null);};
 try{return local.run({trace:scope.trace,parent:span?.id??scope.parent},()=>invoke(done));}catch(error){done(error);throw error;}
}
/** Returning the native stream preserves Content-Length, BYOB and cancellation.
 * This observes handoff only; client resource timings measure body transfer. */
export function causalStreamHandoff(bytes:unknown){
 const scope=local.getStore();if(!scope)return;const span=scope.trace.add('r2.stream.handoff',scope.parent);
 if(span&&typeof bytes==='number'&&Number.isSafeInteger(bytes)&&bytes>=0)span.quantity=bytes;
 scope.trace.complete(span);
}
export function causalInfrastructure(code:string,count:number){
 if(!/^(max_connections|reserved_connections|(auth|social|jobs|other)_(active|idle|idle_in_transaction|idle_in_transaction_aborted|fastpath|disabled|unknown))$/.test(code)||!Number.isSafeInteger(count)||count<0||count>1000000)return;
 const scope=local.getStore();if(!scope)return;const span=scope.trace.add('infra.snapshot',scope.parent);if(span){span.code=code;span.quantity=count;}scope.trace.complete(span);
}
export function causalFailure(error:unknown){const scope=local.getStore();if(scope){const span=scope.trace.add('background',scope.parent);scope.trace.complete(span,error,true);}}

let inFlight=0,tokens=40,last=Date.now();
export function operationalSignal(env:Pick<Env,'METRICS'|'ENVIRONMENT'>,code:string){
 if(!['export_ok','export_failed','export_dropped','export_oversize','cleanup_ok','cleanup_failed'].includes(code))return;
 try{env.METRICS?.writeDataPoint({indexes:['causal_export'],blobs:['porchday_causal_v1',env.ENVIRONMENT,code],doubles:[1]});}catch{}
}
export function d1CausalSink(env:TraceEnv):Sink{return async record=>{
 if(!env.TRACES)return;
 const now=Date.now();tokens=Math.min(40,tokens+Math.max(0,now-last)*0.02);last=now;
 if(inFlight>=4||tokens<1){operationalSignal(env,'export_dropped');return;}
 const json=JSON.stringify(record);if(json.length>64000){operationalSignal(env,'export_oversize');return;}
 tokens--;inFlight++;
 try{const statement=env.TRACES.prepare(`INSERT INTO operational_traces(trace_id,root_id,started_at,updated_at,expires_at,revision,route,status,reason,payload)
 VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(trace_id,root_id) DO UPDATE SET updated_at=excluded.updated_at,revision=excluded.revision,status=excluded.status,reason=excluded.reason,payload=excluded.payload WHERE excluded.revision>operational_traces.revision`)
 .bind(record.traceId,record.rootId,record.started,now,record.started+7*86400000,record.revision,record.route,record.status,record.reason,json);
 await env.TRACES.batch([statement,...(record.links.length?[env.TRACES.prepare(`INSERT OR IGNORE INTO operational_trace_links(linked_trace,trace_id,root_id,expires_at) SELECT json_extract(value,'$.traceId'),?1,?2,?3 FROM json_each(?4)`).bind(record.traceId,record.rootId,record.started+7*86400000,JSON.stringify(record.links))]:[])]);operationalSignal(env,'export_ok');}
 catch{operationalSignal(env,'export_failed');}finally{inFlight--;}
 };}
export function createOperationTrace(env:TraceEnv,parent?:TraceContext,retain:(task:Promise<unknown>)=>void=()=>{},kind:'http'|'cron'|'queue'='http',service:'api'|'edge'='api'):OperationTrace|undefined{
 if(!('OPERATIONAL_TRACING' in env)||env.OPERATIONAL_TRACING!=='true'||!env.TRACES)return;
 const release=/^[a-f0-9-]{36}$/.test(env.CF_VERSION_METADATA?.id??'')?env.CF_VERSION_METADATA!.id:'unknown';
 return new OperationTrace(env.ENVIRONMENT,release,parent,d1CausalSink(env),retain,kind==='cron'?true:undefined,service,kind);
}
export async function cleanupOperationalTraces(env:TraceEnv){if(!('OPERATIONAL_TRACING' in env)||env.OPERATIONAL_TRACING!=='true'||!env.TRACES)return;try{await env.TRACES.batch([env.TRACES.prepare('DELETE FROM operational_traces WHERE expires_at<?1').bind(Date.now()),env.TRACES.prepare('DELETE FROM operational_trace_links WHERE expires_at<?1').bind(Date.now())]);operationalSignal(env,'cleanup_ok');}catch{operationalSignal(env,'cleanup_failed');}}
