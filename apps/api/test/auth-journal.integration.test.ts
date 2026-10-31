import {persistSessionDenial} from '../src/session-denial';
import {provePrivacyCommits} from '../src/privacy-commit-proof';
import {proveAuthCommitCohort} from '../../../scripts/auth-commit-cohort-proof';
import {createStagingInflightRevocation} from '../../../scripts/auth-inflight-revocation';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {cleanupDeniedSessionCandidates as cleanupDeniedSessions} from '../src/session-denial-candidates';
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { Pool, Client } from "pg";
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
  provePrivacyReceipts,
  privacyIntentSchema,
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
async function call(
  path: string,
  body?: unknown,
  cookie = "",
  extraHeaders: Record<string, string> = {},
) {
  // Workers waitUntil belongs to one request. A shared test context would make
  // a completed logout await a deliberately paused concurrent password change.
  const requestPending:Promise<unknown>[]=[];
  const context={waitUntil(p:Promise<unknown>){requestPending.push(p);pending.push(p);},passThroughOnException(){},props:{}} as ExecutionContext;
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
  const scheduled = requestPending.length;
  await Promise.allSettled(requestPending);
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
      !(["localhost","127.0.0.1"].includes(new URL(base).hostname) && /^\/porchday(?:_[a-z0-9]+)*_auth_journal_test$/.test(new URL(base).pathname))
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
  it.each(["confirmed", "rollback-response-lost", "commit-response-lost", "rollback-receipt-failure"])(
    "preserves transaction outcome evidence after %s",
    async (fault) => {
      const p = await person(), store = await journal();
      await owner.query("CREATE TABLE IF NOT EXISTS public.rollback_probe(id uuid PRIMARY KEY)");
      await owner.query("GRANT INSERT ON public.rollback_probe TO porchday_auth");
      if (fault === "rollback-receipt-failure") store.failPrefix = "receipts/";
      const original = Client.prototype.query;
      let injected = false;
      const spy = vi.spyOn(Client.prototype, "query").mockImplementation(function (this: Client, ...args: any[]) {
        const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
        const execute = (...values: any[]) => (original as any).apply(this, values);
        if (text === "SET LOCAL lock_timeout='10s'" && !injected && fault !== "commit-response-lost") {
          injected = true;
          return execute("INSERT INTO public.rollback_probe(id) VALUES($1)", [p.id]).then(() => { throw Error("Synthetic unknown work failure"); });
        }
        if (text === "COMMIT" && !injected && fault === "commit-response-lost") {
          injected = true;
          return execute(...args).then(() => { throw Error("Synthetic lost COMMIT response"); });
        }
        if (text === "ROLLBACK" && fault === "rollback-response-lost")
          return execute(...args).then(() => { throw Error("Synthetic lost ROLLBACK response"); });
        return execute(...args);
      } as any);
      try {
        const result = await call("sign-out", {}, p.cookie);
        expect(injected).toBe(true);
        expect(result.response.status).toBe(503);
        expect(await result.response.json()).toMatchObject({error:{code:"AUTH_UNAVAILABLE"}});
        expect((await owner.query("SELECT count(*)::int AS count FROM public.rollback_probe WHERE id=$1", [p.id])).rows[0].count).toBe(0);
        const control = (await readJournalControl(store)).value;
        expect(control.pending).toHaveLength(fault === "confirmed" ? 0 : 1);
        const sessions = (await owner.query('SELECT count(*)::int AS count FROM public.auth_session WHERE "userId"=$1', [p.id])).rows[0].count;
        expect(sessions).toBe(fault === "commit-response-lost" ? 0 : 1);
        store.failPrefix = "";
        expect(await detectStalePrivacyIntents(store, Date.now() + 120001)).toBe(fault !== "confirmed");
        expect((await readJournalControl(store)).value.mode).toBe(fault === "confirmed" ? "active" : "quarantine");
      } finally { spy.mockRestore(); }
    },
  );
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
  it('independently proves the atomic auth commit after receipt publication fails',async()=>{
    const p=await person(),store=await journal(p.id),previous=env.PRIVACY_COMMIT_WRITER_V1,previousRecovery=env.PRIVACY_COMMIT_RECOVERY_V1;
    env.PRIVACY_COMMIT_WRITER_V1='true';env.PRIVACY_COMMIT_RECOVERY_V1='true';store.failPrefix='receipts/';
    try{
      const result=await call('change-password',{currentPassword:p.password,newPassword:'synthetic-atomic-commit-password'},p.cookie);
      expect(result.response.status).toBe(503);
      const control=(await readJournalControl(store)).value;expect(control.pending).toHaveLength(1);
      const operation=control.pending[0].id,proof=await provePrivacyCommits(store,control);
      expect(proof.has(operation)).toBe(true);expect(store.rows.has(`receipts/${operation}.json`)).toBe(false);
      const fence=(await owner.query('SELECT sequence::text,scope_sha256 FROM app.privacy_operation_commits WHERE operation_id=$1',[operation])).rows[0];
      expect(fence).toEqual({sequence:proof.get(operation)!.sequence,scope_sha256:proof.get(operation)!.scopeSha256});
      expect((await owner.query('SELECT credentials_changed_at IS NOT NULL AS changed FROM public.auth_user WHERE id=$1',[p.id])).rows[0].changed).toBe(true);
      expect((await owner.query('SELECT 1 FROM public.auth_session WHERE "userId"=$1',[p.id])).rowCount).toBe(0);
    }finally{env.PRIVACY_COMMIT_WRITER_V1=previous;env.PRIVACY_COMMIT_RECOVERY_V1=previousRecovery;store.failPrefix='';}
  });
  it.each([2,4])('preserves %i concurrent auth commits after overlapping intent publication',async count=>writer(async()=>{
    const people=[];for(let i=0;i<count;i++)people.push(await person());
    const other=await person(),store=await journal();
    const previousWriter=env.PRIVACY_COMMIT_WRITER_V1,previousRecovery=env.PRIVACY_COMMIT_RECOVERY_V1;
    env.PRIVACY_COMMIT_WRITER_V1='true';env.PRIVACY_COMMIT_RECOVERY_V1='true';
    const baseline=(await owner.query('SELECT coalesce(max(sequence),0)::text AS n FROM app.privacy_operation_commits')).rows[0].n;
    const generation=(await readJournalControl(store)).value.generation;
    const sessions=await Promise.all(people.map(async p=>(await owner.query('SELECT id FROM public.auth_session WHERE "userId"=$1',[p.id])).rows[0].id as string));
    let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
    const arrived=new Set<string>();
    store.beforeWrite=async key=>{if(key.startsWith('intents/')){arrived.add(key);await barrier;}};
    const requests=people.map(async p=>{const startedAt=Date.now(),result=await call('revoke-sessions',{},p.cookie);return{...result,startedAt,endedAt:Date.now()};});
    try{
      // All independent requests reach immutable intent publication before any
      // can register its intent or acquire the SQL mutation lock.
      await vi.waitFor(()=>expect(arrived.size).toBe(count),{timeout:3000});release();
      const results=await Promise.all(requests);expect(results.map(r=>r.response.status)).toEqual(Array(count).fill(200));
      const control=(await readJournalControl(store)).value;expect(control.mode).toBe('active');expect(control.pending).toHaveLength(0);
      const fences=(await owner.query('SELECT operation_id,sequence::text,scope_sha256 FROM app.privacy_operation_commits WHERE sequence>$1::bigint ORDER BY sequence',[baseline])).rows;
      expect(fences).toHaveLength(count);expect(new Set(fences.map(f=>f.operation_id)).size).toBe(count);
      const intents=fences.map(f=>privacyIntentSchema.parse(JSON.parse(store.rows.get(`intents/${f.operation_id}.json`)!.value)));
      expect(new Set(intents.map(i=>`intents/${i.id}.json`))).toEqual(arrived);
      const proofControl={...control,pending:intents.map(({id,started_at})=>({id,started_at}))};
      const proofs=await provePrivacyCommits(store,proofControl),receipts=await provePrivacyReceipts(store,proofControl);
      for(const fence of fences){expect(proofs.get(fence.operation_id)).toEqual({sequence:fence.sequence,scopeSha256:fence.scope_sha256});expect(receipts.has(fence.operation_id)).toBe(true);}
      for(const p of people){
        expect((await owner.query('SELECT 1 FROM public.auth_session WHERE "userId"=$1',[p.id])).rowCount).toBe(0);
        expect((await(await call('get-session',undefined,p.cookie)).response.json())).toBeNull();
        expect((await call('list-sessions',undefined,p.cookie)).response.status).toBe(401);
        expect((await owner.query('SELECT 1 FROM public.auth_user WHERE id=$1',[p.id])).rowCount).toBe(1);
      }
      expect((await(await call('get-session',undefined,other.cookie)).response.json()).user.id).toBe(other.id);
      const sql=(await owner.query('SELECT app.safety_status() AS status')).rows[0].status;
      expect(sql.quarantined).toBe(false);expect(sql.generation).toBe(control.generation);
      const cohort=await proveAuthCommitCohort({db:owner,store,baselineSequence:baseline,generation,assertScope:()=>{},requests:results.map((r,i)=>({memberId:people[i].id,sessionId:sessions[i],startedAt:r.startedAt,endedAt:r.endedAt,status:200,deniedStatus:401}))},AbortSignal.timeout(10000));
      expect(cohort).toMatchObject({passed:true,count,canonicalMarkersAndReceipts:true,perRequestIdentityProved:false});
    }finally{release();await Promise.allSettled(requests);store.beforeWrite=undefined;env.PRIVACY_COMMIT_WRITER_V1=previousWriter;env.PRIVACY_COMMIT_RECOVERY_V1=previousRecovery;}
  }),15000);
  it('observes a real auth request blocked by its owned identity lock on both sides of a release barrier',async()=>writer(async()=>{
    const p=await person(),other=await person(),store=await journal(),directory=await mkdtemp(join(tmpdir(),'auth-inflight-integration-'));
    const sessionId=(await owner.query('SELECT id FROM public.auth_session WHERE "userId"=$1',[p.id])).rows[0].id;
    const previousWriter=env.PRIVACY_COMMIT_WRITER_V1,previousRecovery=env.PRIVACY_COMMIT_RECOVERY_V1;
    env.PRIVACY_COMMIT_WRITER_V1='true';env.PRIVACY_COMMIT_RECOVERY_V1='true';
    const probe=createStagingInflightRevocation({directory,db:owner,lock:await owner.connect(),session:{memberId:p.id,sessionId,cookie:p.cookie},assertScope:()=>{},transport:async(url,init)=>{
      const path=new URL(String(url)).pathname;
      expect(new Headers(init?.headers).get('Cookie')).toBe(p.cookie);
      // Exercise the actual auth routes locally. This suite mounts only auth,
      // so its denial read uses list-sessions rather than the hosted /me route.
      return(await call(path==='/api/auth/revoke-sessions'?'revoke-sessions':'list-sessions',init?.method==='POST'?{}:undefined,p.cookie)).response;
    }},AbortSignal.timeout(12000));
    try{
      expect(await probe.start(AbortSignal.timeout(10000))).toBe('in-flight');
      expect((await owner.query('SELECT 1 FROM public.auth_session WHERE id=$1',[sessionId])).rowCount).toBe(1);
      expect((await(await call('get-session',undefined,other.cookie)).response.json()).user.id).toBe(other.id);
      expect(await probe.finish(AbortSignal.timeout(5000))).toBe('verified');
      const result=probe.result();expect(result.waitingBeforeDispatch&&result.waitingAfterRestore).toBe(true);
      const fences=(await owner.query('SELECT operation_id FROM app.privacy_operation_commits WHERE sequence>$1::bigint',[result.markerBefore])).rows;expect(fences).toHaveLength(1);
      const control=(await readJournalControl(store)).value;expect(control.pending).toHaveLength(0);expect(control.mode).toBe('active');
      const intent=privacyIntentSchema.parse(JSON.parse(store.rows.get(`intents/${fences[0].operation_id}.json`)!.value));
      const proofControl={...control,pending:[{id:intent.id,started_at:intent.started_at}]};
      expect((await provePrivacyCommits(store,proofControl)).has(intent.id)).toBe(true);expect((await provePrivacyReceipts(store,proofControl)).has(intent.id)).toBe(true);
      expect((await owner.query('SELECT 1 FROM public.auth_session WHERE id=$1',[sessionId])).rowCount).toBe(0);
      expect((await(await call('get-session',undefined,other.cookie)).response.json()).user.id).toBe(other.id);
    }finally{await probe.close();env.PRIVACY_COMMIT_WRITER_V1=previousWriter;env.PRIVACY_COMMIT_RECOVERY_V1=previousRecovery;await rm(directory,{recursive:true,force:true});}
  }),15000);
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

  it('recovers a denial committed after the real HTTP publication deadline without a global intent',async()=>writer(async()=>{
    const p=await person(),other=await person(),store=await journal(p.id),control=store.rows.get('control.json')!.value;
    const put=store.put.bind(store);let release!:()=>void,entered!:()=>void,committed!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const finished=new Promise<void>(resolve=>{committed=resolve;});let writes=0;
    store.put=async(...args)=>{
      if(!args[0].startsWith('session-denials/v1/'))return put(...args);
      writes++;entered();await gate;const result=await put(...args);committed();return result;
    };
    try{
      const request=call('sign-out',{},p.cookie);await started;
      expect((await request).response.status).toBe(503);
      expect((await owner.query('SELECT 1 FROM public.auth_session WHERE "userId"=$1',[p.id])).rowCount).toBe(1);
      expect((await(await call('get-session',undefined,p.cookie)).response.json()).user.id).toBe(p.id);
      release();await finished;
      expect(await(await call('get-session',undefined,p.cookie)).response.json()).toBeNull();
      expect((await(await call('get-session',undefined,other.cookie)).response.json()).user.id).toBe(other.id);
      // The timed-out HTTP path must not resume SQL cleanup after the late write.
      expect((await owner.query('SELECT 1 FROM public.auth_session WHERE "userId"=$1',[p.id])).rowCount).toBe(1);
      expect(writes).toBe(1);expect(store.rows.get('control.json')!.value).toBe(control);
      expect((await cleanupDeniedSessions(env)).deleted).toBe(1);
      expect((await cleanupDeniedSessions(env)).deleted).toBe(0);
      expect((await owner.query('SELECT 1 FROM public.auth_session WHERE "userId"=$1',[p.id])).rowCount).toBe(0);
      expect(store.rows.get('control.json')!.value).toBe(control);
      expect(writes).toBe(1);
    }finally{release();}
  }),15000);
  it('bounds real identity-lock contention during logout and recovers through the independent sweep',async()=>writer(async()=>{
    const p=await person(),other=await person(),store=await journal(),control=store.rows.get('control.json')!.value;
    const lock=await owner.connect();
    try{
      await lock.query('BEGIN');
      await lock.query("SELECT pg_advisory_xact_lock(hashtextextended('porchday-identity:'||$1,0))",[p.id]);
      expect((await call('sign-out',{},p.cookie)).response.status).toBe(503);
      expect((await owner.query('SELECT 1 FROM public.auth_session WHERE "userId"=$1',[p.id])).rowCount).toBe(1);
      expect(await(await call('get-session',undefined,p.cookie)).response.json()).toBeNull();
      expect((await(await call('get-session',undefined,other.cookie)).response.json()).user.id).toBe(other.id);
      expect(store.rows.get('control.json')!.value).toBe(control);
    }finally{await lock.query('ROLLBACK');lock.release();}
    expect((await cleanupDeniedSessions(env)).deleted).toBe(1);
    expect((await cleanupDeniedSessions(env)).deleted).toBe(0);
    expect((await owner.query('SELECT 1 FROM public.auth_session WHERE "userId"=$1',[p.id])).rowCount).toBe(0);
    expect((await(await call('get-session',undefined,other.cookie)).response.json()).user.id).toBe(other.id);
    expect(store.rows.get('control.json')!.value).toBe(control);
  }),15000);

  it.each(['password-first','denial-first'] as const)('preserves credential and denial boundaries during concurrent logout (%s)',async order=>writer(async()=>{
    const p=await person(),other=await person(),store=await journal(p.id);
    const originalCheck=store.beforeWrite,newPassword='synthetic-concurrent-new-password';
    const originalSession=(await owner.query('SELECT id FROM public.auth_session WHERE "userId"=$1',[p.id])).rows[0].id;
    let release!:()=>void,paused=false;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    store.beforeWrite=async key=>{
      await originalCheck?.(key);
      const matches=order==='password-first'?key.startsWith('session-denials/v1/'):key.startsWith('intents/');
      if(matches&&!paused){paused=true;await gate;}
    };
    const change=()=>call('change-password',{currentPassword:p.password,newPassword},p.cookie);
    let held:ReturnType<typeof call>|undefined;
    try{
      held=order==='password-first'?call('sign-out',{},p.cookie):change();
      await vi.waitFor(()=>expect(paused).toBe(true),{timeout:3000});
      const first=await(order==='password-first'?change():call('sign-out',{},p.cookie));
      expect(first.response.status).toBe(200);
      release();const second=await held;
      expect(second.response.status).toBe(order==='password-first'?200:401);
      const control=(await readJournalControl(store)).value;
      expect(control.mode).toBe('active');expect(control.pending).toHaveLength(0);
      expect([...store.rows.entries()].some(([key,row])=>key.startsWith('session-denials/v1/')&&JSON.parse(row.value).sessionId===originalSession)).toBe(true);
      expect(await(await call('get-session',undefined,p.cookie)).response.json()).toBeNull();
      expect((await(await call('get-session',undefined,other.cookie)).response.json()).user.id).toBe(other.id);
      const changed=(await owner.query('SELECT credentials_changed_at FROM public.auth_user WHERE id=$1',[p.id])).rows[0].credentials_changed_at;
      if(order==='password-first')expect(changed).not.toBeNull();else expect(changed).toBeNull();
      const accepted=order==='password-first'?newPassword:p.password,rejected=order==='password-first'?p.password:newPassword;
      expect((await call('sign-in/email',{email:p.email,password:rejected})).response.status).toBe(401);
      const fresh=await call('sign-in/email',{email:p.email,password:accepted});expect(fresh.response.status).toBe(200);
      const freshCookie=fresh.response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
      expect((await(await call('get-session',undefined,freshCookie)).response.json()).user.id).toBe(p.id);
      expect(await(await call('get-session',undefined,p.cookie)).response.json()).toBeNull();
    }finally{release();if(held)await held;store.beforeWrite=originalCheck;}
  }),15000);

});
