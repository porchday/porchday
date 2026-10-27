import {Pool, type PoolClient} from 'pg';
import type {Env} from './types';
import {measureFeedPhase, type FeedTiming} from './feed-timing';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A bounded read using the same social role/RLS and transaction-local actor.
 * pg sends Parse/Bind/Execute together, avoiding describe-first network waits.
 * No session-wide identity, cached rows, or change to other social transactions.
 */
export async function readMemberBootstrap(env: Pick<Env,'HYPERDRIVE_SOCIAL'>, memberId: string, bootstrap: boolean, timing?: FeedTiming) {
  if (!uuid.test(memberId)) throw Error('Invalid authenticated member identifier');
  const pool = new Pool({connectionString:env.HYPERDRIVE_SOCIAL.connectionString,max:1,connectionTimeoutMillis:10000,idleTimeoutMillis:1000});
  let client: PoolClient | undefined;
  try {
    await measureFeedPhase(timing,'social_connect_begin',async()=>{
      client=await pool.connect();
      // Only the strictly validated UUID enters this simple-protocol batch.
      // SET LOCAL completes before any RLS-protected data statement executes.
      await client.query(`BEGIN; SET LOCAL app.member_id = '${memberId}'`);
    });
    const member=await measureFeedPhase(timing,'social_query',async()=>{
      const {rows}=await client!.query(`select m.id,m.status,m.notification_preferences,p.handle,p.envelope,
        (select count(*)::int from app.connections) as connection_count,
        ${bootstrap ? `(select coalesce(jsonb_agg(roster order by roster.created_at),'[]'::jsonb) from
          (select id,member_id,public_key,fingerprint,created_at,revoked_at from app.device_keys) roster)` : 'null'} as startup_devices
        from app.members m join app.profiles p on p.member_id=m.id where m.id=$1::uuid`,[memberId]);
      return rows[0];
    });
    await measureFeedPhase(timing,'social_commit',async()=>{await client!.query('COMMIT');});
    if (bootstrap && member) member.startup_devices=member.startup_devices.map((device:any)=>({
      ...device,created_at:new Date(device.created_at).toISOString(),revoked_at:device.revoked_at?new Date(device.revoked_at).toISOString():null,
    }));
    if (!bootstrap && member) delete member.startup_devices;
    return {...member,connection_limit:300};
  } catch(error) {
    // Never retry a query or return data after an uncertain commit/rollback.
    if(client)try{await client.query('ROLLBACK');}catch{}
    throw error;
  } finally {
    client?.release(true);
    await measureFeedPhase(timing,'social_close',()=>pool.end());
  }
}
