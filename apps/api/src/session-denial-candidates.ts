import {CandidateTimings} from './session-denial-timing';
import type {Pool} from 'pg';
import type {JournalStore} from './privacy-journal';
import {sessionDenied,SessionDenialError} from './session-denial';
import {DenialCleanupError,deleteDeniedSession} from './session-denial-cleanup';
import {parseDenialProgress,type DenialProgress,denialProgressHealth} from './session-denial-progress';
import {authPool} from './auth';
import type {Env} from './types';

// Separate discovery strategy and progress namespace. Never write v2 health:
// a SQL candidate pass does not prove that the historical R2 list was scanned.
export const candidateProgressKey='session-denial-maintenance/v3/sql-sessions.json';
export const candidatePageSize=100;
// Workers allow six requests waiting for response headers per invocation.
// Discovery has finished before these reads; deletion and checkpoint I/O wait
// for the entire read batch. Do not exceed the platform ceiling or overlap SQL.
const authorityReadConcurrency=6;
type CandidateProgress=Omit<DenialProgress,'v'>&{v:3;strategy:'sql-session-keyset'};
export function parseCandidateProgress(text:string):CandidateProgress{
 if(text.length>16384)throw new DenialCleanupError();
 const value=JSON.parse(text);
 if(value?.v!==3||value.strategy!=='sql-session-keyset')throw new DenialCleanupError();
 const {strategy:_,...fields}=value;
 // Share structural/time invariants, not persisted evidence or namespace.
 const checked=parseDenialProgress(JSON.stringify({...fields,v:2}));
 return {...checked,v:3,strategy:'sql-session-keyset'};
}
export function candidateProgressHealth(progress:CandidateProgress,now=Date.now()){
 return denialProgressHealth({...progress,v:2},now);
}
async function boundedIO<T>(work:()=>Promise<T>):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new DenialCleanupError()),2000);})]);}
 finally{if(timer!==undefined)clearTimeout(timer);}
}
export interface SessionCandidatePage{ids:string[];more:boolean}
/** No expiry filter: even an expired SQL row restored from a backup must be
 * checked. PostgreSQL's own collation defines both ORDER BY and keyset bounds.
 * The extra row distinguishes a complete pass from a full but truncated page.
 * No connection/transaction is held while consulting independent R2 authority.
 */
export async function listSessionCandidates(pool:Pool,after:string|null):Promise<SessionCandidatePage>{
 const client=await pool.connect();let failed=false;
 const query=(text:string,values?:unknown[])=>{
  // pg supports this deadline even though its QueryConfig types omit it.
  const config={text,values,query_timeout:6000};return client.query(config);
 };
 try{
  await query('BEGIN READ ONLY');await query("SET LOCAL statement_timeout='5s'");
  const result=await query(after===null?'SELECT id FROM public.auth_session ORDER BY id LIMIT $1':
   'SELECT id FROM public.auth_session WHERE id>$2 ORDER BY id LIMIT $1',[candidatePageSize+1,...(after===null?[]:[after])]);
  await query('COMMIT');
  return {ids:result.rows.slice(0,candidatePageSize).map(row=>row.id),more:result.rows.length>candidatePageSize};
 }catch{failed=true;await query('ROLLBACK').catch(()=>{});throw new DenialCleanupError();}
 finally{client.release(failed);}
}
/** Cost follows remaining SQL sessions, never the immutable logout history.
 * Each deletion still needs canonical R2 authority and the existing identity
 * lock. A restored/inserted row behind the cursor is found on the next pass.
 * Stop starting work after 20s; an in-flight bounded SQL operation can finish
 * later. Failed/unknown SQL leaves progress unchanged and is safely repeated.
 */
