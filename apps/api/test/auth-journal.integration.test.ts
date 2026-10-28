import {persistSessionDenial} from '../src/session-denial';
import {cleanupDeniedSessions} from '../src/session-denial-cleanup';
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { Hono } from "hono";
import { hashPassword } from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import { hashToken } from "../src/auth";
import { authRoutes } from "../src/auth-routes";
import {
  initializePrivacyJournal,
  readJournalControl,
  detectStalePrivacyIntents,
  type JournalDatabase,
  type JournalStore,
} from "../src/privacy-journal";
import type { Env, Variables } from "../src/types";

class MemoryStore implements JournalStore {
  rows = new Map<string, { value: string; etag: string }>();
  writes = 0;
  failPrefix = "";
  beforeWrite: ((key: string) => Promise<void>) | undefined;
  async get(key: string) {
    const row = this.rows.get(key);
    return row ? { etag: row.etag, text: async () => row.value } : null;
  }
  async list(options:{prefix:string;limit:number;cursor?:string}){
    const keys=[...this.rows.keys()].filter(key=>key.startsWith(options.prefix)&&(!options.cursor||key>options.cursor)).sort();
    return {objects:keys.slice(0,options.limit).map(key=>({key})),truncated:keys.length>options.limit,...(keys.length>options.limit?{cursor:keys[options.limit-1]}:{})};
  }
  async put(
    key: string,
    value: string,
    options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } },
  ) {
    await this.beforeWrite?.(key);
    if (this.failPrefix && key.startsWith(this.failPrefix))
      throw Error("Synthetic journal storage failure");
    const old = this.rows.get(key);
    if (
      (options?.onlyIf?.etagDoesNotMatch === "*" && old) ||
      (options?.onlyIf?.etagMatches && options.onlyIf.etagMatches !== old?.etag)
    )
      return null;
    const etag = String(++this.writes);
    this.rows.set(key, { value, etag });
    return { etag };
  }
}
const base = process.env.AUTH_JOURNAL_TEST_DATABASE_URL;
const suite = base ? describe : describe.skip;
let owner: Pool, env: Env;
const emails: { text: string; subject: string }[] = [];
const pending: Promise<unknown>[] = [];
const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.route("/api/auth", authRoutes);
const context = {
  waitUntil(p: Promise<unknown>) {
    pending.push(p);
  },
  passThroughOnException() {},
  props: {},
} as ExecutionContext;
async function call(
  path: string,
  body?: unknown,
  cookie = "",
  extraHeaders: Record<string, string> = {},
) {
  const response = await app.fetch(
    new Request(env.APP_URL + "/api/auth/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: env.APP_URL,
        "Content-Type": "application/json",
        Cookie: cookie,
        "CF-Connecting-IP": crypto.randomUUID(),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    context,
  );
  const scheduled = pending.length;
  await Promise.allSettled(pending.splice(0));
  return { response, scheduled };
}
async function person() {
  const id = crypto.randomUUID(),
    email = id + "@example.test",
    password = "synthetic-strong-journal-password";
  await owner.query(
    'INSERT INTO public.auth_user(id,name,email,"emailVerified") VALUES($1,$2,$3,true)',
    [id, "journal", email],
  );
  await owner.query("SELECT app.auth_provision_member($1::uuid,$2)", [
    id,
    "j_" + id.replaceAll("-", "").slice(0, 16),
  ]);
  await owner.query(
    'INSERT INTO public.auth_account(id,"accountId","providerId","userId",password) VALUES($1,$2,\'credential\',$2,$3)',
    [crypto.randomUUID(), id, await hashPassword(password)],
  );
  const login = await call("sign-in/email", { email, password });
  expect(login.response.status).toBe(200);
  return {
    id,
    email,
    password,
    cookie: login.response.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; "),
  };
}
async function journal(memberId?: string) {
  const store = new MemoryStore();
  const db: JournalDatabase = {
    async status() {
      return (await owner.query("SELECT app.safety_status() AS value")).rows[0]
        .value;
    },
    async page(after) {
      return (
        await owner.query("SELECT app.safety_page($1::bigint,200) AS value", [
          after,
        ])
      ).rows[0].value;
    },
  };
  await initializePrivacyJournal(store, db);
  const remote = await readJournalControl(store);
  await store.put(
    "control.json",
    JSON.stringify({ ...remote.value, mode: "active", reason: null }),
    { onlyIf: { etagMatches: remote.etag } },
  );
  if (memberId)
    store.beforeWrite = async () => {
      // An independent connection can acquire this identity's lock at every R2
      // write. The wrapper must commit/release SQL locks before checkpointing.
      const result = await owner.query(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('porchday-identity:'||$1,0)) AS unlocked",
        [memberId],
      );
      expect(result.rows[0].unlocked).toBe(true);
    };
  env.RECOVERY_JOURNAL = store as unknown as R2Bucket;
  return store;
}
async function writer(work:()=>Promise<void>){
  const oldWriter=env.SESSION_DENIAL_WRITER_V1,oldCleanup=env.SESSION_DENIAL_CLEANUP_V1;
  env.SESSION_DENIAL_WRITER_V1='true';env.SESSION_DENIAL_CLEANUP_V1='true';
  try{await work();}finally{env.SESSION_DENIAL_WRITER_V1=oldWriter;env.SESSION_DENIAL_CLEANUP_V1=oldCleanup;}
}
suite("Authenticated account privacy journal boundary", () => {
  beforeAll(async () => {
    if (
      !base ||
      !new URL(base).pathname.endsWith("/porchday_auth_journal_test")
    )
      throw Error("Dedicated disposable auth_journal_test database required");
    owner = new Pool({ connectionString: base });
    await owner.query("DROP SCHEMA IF EXISTS app CASCADE");
    await owner.query("DROP SCHEMA public CASCADE");
    await owner.query("CREATE SCHEMA public");
    for (const name of (
      await readdir(new URL("../migrations/", import.meta.url))
    )
      .filter((n) => n.endsWith(".sql"))
      .sort())
      await owner.query(
        await readFile(
          new URL("../migrations/" + name, import.meta.url),
          "utf8",
        ),
      );
    await owner.query(
      "DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='porchday_auth_journal_auth_test') THEN CREATE ROLE porchday_auth_journal_auth_test LOGIN PASSWORD 'local-auth-journal' IN ROLE porchday_auth; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='porchday_auth_journal_jobs_test') THEN CREATE ROLE porchday_auth_journal_jobs_test LOGIN PASSWORD 'local-jobs-journal' IN ROLE porchday_jobs; END IF; END $$",
    );
    const auth = new URL(base);
    auth.username = "porchday_auth_journal_auth_test";
    auth.password = "local-auth-journal";
    const jobs = new URL(base);
    jobs.username = "porchday_auth_journal_jobs_test";
    jobs.password = "local-jobs-journal";
    env = {
      APP_URL: "http://localhost:5173",
      ENVIRONMENT: "development",
      SIGNUP_ENABLED: "false",
      BETTER_AUTH_SECRET:
        "synthetic-auth-journal-secret-more-than-thirty-two-characters",
      HYPERDRIVE_AUTH: { connectionString: auth.href },
      HYPERDRIVE_JOBS: { connectionString: jobs.href },
      EMAIL: {
        send: async (value: unknown) => {
          emails.push(value as (typeof emails)[number]);
          return { messageId: "synthetic" };
        },
      },
    } as unknown as Env;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (!String(url).startsWith("https://api.pwnedpasswords.com/range/"))
        throw Error("Unexpected test network");
      return new Response("00000000000000000000000000000000000:0");
    });
  }, 30000);
  afterAll(async () => {
    await Promise.allSettled(pending);
    vi.restoreAllMocks();
    await owner?.end();
  });
  it("rejects unauthenticated, forged, expired and cross-origin capabilities without writing R2", async () => {
    const p = await person(),
      store = await journal(),
      before = store.writes;
    await owner.query(
      "INSERT INTO public.auth_verification(id,identifier,value,\"expiresAt\") VALUES($1,$2,$3,now()-interval '1 second')",
      [
        crypto.randomUUID(),
        await hashToken("reset-password:expired-test-token"),
        p.id,
      ],
    );
    for (const [path, body, cookie, headers] of [
      [
        "change-password",
        { currentPassword: p.password, newPassword: "synthetic-new-password" },
        "",
        {},
      ],
      [
        "reset-password",
        { token: "nonexistent", newPassword: "synthetic-new-password" },
        "",
        {},
      ],
      [
        "reset-password",
        { token: "expired-test-token", newPassword: "synthetic-new-password" },
        "",
        {},
      ],
      ["verify-email?token=not-a-jwt", undefined, "", {}],
      [
        "two-factor/verify-backup-code",
        { code: "fake" },
        "better-auth.two_factor=2fa-unsigned-capability.fake",
        {},
      ],
      [
        "change-password",
        { currentPassword: p.password, newPassword: "synthetic-new-password" },
        p.cookie,
        { Origin: "https://hostile.test" },
      ],
    ] as const)
      expect(
        (await call(path, body, cookie, headers)).response.status,
      ).toBeGreaterThanOrEqual(400);
    expect(store.writes).toBe(before);
    const read = await call("get-session", undefined, p.cookie);
    expect(read.response.status).toBe(200);
    expect(read.scheduled).toBe(1); // pool cleanup only; no outbox dispatcher.
    expect(store.writes).toBe(before);
    await call("sign-in/email", { email: p.email, password: p.password });
    expect(store.writes).toBe(before);
    for (let i = 0; i < 11; i++) {
      const attempt = await call(
        "reset-password",
        { token: "bogus", newPassword: "synthetic-new-password" },
        "",
        { "CF-Connecting-IP": "synthetic-rate-limit" },
      );
      if (i === 10) expect(attempt.response.status).toBe(429);
    }
    expect(store.writes).toBe(before);
  });
  it.each([false,true])("journals a valid reset once and rejects its replay before another R2 intent (denied cookie=%s)", async denied => {
    const p = await person(),
      store = await journal(p.id);
    if(denied){const row=(await owner.query('SELECT id FROM public.auth_session WHERE "userId"=$1',[p.id])).rows[0];await persistSessionDenial(store,row.id);}
    const before=store.writes;
    expect(
      (
        await call("request-password-reset", {
          email: p.email,
          redirectTo: env.APP_URL + "/reset-password",
        },denied?p.cookie:'')
      ).response.status,
    ).toBe(200);
    expect(store.writes).toBe(before);
    const mail = emails
      .filter((v) => v.subject === "Reset your Porchday password")
      .at(-1)!;
    const url = new URL(
      mail.text.match(
        /http:\/\/localhost:5173\/api\/auth\/reset-password\/\S+/,
      )![0],
    );
    const token = url.pathname.split("/").at(-1);
    expect(
      (
        await call("reset-password", {
          token,
          newPassword: "new-synthetic-journal-password",
        },denied?p.cookie:'')
      ).response.status,
    ).toBe(200);
    const after = store.writes;
    expect(after).toBeGreaterThan(before);
    expect(
      (
        await call("reset-password", {
          token,
          newPassword: "other-synthetic-journal-password",
        },denied?p.cookie:'')
      ).response.status,
    ).toBe(400);
    expect(store.writes).toBe(after);
    expect((await readJournalControl(store)).value.pending).toHaveLength(0);
  });
  it.each([
    ["/login?emailChanged=1", "/login?verified=1"],
    ["/account/email-complete?from=settings", "/account/email-complete?from=settings"],
  ])("preserves rejected links and completes an email change with callback %s", async (callback, completion) => {
    const target = await person(),
      other = await person(),
      store = await journal(target.id),
      nextEmail = "changed-" + target.email,
      callbackURL = env.APP_URL + callback;
    expect(
      (
        await call(
          "change-email",
          { newEmail: nextEmail, callbackURL },
          target.cookie,
        )
      ).response.status,
    ).toBe(200);
    const approval = emails
      .filter((mail) => mail.subject === "Confirm a Porchday email change")
      .at(-1)!;
    const linkFrom = (text: string) =>
      new URL(
        text.match(/http:\/\/localhost:5173\/api\/auth\/verify-email\?\S+/)![0],
      );
    const approvalURL = linkFrom(approval.text);
    const assertWrongAccountPreservesLink = async (url: URL) => {
      const beforeWrites = store.writes,
        beforeEmails = emails.length,
        sessions = (
          await owner.query(
            'SELECT id,"userId" FROM public.auth_session WHERE "userId" IN ($1,$2) ORDER BY id',
            [target.id, other.id],
          )
        ).rows;
      const response = (
        await call("verify-email" + url.search, undefined, other.cookie)
      ).response;
      expect(response.status).toBe(403);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.json()).toEqual({ error: { code: "INVALID_USER" } });
      expect(store.writes).toBe(beforeWrites);
      expect(emails).toHaveLength(beforeEmails);
      expect(
        (
          await owner.query(
            "SELECT 1 FROM public.used_email_links WHERE token_hash=$1",
            [await hashToken(url.searchParams.get("token")!)],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await owner.query("SELECT email FROM public.auth_user WHERE id=$1", [
            target.id,
          ])
        ).rows[0].email,
      ).toBe(target.email);
      expect(
        (
          await owner.query(
            'SELECT id,"userId" FROM public.auth_session WHERE "userId" IN ($1,$2) ORDER BY id',
            [target.id, other.id],
          )
        ).rows,
      ).toEqual(sessions);
    };
    await assertWrongAccountPreservesLink(approvalURL);
    const approved = (
      await call("verify-email" + approvalURL.search, undefined, target.cookie)
    ).response;
    expect(approved.status).toBe(302);
    expect(approved.headers.get("location")).toBe(callbackURL);
    const replayedApproval = (
      await call("verify-email" + approvalURL.search, undefined, target.cookie)
    ).response;
    expect(replayedApproval.status).toBe(400);
    expect(replayedApproval.headers.get("location")).toBeNull();
    expect(await replayedApproval.json()).toEqual({
      error: { code: "LINK_ALREADY_USED" },
    });
    const verification = emails
      .filter((mail) => mail.subject === "Verify your Porchday email")
      .at(-1)!;
    const verificationURL = linkFrom(verification.text);
    await assertWrongAccountPreservesLink(verificationURL);
    // A signed-out recipient can complete the same unconsumed link. The normal
    // change still revokes target sessions and leaves the other account alone.
    const completed = (await call("verify-email" + verificationURL.search))
      .response;
    expect(completed.status).toBe(302);
    expect(completed.headers.get("location")).toBe(env.APP_URL + completion);
    expect(
      (
        await owner.query("SELECT email FROM public.auth_user WHERE id=$1", [
          target.id,
        ])
      ).rows[0].email,
    ).toBe(nextEmail);
    expect(
      (
        await owner.query('SELECT 1 FROM public.auth_session WHERE "userId"=$1', [
          target.id,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (await (await call("get-session", undefined, other.cookie)).response.json())
        .user.id,
    ).toBe(other.id);
    for (const url of [approvalURL, verificationURL])
      expect(
        (
          await owner.query(
            "SELECT 1 FROM public.used_email_links WHERE token_hash=$1",
            [await hashToken(url.searchParams.get("token")!)],
          )
        ).rowCount,
      ).toBe(1);
    const beforeReplay = store.writes;
    const replayedVerification = (await call("verify-email" + verificationURL.search)).response;
    expect(replayedVerification.status).toBe(400);
    expect(replayedVerification.headers.get("location")).toBeNull();
    expect(store.writes).toBe(beforeReplay);
    expect((await readJournalControl(store)).value.pending).toHaveLength(0);
  });
  it("does not redirect to email-change success before its durability checkpoint is confirmed", async () => {
    const target = await person(),
      store = await journal(target.id),
      nextEmail = "changed-" + target.email,
      callbackURL = env.APP_URL + "/login?emailChanged=1";
    const linkFrom = (subject: string) => new URL(
      emails.filter(mail => mail.subject === subject).at(-1)!.text.match(
        /http:\/\/localhost:5173\/api\/auth\/verify-email\?\S+/,
      )![0],
    );
    expect((await call("change-email", { newEmail: nextEmail, callbackURL }, target.cookie)).response.status).toBe(200);
    const approval = (await call("verify-email" + linkFrom("Confirm a Porchday email change").search, undefined, target.cookie)).response;
    expect(approval.status).toBe(302);
    expect(approval.headers.get("location")).toBe(callbackURL);
    const verificationURL = linkFrom("Verify your Porchday email");
    store.failPrefix = "receipts/";
    const response = (await call("verify-email" + verificationURL.search)).response;
    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    expect((await response.json()).error.code).toBe("PRIVACY_CHECKPOINT_REQUIRED");
    expect((await owner.query('SELECT email,"emailVerified" FROM public.auth_user WHERE id=$1', [target.id])).rows[0]).toEqual({ email: nextEmail, emailVerified: true });
    expect((await owner.query('SELECT 1 FROM public.auth_session WHERE "userId"=$1', [target.id])).rowCount).toBe(0);
    expect((await readJournalControl(store)).value.pending).toHaveLength(1);
  });
  it.each([false,true])("journals MFA enrollment and backup-code consumption while ordinary TOTP login remains read-only to R2 (durable logout=%s)", async durable => {
    const run=durable?writer:async(work:()=>Promise<void>)=>work();
    await run(async()=>{
    const p = await person(),
      store = await journal(p.id);
    const cookieHeader=(response:Response)=>{
      // Apply Set-Cookie in order like a browser; a null-session lookup may
      // expire the old token before MFA supplies the new one in this response.
      const values=new Map(response.headers.getSetCookie().map(value=>{const pair=value.split(';')[0],i=pair.indexOf('=');return [pair.slice(0,i),pair.slice(i+1)];}));
      return [...values].filter(([,value])=>value!=='').map(([key,value])=>key+'='+value).join('; ');
    };
    const withOldCookie=(fresh:string,old:string)=>{
      if(!durable)return fresh;
      const pairs=new Map([...fresh.split('; '),...old.split('; ')].map(pair=>{const i=pair.indexOf('=');return [pair.slice(0,i),pair.slice(i+1)];}));
      return [...pairs].map(([key,value])=>key+'='+value).join('; ');
    };
    const logout=async(cookie:string)=>{
      const current=durable?await(await call('get-session',undefined,cookie)).response.json():null;
      const old=durable?(await owner.query('SELECT * FROM public.auth_session WHERE id=$1',[current.session.id])).rows[0]:null;
      expect((await call('sign-out',{},cookie)).response.status).toBe(200);
      if(old)await owner.query('INSERT INTO public.auth_session(id,"userId",token,"expiresAt") VALUES($1,$2,$3,$4)',[old.id,p.id,old.token,old.expiresAt]);
    };

    const enabled = await call(
      "two-factor/enable",
      { password: p.password },
      p.cookie,
    );
    expect(enabled.response.status).toBe(200);
    const setup = await enabled.response.json();
    const secret = new URL(setup.totpURI).searchParams.get("secret")!;
    const code = () =>
      createOTP(new TextDecoder().decode(base32.decode(secret))).totp();
    const enrollment=await call('two-factor/verify-totp',{code:await code(),trustDevice:false},p.cookie);
    expect(enrollment.response.status).toBe(200);
    // MFA verification rotates the login session; follow the returned cookie as
    // a browser would, instead of attempting to log out the now-expired cookie.
    const enrolledCookie=cookieHeader(enrollment.response);
    await logout(enrolledCookie);
    const before = store.writes;
    const challenge = (
      await call("sign-in/email", { email: p.email, password: p.password })
    ).response;
    const cookie = cookieHeader(challenge);
    const completed = await call(
      "two-factor/verify-totp",
      { code: await code(), trustDevice: false },
      withOldCookie(cookie,enrolledCookie),
    );
    expect(completed.response.status).toBe(200);
    expect(store.writes).toBe(before);
    const session = cookieHeader(completed.response);
    await logout(session);
    const next = (
      await call("sign-in/email", { email: p.email, password: p.password })
    ).response;
    const nextCookie = cookieHeader(next);
    const backupBefore = store.writes;
    expect(
      (
        await call(
          "two-factor/verify-backup-code",
          { code: setup.backupCodes[0], trustDevice: false },
          withOldCookie(nextCookie,session),
        )
      ).response.status,
    ).toBe(200);
    expect(store.writes).toBeGreaterThan(backupBefore);
    expect((await readJournalControl(store)).value.pending).toHaveLength(0);
    if(durable){
      expect(await(await call('get-session',undefined,enrolledCookie)).response.json()).toBeNull();
      expect(await(await call('get-session',undefined,session)).response.json()).toBeNull();
    }
    });
  });
  it("rechecks a session revoked after preflight before changing credentials", async () => {
    const p = await person(),
      store = await journal(p.id);
    const lockCheck = store.beforeWrite;
    store.beforeWrite = async (key) => {
      await lockCheck?.(key);
      if (key.startsWith("intents/"))
        await owner.query('DELETE FROM public.auth_session WHERE "userId"=$1', [
          p.id,
        ]);
    };
    const result = await call(
      "change-password",
      {
        currentPassword: p.password,
        newPassword: "synthetic-new-strong-password",
      },
      p.cookie,
    );
    expect(result.response.status).toBe(401);
    expect(
      (
        await owner.query(
          "SELECT credentials_changed_at FROM public.auth_user WHERE id=$1",
          [p.id],
        )
      ).rows[0].credentials_changed_at,
    ).toBeNull();
    expect((await readJournalControl(store)).value.pending).toHaveLength(0);
  });
  it("acknowledges a committed password change only after durable checkpoint and no SQL locks", async () => {
    const p = await person(),
      store = await journal(p.id);
    const result = await call(
      "change-password",
      {
        currentPassword: p.password,
        newPassword: "synthetic-new-strong-password",
      },
      p.cookie,
    );
    expect(result.response.status).toBe(200);
    const control = (await readJournalControl(store)).value;
    expect(control.pending).toHaveLength(0);
    expect(BigInt(control.sequence)).toBeGreaterThan(0n);
    expect(
      (
        await owner.query(
          'SELECT id FROM public.auth_session WHERE "userId"=$1',
          [p.id],
        )
      ).rowCount,
    ).toBe(0);
    const batch = [...store.rows].find(([key]) => key.startsWith("batches/"));
    expect(batch).toBeDefined();
    for (const row of store.rows.values()) {
      expect(row.value).not.toContain(p.password);
      expect(row.value).not.toContain(p.email);
    }
  });
  it("leaves an ambiguous post-commit R2 failure unresolved and fails closed", async () => {
    const p = await person(),
      store = await journal(p.id);
    store.failPrefix = "batches/";
    const result = await call(
      "change-password",
      {
        currentPassword: p.password,
        newPassword: "synthetic-new-strong-password",
      },
      p.cookie,
    );
    expect(result.response.status).toBe(503);
    expect((await result.response.json()).error.code).toBe(
      "PRIVACY_CHECKPOINT_REQUIRED",
    );
    expect(
      (
        await owner.query(
          "SELECT credentials_changed_at FROM public.auth_user WHERE id=$1",
          [p.id],
        )
      ).rows[0].credentials_changed_at,
    ).not.toBeNull();
    const control = (await readJournalControl(store)).value;
    expect(control.pending).toHaveLength(1);
    expect(
      await detectStalePrivacyIntents(
        store,
        Date.parse(control.pending[0].started_at) + 120001,
      ),
    ).toBe(true);
    expect((await readJournalControl(store)).value.mode).toBe("quarantine");
  });
  it.each(['http://localhost:5173','https://porchday.test'])('independently denies only the verified caller session and clears SDK cookies at %s',async appUrl=>writer(async()=>{
    const previousUrl=env.APP_URL;env.APP_URL=appUrl;
    try{
      const p=await person(),other=await person(),store=await journal(p.id),before=store.writes;
      const row=(await owner.query('SELECT * FROM public.auth_session WHERE "userId"=$1',[p.id])).rows[0];
      const control=store.rows.get('control.json')!.value;
      const chunkName=(appUrl.startsWith('https:')?'__Secure-':'')+'better-auth.session_data.0';
      const result=await call('sign-out',{sessionId:'00000000-0000-4000-8000-000000000000',memberId:other.id},p.cookie+'; '+chunkName+'=obsolete-cache');
      expect(result.response.status).toBe(200);expect(await result.response.json()).toEqual({success:true});
      const cookies=result.response.headers.getSetCookie(),prefix=appUrl.startsWith('https:')?'__Secure-':'';
      expect(cookies.some(value=>value.startsWith(prefix+'better-auth.session_token=;')&&/Max-Age=0/i.test(value))).toBe(true);
      expect(cookies.every(value=>/HttpOnly/i.test(value)&&/SameSite=Lax/i.test(value))).toBe(true);
      expect(cookies.some(value=>value.startsWith(chunkName+'=;')&&/Max-Age=0/i.test(value))).toBe(true);
      if(prefix)expect(cookies.every(value=>/; Secure/i.test(value))).toBe(true);
      expect(store.writes).toBe(before+1);expect(store.rows.get('control.json')!.value).toBe(control);
      const denial=[...store.rows].find(([key])=>key.startsWith('session-denials/v1/'))!;
      expect(JSON.parse(denial[1].value).sessionId).toBe(row.id);
      expect((await owner.query('SELECT 1 FROM public.auth_session WHERE id=$1',[row.id])).rowCount).toBe(0);
      expect((await call('get-session',undefined,other.cookie)).response.status).toBe(200);
      await owner.query('INSERT INTO public.auth_session(id,"userId",token,"expiresAt") VALUES($1,$2,$3,$4)',[row.id,p.id,row.token,row.expiresAt]);
      expect(await(await call('get-session',undefined,p.cookie)).response.json()).toBeNull();
      expect((await(await call('get-session',undefined,other.cookie)).response.json()).user.id).toBe(other.id);
      expect((await call('sign-out',{},p.cookie)).response.status).toBe(401);expect(store.writes).toBe(before+1);
    }finally{env.APP_URL=previousUrl;}
  }));
  it('requires cleanup readiness and verified origin/session before publishing any denial',async()=>writer(async()=>{
    const p=await person(),store=await journal(),before=store.writes;
    env.SESSION_DENIAL_CLEANUP_V1=undefined;
    expect((await call('sign-out',{},p.cookie)).response.status).toBe(503);
    env.SESSION_DENIAL_CLEANUP_V1='true';
    expect((await call('sign-out',{})).response.status).toBe(401);
    expect((await call('sign-out',{},'better-auth.session_token=forged')).response.status).toBe(401);
    expect((await call('sign-out',{},p.cookie,{Origin:'https://other.test'})).response.status).toBe(403);
    expect(store.writes).toBe(before);
    expect((await(await call('get-session',undefined,p.cookie)).response.json()).user.id).toBe(p.id);
    expect((await call('clearDeniedSessionCookies',{},p.cookie)).response.status).toBe(404);
  }));
  it('leaves SQL untouched after an unconfirmed denial and reconciles a lost successful write reply',async()=>writer(async()=>{
    const p=await person(),store=await journal(p.id),control=store.rows.get('control.json')!.value;
    store.failPrefix='session-denials/v1/';
    expect((await call('sign-out',{},p.cookie)).response.status).toBe(503);
    expect((await(await call('get-session',undefined,p.cookie)).response.json()).user.id).toBe(p.id);
    expect(store.rows.get('control.json')!.value).toBe(control);
    store.failPrefix='';const put=store.put.bind(store);let attempts=0;
    store.put=async(...args)=>{const value=await put(...args);if(args[0].startsWith('session-denials/v1/')){attempts++;throw Error('lost denial acknowledgement');}return value;};
    expect((await call('sign-out',{},p.cookie)).response.status).toBe(200);expect(attempts).toBe(1);
    expect((await owner.query('SELECT 1 FROM public.auth_session WHERE "userId"=$1',[p.id])).rowCount).toBe(0);
    expect(store.rows.get('control.json')!.value).toBe(control);
  }));
  it('keeps a denial effective after SQL cleanup failure, without quarantining others, then sweeps it',async()=>writer(async()=>{
    const p=await person(),other=await person(),store=await journal(p.id),control=store.rows.get('control.json')!.value;
    await owner.query(`CREATE FUNCTION public.test_deny_session_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic cleanup failure'; END $$; CREATE TRIGGER test_deny_session_delete BEFORE DELETE ON public.auth_session FOR EACH ROW EXECUTE FUNCTION public.test_deny_session_delete()`);
    try{
      expect((await call('sign-out',{},p.cookie)).response.status).toBe(503);
      expect((await owner.query('SELECT 1 FROM public.auth_session WHERE "userId"=$1',[p.id])).rowCount).toBe(1);
      expect(await(await call('get-session',undefined,p.cookie)).response.json()).toBeNull();
      expect((await(await call('get-session',undefined,other.cookie)).response.json()).user.id).toBe(other.id);
      expect(store.rows.get('control.json')!.value).toBe(control);
    }finally{await owner.query('DROP TRIGGER test_deny_session_delete ON public.auth_session; DROP FUNCTION public.test_deny_session_delete()');}
    expect((await cleanupDeniedSessions(env)).deleted).toBe(1);
    expect((await owner.query('SELECT 1 FROM public.auth_session WHERE "userId"=$1',[p.id])).rowCount).toBe(0);
    expect(store.rows.get('control.json')!.value).toBe(control);
  }));

});
