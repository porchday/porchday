import {Hono, type Context} from 'hono';
import {z} from 'zod';
import postgres from 'postgres';
import webPush, {type PushSubscription} from 'web-push';
import type {Db} from './db.js';
import type {Env, Variables} from './types.js';

type C = Context<{Bindings: Env; Variables: Variables}>;
type PushEnv = Pick<Env, 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT'>;
type Dependencies = {
  tx<T>(c: C, fn: (db: Db) => Promise<T>): Promise<T>;
  body<T>(c: C, schema: z.ZodType<T>, maxBytes?: number): Promise<T>;
  fail(code: string, status?: 400 | 403 | 404 | 409 | 413 | 429): never;
  id(raw: string | undefined): string;
};
const subscriptionSchema = z.object({
  endpoint: z.string().min(1).max(2048),
  keys: z.object({p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/)}).strict(),
  expirationTime: z.number().nullable().optional(),
}).strict();

/** Browser push services only. Never follow redirects or allow custom push URLs. */
export function validPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return endpoint.length <= 2048 && /^[\x21-\x7e]+$/.test(endpoint)
      && u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.hash
      && u.pathname.length > 1 && u.href === endpoint
      && (['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'].includes(u.hostname)
        || /^[a-z0-9-]+\.notify\.windows\.com$/.test(u.hostname));
  } catch { return false; }
}
export async function validatePushSubscription(value: unknown): Promise<PushSubscription> {
  const parsed = subscriptionSchema.parse(value);
  if (!validPushEndpoint(parsed.endpoint)) throw new Error('INVALID_PUSH_ENDPOINT');
  const raw = Uint8Array.from(atob(parsed.keys.p256dh.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('INVALID_PUSH_KEY');
  await crypto.subtle.importKey('raw', raw, {name: 'ECDH', namedCurve: 'P-256'}, false, []);
  return {endpoint: parsed.endpoint, keys: parsed.keys};
}
function configured(env: PushEnv): boolean {return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);}

export function registerPushRoutes(app: Hono<{Bindings: Env; Variables: Variables}>, deps: Dependencies) {
  const {tx, body, fail, id} = deps;
  app.get('/push/config', c => c.json({enabled: configured(c.env), public_key: configured(c.env) ? c.env.VAPID_PUBLIC_KEY : null}));
  app.get('/push/subscriptions', async c => c.json({items: await tx(c, db => db`
    select id,created_at,last_used_at,session_id=${c.get('sessionId')} as current_session
    from app.push_subscriptions order by created_at desc`)}));
  app.post('/push/subscriptions', async c => {
    if (!configured(c.env)) fail('PUSH_NOT_CONFIGURED', 409);
    const input = await body(c, subscriptionSchema, 4096);
    let subscription: PushSubscription;
    try {subscription = await validatePushSubscription(input);} catch {return fail('INVALID_PUSH_SUBSCRIPTION');}
    if (!c.get('sessionId')) fail('UNAUTHORIZED', 403);
    try {
      return c.json(await tx(c, async db => {
        const [r] = await db`select app.register_push(${c.get('sessionId')},${subscription.endpoint},${subscription.keys.p256dh},${subscription.keys.auth}) as id`;
        return {id: r.id};
      }), 201);
    } catch (error) {
      if (['PUSH_ENDPOINT_IN_USE', 'PUSH_DEVICE_LIMIT'].includes((error as Error).message)) fail((error as Error).message, 409);
      throw error;
    }
  });
  app.delete('/push/subscriptions/:id', async c => c.json(await tx(c, async db => {
    await db`delete from app.push_subscriptions where id=${id(c.req.param('id'))}`;
    return {ok: true};
  })));
  app.delete('/push/subscriptions', async c => c.json(await tx(c, async db => {
    await db`update app.members set notification_preferences=jsonb_set(notification_preferences,'{push}','false') where id=${c.get('memberId')}`;
    return {ok: true};
  })));
}

/** No social identifiers, names, text, counts or secret keys enter this payload. */
export const GENERIC_PUSH_PAYLOAD = JSON.stringify({title: 'Porchday', body: 'You have a new update', url: '/app/notifications'});
export function generatePushRequest(subscription: PushSubscription, env: PushEnv) {
  if (!configured(env) || !validPushEndpoint(subscription.endpoint)) throw new Error('PUSH_UNAVAILABLE');
  return webPush.generateRequestDetails(subscription, GENERIC_PUSH_PAYLOAD, {
    vapidDetails: {subject: env.VAPID_SUBJECT!, publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY!},
    contentEncoding: 'aes128gcm', TTL: 60, urgency: 'normal', topic: 'porchday-update',
  });
}

/** Manual redirects keep VAPID credentials and ciphertext on the validated endpoint. */
export function webPushRequest(subscription: PushSubscription, env: PushEnv) {
  const request = generatePushRequest(subscription, env);
  return {url: request.endpoint, init: {
    method: request.method, headers: request.headers, body: new Uint8Array(request.body!),
    redirect: 'manual', signal: AbortSignal.timeout(8000),
  } satisfies RequestInit};
}

/** At-least-once delivery; fixed topic collapses crash-retried generic previews. */
export async function processWebPush(env: Pick<Env, 'HYPERDRIVE_JOBS'> & PushEnv, send: typeof fetch = fetch): Promise<{sent: number; retried: number; skipped: number}> {
  const counts = {sent: 0, retried: 0, skipped: 0};
  if (!configured(env)) return counts;
  const sql = postgres(env.HYPERDRIVE_JOBS.connectionString, {max: 1, prepare: true, fetch_types: false, connect_timeout: 10});
  try {
    const jobs = await sql`select * from app.claim_push(20)`;
    for (let offset = 0; offset < jobs.length; offset += 4) {
      await Promise.all(jobs.slice(offset, offset + 4).map(async job => {
        const [row] = await sql`select app.prepare_push(${job.id},${job.lease}) as subscription`;
        if (!row?.subscription) {counts.skipped++; return;}
        let outcome = 'retry';
        let delay = Math.min(3600, 15 * 2 ** Math.min(Number(job.attempts), 8));
        try {
          const request = webPushRequest(row.subscription, env);
          const response = await send(request.url, request.init);
          if (response.status >= 300 && response.status < 400) outcome = 'failed';
          else if (response.ok) outcome = 'sent';
          else if ([404, 410].includes(response.status)) outcome = 'gone';
          else if (response.status === 429 || response.status >= 500 || [401, 403].includes(response.status)) {
            const retryAfter = response.headers.get('Retry-After');
            const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : retryAfter ? (Date.parse(retryAfter) - Date.now()) / 1000 : 0;
            if (Number.isFinite(seconds)) delay = Math.min(3600, Math.max(delay, Math.ceil(seconds)));
          } else outcome = 'failed';
          // Never read, return or log push-provider response bodies or endpoint URLs.
          await response.body?.cancel();
        } catch { /* Network/configuration failures retry with bounded backoff. */ }
        await sql`select app.finish_push(${job.id},${job.lease},${outcome},${delay})`;
        if (outcome === 'sent') counts.sent++;
        else if (outcome === 'retry') counts.retried++;
        else counts.skipped++;
      }));
    }
    return counts;
  } finally {await sql.end({timeout: 1});}
}
