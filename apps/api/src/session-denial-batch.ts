import type {Pool} from 'pg';
import {DenialCleanupError,deleteDeniedSession} from './session-denial-cleanup';

export const denialDeleteBatchLimit=24;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Internal cleanup primitive: the caller must have independently verified an
 * immutable denial for every ID. Never consult R2 while holding a SQL lock.
 * Each member gets a separate transaction: a contended member cannot hold
 * another member's identity lock. Partial/unknown completion throws; callers
 * must leave their discovery checkpoint unchanged and reconcile/repeat only
 * these exact idempotent deletions, never a user operation.
 */
export async function deleteDeniedSessionBatch(pool:Pool,ids:readonly string[],workDeadline=Date.now()+20000):Promise<Set<string>>{
 if(!Array.isArray(ids)||ids.length>denialDeleteBatchLimit||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!uuid.test(id))||!Number.isSafeInteger(workDeadline)||workDeadline>Date.now()+20000)throw new DenialCleanupError();
 const start=()=>{if(Date.now()>=workDeadline)throw new DenialCleanupError();};
 const deleted=new Set<string>();if(!ids.length)return deleted;
 // Avoid adding discovery overhead to small groups.
 if(ids.length<4){for(const id of ids){start();if(await deleteDeniedSession(pool,id))deleted.add(id);}return deleted;}
 start();const client=await pool.connect();let failed=false,transaction=false;
 const query=(text:string,values?:unknown[])=>{
  // pg supports this deadline; its QueryConfig types omit the field.
  const config={text,values,query_timeout:6000};return client.query(config);
 };
 try{
  await query('BEGIN READ ONLY');transaction=true;
  await query("SET LOCAL statement_timeout='5s'");
  const targets=await query('SELECT id,"userId" AS member_id FROM public.auth_session WHERE id=ANY($1::text[]) ORDER BY id',[ids]);
  const members=new Map<string,string[]>();
  for(const row of targets.rows){
   if(!ids.includes(row.id)||typeof row.member_id!=='string'||!row.member_id)throw new DenialCleanupError();
   const group=members.get(row.member_id)??[];if(group.includes(row.id))throw new DenialCleanupError();group.push(row.id);members.set(row.member_id,group);
  }
  await query('COMMIT');transaction=false;
  for(const [memberId,sessionIds] of [...members].sort(([a],[b])=>a<b?-1:a>b?1:0)){
   start();await query('BEGIN');transaction=true;
   await query("SET LOCAL statement_timeout='5s'");await query("SET LOCAL lock_timeout='5s'");
   await query("SELECT pg_advisory_xact_lock(hashtextextended('porchday-identity:'||$1,0))",[memberId]);
   // Recheck the captured owner after obtaining its lock. A moved/replaced row
   // cannot be deleted under another member's identity lock.
   const result=await query('DELETE FROM public.auth_session WHERE id=ANY($1::text[]) AND "userId"=$2 RETURNING id',[sessionIds,memberId]);
   if(result.rows.some(row=>!sessionIds.includes(row.id))||new Set(result.rows.map(row=>row.id)).size!==result.rows.length)throw new DenialCleanupError();
   await query('COMMIT');transaction=false;
   for(const row of result.rows)deleted.add(row.id);
  }
  return deleted;
 }catch{failed=true;if(transaction)await query('ROLLBACK').catch(()=>{});throw new DenialCleanupError();}
 finally{client.release(failed);}
}
