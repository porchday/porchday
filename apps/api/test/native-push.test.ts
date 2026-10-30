import {persistSessionDenial} from '../src/session-denial';
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Hono } from "hono";
import postgres, { type Sql } from "postgres";
import { generateKeyPair, exportPKCS8, jwtVerify } from "jose";
import { z } from "zod";
import { withMember } from "../src/db";
import {
  registerNativePushRoutes,
  processNativePush,
  nativePushRequest,
  nativeSubscriptionSchema,
  nativePushConfigured,
  signNativeProviderToken,
  nativePushOutcome,
  GENERIC_NATIVE_PAYLOAD,
} from "../src/social-native-push";
import type { Env, Variables } from "../src/types";

const pair = await generateKeyPair("ES256", { extractable: true });
const config = {
  APNS_TEAM_ID: "TEAM123456",
  APNS_KEY_ID: "KEY1234567",
  APNS_BUNDLE_ID: "com.porchday.app",
  APNS_PRIVATE_KEY: await exportPKCS8(pair.privateKey),
};
function device() {
  return {
    token: randomBytes(32).toString("hex"),
    environment: "sandbox" as const,
  };
}

describe("APNs provider contract", () => {
  it("signs ES256 issuer/time/key claims and sends only a generic alert to fixed Apple hosts", async () => {
    const now = Date.now();
    const signed = await signNativeProviderToken(config, now);
    const verified = await jwtVerify(signed, pair.publicKey, {
      algorithms: ["ES256"],
      issuer: config.APNS_TEAM_ID,
    });
    expect(verified.payload).toEqual({
      iss: config.APNS_TEAM_ID,
      iat: Math.floor(now / 1000),
    });
    expect(verified.protectedHeader).toEqual({
      alg: "ES256",
      kid: config.APNS_KEY_ID,
      typ: "JWT",
    });
    for (const environment of ["production", "sandbox"] as const) {
      const sub = { ...device(), environment };
      const req = nativePushRequest(sub, config, signed);
      expect(req.url).toBe(
        `https://api.${environment === "sandbox" ? "sandbox." : ""}push.apple.com/3/device/${sub.token}`,
      );
      expect(req.init.redirect).toBe("manual");
      expect(req.init.headers["apns-expiration"]).toBe("0");
      expect(req.init.headers["apns-topic"]).toBe(config.APNS_BUNDLE_ID);
      expect(req.init.headers["apns-push-type"]).toBe("alert");
      expect(JSON.parse(req.init.body)).toEqual({
        aps: { alert: { title: "Porchday", body: "You have a new update" } },
      });
    }
  });
  it("rejects injected URLs, malformed tokens, unknown environments and incomplete provider configuration", async () => {
    for (const token of [
      "ab",
      "ab".repeat(101),
      "AB".repeat(32),
      "ab".repeat(32) + "/../elsewhere",
      "https://evil.test/",
    ])
      expect(
        nativeSubscriptionSchema.safeParse({ token, environment: "sandbox" })
          .success,
      ).toBe(false);
    expect(
      nativeSubscriptionSchema.safeParse({
        ...device(),
        environment: "https://evil.test",
      }).success,
    ).toBe(false);
    expect(
      nativeSubscriptionSchema.safeParse({
        ...device(),
        token: "ab".repeat(100),
      }).success,
    ).toBe(true);
    expect(nativePushConfigured({})).toBe(false);
    expect(
      nativePushConfigured({ ...config, APNS_PRIVATE_KEY: undefined }),
    ).toBe(false);
    expect(
      nativePushConfigured({ ...config, APNS_BUNDLE_ID: "bad\nheader" }),
    ).toBe(false);
    const send = vi.fn();
    expect(
      await processNativePush(
        { HYPERDRIVE_JOBS: { connectionString: "unused" } } as Env,
        send,
      ),
    ).toEqual({ sent: 0, retried: 0, skipped: 0 });
    expect(send).not.toHaveBeenCalled();
  });
  it("classifies permanent token failures, bounded retries and provider errors without exposing response bodies", async () => {
    for (const [status, reason] of [
      [400, "BadDeviceToken"],
      [400, "DeviceTokenNotForTopic"],
      [410, "Unregistered"],
    ] as const)
      expect(
        (await nativePushOutcome(Response.json({ reason }, { status }), 1))
          .outcome,
      ).toBe("gone");
    expect(
      (
        await nativePushOutcome(
          Response.json({ reason: "Forbidden" }, { status: 403 }),
          1,
        )
      ).outcome,
    ).toBe("failed");
    expect(
      await nativePushOutcome(new Response(null, { status: 503 }), 1),
    ).toEqual({ outcome: "retry", delay: 900 });
    expect(
      await nativePushOutcome(
        new Response(null, { status: 429, headers: { "Retry-After": "120" } }),
        1,
      ),
    ).toEqual({ outcome: "retry", delay: 120 });
    expect(
      await nativePushOutcome(
        new Response("x".repeat(5000), { status: 403 }),
        1,
      ),
    ).toEqual({ outcome: "retry", delay: 900 });
    expect(
      (await nativePushOutcome(new Response(null, { status: 302 }), 1)).outcome,
    ).toBe("failed");
  });
});

