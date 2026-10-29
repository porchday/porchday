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
export async function sweepSessionCandidates(store:JournalStore,list:(after:string|null)=>Promise<SessionCandidatePage>,cleanup:(id:string)=>Promise<boolean>){
 const startedAt=Date.now();
 const saved=await boundedIO(async()=>{const object=await store.get(candidateProgressKey);return object?{etag:object.etag,text:await object.text()}:null;});
 const previous=saved?parseCandidateProgress(saved.text):null;
 if(previous&&previous.pageCompletedAt>startedAt)throw new DenialCleanupError();
 const cursor=previous?.cursor??null,page=await list(cursor);
 if(!Array.isArray(page.ids)||page.ids.length>candidatePageSize||typeof page.more!=='boolean'||page.more&&!page.ids.length||
  page.ids.some(id=>typeof id!=='string'||!id||id.length>8192||id===cursor)||new Set(page.ids).size!==page.ids.length)throw new DenialCleanupError();
 const result={seen:0,deleted:0,invalid:0,advanced:false};
 let stopped=false;
 for(let offset=0;offset<page.ids.length;offset+=5){
  if(Date.now()-startedAt>=20000){stopped=true;break;}
  // Only reads run concurrently. Late reads cannot dispatch a SQL deletion.
  const batch=page.ids.slice(offset,offset+5);
  const authority=await Promise.all(batch.map(async id=>{
   try{return await boundedIO(()=>sessionDenied(store,id));}
   catch(error){if(error instanceof SessionDenialError&&['SESSION_DENIAL_INVALID','SESSION_DENIAL_ID_INVALID'].includes(error.code))return 'invalid' as const;throw new DenialCleanupError();}
  }));
  for(let i=0;i<batch.length;i++){
   if(Date.now()-startedAt>=20000){stopped=true;break;}
   if(authority[i]==='invalid')result.invalid++;
   else if(authority[i]&&await cleanup(batch[i]))result.deleted++;
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
 const updated=await boundedIO(()=>store.put(candidateProgressKey,JSON.stringify(progress),{onlyIf:saved?{etagMatches:saved.etag}:{etagDoesNotMatch:'*'}}));
 result.advanced=!!updated&&next!==cursor;return result;
}

export async function cleanupDeniedSessionCandidates(env:Env){
 if(env.SESSION_DENIAL_CLEANUP_V1!=='true')return {seen:0,deleted:0,invalid:0,advanced:false};
 if(!env.RECOVERY_JOURNAL)throw new DenialCleanupError();
 const pool=authPool(env);
 try{return await sweepSessionCandidates(env.RECOVERY_JOURNAL as JournalStore,after=>listSessionCandidates(pool,after),id=>deleteDeniedSession(pool,id));}
 finally{await pool.end();}
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
