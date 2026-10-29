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
  it("journals a valid reset once and rejects its replay before another R2 intent", async () => {
    const p = await person(),
      store = await journal(p.id),
      before = store.writes;
    expect(
      (
        await call("request-password-reset", {
          email: p.email,
          redirectTo: env.APP_URL + "/reset-password",
        })
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
        })
      ).response.status,
    ).toBe(200);
    const after = store.writes;
    expect(after).toBeGreaterThan(before);
    expect(
      (
        await call("reset-password", {
          token,
          newPassword: "other-synthetic-journal-password",
        })
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
  it("journals MFA enrollment and backup-code consumption while ordinary TOTP login remains read-only to R2", async () => {
    const p = await person(),
      store = await journal(p.id);
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
    expect(
      (
        await call(
          "two-factor/verify-totp",
          { code: await code(), trustDevice: false },
          p.cookie,
        )
      ).response.status,
    ).toBe(200);
    await call("sign-out", {}, p.cookie);
    const before = store.writes;
    const challenge = (
      await call("sign-in/email", { email: p.email, password: p.password })
    ).response;
    const cookie = challenge.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    const completed = await call(
      "two-factor/verify-totp",
      { code: await code(), trustDevice: false },
      cookie,
    );
    expect(completed.response.status).toBe(200);
    expect(store.writes).toBe(before);
    const session = completed.response.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    await call("sign-out", {}, session);
    const next = (
      await call("sign-in/email", { email: p.email, password: p.password })
    ).response;
    const nextCookie = next.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    const backupBefore = store.writes;
    expect(
      (
        await call(
          "two-factor/verify-backup-code",
          { code: setup.backupCodes[0], trustDevice: false },
          nextCookie,
        )
      ).response.status,
    ).toBe(200);
    expect(store.writes).toBeGreaterThan(backupBefore);
    expect((await readJournalControl(store)).value.pending).toHaveLength(0);
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
});
