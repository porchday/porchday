import { Hono, type Context } from "hono";
import { z } from "zod";
import { hashPassword } from "better-auth/crypto";
import { isPasswordCompromised } from "better-auth/plugins";
import type { PoolClient } from "pg";
import { authPool, hashToken } from "./auth";
import type { Env, Variables } from "./types";
import { withPrivacyJournal, JournalError } from "./privacy-journal";
import {
  enqueueAccountEmail,
  enqueueRecoveryEmail,
  processAccountEmails,
} from "./email-outbox";
import { event } from "./telemetry";

function dispatchRecoveryEmails(
  c: Context<{ Bindings: Env; Variables: Variables }>,
) {
  c.executionCtx.waitUntil(
    processAccountEmails(c.env).catch(() =>
      event("error", {code: "recovery_email_retry"}, c.env),
    ),
  );
}

const reports = new Hono<{ Bindings: Env; Variables: Variables }>();
const generic = {
  message:
    "If the contact address can receive email, we will send instructions. Reporting alone does not change account access.",
};
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
function secret() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
async function audit(
  db: PoolClient,
  staff: string | null,
  action: string,
  target: string,
) {
  await db.query(
    "INSERT INTO public.security_audit(staff_subject,action,target) VALUES($1,$2,$3)",
    [staff, action, target],
  );
}
async function revokeAccountAccess(db: PoolClient, member: string) {
  await db.query("SELECT app.set_security_hold($1::uuid)", [member]);
  await db.query('DELETE FROM public.auth_session WHERE "userId"=$1', [member]);
  await db.query(
    'DELETE FROM public.auth_verification WHERE value=$1 OR value IN(SELECT id FROM public.auth_two_factor WHERE "userId"=$1)',
    [member],
  );
  await db.query(
    "UPDATE public.auth_user SET credentials_changed_at=now() WHERE id=$1",
    [member],
  );
  await db.query(
    "UPDATE public.recovery_cases SET restore_token_hash=NULL,restore_token_expires_at=NULL WHERE member_id=$1",
    [member],
  );
}
async function enqueueRestorationEmail(
  env: Env,
  db: PoolClient,
  caseId: string,
  email: string,
  token: string,
) {
  await enqueueRecoveryEmail(
    env,
    db,
    caseId,
    "case_restore",
    email,
    "Complete your Porchday account recovery",
    `Two authorized reviewers approved your recovery. Set a new login password using this single-use link within 30 minutes:\n\n${env.APP_URL}/recovery#restore=${token}\n\nThis does not unlock encrypted history. You still need a trusted encryption recovery secret. All previous sessions and device keys will be revoked. If this was not you, visit ${env.APP_URL}/recovery.`,
  );
}
reports.post("/reports", async (c) => {
  const input = z
    .object({
      accountReference: z.string().trim().min(3).max(254),
      safeEmail: z.email().max(254),
      compromisedAt: z.string().max(50).optional(),
      trustedMethod: z.string().max(300).optional(),
      description: z.string().max(2000).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json(generic, 202);
  const pool = authPool(c.env);
  try {
    const ipHash = await hashToken(
      c.env.BETTER_AUTH_SECRET +
        "|recovery|" +
        (c.req.header("CF-Connecting-IP") || "local"),
    );
    const limit = await pool.query(
      `INSERT INTO public.auth_rate_limits(key,count,expires_at) VALUES($1,1,now()+interval '1 hour') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN auth_rate_limits.expires_at<now() THEN 1 ELSE auth_rate_limits.count+1 END,expires_at=CASE WHEN auth_rate_limits.expires_at<now() THEN now()+interval '1 hour' ELSE auth_rate_limits.expires_at END RETURNING count`,
      [ipHash],
    );
    if (limit.rows[0].count > 5) return c.json(generic, 202);
    const token = secret(),
      caseId = crypto.randomUUID();
    const when = input.data.compromisedAt
      ? new Date(input.data.compromisedAt)
      : null;
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      await db.query(
        `INSERT INTO public.recovery_cases(id,account_reference,safe_email,contact_token_hash,contact_token_expires_at,compromised_at,trusted_method,description) VALUES($1,$2,$3,$4,now()+interval '30 minutes',$5,$6,$7)`,
        [
          caseId,
          input.data.accountReference.toLowerCase().replace(/^@/, ""),
          input.data.safeEmail.toLowerCase(),
          await hashToken(token),
          when && Number.isFinite(+when) ? when : null,
          input.data.trustedMethod || null,
          input.data.description || null,
        ],
      );
      // Deliberately no account-existence lookup. Contact verification is not ownership proof.
      await enqueueRecoveryEmail(
        c.env,
        db,
        caseId,
        "case_contact",
        input.data.safeEmail,
        "Confirm your Porchday recovery contact",
        `Someone submitted a stolen-account report using this safe contact address. Confirm this address to submit the case:\n\n${c.env.APP_URL}/recovery#token=${token}\n\nThis link expires in 30 minutes. Confirmation does not grant access to any account. If this was not you, ignore it.`,
      );
      await db.query("COMMIT");
    } finally {
      await db.query("ROLLBACK");
      db.release();
    }
    dispatchRecoveryEmails(c);
    return c.json(generic, 202);
  } finally {
    c.executionCtx.waitUntil(pool.end());
  }
});
reports.post("/resume", async (c) => {
  const input = z
    .object({ caseId: z.uuid(), safeEmail: z.email().max(254) })
    .safeParse(await c.req.json().catch(() => null));
  if (!input.success) return c.json(generic, 202);
  const pool = authPool(c.env);
  try {
    const key = await hashToken(
      c.env.BETTER_AUTH_SECRET + "|recovery-resume|" + input.data.caseId,
    );
    const limit = await pool.query(
      `INSERT INTO public.auth_rate_limits(key,count,expires_at) VALUES($1,1,now()+interval '1 hour') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN auth_rate_limits.expires_at<now() THEN 1 ELSE auth_rate_limits.count+1 END,expires_at=CASE WHEN auth_rate_limits.expires_at<now() THEN now()+interval '1 hour' ELSE auth_rate_limits.expires_at END RETURNING count`,
      [key],
    );
    if (limit.rows[0].count > 3) return c.json(generic, 202);
    const token = secret();
    const db = await pool.connect();
    let queued = false;
    try {
      await db.query("BEGIN");
      const { rows } = await db.query(
        `UPDATE public.recovery_cases SET contact_token_hash=$1,contact_token_expires_at=now()+interval '30 minutes' WHERE id=$2 AND lower(safe_email)=$3 AND contact_verified_at IS NOT NULL AND retention_until>now() AND state<>'restored' RETURNING safe_email`,
        [
          await hashToken(token),
          input.data.caseId,
          input.data.safeEmail.toLowerCase(),
        ],
      );
      if (rows[0])
        await enqueueRecoveryEmail(
          c.env,
          db,
          input.data.caseId,
          "case_contact",
          rows[0].safe_email,
          "Resume your Porchday recovery case",
          `Use this single-use link within 30 minutes to reopen your private recovery case channel:\n\n${c.env.APP_URL}/recovery#token=${token}\n\nThis does not grant access to your account or encrypted history. If you did not request it, ignore it.`,
        );
      queued = !!rows[0];
      await db.query("COMMIT");
    } finally {
      await db.query("ROLLBACK");
      db.release();
    }
    if (queued) dispatchRecoveryEmails(c);
    return c.json(generic, 202);
  } finally {
    c.executionCtx.waitUntil(pool.end());
  }
});
reports.post("/verify-contact", async (c) => {
  const input = z.object({ token: tokenSchema }).safeParse(await c.req.json());
  if (!input.success) return c.json({ error: { code: "INVALID_LINK" } }, 400);
  const pool = authPool(c.env),
    session = secret();
  try {
    const { rows } = await pool.query(
      `UPDATE public.recovery_cases SET contact_verified_at=coalesce(contact_verified_at,now()),contact_token_expires_at=now(),state=CASE WHEN state='contact_pending' THEN 'submitted' ELSE state END,session_hash=$1,session_expires_at=now()+interval '24 hours',updated_at=now()
  WHERE contact_token_hash=$2 AND contact_token_expires_at>now() AND retention_until>now() AND state<>'restored' RETURNING id`,
      [await hashToken(session), await hashToken(input.data.token)],
    );
    if (!rows.length)
      return c.json({ error: { code: "INVALID_OR_USED_LINK" } }, 400);
    return c.json({
      caseId: rows[0].id,
      recoverySession: session,
      expiresIn: 86400,
    });
  } finally {
    c.executionCtx.waitUntil(pool.end());
  }
});
reports.get("/case", async (c) => {
  const bearer = c.req.header("Authorization")?.replace(/^Bearer /, "");
  if (!bearer || !tokenSchema.safeParse(bearer).success)
    return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
  const pool = authPool(c.env);
  try {
    const { rows } = await pool.query(
      "SELECT id,state,reason,created_at,updated_at FROM public.recovery_cases WHERE session_hash=$1 AND session_expires_at>now()",
      [await hashToken(bearer)],
    );
    if (!rows.length) return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    return c.json({
      ...rows[0],
      message:
        "A verified recovery contact does not prove account ownership. The team will review corroborating evidence. Support cannot decrypt encrypted history.",
    });
  } finally {
    c.executionCtx.waitUntil(pool.end());
  }
});
reports.post("/evidence", async (c) => {
  const bearer = c.req.header("Authorization")?.replace(/^Bearer /, "");
  const input = z
    .object({
      description: z.string().trim().min(1).max(2000),
      evidenceReference: z.string().max(500).optional(),
      appeal: z.boolean().optional(),
    })
    .safeParse(await c.req.json());
  if (!bearer || !tokenSchema.safeParse(bearer).success)
    return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
  if (!input.success)
    return c.json({ error: { code: "INVALID_EVIDENCE" } }, 400);
  const pool = authPool(c.env),
    db = await pool.connect();
  try {
    await db.query("BEGIN");
    const { rows } = await db.query(
      "SELECT * FROM public.recovery_cases WHERE session_hash=$1 AND session_expires_at>now() FOR UPDATE",
      [await hashToken(bearer)],
    );
    if (!rows[0]) return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    const count = await db.query(
      "SELECT count(*)::int AS count FROM public.recovery_evidence WHERE case_id=$1",
      [rows[0].id],
    );
    if (count.rows[0].count >= 20)
      return c.json({ error: { code: "EVIDENCE_LIMIT" } }, 429);
    await db.query(
      "INSERT INTO public.recovery_evidence(case_id,description,evidence_reference) VALUES($1,$2,$3)",
      [
        rows[0].id,
        input.data.description,
        input.data.evidenceReference || null,
      ],
    );
    if (input.data.appeal && rows[0].state === "denied") {
      await db.query(
        "UPDATE public.recovery_cases SET state='submitted',appeal_count=appeal_count+1,reason=NULL,updated_at=now() WHERE id=$1",
        [rows[0].id],
      );
      await db.query("DELETE FROM public.recovery_reviews WHERE case_id=$1", [
        rows[0].id,
      ]);
    }
    await audit(
      db,
      null,
      input.data.appeal ? "recovery_appeal" : "recovery_evidence",
      rows[0].id,
    );
    await db.query("COMMIT");
    return c.json({ ok: true });
  } finally {
    await db.query("ROLLBACK");
    db.release();
    c.executionCtx.waitUntil(pool.end());
  }
});
reports.post("/complete", async (c) => {
  const input = z
    .object({ token: tokenSchema, newPassword: z.string().min(12).max(128) })
    .safeParse(await c.req.json());
  if (!input.success)
    return c.json({ error: { code: "INVALID_RECOVERY" } }, 400);
  const pool = authPool(c.env),
    tokenHash = await hashToken(input.data.token);
  try {
    // Autocommit rate/token checks precede R2 writes and expensive password work.
    // The token and reviewer authority are checked again after the identity lock.
    const rateKey = await hashToken(
      c.env.BETTER_AUTH_SECRET +
        "|recovery-complete|" +
        (c.req.header("CF-Connecting-IP") || "local"),
    );
    const limit = await pool.query(
      `INSERT INTO public.auth_rate_limits(key,count,expires_at) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET count=CASE WHEN auth_rate_limits.expires_at<now() THEN 1 ELSE auth_rate_limits.count+1 END,expires_at=CASE WHEN auth_rate_limits.expires_at<now() THEN now()+interval '15 minutes' ELSE auth_rate_limits.expires_at END RETURNING count`,
      [rateKey],
    );
    if (limit.rows[0].count > 10)
      return c.json({ error: { code: "RATE_LIMITED" } }, 429);
    const candidate = await pool.query(
      `SELECT member_id FROM public.recovery_cases WHERE restore_token_hash=$1 AND restore_token_expires_at>now() AND state='hold' AND (SELECT count(*) FROM public.recovery_reviews r JOIN public.staff_users s ON s.subject=r.reviewer WHERE r.case_id=recovery_cases.id AND r.decision='restore' AND s.active AND 'recovery'=ANY(s.roles))>=2`,
      [tokenHash],
    );
    if (!candidate.rows[0]?.member_id)
      return c.json({ error: { code: "INVALID_OR_USED_LINK" } }, 400);
    if (await isPasswordCompromised(input.data.newPassword))
      return c.json(
        {
          error: {
            code: "PASSWORD_COMPROMISED",
            message:
              "Choose a password that has not appeared in known breaches.",
          },
        },
        400,
      );
    const password = await hashPassword(input.data.newPassword);
    const rejected = await withPrivacyJournal(c.env, async () => {
      const db = await pool.connect();
      try {
        await db.query("BEGIN");
        await db.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('porchday-identity:'||$1,0))",
          [candidate.rows[0].member_id],
        );
        const { rows } = await db.query(
          `SELECT * FROM public.recovery_cases WHERE restore_token_hash=$1 AND restore_token_expires_at>now() AND state='hold' FOR UPDATE`,
          [tokenHash],
        );
        const current = rows[0];
        if (!current || current.member_id !== candidate.rows[0].member_id)
          return c.json({ error: { code: "INVALID_OR_USED_LINK" } }, 400);
        const votes = await db.query(
          `SELECT r.reviewer FROM public.recovery_reviews r JOIN public.staff_users s ON s.subject=r.reviewer WHERE case_id=$1 AND decision='restore' AND s.active AND 'recovery'=ANY(s.roles)`,
          [current.id],
        );
        if (votes.rows.length < 2)
          return c.json({ error: { code: "REVIEW_REQUIRED" } }, 403);
        const user = await db.query(
          "SELECT email FROM public.auth_user WHERE id=$1 FOR UPDATE",
          [current.member_id],
        );
        if (!user.rows[0])
          return c.json({ error: { code: "INVALID_OR_USED_LINK" } }, 400);
        await revokeAccountAccess(db, current.member_id);
        await db.query(
          'UPDATE public.auth_account SET password=$1,"updatedAt"=now() WHERE "userId"=$2 AND "providerId"=\'credential\'',
          [password, current.member_id],
        );
        await db.query('DELETE FROM public.auth_two_factor WHERE "userId"=$1', [
          current.member_id,
        ]);
        await db.query(
          'UPDATE public.auth_user SET email=$1,"emailVerified"=true,"twoFactorEnabled"=false,"updatedAt"=now(),credentials_changed_at=now() WHERE id=$2',
          [current.safe_email, current.member_id],
        );
        await db.query("SELECT app.recovery_restore($1,$2::uuid)", [
          votes.rows[0].reviewer,
          current.member_id,
        ]);
        await db.query(
          "UPDATE public.recovery_cases SET state='restored',session_hash=NULL,session_expires_at=NULL,restore_token_hash=NULL,restore_token_expires_at=NULL,updated_at=now() WHERE id=$1",
          [current.id],
        );
        await audit(db, null, "recovery_completed", current.id);
        for (const address of new Set<string>([
          current.safe_email,
          user.rows[0].email,
        ]))
          await enqueueAccountEmail(
            c.env,
            db,
            current.member_id,
            address,
            "Your Porchday account access changed",
            `A reviewed recovery changed your login credentials. Previous sessions and device keys were revoked. Sign in again and recover your encryption keys using your own recovery secret. If this was not authorized, report it at ${c.env.APP_URL}/recovery.`,
          );
        await db.query("COMMIT");
      } finally {
        await db.query("ROLLBACK");
        db.release();
      }
    });
    if (rejected) return rejected;
  } catch (error) {
    if (error instanceof JournalError)
      return c.json(
        {
          error: {
            code: "PRIVACY_CHECKPOINT_REQUIRED",
            message:
              "The change could not be safely confirmed. Please try again later.",
          },
        },
        503,
      );
    if ((error as { code?: string }).code === "23505")
      return c.json({ error: { code: "CONTACT_UNAVAILABLE" } }, 409);
    throw error;
  } finally {
    c.executionCtx.waitUntil(pool.end());
  }
  dispatchRecoveryEmails(c);
  return c.json({
    ok: true,
    signInRequired: true,
    encryptionRecoveryRequired: true,
  });
});

