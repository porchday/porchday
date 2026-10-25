import {beforeAll, afterAll, describe, it, expect, vi} from 'vitest';
import {createECDH, randomBytes, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readdir, readFile} from 'node:fs/promises';
import {Hono} from 'hono';
import postgres, {type Sql} from 'postgres';
import webPush from 'web-push';
import {z} from 'zod';
import {withMember} from '../src/db';
import {registerPushRoutes, processWebPush, generatePushRequest, validatePushSubscription, validPushEndpoint, GENERIC_PUSH_PAYLOAD} from '../src/social-push';
import type {Env, Variables} from '../src/types';

const ece = createRequire(import.meta.url)('http_ece');
const vapid = webPush.generateVAPIDKeys();
const config = {VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:push@example.test'};
function browser() {
  const key = createECDH('prime256v1'); key.generateKeys();
  const auth = randomBytes(16).toString('base64url');
  return {key, subscription: {endpoint: 'https://fcm.googleapis.com/wp/' + randomUUID(), keys: {p256dh: key.getPublicKey().toString('base64url'), auth}}};
}
describe('Web Push encryption and endpoint validation', () => {
  it('uses real RFC8291 encryption and VAPID with only a generic preview', async () => {
    const b = browser(); await expect(validatePushSubscription(b.subscription)).resolves.toEqual(b.subscription);
    const request = generatePushRequest(b.subscription, config);
    expect(request.headers['Content-Encoding']).toBe('aes128gcm');
    expect(request.headers.TTL).toBe(60);
    expect(request.headers.Authorization).toMatch(/^vapid t=/);
    const clear = ece.decrypt(request.body, {version: 'aes128gcm', privateKey: b.key, authSecret: b.subscription.keys.auth}).toString();
    expect(clear).toBe(GENERIC_PUSH_PAYLOAD);
    expect(JSON.parse(clear)).toEqual({title: 'Porchday', body: 'You have a new update', url: '/app/notifications'});
    expect(Buffer.from(request.body!).includes(Buffer.from('You have'))).toBe(false);
  });
  it('rejects redirects-by-URL, custom servers, credentials, ports and invalid curve keys', async () => {
    for (const endpoint of ['http://fcm.googleapis.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com.evil.test/x', 'https://fcm.googleapis.com@evil.test/x', 'https://user:pass@fcm.googleapis.com/x', 'https://fcm.googleapis.com:443/x', 'https://fcm.googleapis.com/x#fragment', 'https://fcm.googleapis.com/x\n', 'https://evil.test/notify.windows.com/x']) expect(validPushEndpoint(endpoint)).toBe(false);
    for (const endpoint of ['https://updates.push.services.mozilla.com/wpush/v2/example', 'https://web.push.apple.com/example', 'https://wns2.notify.windows.com/w/?token=example']) expect(validPushEndpoint(endpoint)).toBe(true);
    await expect(validatePushSubscription({...browser().subscription, keys: {p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: randomBytes(16).toString('base64url')}})).rejects.toThrow();
  });
});

const url = process.env.PUSH_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
let sql: Sql, app: Hono<{Bindings: Env; Variables: Variables}>, env: Env;
async function seed() {
  const id = randomUUID(), session = randomUUID();
  await sql`insert into public.auth_user(id,name,email,"emailVerified") values(${id},'Push test',${id+'@example.test'},true)`;
  await sql`insert into public.auth_session(id,"userId",token,"expiresAt") values(${session},${id},${randomUUID()},now()+interval '7 days')`;
  await sql`insert into app.members(id,adult_attested_at,rules_accepted_at) values(${id},now(),now())`;
  return {id, session};
}
async function request(person: {id: string; session: string}, path: string, method = 'GET', body?: unknown) {
  const response = await app.request('https://porchday.test'+path, {method, headers: {'x-test-member': person.id, 'x-test-session': person.session, 'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)}, env);
  return {status: response.status, data: await response.json() as any};
}
async function notification(recipient: string, actor: string, postId: string | null = null) {
  const [n] = await sql`insert into app.notifications(recipient,actor,kind,post_id) values(${recipient},${actor},'comment',${postId}) returning id`;
  return n.id;
}
suite('Push HTTP authorization, durable delivery and revocation', () => {
  beforeAll(async () => {
    if (!url || !new URL(url).pathname.includes('push_test')) throw new Error('Disposable push_test DB only');
    sql = postgres(url, {prepare: false, max: 4, onnotice: () => {}});
    await sql`drop schema if exists app cascade`; await sql`drop schema public cascade`; await sql`create schema public`;
    for (const name of (await readdir(new URL('../migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort()) await sql.unsafe(await readFile(new URL('../migrations/'+name, import.meta.url), 'utf8'));
    await sql.unsafe("DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='porchday_push_social_test') THEN CREATE ROLE porchday_push_social_test LOGIN PASSWORD 'push-test-social' IN ROLE porchday_social; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='porchday_push_jobs_test') THEN CREATE ROLE porchday_push_jobs_test LOGIN PASSWORD 'push-test-jobs' IN ROLE porchday_jobs; END IF; END $$");
    const socialUrl = new URL(url); socialUrl.username = 'porchday_push_social_test'; socialUrl.password = 'push-test-social';
    const jobsUrl = new URL(url); jobsUrl.username = 'porchday_push_jobs_test'; jobsUrl.password = 'push-test-jobs';
    env = {...config, HYPERDRIVE_SOCIAL: {connectionString: socialUrl.href}, HYPERDRIVE_JOBS: {connectionString: jobsUrl.href}} as Env;
    app = new Hono(); app.use('*', async (c, next) => {c.set('memberId', c.req.header('x-test-member')!); c.set('sessionId', c.req.header('x-test-session')!); await next();});
    const fail = (code: string, status = 400): never => {throw Object.assign(new Error(code), {status});};
    registerPushRoutes(app, {tx: (c, fn) => withMember(c.env, c.get('memberId'), fn), body: async (c, schema) => schema.parse(await c.req.json()), fail, id: value => z.string().uuid().parse(value)});
    app.onError((err, c) => c.json({error: {code: err.message}}, (err as any).status || (err.message === 'FORBIDDEN' ? 403 : 500)));
  }, 30000);
  afterAll(async () => {if (sql) await sql.end();});
  it('isolates endpoints, binds them to an owned session, and cascades sign-out', async () => {
    const a = await seed(), b = await seed(), sub = browser().subscription;
    expect((await request(a, '/push/config')).data.enabled).toBe(true);
    expect((await request({...a, session: b.session}, '/push/subscriptions', 'POST', sub)).status).toBe(403);
    const added = await request(a, '/push/subscriptions', 'POST', sub); expect(added.status, JSON.stringify(added.data)).toBe(201);
    expect((await request(a, '/push/subscriptions', 'POST', sub)).data.id).toBe(added.data.id);
    expect((await request(b, '/push/subscriptions', 'POST', sub)).status).toBe(409);
    expect((await request(b, '/push/subscriptions')).data.items).toEqual([]);
    await request(b, '/push/subscriptions/'+added.data.id, 'DELETE');
    const listed = (await request(a, '/push/subscriptions')).data.items;
    expect(listed).toHaveLength(1); expect(listed[0].current_session).toBe(true); expect(listed[0].endpoint).toBeUndefined();
    await notification(a.id, b.id);
    expect(await sql`select id from app.push_outbox where subscription_id=${added.data.id}`).toHaveLength(1);
    await sql`delete from public.auth_session where id=${a.session}`;
    expect(await sql`select id from app.push_subscriptions where id=${added.data.id}`).toHaveLength(0);
    expect(await sql`select id from app.push_outbox where subscription_id=${added.data.id}`).toHaveLength(0);
  });
  it('sends real encrypted request bytes through injected fetch, retries 429, and removes 410 subscriptions', async () => {
    const a = await seed(), b = await seed(), browserSub = browser();
    const registered = await request(a, '/push/subscriptions', 'POST', browserSub.subscription);
    const n = await notification(a.id, b.id);
    const send = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual'); expect(init?.signal).toBeDefined();
      const clear = ece.decrypt(Buffer.from(init?.body as Uint8Array), {version:'aes128gcm', privateKey:browserSub.key, authSecret:browserSub.subscription.keys.auth}).toString();
      expect(clear).toBe(GENERIC_PUSH_PAYLOAD);
      return new Response(null, {status: 429, headers: {'Retry-After':'120'}});
    });
    expect(await processWebPush(env, send as typeof fetch)).toEqual({sent:0,retried:1,skipped:0});
    const [pending] = await sql`select attempts,next_retry>now()+interval '100 seconds' as delayed from app.push_outbox where notification_id=${n}`;
    expect(pending).toEqual({attempts:1,delayed:true});
    await sql`update app.push_outbox set next_retry=now() where notification_id=${n}`;
    expect(await processWebPush(env, vi.fn(async () => new Response(null,{status:201})) as typeof fetch)).toEqual({sent:1,retried:0,skipped:0});
    await notification(a.id,b.id);
    expect(await processWebPush(env, vi.fn(async () => new Response(null,{status:410})) as typeof fetch)).toEqual({sent:0,retried:0,skipped:1});
    expect(await sql`select id from app.push_subscriptions where id=${registered.data.id}`).toHaveLength(0);
  });
  it('fails redirects without following Location or removing the valid subscription', async () => {
    const a = await seed(), b = await seed(), sub = browser().subscription;
    const registered = await request(a, '/push/subscriptions', 'POST', sub);
    for (const status of [301, 302, 303, 307, 308]) {
      const n = await notification(a.id, b.id);
      const cancelled = vi.fn();
      const response = new Response(new ReadableStream({cancel: cancelled}), {status, headers: {Location: 'https://attacker.test/capture', 'Retry-After': '3600'}});
      const send = vi.fn(async (url: unknown, init?: RequestInit) => {
        expect(url).toBe(sub.endpoint); expect(init?.redirect).toBe('manual');
        return response;
      });
      expect(await processWebPush(env, send as typeof fetch)).toEqual({sent: 0, retried: 0, skipped: 1});
      expect(send).toHaveBeenCalledTimes(1); expect(cancelled).toHaveBeenCalledTimes(1);
      expect((await sql`select outcome,completed_at is not null as finished from app.push_outbox where notification_id=${n}`)[0]).toEqual({outcome: 'failed', finished: true});
      expect(await sql`select id from app.push_subscriptions where id=${registered.data.id}`).toHaveLength(1);
    }
  });
  it('rechecks read state, blocks, mute, status, opt-out, expiration and deletion before delivery', async () => {
    const a = await seed(), b = await seed();
    await request(a,'/push/subscriptions','POST',browser().subscription);
    const n = await notification(a.id,b.id);
    await sql`update app.notifications set read_at=now() where id=${n}`;
    const send = vi.fn(async () => new Response(null,{status:201}));
    expect((await processWebPush(env,send as typeof fetch)).skipped).toBe(1); expect(send).not.toHaveBeenCalled();
    await notification(a.id,b.id); await sql`insert into app.mutes(actor,target) values(${a.id},${b.id})`;
    expect((await processWebPush(env,send as typeof fetch)).skipped).toBe(1); expect(send).not.toHaveBeenCalled();
    await sql`delete from app.mutes where actor=${a.id}`;
    await notification(a.id,b.id); await sql`insert into app.blocks(actor,target) values(${a.id},${b.id})`;
    expect((await processWebPush(env,send as typeof fetch)).skipped).toBe(1); expect(send).not.toHaveBeenCalled();
    await sql`delete from app.blocks where actor=${a.id}`;
    const post = randomUUID();
    await sql`insert into app.posts(id,author_id,audience,envelope,epoch,created_at,expires_at) values(${post},${a.id},'only_me','{}',1,now()-interval '5 minutes',now()+interval '1 minute')`;
    await notification(a.id,b.id,post); await sql`update app.posts set expires_at=now()-interval '1 second' where id=${post}`;
    expect((await processWebPush(env,send as typeof fetch)).skipped).toBe(1); expect(send).not.toHaveBeenCalled();
    await notification(a.id,b.id,post); await sql`delete from app.posts where id=${post}`;
    expect((await processWebPush(env,send as typeof fetch)).sent).toBe(0); expect(send).not.toHaveBeenCalled();
    await notification(a.id,b.id); await request(a,'/push/subscriptions','DELETE');
    expect(await sql`select id from app.push_subscriptions where member_id=${a.id}`).toHaveLength(0);
    expect(await sql`select o.id from app.push_outbox o join app.notifications n on n.id=o.notification_id where n.recipient=${a.id}`).toHaveLength(0);
    await request(a,'/push/subscriptions','POST',browser().subscription);
    await sql`update app.members set status='suspended' where id=${a.id}`;
    expect(await sql`select id from app.push_subscriptions where member_id=${a.id}`).toHaveLength(0);
    await expect(sql.begin(async db => {await db`set local role porchday_social`; await db`select * from app.push_outbox`;})).rejects.toMatchObject({code:'42501'});
  });
  it('leases work once, rejects stale completion tokens, and stops after bounded attempts', async () => {
    const a = await seed(), b = await seed();
    const subscription = await request(a,'/push/subscriptions','POST',browser().subscription);
    const n = await notification(a.id,b.id);
    const claim = () => sql.begin(async db => {await db`set local role porchday_jobs`; return db`select * from app.claim_push(20)`;});
    const [first] = await claim(); expect(first.attempts).toBe(1); expect(await claim()).toHaveLength(0);
    await sql`update app.push_outbox set next_retry=now() where notification_id=${n}`;
    const [second] = await claim(); expect(second.lease).not.toBe(first.lease);
    await sql.begin(async db => {await db`set local role porchday_jobs`; await db`select app.finish_push(${first.id},${first.lease},'gone',60)`;});
    expect(await sql`select id from app.push_subscriptions where id=${subscription.data.id}`).toHaveLength(1);
    const [pending] = await sql`select completed_at,lease from app.push_outbox where id=${first.id}`;
    expect(pending.completed_at).toBeNull(); expect(pending.lease).toBe(second.lease);
    await sql`update app.push_outbox set attempts=8,next_retry=now() where id=${first.id}`;
    expect(await claim()).toHaveLength(0);
    expect((await sql`select outcome from app.push_outbox where id=${first.id}`)[0].outcome).toBe('expired');
    await expect(sql.begin(async db => {await db`set local role porchday_social`; return db`select app.claim_push(20)`;})).rejects.toMatchObject({code:'42501'});
  });
});