const url = process.env.NATIVE_PUSH_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
let sql: Sql, app: Hono<{ Bindings: Env; Variables: Variables }>, env: Env;
async function seed() {
  const id = randomUUID(),
    session = randomUUID();
  await sql`insert into public.auth_user(id,name,email,"emailVerified") values(${id},'Native push test',${id + "@example.test"},true)`;
  await sql`insert into public.auth_session(id,"userId",token,"expiresAt") values(${session},${id},${randomUUID()},now()+interval '7 days')`;
  await sql`insert into app.members(id,adult_attested_at,rules_accepted_at) values(${id},now(),now())`;
  return { id, session };
}
async function request(
  person: { id: string; session: string },
  path: string,
  method = "GET",
  body?: unknown,
) {
  const response = await app.request(
    "https://porchday.test" + path,
    {
      method,
      headers: {
        "x-test-member": person.id,
        "x-test-session": person.session,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
  return { status: response.status, data: (await response.json()) as any };
}
async function notification(
  recipient: string,
  actor: string,
  postId: string | null = null,
) {
  const [n] =
    await sql`insert into app.notifications(recipient,actor,kind,post_id) values(${recipient},${actor},'comment',${postId}) returning id`;
  return n.id;
}
suite("Native push HTTP authorization, durable delivery and revocation", () => {
  beforeAll(async () => {
    if (!url || !new URL(url).pathname.includes("native_push_test"))
      throw new Error("Disposable native_push_test DB only");
    sql = postgres(url, { prepare: false, max: 4, onnotice: () => {} });
    await sql`drop schema if exists app cascade`;
    await sql`drop schema public cascade`;
    await sql`create schema public`;
    for (const name of (
      await readdir(new URL("../migrations/", import.meta.url))
    )
      .filter((n) => n.endsWith(".sql"))
      .sort())
      await sql.unsafe(
        await readFile(
          new URL("../migrations/" + name, import.meta.url),
          "utf8",
        ),
      );
    await sql.unsafe(
      "DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='porchday_native_push_social_test') THEN CREATE ROLE porchday_native_push_social_test LOGIN PASSWORD 'push-test-social' IN ROLE porchday_social; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='porchday_native_push_jobs_test') THEN CREATE ROLE porchday_native_push_jobs_test LOGIN PASSWORD 'push-test-jobs' IN ROLE porchday_jobs; END IF; END $$",
    );
    const socialUrl = new URL(url);
    socialUrl.username = "porchday_native_push_social_test";
    socialUrl.password = "push-test-social";
    const jobsUrl = new URL(url);
    jobsUrl.username = "porchday_native_push_jobs_test";
    jobsUrl.password = "push-test-jobs";
    env = {
      ENVIRONMENT:'development',
      ...config,
      HYPERDRIVE_SOCIAL: { connectionString: socialUrl.href },
      HYPERDRIVE_JOBS: { connectionString: jobsUrl.href },
    } as Env;
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("memberId", c.req.header("x-test-member")!);
      c.set("sessionId", c.req.header("x-test-session")!);
      await next();
    });
    const fail = (code: string, status = 400): never => {
      throw Object.assign(new Error(code), { status });
    };
    registerNativePushRoutes(app, {
      tx: (c, fn) => withMember(c.env, c.get("memberId"), fn),
      body: async (c, schema) => schema.parse(await c.req.json()),
      fail,
      id: (value) => z.string().uuid().parse(value),
    });
    app.onError((err, c) =>
      c.json(
        { error: { code: err.message } },
        (err as any).status || (err.message === "FORBIDDEN" ? 403 : 500),
      ),
    );
  }, 30000);
  afterAll(async () => {
    if (sql) await sql.end();
  });
  it("shares a bounded provider-token cache across jobs while keeping credentials inaccessible to members", async () => {
    const a = await seed(),
      b = await seed();
    await request(a, "/native-push/subscriptions", "POST", device());
    const tokens: string[] = [];
    const send = vi.fn(async (_url: unknown, init?: RequestInit) => {
      tokens.push((init?.headers as Record<string, string>).authorization);
      return new Response(null, { status: 200 });
    });
    await notification(a.id, b.id);
    await processNativePush(env, send as typeof fetch);
    await notification(a.id, b.id);
    await processNativePush(env, send as typeof fetch);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).toBe(tokens[1]);
    await sql`update app.native_push_provider_tokens set issued_at=now()-interval '46 minutes'`;
    await notification(a.id, b.id);
    await processNativePush(env, send as typeof fetch);
    expect(tokens[2]).not.toBe(tokens[0]);
    await expect(
      sql.begin(async (db) => {
        await db`set local role porchday_social`;
        return db`select token from app.native_push_subscriptions`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      sql.begin(async (db) => {
        await db`set local role porchday_social`;
        return db`select * from app.native_push_provider_tokens`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      sql.begin(async (db) => {
        await db`set local role porchday_social`;
        return db`select app.native_provider_token(${"a".repeat(64)},NULL)`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("bounds devices, clears pending work on re-enrollment, and honors global opt-out", async () => {
    const a = await seed(),
      b = await seed(),
      sub = device();
    const added = await request(a, "/native-push/subscriptions", "POST", sub);
    const notificationId = await notification(a.id, b.id);
    const [leased] = await sql.begin(async (db) => {
      await db`set local role porchday_jobs`;
      return db`select * from app.claim_native_push(20)`;
    });
    await request(a, "/native-push/subscriptions", "POST", sub);
    await sql.begin(async (db) => {
      await db`set local role porchday_jobs`;
      await db`select app.finish_native_push(${leased.id},${leased.lease},'gone',60)`;
    });
    expect(
      await sql`select id from app.native_push_subscriptions where id=${added.data.id}`,
    ).toHaveLength(1);
    expect(
      await sql`select id from app.native_push_outbox where notification_id=${notificationId}`,
    ).toHaveLength(0);
    for (let i = 0; i < 9; i++)
      expect(
        (await request(a, "/native-push/subscriptions", "POST", device()))
          .status,
      ).toBe(201);
    expect(
      (await request(a, "/native-push/subscriptions", "POST", device())).data
        .error.code,
    ).toBe("NATIVE_PUSH_DEVICE_LIMIT");
    await sql`update app.members set notification_preferences=jsonb_set(notification_preferences,'{push}','false') where id=${a.id}`;
    expect(
      await sql`select id from app.native_push_subscriptions where member_id=${a.id}`,
    ).toHaveLength(0);
  });
  it("isolates tokens, binds them to an owned session, and cascades sign-out", async () => {
    const a = await seed(),
      b = await seed(),
      sub = device();
    expect((await request(a, "/native-push/config")).data.enabled).toBe(true);
    expect(
      (
        await request(
          { ...a, session: b.session },
          "/native-push/subscriptions",
          "POST",
          sub,
        )
      ).status,
    ).toBe(403);
    const added = await request(a, "/native-push/subscriptions", "POST", sub);
    expect(added.status, JSON.stringify(added.data)).toBe(201);
    expect(
      (await request(a, "/native-push/subscriptions", "POST", sub)).data.id,
    ).toBe(added.data.id);
    expect(
      (await request(b, "/native-push/subscriptions", "POST", sub)).status,
    ).toBe(409);
    expect((await request(b, "/native-push/subscriptions")).data.items).toEqual(
      [],
    );
    await request(b, "/native-push/subscriptions/" + added.data.id, "DELETE");
    const listed = (await request(a, "/native-push/subscriptions")).data.items;
    expect(listed).toHaveLength(1);
    expect(listed[0].current_session).toBe(true);
    expect(listed[0].token).toBeUndefined();
    await notification(a.id, b.id);
    expect(
      await sql`select id from app.native_push_outbox where subscription_id=${added.data.id}`,
    ).toHaveLength(1);
    await sql`delete from public.auth_session where id=${a.session}`;
    expect(
      await sql`select id from app.native_push_subscriptions where id=${added.data.id}`,
    ).toHaveLength(0);
    expect(
      await sql`select id from app.native_push_outbox where subscription_id=${added.data.id}`,
    ).toHaveLength(0);
  });
  it("sends a real signed APNs request through injected fetch, retries 429, and removes 410 subscriptions", async () => {
    const a = await seed(),
      b = await seed(),
      browserSub = device();
    const registered = await request(
      a,
      "/native-push/subscriptions",
      "POST",
      browserSub,
    );
    const n = await notification(a.id, b.id);
    const send = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeDefined();
      expect(init?.body).toBe(GENERIC_NATIVE_PAYLOAD);
      const jwt = (init?.headers as Record<string, string>).authorization.slice(
        7,
      );
      const verified = await jwtVerify(jwt, pair.publicKey, {
        algorithms: ["ES256"],
        issuer: config.APNS_TEAM_ID,
      });
      expect(verified.protectedHeader.kid).toBe(config.APNS_KEY_ID);
      expect(_url).toBe(
        "https://api.sandbox.push.apple.com/3/device/" + browserSub.token,
      );
      return new Response(null, {
        status: 429,
        headers: { "Retry-After": "120" },
      });
    });
    expect(await processNativePush(env, send as typeof fetch)).toEqual({
      sent: 0,
      retried: 1,
      skipped: 0,
    });
    const [pending] =
      await sql`select attempts,next_retry>now()+interval '100 seconds' as delayed from app.native_push_outbox where notification_id=${n}`;
    expect(pending).toEqual({ attempts: 1, delayed: true });
    await sql`update app.native_push_outbox set next_retry=now() where notification_id=${n}`;
    expect(
      await processNativePush(
        env,
        vi.fn(async () => new Response(null, { status: 200 })) as typeof fetch,
      ),
    ).toEqual({ sent: 1, retried: 0, skipped: 0 });
    await notification(a.id, b.id);
    expect(
      await processNativePush(
        env,
        vi.fn(async () => new Response(null, { status: 410 })) as typeof fetch,
      ),
    ).toEqual({ sent: 0, retried: 0, skipped: 1 });
    expect(
      await sql`select id from app.native_push_subscriptions where id=${registered.data.id}`,
    ).toHaveLength(0);
  });
  it("fails redirects without interpreting token-revocation bodies or forwarding authorization", async () => {
    const a = await seed(), b = await seed(), sub = device();
    const registered = await request(a, "/native-push/subscriptions", "POST", sub);
    for (const status of [301, 302, 303, 307, 308]) {
      const n = await notification(a.id, b.id);
      const response = Response.json({reason: "Unregistered"}, {status, headers: {Location: "https://attacker.test/capture"}});
      const cancelled = vi.spyOn(response.body!, "cancel");
      const read = vi.spyOn(response.body!, "getReader");
      const send = vi.fn(async (url: unknown, init?: RequestInit) => {
        expect(url).toBe("https://api.sandbox.push.apple.com/3/device/" + sub.token);
        expect(init?.redirect).toBe("manual"); return response;
      });
      expect(await processNativePush(env, send as typeof fetch)).toEqual({sent: 0, retried: 0, skipped: 1});
      expect(send).toHaveBeenCalledTimes(1); expect(cancelled).toHaveBeenCalledTimes(1); expect(read).not.toHaveBeenCalled();
      expect((await sql`select outcome,completed_at is not null as finished from app.native_push_outbox where notification_id=${n}`)[0]).toEqual({outcome: "failed", finished: true});
      expect(await sql`select id from app.native_push_subscriptions where id=${registered.data.id}`).toHaveLength(1);
    }
  });
  it("rechecks read state, blocks, mute, status, opt-out, expiration and deletion before delivery", async () => {
    const a = await seed(),
      b = await seed();
    await request(a, "/native-push/subscriptions", "POST", device());
    const n = await notification(a.id, b.id);
    await sql`update app.notifications set read_at=now() where id=${n}`;
    const send = vi.fn(async () => new Response(null, { status: 200 }));
    expect((await processNativePush(env, send as typeof fetch)).skipped).toBe(
      1,
    );
    expect(send).not.toHaveBeenCalled();
    await notification(a.id, b.id);
    await sql`insert into app.mutes(actor,target) values(${a.id},${b.id})`;
    expect((await processNativePush(env, send as typeof fetch)).skipped).toBe(
      1,
    );
    expect(send).not.toHaveBeenCalled();
    await sql`delete from app.mutes where actor=${a.id}`;
    await notification(a.id, b.id);
    await sql`insert into app.blocks(actor,target) values(${a.id},${b.id})`;
    expect((await processNativePush(env, send as typeof fetch)).skipped).toBe(
      1,
    );
    expect(send).not.toHaveBeenCalled();
    await sql`delete from app.blocks where actor=${a.id}`;
    const post = randomUUID();
    await sql`insert into app.posts(id,author_id,audience,envelope,epoch,created_at,expires_at) values(${post},${a.id},'only_me','{}',1,now()-interval '5 minutes',now()+interval '1 minute')`;
    await notification(a.id, b.id, post);
    await sql`update app.posts set expires_at=now()-interval '1 second' where id=${post}`;
    expect((await processNativePush(env, send as typeof fetch)).skipped).toBe(
      1,
    );
    expect(send).not.toHaveBeenCalled();
    await notification(a.id, b.id, post);
    await sql`delete from app.posts where id=${post}`;
    expect((await processNativePush(env, send as typeof fetch)).sent).toBe(0);
    expect(send).not.toHaveBeenCalled();
    await notification(a.id, b.id);
    await request(a, "/native-push/subscriptions", "DELETE");
    expect(
      await sql`select id from app.native_push_subscriptions where member_id=${a.id}`,
    ).toHaveLength(0);
    expect(
      await sql`select o.id from app.native_push_outbox o join app.notifications n on n.id=o.notification_id where n.recipient=${a.id}`,
    ).toHaveLength(0);
    await request(a, "/native-push/subscriptions", "POST", device());
    await sql`update app.members set status='suspended' where id=${a.id}`;
    expect(
      await sql`select id from app.native_push_subscriptions where member_id=${a.id}`,
    ).toHaveLength(0);
    await expect(
      sql.begin(async (db) => {
        await db`set local role porchday_social`;
        await db`select * from app.native_push_outbox`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("leases work once, rejects stale completion tokens, and stops after bounded attempts", async () => {
    const a = await seed(),
      b = await seed();
    const subscription = await request(
      a,
      "/native-push/subscriptions",
      "POST",
      device(),
    );
    const n = await notification(a.id, b.id);
    const claim = () =>
      sql.begin(async (db) => {
        await db`set local role porchday_jobs`;
        return db`select * from app.claim_native_push(20)`;
      });
    const [first] = await claim();
    expect(first.attempts).toBe(1);
    expect(await claim()).toHaveLength(0);
    await sql`update app.native_push_outbox set next_retry=now() where notification_id=${n}`;
    const [second] = await claim();
    expect(second.lease).not.toBe(first.lease);
    await sql.begin(async (db) => {
      await db`set local role porchday_jobs`;
      await db`select app.finish_native_push(${first.id},${first.lease},'gone',60)`;
    });
    expect(
      await sql`select id from app.native_push_subscriptions where id=${subscription.data.id}`,
    ).toHaveLength(1);
    const [pending] =
      await sql`select completed_at,lease from app.native_push_outbox where id=${first.id}`;
    expect(pending.completed_at).toBeNull();
    expect(pending.lease).toBe(second.lease);
    await sql`update app.native_push_outbox set attempts=8,next_retry=now() where id=${first.id}`;
    expect(await claim()).toHaveLength(0);
    expect(
      (
        await sql`select outcome from app.native_push_outbox where id=${first.id}`
      )[0].outcome,
    ).toBe("expired");
    await expect(
      sql.begin(async (db) => {
        await db`set local role porchday_social`;
        return db`select app.claim_native_push(20)`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it('suppresses a denied SQL session while delivering for a different session',async()=>{
    const a=await seed(),b=await seed(),one=device(),two=device();
    await request(a,'/native-push/subscriptions','POST',one);await request(b,'/native-push/subscriptions','POST',two);
    const first=await notification(a.id,b.id);await notification(b.id,a.id);
    const records=new Map<string,string>();
    const store={get:async(key:string)=>records.has(key)?{etag:'record',text:async()=>records.get(key)!}:null,
      put:async(key:string,text:string)=>{if(records.has(key))return null;records.set(key,text);return {etag:'record'};}};
    await persistSessionDenial(store,a.session);
    const writeDataPoint=vi.fn(),send=vi.fn(async()=>new Response(null,{status:200}));
    expect(await processNativePush({...env,ENVIRONMENT:'production',METRICS:{writeDataPoint},RECOVERY_JOURNAL:store as unknown as R2Bucket},send as typeof fetch)).toEqual({sent:1,retried:0,skipped:1});
    expect(send).toHaveBeenCalledTimes(1);
    const deniedPoints=writeDataPoint.mock.calls.map(c=>c[0]).filter(p=>p.blobs?.[5]==='native_push_denied');
    expect(deniedPoints).toEqual([{indexes:['job:none'],blobs:['porchday_metrics_v1','production','job','none','none','native_push_denied','none'],doubles:[0,-1,1]}]);
    const evidence=JSON.stringify(deniedPoints);for(const value of [a.id,b.id,a.session,b.session,first])expect(evidence).not.toContain(value);

    expect(JSON.stringify(send.mock.calls)).not.toContain(a.session);expect(JSON.stringify(send.mock.calls)).not.toContain(b.session);
    expect(await sql`select id from public.auth_session where id=${a.session}`).toHaveLength(1);
    expect((await sql`select outcome from app.native_push_outbox where notification_id=${first}`)[0].outcome).toBe('failed');
  });
  it('never sends on unknown denial state and can retry after storage recovers',async()=>{
    const a=await seed(),b=await seed();await request(a,'/native-push/subscriptions','POST',device());
    const writeDataPoint=vi.fn(),n=await notification(a.id,b.id),send=vi.fn(async()=>new Response(null,{status:200}));
    for(const mode of ['missing','failure','malformed']){
      const binding=mode==='missing'?undefined:{get:async()=>{if(mode==='failure')throw Error('private storage error');return {etag:'record',text:async()=>'{}'};}} as unknown as R2Bucket;
      expect(await processNativePush({...env,ENVIRONMENT:'production',METRICS:{writeDataPoint},RECOVERY_JOURNAL:binding},send as typeof fetch)).toEqual({sent:0,retried:1,skipped:0});
      expect(send).not.toHaveBeenCalled();
      expect((await sql`select completed_at from app.native_push_outbox where notification_id=${n}`)[0].completed_at).toBeNull();
      await sql`update app.native_push_outbox set next_retry=now() where notification_id=${n}`;
    }
    expect(await processNativePush({...env,ENVIRONMENT:'production',METRICS:{writeDataPoint},RECOVERY_JOURNAL:{get:async()=>null} as unknown as R2Bucket},send as typeof fetch)).toEqual({sent:1,retried:0,skipped:0});
    expect(send).toHaveBeenCalledTimes(1);
    expect(writeDataPoint.mock.calls.filter(c=>c[0].blobs?.[5]==='native_push_denied')).toEqual([]);
  });
  it('does not attribute a provider rejection to a session denial',async()=>{
    const a=await seed(),b=await seed();await request(a,'/native-push/subscriptions','POST',device());
    const n=await notification(a.id,b.id),writeDataPoint=vi.fn(),send=vi.fn(async()=>Response.json({reason:'Forbidden'},{status:400}));
    expect(await processNativePush({...env,ENVIRONMENT:'production',METRICS:{writeDataPoint},RECOVERY_JOURNAL:{get:async()=>null} as unknown as R2Bucket},send as typeof fetch)).toEqual({sent:0,retried:0,skipped:1});
    expect(send).toHaveBeenCalledOnce();
    expect((await sql`select outcome from app.native_push_outbox where notification_id=${n}`)[0].outcome).toBe('failed');
    expect(writeDataPoint.mock.calls.filter(c=>c[0].blobs?.[5]==='native_push_denied')).toEqual([]);
  });
  it('still suppresses denied sessions when metrics fail',async()=>{
    const a=await seed(),b=await seed();await request(a,'/native-push/subscriptions','POST',device());await notification(a.id,b.id);
    const records=new Map<string,string>(),store={get:async(key:string)=>records.has(key)?{etag:'record',text:async()=>records.get(key)!}:null,put:async(key:string,text:string)=>{records.set(key,text);return {etag:'record'};}};
    await persistSessionDenial(store,a.session);const send=vi.fn();
    expect(await processNativePush({...env,ENVIRONMENT:'production',METRICS:{writeDataPoint(){throw Error('private metrics failure');}},RECOVERY_JOURNAL:store as unknown as R2Bucket},send)).toEqual({sent:0,retried:0,skipped:1});
    expect(send).not.toHaveBeenCalled();expect(await sql`select id from public.auth_session where id=${a.session}`).toHaveLength(1);
  });
  it('keeps old preparation JSON compatible and restricts the session-bound projection to jobs',async()=>{
    const a=await seed(),b=await seed(),subscription=device();await request(a,'/native-push/subscriptions','POST',subscription);await notification(a.id,b.id);
    const result=await sql.begin(async db=>{
      await db`set local role porchday_jobs`;
      const [job]=await db`select * from app.claim_native_push(20)`;
      const [row]=await db`select app.prepare_native_push_delivery(${job.id},${job.lease}) as delivery,app.prepare_native_push(${job.id},${job.lease}) as legacy`;
      expect((await db`select app.prepare_native_push_delivery(${job.id},${randomUUID()}) as delivery`)[0].delivery).toBeNull();
      await db`select app.finish_native_push(${job.id},${job.lease},'failed',60)`;
      return row;
    });
    expect(result.delivery).toEqual({sessionId:a.session,subscription});expect(result.legacy).toEqual(subscription);
    await expect(sql.begin(async db=>{await db`set local role porchday_social`;return db`select app.prepare_native_push_delivery(${randomUUID()},${randomUUID()})`;})).rejects.toMatchObject({code:'42501'});
  });

});