/** Mounted only behind requireStaff('recovery'). No claimant session reaches this router. */
export function createStaffRecoveryRoutes() {
  const staff = new Hono<{ Bindings: Env; Variables: Variables }>();
  staff.get("/cases", async (c) => {
    const query = z
      .object({
        state: z
          .enum(["submitted", "reviewing", "hold", "restored", "denied"])
          .optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z.string().max(256).optional(),
      })
      .safeParse(c.req.query());
    if (!query.success)
      return c.json({ error: { code: "INVALID_QUERY" } }, 400);
    let after: [string, string] | null = null;
    if (query.data.cursor) {
      try {
        after = z
          .tuple([z.string().datetime({ precision: 6 }), z.uuid()])
          .parse(
            JSON.parse(
              Buffer.from(query.data.cursor, "base64url").toString("utf8"),
            ),
          );
      } catch {
        return c.json({ error: { code: "INVALID_CURSOR" } }, 400);
      }
    }
    const pool = authPool(c.env);
    try {
      const { rows } = await pool.query(
        `SELECT id,account_reference,safe_email,state,created_at,updated_at,assigned_to,contact_verified_at,
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
    FROM public.recovery_cases WHERE contact_verified_at IS NOT NULL AND retention_until>now()
    AND ($1::text IS NULL OR state=$1) AND ($2::timestamptz IS NULL OR (created_at,id)>($2::timestamptz,$3::uuid))
    ORDER BY created_at,id LIMIT $4`,
        [
          query.data.state || null,
          after?.[0] || null,
          after?.[1] || null,
          query.data.limit + 1,
        ],
      );
      const page = rows.slice(0, query.data.limit),
        last = page.at(-1);
      const next =
        rows.length > query.data.limit && last
          ? Buffer.from(JSON.stringify([last.cursor_time, last.id])).toString(
              "base64url",
            )
          : null;
      await pool.query(
        "INSERT INTO public.security_audit(staff_subject,action) VALUES($1,'recovery_queue_view')",
        [c.get("staffSubject")],
      );
      return c.json({
        cases: page.map(({ cursor_time, ...row }) => row),
        next_cursor: next,
      });
    } finally {
      c.executionCtx.waitUntil(pool.end());
    }
  });
  staff.get("/cases/:id", async (c) => {
    if (!z.uuid().safeParse(c.req.param("id")).success)
      return c.json({ error: { code: "NOT_FOUND" } }, 404);
    const pool = authPool(c.env);
    try {
      const { rows } = await pool.query(
        `SELECT id,account_reference,safe_email,state,compromised_at,trusted_method,description,reason,member_id,assigned_to,created_at,updated_at,contact_verified_at FROM public.recovery_cases WHERE id=$1 AND contact_verified_at IS NOT NULL AND retention_until>now()`,
        [c.req.param("id")],
      );
      if (!rows[0]) return c.json({ error: { code: "NOT_FOUND" } }, 404);
      const evidence = await pool.query(
        "SELECT id,description,evidence_reference,created_at FROM public.recovery_evidence WHERE case_id=$1 ORDER BY created_at",
        [rows[0].id],
      );
      const reviews = await pool.query(
        "SELECT reviewer,decision,evidence_reference,reviewed_at FROM public.recovery_reviews WHERE case_id=$1",
        [rows[0].id],
      );
      await pool.query(
        "INSERT INTO public.security_audit(staff_subject,action,target) VALUES($1,'recovery_case_view',$2)",
        [c.get("staffSubject"), rows[0].id],
      );
      return c.json({
        ...rows[0],
        evidence: evidence.rows,
        reviews: reviews.rows,
      });
    } finally {
      c.executionCtx.waitUntil(pool.end());
    }
  });
  staff.post("/cases/:id/review", async (c) => {
    const input = z
      .object({
        decision: z.enum(["hold", "restore", "deny"]),
        evidenceReference: z.string().trim().min(10).max(500),
        reason: z.string().trim().min(10).max(1000),
      })
      .safeParse(await c.req.json());
    if (!z.uuid().safeParse(c.req.param("id")).success || !input.success)
      return c.json({ error: { code: "INVALID_REVIEW" } }, 400);
    const pool = authPool(c.env),
      db = await pool.connect();
    let token: string | undefined,
      approvals = 0;
    try {
      await db.query("BEGIN");
      if (
        !(
          await db.query(
            "SELECT 1 FROM public.staff_users WHERE subject=$1 AND active AND 'recovery'=ANY(roles)",
            [c.get("staffSubject")],
          )
        ).rowCount
      )
        return c.json({ error: { code: "STAFF_ROLE_REQUIRED" } }, 403);
      const candidate = await db.query(
        "SELECT member_id,account_reference FROM public.recovery_cases WHERE id=$1",
        [c.req.param("id")],
      );
      if (candidate.rows[0]) {
        const candidateId =
          candidate.rows[0].member_id ||
          (
            await db.query("SELECT app.recovery_lookup($1,$2) AS id", [
              c.get("staffSubject"),
              candidate.rows[0].account_reference,
            ])
          ).rows[0]?.id;
        if (candidateId)
          await db.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('porchday-identity:'||$1,0))",
            [candidateId],
          );
      }
      const { rows } = await db.query(
        "SELECT * FROM public.recovery_cases WHERE id=$1 AND contact_verified_at IS NOT NULL AND retention_until>now() FOR UPDATE",
        [c.req.param("id")],
      );
      const current = rows[0];
      if (!current) return c.json({ error: { code: "NOT_FOUND" } }, 404);
      if (["restored", "denied"].includes(current.state))
        return c.json({ error: { code: "CASE_CLOSED" } }, 409);
      const subject = c.get("staffSubject");
      const who = await db.query(
        "SELECT 1 FROM public.staff_users WHERE subject=$1 AND active AND 'recovery'=ANY(roles)",
        [subject],
      );
      if (!who.rowCount)
        return c.json({ error: { code: "STAFF_ROLE_REQUIRED" } }, 403);
      const lookup = await db.query("SELECT app.recovery_lookup($1,$2) AS id", [
        subject,
        current.account_reference,
      ]);
      const member = current.member_id || lookup.rows[0]?.id;
      if (!member && input.data.decision !== "deny")
        return c.json({ error: { code: "OWNERSHIP_NOT_ESTABLISHED" } }, 409);
      // The reference must document independent established-method/account-history evidence.
      // User-supplied claims and a verified new email are never sufficient on their own.
      await db.query(
        "INSERT INTO public.recovery_reviews(case_id,reviewer,decision,evidence_reference) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [
          current.id,
          subject,
          input.data.decision,
          input.data.evidenceReference,
        ],
      );
      if (input.data.decision === "hold") {
        await revokeAccountAccess(db, member);
        await db.query(
          "UPDATE public.recovery_cases SET member_id=$1,state='hold',assigned_to=$2,reason=$3,updated_at=now() WHERE id=$4",
          [member, subject, input.data.reason, current.id],
        );
        const oldEmail = (
          await db.query("SELECT email FROM public.auth_user WHERE id=$1", [
            member,
          ])
        ).rows[0]?.email;
        if (oldEmail)
          await enqueueRecoveryEmail(
            c.env,
            db,
            current.id,
            "case_security",
            oldEmail,
            "Your Porchday account is protected",
            `A security review placed your account on hold. Sessions and integration access were revoked while ownership is reviewed. Content expiration continues normally. If you need help, visit ${c.env.APP_URL}/recovery.`,
          );
      } else if (input.data.decision === "restore") {
        if (current.state !== "hold")
          return c.json({ error: { code: "HOLD_REQUIRED" } }, 409);
        const votes = await db.query(
          `SELECT count(*)::int AS count FROM public.recovery_reviews r JOIN public.staff_users s ON s.subject=r.reviewer WHERE case_id=$1 AND decision='restore' AND s.active AND 'recovery'=ANY(s.roles)`,
          [current.id],
        );
        approvals = votes.rows[0].count;
        if (approvals >= 2) {
          token = secret();
          await db.query(
            "UPDATE public.recovery_cases SET restore_token_hash=$1,restore_token_expires_at=now()+interval '30 minutes',reason=$2,updated_at=now() WHERE id=$3",
            [await hashToken(token), input.data.reason, current.id],
          );
          await enqueueRestorationEmail(
            c.env,
            db,
            current.id,
            current.safe_email,
            token,
          );
        }
      } else {
        await db.query(
          "UPDATE public.recovery_cases SET state='denied',reason=$1,restore_token_hash=NULL,restore_token_expires_at=NULL,updated_at=now() WHERE id=$2",
          [input.data.reason, current.id],
        );
        // Denying one claimant does not automatically release a corroborated security hold.
      }
      await audit(db, subject, "recovery_" + input.data.decision, current.id);
      await db.query("COMMIT");
    } finally {
      await db.query("ROLLBACK");
      db.release();
      c.executionCtx.waitUntil(pool.end());
    }
    // Staff changes are acknowledged by the outer privacy journal middleware.
    // The minute scheduler drains committed mail after that boundary.
    return c.json({ ok: true, approvals, restoreLinkQueued: !!token });
  });
  return staff;
}
export default reports;