export interface CandidateSweepResult{seen:number;deleted:number;invalid:number;advanced:boolean;continuation?:string}
export async function sweepSessionCandidates(store:JournalStore,list:(after:string|null)=>Promise<SessionCandidatePage>,cleanup:(id:string)=>Promise<boolean>,expectedProgressEtag?:string,workDeadline?:number,timing=new CandidateTimings()):Promise<CandidateSweepResult>{
 const startedAt=Date.now(),deadline=workDeadline??startedAt+20000;
 if(!Number.isSafeInteger(deadline)||deadline<=startedAt||deadline>startedAt+20000)throw new DenialCleanupError();
 if(expectedProgressEtag!==undefined&&(typeof expectedProgressEtag!=='string'||!expectedProgressEtag||expectedProgressEtag.length>256))throw new DenialCleanupError();
 const saved=await timing.run('progress_read',()=>boundedIO(async()=>{const object=await store.get(candidateProgressKey);return object?{etag:object.etag,text:await object.text()}:null;}));
 // A delayed/duplicate continuation cannot restart a completed pass or fan out.
 // Cron jobs have no token and resume current persisted work after a lost send.
 if(expectedProgressEtag!==undefined&&saved?.etag!==expectedProgressEtag)return {seen:0,deleted:0,invalid:0,advanced:false};
 const previous=saved?parseCandidateProgress(saved.text):null;
 if(previous&&previous.pageCompletedAt>startedAt)throw new DenialCleanupError();
 const cursor=previous?.cursor??null,page=await timing.run('sql_list',()=>list(cursor));
 if(!Array.isArray(page.ids)||page.ids.length>candidatePageSize||typeof page.more!=='boolean'||page.more&&!page.ids.length||
  page.ids.some(id=>typeof id!=='string'||!id||id.length>8192||id===cursor)||new Set(page.ids).size!==page.ids.length)throw new DenialCleanupError();
 const result:CandidateSweepResult={seen:0,deleted:0,invalid:0,advanced:false};
 let stopped=false;
 for(let offset=0;offset<page.ids.length;offset+=authorityReadConcurrency){
  if(Date.now()>=deadline){stopped=true;break;}
  // Only reads run concurrently. Late reads cannot dispatch a SQL deletion.
  const batch=page.ids.slice(offset,offset+authorityReadConcurrency);
  const authority=await timing.run('authority_batches',()=>Promise.all(batch.map(async id=>{
   try{return await boundedIO(()=>sessionDenied(store,id));}
   catch(error){if(error instanceof SessionDenialError&&['SESSION_DENIAL_INVALID','SESSION_DENIAL_ID_INVALID'].includes(error.code))return 'invalid' as const;throw new DenialCleanupError();}
  })));
  for(let i=0;i<batch.length;i++){
   if(Date.now()>=deadline){stopped=true;break;}
   if(authority[i]==='invalid')result.invalid++;
   else if(authority[i]&&await timing.run('sql_delete',()=>cleanup(batch[i])))result.deleted++;
   result.seen++;
  }
  if(stopped)break;
 }
 if(stopped&&result.seen===0)throw new DenialCleanupError();
 const next=stopped||page.more?page.ids[result.seen-1]:null;
 const completedAt=Date.now(),passStartedAt=previous?.passStartedAt??startedAt;
 if(completedAt<startedAt)throw new DenialCleanupError();
 const seen=(previous?.passSeen??0)+result.seen,invalid=(previous?.passInvalid??0)+result.invalid;
 const progress:CandidateProgress={v:3,strategy:'sql-session-keyset',cursor:next,pageCompletedAt:completedAt,
  passStartedAt:next?passStartedAt:null,passSeen:next?seen:0,passInvalid:next?invalid:0,
  lastPass:next?(previous?.lastPass??null):{completedAt,durationMs:completedAt-passStartedAt,seen,invalid}};
 const updated=await timing.run('progress_write',()=>boundedIO(()=>store.put(candidateProgressKey,JSON.stringify(progress),{onlyIf:saved?{etagMatches:saved.etag}:{etagDoesNotMatch:'*'}})));
 result.advanced=!!updated&&next!==cursor;
 // Only the confirmed CAS winner can request the next bounded page. Completed
 // passes stop here; the normal cron starts the next pass.
 if(updated&&next!==null&&next!==cursor)result.continuation=updated.etag;
 return result;
}

