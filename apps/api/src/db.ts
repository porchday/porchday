import postgres, { type TransactionSql } from 'postgres';
import type { Env } from './types.js';
import {measureFeedPhase,recordFeedPhase,type FeedTiming} from './feed-timing';
export type Db = TransactionSql;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** No session-wide identity: Hyperdrive can reassign a connection after COMMIT. */
export async function withMember<T>(env: Pick<Env, 'HYPERDRIVE_SOCIAL'>, memberId: string, work: (db: Db) => Promise<T>, timing?:FeedTiming): Promise<T> {
    if (!uuid.test(memberId))
        throw new Error('Invalid authenticated member identifier');
    const sql = postgres(env.HYPERDRIVE_SOCIAL.connectionString, { max: 1, prepare: false, fetch_types: false, idle_timeout: 5, connect_timeout: 10 });
    const started=timing?performance.now():0;
    let commitStarted:number|undefined;
    try {
        const result=await sql.begin(async (db) => {
            if(timing)recordFeedPhase(timing,'social_connect_begin',performance.now()-started);
            await measureFeedPhase(timing,'social_actor',async()=>{await db `select set_config('app.member_id', ${memberId}, true)`;});
            const value=await measureFeedPhase(timing,'social_query',()=>work(db));
            if(timing)commitStarted=performance.now();
            return value;
        }) as T;
        if(commitStarted!==undefined)recordFeedPhase(timing,'social_commit',performance.now()-commitStarted);
        return result;
    }
    finally {
        await measureFeedPhase(timing,'social_close',()=>sql.end({ timeout: 1 }));
    }
}
export async function cleanupExpired(env: Pick<Env, 'HYPERDRIVE_JOBS' | 'MEDIA'>): Promise<{
    posts: number;
    comments: number;
    abandoned_media: number;
    deleted_objects: number;
}> {
    const sql = postgres(env.HYPERDRIVE_JOBS.connectionString, { max: 1, prepare: false, fetch_types: false });
    try {
        const [row] = await sql `select app.expire_batch(200) as counts`;
        // Each claim has a bounded lease. A crash after R2 deletion is safe to retry.
        const pending = await sql.begin(async (db) => db `
      update app.deletion_outbox set attempts=attempts+1,next_retry=now()+interval '5 minutes'
      where id in(select id from app.deletion_outbox where completed_at is null and next_retry<=now() order by id limit 100 for update skip locked)
      returning id,object_key,attempts,created_at`);
        let deleted = 0;
        for (const object of pending) {
            try {
                await env.MEDIA.delete(object.object_key);
                // Revoke reads immediately, delete immediately, then verify
                // absence again after bounded (<=2 minute) pending uploads have
                // stopped. A writer crash after an outbox-first delete cannot
                // leave a late-created private object indefinitely.
                await sql `update app.deletion_outbox set
                  completed_at=case when created_at<=now()-interval '10 minutes' then now() else null end,
                  next_retry=greatest(created_at+interval '10 minutes',now()) where id=${object.id}`;
                deleted++;
            }
            catch {
                const delay = Math.min(3600, 15 * 2 ** Math.min(Number(object.attempts), 8));
                await sql `update app.deletion_outbox set next_retry=now()+${delay}*interval '1 second' where id=${object.id}`;
            }
        }
        return { ...row.counts, deleted_objects: deleted };
    }
    finally {
        await sql.end({ timeout: 1 });
    }
}
