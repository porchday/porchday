import type {Pool} from 'pg';
import type {JournalStore} from './privacy-journal';
import {sessionIdFromDenialObject,SessionDenialError} from './session-denial';
import {authPool} from './auth';
import type {Env} from './types';
const CURSOR='session-denial-maintenance/v1/cursor.json';
const PREFIX='session-denials/v1/';
export interface DenialSweepStore extends JournalStore{
 list(options:{prefix:string;limit:number;cursor?:string}):Promise<{objects:{key:string}[];truncated:boolean;cursor?:string}>;
}
export class DenialCleanupError extends Error{
 constructor(){super('SESSION_DENIAL_CLEANUP_UNAVAILABLE');}
}
async function bounded<T>(work:()=>Promise<T>):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new DenialCleanupError()),2000);})]);}
 catch{throw new DenialCleanupError();}
 finally{if(timer!==undefined)clearTimeout(timer);}
}
/** One bounded page, with a durable CAS cursor. A process stop or unknown SQL
 * commit repeats the page; cleanup must be idempotent. End-of-list wraps around
 * so objects inserted before a previous cursor are discovered on the next pass.
 * Denials are never deleted. Cursor writes are progress, not privacy authority.
 */
export async function sweepSessionDenials(store:DenialSweepStore,cleanup:(sessionId:string)=>Promise<boolean>){
 const saved=await bounded(async()=>{const object=await store.get(CURSOR);return object?{etag:object.etag,text:await object.text()}:null;});
 let cursor:string|null=null;
 if(saved){
  try{
   const value=JSON.parse(saved.text);
   if(value?.v!==1||!(value.cursor===null||typeof value.cursor==='string'&&value.cursor.length>0&&value.cursor.length<=8192)||Object.keys(value).sort().join(',')!=='cursor,v')throw Error();
   cursor=value.cursor;
  }catch{throw new DenialCleanupError();}
 }
 const page=await bounded(()=>store.list({prefix:PREFIX,limit:10,...(cursor?{cursor}:{})}));
 if(!Array.isArray(page.objects)||page.objects.length>10||typeof page.truncated!=='boolean'||page.truncated&&(typeof page.cursor!=='string'||!page.cursor||page.cursor===cursor||page.cursor.length>8192))throw new DenialCleanupError();
 const result={seen:0,deleted:0,invalid:0,advanced:false};
 for(const object of page.objects){
  result.seen++;
  if(typeof object?.key!=='string'||!object.key.startsWith(PREFIX)){result.invalid++;continue;}
  const text=await bounded(async()=>{const record=await store.get(object.key);return record?record.text():null;});
  if(text===null)throw new DenialCleanupError(); // Listed immutable authority disappeared; do not advance.
  let sessionId:string;
  try{sessionId=await sessionIdFromDenialObject(object.key,text);}
  catch(error){if(!(error instanceof SessionDenialError))throw error;result.invalid++;continue;}
  if(await cleanup(sessionId))result.deleted++;
 }
 const next=page.truncated?page.cursor!:null;
 if(next===cursor)return result; // A single page needs no persistent cursor.
 const updated=await bounded(()=>store.put(CURSOR,JSON.stringify({v:1,cursor:next}),{onlyIf:saved?{etagMatches:saved.etag}:{etagDoesNotMatch:'*'}}));
 result.advanced=!!updated; // Another worker won the cursor; never overwrite it.
 return result;
}
/** Caller has already verified an immutable denial. No R2 operation occurs
 * while holding a SQL transaction or identity lock. A lost commit reply is
 * retried as this exact deletion, never by replaying a user operation. */
export async function deleteDeniedSession(pool:Pool,sessionId:string):Promise<boolean>{
 const client=await pool.connect();
 const query=(text:string,values?:unknown[])=>{
  // pg supports per-query read deadlines; @types/pg omits this QueryConfig field.
  const config={text,values,query_timeout:6000};return client.query(config);
 };
 let failed=false;
 try{
  await query('BEGIN');
  await query("SET LOCAL statement_timeout='5s'");
  await query("SET LOCAL lock_timeout='5s'");
  const {rows}=await query('SELECT "userId" FROM public.auth_session WHERE id=$1',[sessionId]);
  let deleted=false;
  if(rows[0]){
   await query("SELECT pg_advisory_xact_lock(hashtextextended('porchday-identity:'||$1,0))",[rows[0].userId]);
   deleted=!!(await query('DELETE FROM public.auth_session WHERE id=$1 AND "userId"=$2',[sessionId,rows[0].userId])).rowCount;
  }
  await query('COMMIT');return deleted;
 }catch{failed=true;await query('ROLLBACK').catch(()=>{});throw new DenialCleanupError();}
 finally{client.release(failed);}
}
export async function cleanupDeniedSessions(env:Env){
 if(env.SESSION_DENIAL_CLEANUP_V1!=='true')return {seen:0,deleted:0,invalid:0,advanced:false};
 if(!env.RECOVERY_JOURNAL)throw new DenialCleanupError();
 const pool=authPool(env);
 try{return await sweepSessionDenials(env.RECOVERY_JOURNAL as DenialSweepStore,id=>deleteDeniedSession(pool,id));}
 finally{await pool.end();}
}
