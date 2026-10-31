import {openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
type Database={query:(text:string,values?:unknown[])=>Promise<{rows:unknown[]}>};
type Lock=Database&{release:(destroy?:boolean)=>void;on:(event:'error',callback:()=>void)=>unknown};
type Options={directory:string;db:Database;lock:Lock;session:{memberId:string;sessionId:string;cookie:string};assertScope:()=>void;transport?:typeof fetch};
const failed=()=>new Error('STAGING_INFLIGHT_REQUEST_UNVERIFIED');
/** Only exact advisory-lock metadata is returned, never other sessions' SQL. */
export const inflightWaiterQuery="WITH k AS(SELECT hashtextextended('porchday-identity:'||$1,0) AS h) SELECT count(*)::int AS waiting FROM pg_locks l,k WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=((h>>32)&4294967295)::oid AND objid=(h&4294967295)::oid AND objsubid=1 AND NOT granted AND $2::int=ANY(pg_blocking_pids(l.pid))";

/** Caller supplies one dedicated, connected staging lock client and owns the
 * exact synthetic fixture, provider admission and post-rollback commit audit.
 * Always await close() in the outer harness finally. */
export function createStagingInflightRevocation(input:Options,caller:AbortSignal){
 const session=z.object({memberId:z.uuid(),sessionId:z.uuid(),cookie:z.string().min(1).max(16384).regex(/^[^\r\n]+$/)}).strict().parse(input.session);
 const local=new AbortController(),signal=AbortSignal.any([caller,local.signal]);
 let phase:'new'|'starting'|'waiting'|'finishing'|'verified'|'failed'='new',released=false,expired=false,pid=0,startedAt=0,markerBefore='',generation='';
 let holdTimer:ReturnType<typeof setTimeout>|undefined,request:Promise<{known:boolean;status?:number;endedAt:number}>|undefined,settled=false;
 let evidence:{markerBefore:string;generation:string;startedAt:number;endedAt:number;waitingBeforeDispatch:true;waitingAfterRestore:true}|undefined;
 const save=(name:string,value:unknown)=>{const fd=openSync(join(input.directory,`inflight-request-${name}.json`),'wx',0o600);try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}const parent=openSync(input.directory,'r');try{fsyncSync(parent);}finally{closeSync(parent);}};
 const check=(s=signal)=>{s.throwIfAborted();signal.throwIfAborted();input.assertScope();if(expired)throw failed();};
 const destroy=()=>{if(released)return;released=true;if(holdTimer)clearTimeout(holdTimer);input.lock.release(true);};
 input.lock.on('error',()=>{expired=true;local.abort();destroy();});
 async function bounded<T>(work:()=>Promise<T>,s:AbortSignal,milliseconds=5000){
  check(s);const limit=AbortSignal.any([s,signal,AbortSignal.timeout(milliseconds)]);let abort=()=>{};
  try{return await Promise.race([work(),new Promise<never>((_,reject)=>{abort=()=>reject(failed());limit.addEventListener('abort',abort,{once:true});if(limit.aborted)abort();})]);}finally{limit.removeEventListener('abort',abort);}
 }
 const query=(db:Database,text:string,values:unknown[]|undefined,s:AbortSignal)=>bounded(()=>db.query(text,values),s);
 async function waiting(s:AbortSignal){const result=await query(input.db,inflightWaiterQuery,[session.memberId,pid],s);check(s);return result.rows.length===1&&(result.rows[0] as {waiting?:unknown}).waiting===1;}
 async function unlock(s:AbortSignal){if(released)throw failed();try{await query(input.lock,'ROLLBACK',undefined,s);check(s);released=true;clearTimeout(holdTimer);input.lock.release();}catch{destroy();throw failed();}}
 async function http(path:string,method:'POST'|'GET',s:AbortSignal){
  const timeout=AbortSignal.any([s,signal,AbortSignal.timeout(10000)]);
  return bounded(async()=>{const response=await (input.transport??fetch)('https://staging.porchday.com'+path,{method,redirect:'error',signal:timeout,headers:{Cookie:session.cookie,Origin:'https://staging.porchday.com','Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})});await response.body?.cancel();return response.status;},timeout,10000);
 }
 return{
  start:async(s:AbortSignal):Promise<'in-flight'>=>{
   if(phase!=='new')throw failed();phase='starting';
   try{
    check(s);save('intent',{at:new Date().toISOString(),memberId:session.memberId,sessionId:session.sessionId,automaticRetry:false});
    const owned=await query(input.db,'SELECT EXISTS(SELECT 1 FROM public.auth_session WHERE id=$1 AND "userId"=$2) AS owned',[session.sessionId,session.memberId],s);
    if(owned.rows.length!==1||(owned.rows[0] as {owned?:unknown}).owned!==true)throw failed();
    const baseline=await query(input.db,"SELECT coalesce(max(sequence),0)::text AS n,(app.safety_status())->>'generation' AS generation FROM app.privacy_operation_commits",undefined,s);
    const row=z.object({n:z.string().regex(/^(0|[1-9][0-9]*)$/),generation:z.uuid()}).parse(baseline.rows.length===1?baseline.rows[0]:null);markerBefore=row.n;generation=row.generation;
    await query(input.lock,'BEGIN',undefined,s);
    // Independent server limits also release the lock on a lost host/process.
    await query(input.lock,"SET LOCAL statement_timeout='5s'",undefined,s);await query(input.lock,"SET LOCAL transaction_timeout='12s'",undefined,s);await query(input.lock,"SET LOCAL idle_in_transaction_session_timeout='12s'",undefined,s);
    const acquired=await query(input.lock,"SELECT pg_backend_pid() AS pid,pg_try_advisory_xact_lock(hashtextextended('porchday-identity:'||$1,0)) AS acquired",[session.memberId],s);
    const lock=z.object({pid:z.number().int().positive(),acquired:z.literal(true)}).parse(acquired.rows.length===1?acquired.rows[0]:null);pid=lock.pid;
    holdTimer=setTimeout(()=>{expired=true;local.abort();destroy();},9000);
    check(s);startedAt=Date.now();save('dispatch',{startedAt,markerBefore,generation,maximumHoldMs:9000,automaticRetry:false});
    request=http('/api/auth/revoke-sessions','POST',s).then(status=>({known:true,status,endedAt:Date.now()}),()=>({known:false,endedAt:Date.now()})).then(result=>{settled=true;try{save('outcome',result);}catch{return{known:false,endedAt:result.endedAt};}return result;});
    const until=Date.now()+3500;let observed=false;
    while(Date.now()<until&&!settled){if(await waiting(s)){observed=true;break;}await bounded(()=>new Promise(resolve=>setTimeout(resolve,100)),s);}
    check(s);if(!observed||settled)throw failed();save('waiting-before',{at:Date.now(),ownedWaiterBlockedByOwnedConnection:true});phase='waiting';return 'in-flight';
   }catch{phase='failed';local.abort();destroy();throw failed();}
  },
  finish:async(s:AbortSignal):Promise<'verified'>=>{
   if(phase!=='waiting')throw failed();phase='finishing';
   try{
    check(s);if(settled||!await waiting(s)||settled)throw failed();save('waiting-after',{at:Date.now(),ownedWaiterBlockedByOwnedConnection:true});
    await unlock(s);const result=await bounded(()=>request!,s);check(s);
    if(!result.known||result.status!==200||result.endedAt-startedAt>10000)throw failed();
    const denied=await http('/api/v1/me?bootstrap=1','GET',s);check(s);save('denial',{at:Date.now(),status:denied});if(denied!==401)throw failed();
    evidence={markerBefore,generation,startedAt,endedAt:result.endedAt,waitingBeforeDispatch:true,waitingAfterRestore:true};save('verified',evidence);phase='verified';return 'verified';
   }catch{phase='failed';local.abort();destroy();throw failed();}
  },
  result:()=>{if(phase!=='verified'||!evidence)throw failed();return{...evidence};},
  close:async()=>{local.abort();destroy();await request;},
 };
}
