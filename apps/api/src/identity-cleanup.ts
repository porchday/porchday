import postgres from 'postgres';
import {authPool} from './auth';
import type {Env} from './types';
import {trackPostgres} from './connection-metrics';
/** Social deletion is durable first; retry identity erasure without restoring deleted data. */
export async function cleanupDeletedIdentities(env: Env):Promise<number>{
 const jobs=trackPostgres(env,'jobs',postgres(env.HYPERDRIVE_JOBS.connectionString,{max:1,prepare:true,fetch_types:false}));
 const auth=authPool(env);let count=0;
 try{
  const rows=await jobs`SELECT member_id FROM app.identity_deletion_outbox WHERE completed_at IS NULL ORDER BY created_at LIMIT 100`;
  for(const row of rows){
   const client=await auth.connect();
   try{
    await client.query('BEGIN');
    await client.query('DELETE FROM public.auth_verification WHERE value=$1',[row.member_id]);
    await client.query('DELETE FROM public.pilot_invitations WHERE consumed_user=$1',[row.member_id]);
    await client.query('DELETE FROM public.auth_user WHERE id=$1',[row.member_id]);
    await client.query('COMMIT');
   }catch{await client.query('ROLLBACK');throw new Error('IDENTITY_CLEANUP_RETRY');}
   finally{client.release();}
   await jobs`UPDATE app.identity_deletion_outbox SET completed_at=now() WHERE member_id=${row.member_id}`;
   count++;
  }
  return count;
 }finally{await Promise.all([jobs.end({timeout:1}),auth.end()]);}
}
