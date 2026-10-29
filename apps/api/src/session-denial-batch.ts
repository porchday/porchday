import type {Pool} from 'pg';
import {DenialCleanupError,deleteDeniedSession} from './session-denial-cleanup';

export const denialDeleteBatchLimit=24;
/** Confirmed input prefix; deleted counts only IDs within that prefix. A member
 * group may also delete later IDs, but those do not advance discovery progress. */
export interface DenialBatchResult{completed:number;deleted:Set<string>}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Internal cleanup primitive: the caller must have independently verified an
 * immutable denial for every ID. Never consult R2 while holding a SQL lock.
 * Each member gets a separate transaction: a contended member cannot hold
 * another member's identity lock. Normal budget exhaustion returns only the
 * confirmed ordered prefix. SQL failures/unknown commits still throw, requiring
 * an unchanged checkpoint and exact idempotent deletion reconciliation.
 */
export async function deleteDeniedSessionBatch(pool:Pool,ids:readonly string[],workDeadline=Date.now()+20000):Promise<DenialBatchResult>{
 if(!Array.isArray(ids)||ids.length>denialDeleteBatchLimit||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!uuid.test(id))||!Number.isSafeInteger(workDeadline)||workDeadline>Date.now()+20000)throw new DenialCleanupError();
 const expired=()=>Date.now()>=workDeadline;
 const deleted=new Set<string>(),completed=new Set<string>();
 const finish=():DenialBatchResult=>{let count=0;while(count<ids.length&&completed.has(ids[count]))count++;return {completed:count,deleted:new Set(ids.slice(0,count).filter(id=>deleted.has(id)))};};
 if(!ids.length||expired())return finish();
 // Avoid adding discovery overhead to small groups.
 if(ids.length<4){for(const id of ids){if(expired())break;if(await deleteDeniedSession(pool,id))deleted.add(id);completed.add(id);}return finish();}
 const client=await pool.connect();let failed=false,transaction=false;
 const query=(text:string,values?:unknown[])=>{
  // pg supports this deadline; its QueryConfig types omit the field.
  const config={text,values,query_timeout:6000};return client.query(config);
 };
 try{
  if(expired())return finish();
  transaction=true;await query("BEGIN READ ONLY; SET LOCAL statement_timeout='5s'");
  const targets=await query('SELECT id,"userId" AS member_id FROM public.auth_session WHERE id=ANY($1::text[]) ORDER BY id',[ids]);
  const owners=new Map<string,string>();
  for(const row of targets.rows){
   if(!ids.includes(row.id)||typeof row.member_id!=='string'||!row.member_id||owners.has(row.id))throw new DenialCleanupError();
   owners.set(row.id,row.member_id);
  }
  await query('COMMIT');transaction=false;
  const members=new Map<string,string[]>();
  // Input order is the caller's keyset order. First-appearance member order
  // guarantees useful prefix progress without holding multiple member locks.
  for(const id of ids){const member=owners.get(id);if(member===undefined){completed.add(id);continue;}const group=members.get(member)??[];group.push(id);members.set(member,group);}
  for(const [memberId,sessionIds] of members){
   if(expired())break;transaction=true;
   // No member values are interpolated into this static multi-statement setup.
   await query("BEGIN; SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='5s'");
   await query("SELECT pg_advisory_xact_lock(hashtextextended('porchday-identity:'||$1,0))",[memberId]);
   // Recheck the captured owner after obtaining its lock. A moved/replaced row
   // cannot be deleted under another member's identity lock.
   const result=await query('DELETE FROM public.auth_session WHERE id=ANY($1::text[]) AND "userId"=$2 RETURNING id',[sessionIds,memberId]);
   if(result.rows.some(row=>!sessionIds.includes(row.id))||new Set(result.rows.map(row=>row.id)).size!==result.rows.length)throw new DenialCleanupError();
   await query('COMMIT');transaction=false;
   for(const row of result.rows)deleted.add(row.id);
   for(const id of sessionIds)completed.add(id);
  }
  return finish();
 }catch{failed=true;if(transaction)await query('ROLLBACK').catch(()=>{});throw new DenialCleanupError();}
 finally{client.release(failed);}
}
