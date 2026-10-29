import {JOURNAL_PHASES} from './journal-phases';
import type {Env} from './types';
import {JOURNAL_IO_CODES} from './journal-io';

/** Only these finite dimensions can reach console output or Analytics Engine.
 * No request/response objects, headers, URLs, identifiers, SQL or error objects.
 */
const journalPhases=new Set<string>(JOURNAL_PHASES);
const names=new Set(['journal_phase','request','job','email','error','feed_phase','trace_store','db_conn','db_snapshot']);
export const CONNECTION_ROLES=['auth','social','jobs'] as const;
export type ConnectionRole=typeof CONNECTION_ROLES[number];
const CONNECTION_CODES=[...CONNECTION_ROLES.flatMap(role=>[role+'_open',role+'_close',role+'_open_at_response']),'refused_53300','refused_53400','refused_hyperdrive','connect_timeout'];
export const SNAPSHOT_STATES=['active','idle','idle_in_transaction','idle_in_transaction_aborted','fastpath','disabled','unknown'] as const;
const SNAPSHOT_CODES=[...[...CONNECTION_ROLES,'other'].flatMap(role=>SNAPSHOT_STATES.map(state=>role+'_'+state)),'max_connections','reserved_connections','snapshot_failed','snapshot_refused'];
// Registered route patterns contain parameter names, never values: literal
// segments are words (or a version such as v1), so an ID cannot pass.
const ROUTE_PATTERN=/^\/api(?:\/(?:v[0-9]{1,2}|[a-z]+(?:[-_][a-z]+)*|:[a-zA-Z_]+))+$/;
export const TRACE_STORE_CODES=['trace_write_ok','trace_write_failed','trace_write_throttled','trace_read_ok','trace_read_failed','trace_cleanup_ok','trace_cleanup_failed'] as const;
export type TraceStoreCode=typeof TRACE_STORE_CODES[number];
export const FEED_PHASES=['journal_check','journal_close','auth_session','auth_status','social_first_parameter','social_connect_begin','social_actor','social_query','social_commit','social_close'] as const;
export type FeedPhase=typeof FEED_PHASES[number];
export const JOURNAL_FAILURE_CODES=['journal_begin_failed','journal_work_failed','journal_completion_failed','journal_close_failed'] as const;
export const CLEANUP_FAILURE_CODES=['cleanup_journal_failed','cleanup_expiry_failed','cleanup_identity_failed','cleanup_auth_metadata_failed','cleanup_web_push_failed','cleanup_native_push_failed','cleanup_email_failed','cleanup_heartbeat_failed','cleanup_ack_failed'] as const;
export type JournalFailureCode=typeof JOURNAL_FAILURE_CODES[number];
export type CleanupFailureCode=typeof CLEANUP_FAILURE_CODES[number];
const feedPhases=new Set<string>(FEED_PHASES);
const codes=new Set(['accepted','send_failed','auth_failed','request_failed','cleanup_complete','cleanup_retry','outbox_retry','outbox_delivered','email_outbox_retry','recovery_email_retry','media_backup_retry','journal_not_initialized','restore_quarantined','database_rollback_detected','journal_not_configured','journal_unavailable','journal_store_read_failed','journal_control_invalid','journal_database_read_failed','journal_database_status_invalid',...JOURNAL_FAILURE_CODES,...CLEANUP_FAILURE_CODES,...JOURNAL_IO_CODES,...TRACE_STORE_CODES,...CONNECTION_CODES,...SNAPSHOT_CODES]);
const methods=new Set(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']);
const environments=new Set(['development','staging','production']);
const routes=new Set(['/health','/api/operations/health','/api/v1/feed','/api/v1/traces','/api/auth/*','/api/account-recovery/*','/api/*','/assets/*',
 ...['sign-in/email','sign-up/email','sign-out','get-session','verify-email','request-password-reset','reset-password','send-verification-email','change-password','list-sessions','revoke-session','revoke-sessions'].map(route=>'/api/auth/'+route)]);
/** detailMs (double4): for trace_store, D1's own query duration; for db_conn
 * closes, how long the connection stayed open after the response. */
type Fields={route?:string;method?:string;status?:number;durationMs?:number;code?:string;environment?:string;count?:number;detailMs?:number};
type MetricsEnvironment=Pick<Env,'ENVIRONMENT'|'METRICS'|'FEED_PHASE_TIMING'|'LOGOUT_PHASE_TIMING'>;
export function event(name:'journal_phase'|'request'|'job'|'email'|'error'|'feed_phase'|'trace_store'|'db_conn'|'db_snapshot',fields:Fields={},env?:MetricsEnvironment):void{
 try{
  if(!names.has(name))return;
  if(name==='journal_phase'){
   if(env?.LOGOUT_PHASE_TIMING!=='true'||!['staging','production'].includes(env.ENVIRONMENT)||fields.route!=='/api/auth/sign-out'||fields.method!=='POST'||!fields.code||!journalPhases.has(fields.code))return;
   if(typeof fields.durationMs!=='number'||!Number.isFinite(fields.durationMs)||fields.durationMs<0||fields.durationMs>3_600_000)return;
   fields={route:'/api/auth/sign-out',method:'POST',code:fields.code,durationMs:fields.durationMs};
  }
  if(name==='feed_phase'){
   // Gate here as well as at the call sites: even an accidental direct call
   // cannot enable production diagnostics or attach extra fields to a phase.
   if(env?.ENVIRONMENT!=='staging'||env.FEED_PHASE_TIMING!=='true'||fields.route!=='/api/v1/feed'||fields.method!=='GET'||!fields.code||!feedPhases.has(fields.code))return;
   if(typeof fields.durationMs!=='number'||!Number.isFinite(fields.durationMs)||fields.durationMs<0||fields.durationMs>3_600_000)return;
   fields={route:'/api/v1/feed',method:'GET',code:fields.code,durationMs:fields.durationMs};
  }
  const safe:Record<string,string|number>={event:name};
  if(typeof fields.route==='string'&&routes.has(fields.route))safe.route=fields.route;
  else if((name==='db_conn'||name==='db_snapshot')&&typeof fields.route==='string'&&(['job:cron','job:queue'].includes(fields.route)||(fields.route.length<=100&&ROUTE_PATTERN.test(fields.route))))safe.route=fields.route;
  if(fields.method&&methods.has(fields.method))safe.method=fields.method;
  if(fields.code&&(name==='journal_phase'?journalPhases:name==='feed_phase'?feedPhases:codes).has(fields.code))safe.code=fields.code;
  const environment=env?.ENVIRONMENT??fields.environment;
  if(environment&&environments.has(environment))safe.environment=environment;
  if(Number.isInteger(fields.status)&&fields.status!>=100&&fields.status!<=599)safe.status=fields.status!;
  if(typeof fields.durationMs==='number'&&Number.isFinite(fields.durationMs)&&fields.durationMs>=0&&fields.durationMs<=3_600_000)safe.durationMs=Math.round(fields.durationMs);
  if(Number.isInteger(fields.count)&&fields.count!>=0&&fields.count!<=1_000_000)safe.count=fields.count!;
  if(typeof fields.detailMs==='number'&&Number.isFinite(fields.detailMs)&&fields.detailMs>=0&&fields.detailMs<=3_600_000)safe.detailMs=Math.round(fields.detailMs*10)/10;
  // Keep debugging local. Hosted telemetry never depends on persisted console
  // records, which may otherwise acquire provider-generated request metadata.
  if(!env||env.ENVIRONMENT==='development')try{console.log(JSON.stringify(safe));}catch{}
  if(!env?.METRICS||!safe.environment)return;
  const route=String(safe.route??'none'),code=String(safe.code??'none'),status=Number(safe.status??0);
  // Stable positional schema: see docs/operational-metrics.md. The index is a
  // bounded route/event class, never a member/device/session or random value.
  const result:unknown=env.METRICS.writeDataPoint({
   indexes:[name+':'+route],
   blobs:['porchday_metrics_v1',String(safe.environment),name,route,String(safe.method??'none'),code,status?Math.floor(status/100)+'xx':'none'],
   // double4 exists only when detailMs is set; older points keep three.
   doubles:[status,Number(safe.durationMs??-1),Number(safe.count??0),...(safe.detailMs===undefined?[]:[Number(safe.detailMs)])],
  });
  // Native writeDataPoint returns void immediately. Also absorb rejection from
  // an injected/future async adapter without awaiting or delaying the request.
  if(result&&typeof (result as PromiseLike<unknown>).then==='function')void Promise.resolve(result).catch(()=>{});
 }catch{/* Missing/failed telemetry never blocks a request, email or deletion. */}
}
export function normalizedRoute(path:string):string{
 if(routes.has(path))return path;
 if(path.startsWith('/api/auth/'))return '/api/auth/*';
 if(path.startsWith('/api/account-recovery/'))return '/api/account-recovery/*';
 return path.startsWith('/api/')?'/api/*':'/assets/*';
}
