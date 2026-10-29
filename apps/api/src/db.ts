import postgres, { type TransactionSql } from 'postgres';
import type { Env } from './types.js';
import {measureFeedPhase,recordFeedPhase,traceTiming,type FeedTiming} from './feed-timing';
import {trackPostgres} from './connection-metrics';
export type Db = TransactionSql;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** No session-wide identity: Hyperdrive can reassign a connection after COMMIT. */
export async function withMember<T>(env: Pick<Env, 'HYPERDRIVE_SOCIAL'>, memberId: string, work: (db: Db) => Promise<T>, timing:FeedTiming|undefined=traceTiming()): Promise<T> {
    if (!uuid.test(memberId))
        throw new Error('Invalid authenticated member identifier');
    // Hyperdrive supports prepared statements. Disabling them adds parameter
    // discovery messages that its transaction pool does not reliably support.
    // This caches query plans, never permission decisions or returned rows.
    const started=timing?performance.now():0;
    let firstParameter=false,beginEntered=false;
    // A startup milestone, not proof of socket readiness or backend allocation.
    // Ignore parameter names/values and later SET responses. Never enable the
    // driver's debug hook: it changes query/parameter enumerability on errors.
    const onparameter=timing?()=>{
        if(firstParameter||beginEntered)return;
        firstParameter=true;
        recordFeedPhase(timing,'social_first_parameter',performance.now()-started);
    }:undefined;
    const sql = trackPostgres(env, 'social', postgres(env.HYPERDRIVE_SOCIAL.connectionString, { max: 1, prepare: true, fetch_types: false, idle_timeout: 5, connect_timeout: 10, onparameter }));
    let commitStarted:number|undefined;
    try {
        const result=await sql.begin(async (db) => {
            beginEntered=true;
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
    const sql = trackPostgres(env, 'jobs', postgres(env.HYPERDRIVE_JOBS.connectionString, { max: 1, prepare: true, fetch_types: false }));
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
                  first_deleted_at=coalesce(first_deleted_at,now()),
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
