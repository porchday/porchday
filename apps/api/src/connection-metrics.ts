import {AsyncLocalStorage} from 'node:async_hooks';
import type {Pool} from 'pg';
import type postgres from 'postgres';
import {event,type ConnectionRole} from './telemetry';
import {countTrace} from './tracing';
import type {Env} from './types';

/** Always-on aggregate accounting of Postgres connections (issue #40).
 * Every client is counted when it opens and again when it closes, with how
 * long it was held and how much of that came after the HTTP response was
 * returned. Opens minus closes over time exposes clients that are never
 * ended. Points carry only the role, a fixed code, a route pattern such as
 * /api/v1/media/:id/bytes (or job:cron / job:queue) and numbers.
 */
type MetricsEnv=Partial<Pick<Env,'ENVIRONMENT'|'METRICS'|'FEED_PHASE_TIMING'>>;
type Point={code:string;durationMs?:number;count:number;detailMs?:number;env:MetricsEnv};
type Tracker={role:ConnectionRole;env:MetricsEnv;opened:number;connections:number;closed:boolean};
type Scope={route:string;respondedAt?:number;pending:Point[]|null;open:Set<Tracker>};
const store=new AsyncLocalStorage<Scope>();

function emit(point:Point,scope=store.getStore()):void {
 if(scope?.pending){scope.pending.push(point);return;}
 try{event('db_conn',{route:scope?.route??'none',code:point.code,durationMs:point.durationMs,count:point.count,detailMs:point.detailMs},point.env as Pick<Env,'ENVIRONMENT'|'METRICS'>);}catch{}
}
/** Run a request or job with connection accounting. Points wait until the
 * route pattern is known, then flush; later closes are emitted directly. */
export async function connectionScope<T>(route:string,work:()=>Promise<T>,resolveRoute?:()=>string|undefined):Promise<T> {
 const scope:Scope={route,pending:[],open:new Set()};
 try{return await store.run(scope,work);}
 finally{
  try{
   scope.route=resolveRoute?.()??scope.route;scope.respondedAt=Date.now();
   const pending=scope.pending??[];scope.pending=null;
   for(const point of pending)emit(point,scope);
   for(const tracker of scope.open)if(!tracker.closed)emit({code:tracker.role+'_open_at_response',count:Math.max(1,tracker.connections),env:tracker.env},scope);
  }catch{}
 }
}
function open(env:MetricsEnv,role:ConnectionRole):{tracker:Tracker;scope?:Scope;connect:()=>void;close:()=>void} {
 const scope=store.getStore(),tracker:Tracker={role,env,opened:Date.now(),connections:0,closed:false};
 scope?.open.add(tracker);
 const connect=()=>{tracker.connections++;countTrace('db_conn_'+role);emit({code:role+'_open',count:1,env},scope);};
 const close=()=>{
  if(tracker.closed)return;tracker.closed=true;
  const now=Date.now(),after=scope?.respondedAt===undefined?undefined:Math.max(0,now-Math.max(scope.respondedAt,tracker.opened));
  emit({code:role+'_close',durationMs:now-tracker.opened,count:tracker.connections,detailMs:after,env},scope);
 };
 return {tracker,scope,connect,close};
}
/** postgres.js clients here use max:1, so one client is one connection. */
export function trackPostgres<T extends postgres.Sql<any>>(env:object,role:ConnectionRole,sql:T):T {
 try{
  const {connect,close}=open(env as MetricsEnv,role);connect();
  // Intercept only end(); tagged-template calls and every other member pass
  // straight through to the original client, which is left unmodified.
  const end=(options?:{timeout?:number})=>sql.end(options).finally(close);
  return new Proxy(sql,{get:(target,key)=>key==='end'?end:Reflect.get(target,key)});
 }catch{return sql;}
}
/** pg pools may open several connections; each physical connect is counted. */
export function trackPool<T extends Pool>(env:object,role:ConnectionRole,pool:T):T {
 try{
  const {connect,close}=open(env as MetricsEnv,role);
  pool.on('connect',connect);
  const end=pool.end.bind(pool) as ()=>Promise<void>;
  (pool as {end:()=>Promise<void>}).end=()=>end().finally(close);
 }catch{}
 return pool;
}
/** Classify connection refusals that reach a top-level error handler. */
export function connectionRefusal(error:unknown):string|undefined {
 const e=(error??{}) as {code?:unknown;message?:unknown;cause?:unknown};
 if(e.code==='53300')return 'refused_53300';
 if(e.code==='53400')return 'refused_53400';
 if(e.code==='CONNECT_TIMEOUT')return 'connect_timeout';
 const message=typeof e.message==='string'?e.message:'';
 if(/too many (clients|connections)/i.test(message))return 'refused_53300';
 if(/hyperdrive/i.test(message)&&/(pool|connect|timeout|limit)/i.test(message))return 'refused_hyperdrive';
 if(/(connection|connect).*(timeout|timed out)|timeout.*(acquir|connect)/i.test(message))return 'connect_timeout';
 return e.cause&&e.cause!==error?connectionRefusal(e.cause):undefined;
}
export function reportConnectionRefusal(env:object,error:unknown):void {
 const code=connectionRefusal(error);if(code)emit({code,count:1,env:env as MetricsEnv});
}
