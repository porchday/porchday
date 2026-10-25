import type {Env} from './types';

/** Only these finite dimensions can reach console output or Analytics Engine.
 * No request/response objects, headers, URLs, identifiers, SQL or error objects.
 */
const names=new Set(['request','job','email','error','feed_phase']);
export const FEED_PHASES=['journal_check','journal_close','auth_session','auth_status','social_connect_begin','social_actor','social_query','social_commit','social_close'] as const;
export type FeedPhase=typeof FEED_PHASES[number];
const feedPhases=new Set<string>(FEED_PHASES);
const codes=new Set(['accepted','send_failed','auth_failed','request_failed','cleanup_complete','cleanup_retry','outbox_retry','outbox_delivered','email_outbox_retry','recovery_email_retry','media_backup_retry','journal_not_initialized','restore_quarantined','database_rollback_detected','journal_not_configured','journal_unavailable','journal_store_read_failed','journal_control_invalid','journal_database_read_failed','journal_database_status_invalid']);
const methods=new Set(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']);
const environments=new Set(['development','staging','production']);
const routes=new Set(['/health','/api/operations/health','/api/v1/feed','/api/auth/*','/api/account-recovery/*','/api/*','/assets/*',
 ...['sign-in/email','sign-up/email','sign-out','get-session','verify-email','request-password-reset','reset-password','send-verification-email','change-password','list-sessions','revoke-session','revoke-sessions'].map(route=>'/api/auth/'+route)]);
type Fields={route?:string;method?:string;status?:number;durationMs?:number;code?:string;environment?:string;count?:number};
type MetricsEnvironment=Pick<Env,'ENVIRONMENT'|'METRICS'|'FEED_PHASE_TIMING'>;
export function event(name:'request'|'job'|'email'|'error'|'feed_phase',fields:Fields={},env?:MetricsEnvironment):void{
 try{
  if(!names.has(name))return;
  if(name==='feed_phase'){
   // Gate here as well as at the call sites: even an accidental direct call
   // cannot enable production diagnostics or attach extra fields to a phase.
   if(env?.ENVIRONMENT!=='staging'||env.FEED_PHASE_TIMING!=='true'||fields.route!=='/api/v1/feed'||fields.method!=='GET'||!fields.code||!feedPhases.has(fields.code))return;
   if(typeof fields.durationMs!=='number'||!Number.isFinite(fields.durationMs)||fields.durationMs<0||fields.durationMs>3_600_000)return;
   fields={route:'/api/v1/feed',method:'GET',code:fields.code,durationMs:fields.durationMs};
  }
  const safe:Record<string,string|number>={event:name};
  if(typeof fields.route==='string'&&routes.has(fields.route))safe.route=fields.route;
  if(fields.method&&methods.has(fields.method))safe.method=fields.method;
  if(fields.code&&(name==='feed_phase'?feedPhases:codes).has(fields.code))safe.code=fields.code;
  const environment=env?.ENVIRONMENT??fields.environment;
  if(environment&&environments.has(environment))safe.environment=environment;
  if(Number.isInteger(fields.status)&&fields.status!>=100&&fields.status!<=599)safe.status=fields.status!;
  if(typeof fields.durationMs==='number'&&Number.isFinite(fields.durationMs)&&fields.durationMs>=0&&fields.durationMs<=3_600_000)safe.durationMs=Math.round(fields.durationMs);
  if(Number.isInteger(fields.count)&&fields.count!>=0&&fields.count!<=1_000_000)safe.count=fields.count!;
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
   doubles:[status,Number(safe.durationMs??-1),Number(safe.count??0)],
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