/** Amortize queue delivery overhead without growing individual SQL/R2 pages.
 * At most five pages share one 20-second work-start budget and pool. Every page
 * commits its own CAS checkpoint before another page begins. Stop on a lost CAS,
 * stale token or full-pass completion; never start another pass in this batch. */
export async function drainSessionCandidates(store:JournalStore,list:(after:string|null)=>Promise<SessionCandidatePage>,cleanup:(id:string)=>Promise<boolean>,expectedProgressEtag?:string,timing=new CandidateTimings()):Promise<CandidateSweepResult>{
 const deadline=Date.now()+20000,result:CandidateSweepResult={seen:0,deleted:0,invalid:0,advanced:false};
 let token=expectedProgressEtag;
 for(let page=0;page<5&&Date.now()<deadline;page++){
  const current=await sweepSessionCandidates(store,list,cleanup,token,deadline,timing);
  result.seen+=current.seen;result.deleted+=current.deleted;result.invalid+=current.invalid;result.advanced ||= current.advanced;
  delete result.continuation;
  if(!current.continuation)return result;
  token=current.continuation;result.continuation=token;
 }
 return result;
}

export async function cleanupDeniedSessionCandidates(env:Env,expectedProgressEtag?:string):Promise<CandidateSweepResult>{
 if(env.SESSION_DENIAL_CLEANUP_V1!=='true')return {seen:0,deleted:0,invalid:0,advanced:false};
 if(!env.RECOVERY_JOURNAL)throw new DenialCleanupError();
 const timing=new CandidateTimings();
 try{return await timing.run('total',async()=>{
  const pool=authPool(env);
  try{return await drainSessionCandidates(env.RECOVERY_JOURNAL as JournalStore,after=>listSessionCandidates(pool,after),id=>deleteDeniedSession(pool,id),expectedProgressEtag,timing);}
  finally{await timing.run('pool_close',()=>pool.end());}
 });}finally{timing.flush(env);}
}

/** A timed-out send can still arrive. The checkpoint token makes its eventual
 * delivery harmless if a retry or the next cron has already advanced progress. */
export async function enqueueCandidateContinuation(env:Pick<Env,'JOBS'>&Partial<Pick<Env,'ENVIRONMENT'|'METRICS'>>,etag:string){
 const timing=new CandidateTimings();let timer:ReturnType<typeof setTimeout>|undefined;
 try{await timing.run('enqueue',()=>Promise.race([env.JOBS.send({kind:'session_denial_cleanup',denialProgressEtag:etag}),new Promise<never>((_,reject)=>{
  timer=setTimeout(()=>reject(new DenialCleanupError()),5000);
 })]));}finally{if(timer!==undefined)clearTimeout(timer);timing.flush(env as Pick<Env,'ENVIRONMENT'|'METRICS'>);}
}

/** No fallback to v2: a fresh history scan cannot prove candidate progress.
 * This is read-only and exposes aggregates, never internal session IDs. */
export async function readCandidateCleanupHealth(env:Pick<Env,'SESSION_DENIAL_CLEANUP_V1'|'RECOVERY_JOURNAL'>){
 if(env.SESSION_DENIAL_CLEANUP_V1!=='true')return {issues:[] as string[],snapshot:null};
 try{
  if(!env.RECOVERY_JOURNAL)throw new DenialCleanupError();
  const progress=await boundedIO(async()=>{
   const object=await env.RECOVERY_JOURNAL!.get(candidateProgressKey);
   return object?parseCandidateProgress(await object.text()):null;
  });
  return progress?candidateProgressHealth(progress):{issues:['session_denial_cleanup_missing'],snapshot:null};
 }catch{return {issues:['session_denial_cleanup_unavailable'],snapshot:null};}
}
