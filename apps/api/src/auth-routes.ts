import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getSignedCookie } from "hono/cookie";
import { jwtVerify } from "jose";
import type { Pool } from "pg";
import { authPool, createAuth, hashToken } from "./auth";
import type { Env, Variables } from "./types";
import { event } from "./telemetry";
import { enqueueAccountEmail, processAccountEmails } from "./email-outbox";
import { JournalError, withPrivacyJournal } from "./privacy-journal";

type AuthContext = Context<{ Bindings: Env; Variables: Variables }>;
class AuthRejection extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 403 | 405 | 429,
  ) {
    super(code);
  }
}
function reject(
  code: string,
  status: 400 | 401 | 403 | 405 | 429 = 400,
): never {
  throw new AuthRejection(code, status);
}
const allowed = new Set([
  "sign-in/email",
  "sign-up/email",
  "sign-out",
  "get-session",
  "verify-email",
  "request-password-reset",
  "reset-password",
  "send-verification-email",
  "change-password",
  "list-sessions",
  "revoke-session",
  "revoke-sessions",
  "revoke-other-sessions",
  "change-email",
  "two-factor/enable",
  "two-factor/disable",
  "two-factor/verify-totp",
  "two-factor/verify-backup-code",
  "two-factor/generate-backup-codes",
]);
const readRoutes = new Set(["get-session", "list-sessions", "verify-email"]);
const freshSessionRoutes = new Set([
  "change-password",
  "change-email",
  "revoke-session",
  "revoke-sessions",
  "revoke-other-sessions",
  "two-factor/enable",
  "two-factor/disable",
  "two-factor/generate-backup-codes",
]);
const factorChecks = new Set([
  "two-factor/verify-totp",
  "two-factor/verify-backup-code",
]);
export const authMailRoutes = new Set([
  "sign-in/email",
  "sign-up/email",
  "request-password-reset",
  "reset-password",
  "send-verification-email",
  "change-password",
  "change-email",
  "verify-email",
]);
const sensitive = (path: string) =>
  freshSessionRoutes.has(path) ||
  factorChecks.has(path) ||
  ["sign-out", "verify-email", "reset-password"].includes(path);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type Authorization = {
  memberId: string;
  journal: boolean;
  changedEmailUser?: { id: string; email: string };
  emailTokenHash?: string;
};

function sameOriginTarget(raw: unknown, base: string) {
  if (raw === undefined || raw === null) return true;
  if (typeof raw !== "string") return false;
  try {
    return new URL(raw, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/** Read-only capability checks. Run once before R2 and again under the identity
 * lock, so a revoked session or consumed link cannot win an intervening race. */
async function authorize(
  c: AuthContext,
  pool: Pool,
  path: string,
  incoming: Record<string, unknown>,
): Promise<Authorization> {
  const request = c.req.raw;
  if (path === "verify-email") {
    const url = new URL(request.url),
      token = url.searchParams.get("token");
    if (
      !token ||
      token.length > 4096 ||
      !sameOriginTarget(url.searchParams.get("callbackURL"), c.env.APP_URL)
    )
      reject("INVALID_LINK");
    let claims;
    try {
      claims = (
        await jwtVerify(
          token,
          new TextEncoder().encode(c.env.BETTER_AUTH_SECRET),
          { algorithms: ["HS256"], requiredClaims: ["iat", "exp"] },
        )
      ).payload;
    } catch {
      return reject("INVALID_LINK");
    }
    if (
      typeof claims.email !== "string" ||
      typeof claims.iat !== "number" ||
      typeof claims.exp !== "number"
    )
      reject("INVALID_LINK");
    if (
      claims.requestType !== undefined &&
      !["change-email-confirmation", "change-email-verification"].includes(
        String(claims.requestType),
      )
    )
      reject("INVALID_LINK");
    if (
      claims.updateTo !== undefined &&
      (typeof claims.updateTo !== "string" || !claims.updateTo.includes("@"))
    )
      reject("INVALID_LINK");
    const account = (
      await pool.query(
        "SELECT id,email,credentials_changed_at,app.auth_member_status(id::uuid) AS status FROM public.auth_user WHERE email=$1",
        [claims.email],
      )
    ).rows[0];
    if (
      !account ||
      ["hold", "suspended", "deleted", "deleting"].includes(account.status) ||
      (account.credentials_changed_at &&
        claims.iat <=
          Math.floor(new Date(account.credentials_changed_at).getTime() / 1000))
    )
      reject("INVALID_LINK");
    const emailTokenHash = await hashToken(token);
    if (
      (
        await pool.query(
          "SELECT 1 FROM public.used_email_links WHERE token_hash=$1",
          [emailTokenHash],
        )
      ).rowCount
    )
      reject("LINK_ALREADY_USED");
    return {
      memberId: account.id,
      journal: true,
      emailTokenHash,
      changedEmailUser:
        claims.requestType === "change-email-verification"
          ? account
          : undefined,
    };
  }
  if (path === "reset-password") {
    const token =
      typeof incoming.token === "string"
        ? incoming.token
        : new URL(request.url).searchParams.get("token");
    if (
      !token ||
      token.length > 200 ||
      typeof incoming.newPassword !== "string" ||
      incoming.newPassword.length < 12 ||
      incoming.newPassword.length > 128
    )
      reject("INVALID_RESET_REQUEST");
    const account = (
      await pool.query(
        'SELECT value AS id,app.auth_member_status(value::uuid) AS status FROM public.auth_verification WHERE identifier=$1 AND "expiresAt">now()',
        [await hashToken("reset-password:" + token)],
      )
    ).rows[0];
    if (!account || !uuid.test(account.id)) reject("INVALID_LINK");
    if (["hold", "deleted", "deleting", "suspended"].includes(account.status))
      reject("ACCOUNT_UNAVAILABLE", 403);
    return { memberId: account.id, journal: true };
  }
  const session = await createAuth(c.env, pool, undefined, true).api.getSession(
    {
      headers: request.headers,
      query: { disableRefresh: true, disableCookieCache: true },
    },
  );
  if (session) {
    if (
      (freshSessionRoutes.has(path) || factorChecks.has(path)) &&
      Date.now() - new Date(session.session.createdAt).getTime() > 15 * 60_000
    )
      reject("RECENT_AUTH_REQUIRED", 403);
    const status = (
      await pool.query("SELECT app.auth_member_status($1::uuid) AS status", [
        session.user.id,
      ])
    ).rows[0]?.status;
    if (
      path !== "sign-out" &&
      ["hold", "deleted", "deleting", "suspended"].includes(status)
    )
      reject("ACCOUNT_UNAVAILABLE", 403);
    return { memberId: session.user.id, journal: true };
  }
  if (factorChecks.has(path)) {
    // Hono verifies the same standard HMAC-SHA256 signed-cookie format as
    // Better Auth. An unsigned database identifier is never an R2 capability.
    const name =
      (c.env.APP_URL.startsWith("https:") ? "__Secure-" : "") +
      "better-auth.two_factor";
    const challenge = await getSignedCookie(c, c.env.BETTER_AUTH_SECRET, name);
    if (
      typeof challenge !== "string" ||
      !/^2fa-[A-Za-z0-9_-]{16,128}$/.test(challenge)
    )
      reject("UNAUTHORIZED", 401);
    const account = (
      await pool.query(
        'SELECT value AS id,app.auth_member_status(value::uuid) AS status FROM public.auth_verification WHERE identifier=$1 AND "expiresAt">now()',
        [await hashToken(challenge)],
      )
    ).rows[0];
    if (
      !account ||
      !uuid.test(account.id) ||
      ["hold", "deleted", "deleting"].includes(account.status)
    )
      reject("UNAUTHORIZED", 401);
    // Ordinary TOTP sign-in changes no long-lived credential. Backup-code
    // consumption must be durable so a restore cannot revive a used code.
    return {
      memberId: account.id,
      journal: path === "two-factor/verify-backup-code",
    };
  }
  return reject("UNAUTHORIZED", 401);
}

export const authRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
authRoutes.use(
  "*",
  bodyLimit({
    maxSize: 16384,
    onError: (c) => c.json({ error: { code: "TOO_LARGE" } }, 413),
  }),
);
authRoutes.all("/*", async (c) => {
  const path = new URL(c.req.url).pathname.replace("/api/auth/", "");
  const resetRedirect = /^reset-password\/[A-Za-z0-9_-]{16,200}$/.test(path);
  if (!allowed.has(path) && !(c.req.method === "GET" && resetRedirect))
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "This sign-in method is not enabled.",
        },
      },
      404,
    );
  const expectedMethod = readRoutes.has(path) || resetRedirect ? "GET" : "POST";
  if (c.req.method !== expectedMethod)
    return c.json({ error: { code: "METHOD_NOT_ALLOWED" } }, 405);
  const physicalPool = authPool(c.env);
  let committedAndConfirmed = false;
  try {
    // Commit the rate limit before any operation transaction or R2 write.
    const ip = c.req.header("CF-Connecting-IP") || "local";
    const key = await hashToken(
      c.env.BETTER_AUTH_SECRET + "|" + ip + "|" + path,
    );
    const limited = await physicalPool.query(
      `INSERT INTO public.auth_rate_limits(key,count,expires_at) VALUES($1,1,now()+interval '1 minute')
      ON CONFLICT(key) DO UPDATE SET count=CASE WHEN auth_rate_limits.expires_at<now() THEN 1 ELSE auth_rate_limits.count+1 END,
      expires_at=CASE WHEN auth_rate_limits.expires_at<now() THEN now()+interval '1 minute' ELSE auth_rate_limits.expires_at END RETURNING count`,
      [key],
    );
    if (limited.rows[0].count > (path === "get-session" ? 60 : 10))
      reject("RATE_LIMIT", 429);
    let incoming: Record<string, unknown> = {};
    if (c.req.method === "POST") {
      if (c.req.header("Origin") !== new URL(c.env.APP_URL).origin)
        reject("INVALID_ORIGIN", 403);
      const value = await c.req.raw
        .clone()
        .json()
        .catch(() => null);
      if (!value || typeof value !== "object" || Array.isArray(value))
        reject("INVALID_BODY");
      incoming = value as Record<string, unknown>;
      if (
        !sameOriginTarget(incoming.callbackURL, c.env.APP_URL) ||
        !sameOriginTarget(incoming.redirectTo, c.env.APP_URL)
      )
        reject("INVALID_CALLBACK", 403);
      if (
        factorChecks.has(path) &&
        (typeof incoming.code !== "string" ||
          incoming.code.length > 100 ||
          incoming.code.length < 1)
      )
        reject("INVALID_CODE");
    }
    const proof = sensitive(path)
      ? await authorize(c, physicalPool, path, incoming)
      : null;
    let memberToLock = proof?.memberId;
    if (!memberToLock && typeof incoming.email === "string")
      memberToLock = (
        await physicalPool.query(
          "SELECT id FROM public.auth_user WHERE lower(email)=$1",
          [incoming.email.toLowerCase()],
        )
      ).rows[0]?.id;
    const work = async () => {
      const client = await physicalPool.connect();
      const proxyClient = {
        query: client.query.bind(client),
        release: () => {},
      };
      const pool = {
        query: client.query.bind(client),
        connect: async () => proxyClient,
        end: async () => {},
      } as unknown as Pool;
      let transaction = false;
      try {
        await client.query("BEGIN");
        transaction = true;
        await client.query("SET LOCAL lock_timeout='10s'");
        if (memberToLock && uuid.test(memberToLock))
          await pool.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('porchday-identity:'||$1,0))",
            [memberToLock],
          );
        const checked = proof ? await authorize(c, pool, path, incoming) : null;
        if (checked && checked.memberId !== proof?.memberId)
          reject("UNAUTHORIZED", 401);
        let request = c.req.raw;
        const changedEmailUser = checked?.changedEmailUser;
        if (checked?.emailTokenHash) {
          const inserted = await pool.query(
            "INSERT INTO public.used_email_links(token_hash,expires_at) VALUES($1,now()+interval '2 hours') ON CONFLICT DO NOTHING RETURNING token_hash",
            [checked.emailTokenHash],
          );
          if (!inserted.rowCount) reject("LINK_ALREADY_USED");
        }
        const handle = async () => {
          let signupId: string | undefined;
          if (path === "sign-up/email") {
            if (c.env.SIGNUP_ENABLED !== "true")
              return c.json(
                {
                  error: {
                    code: "PILOT_CLOSED",
                    message: "Pilot registration is not open yet.",
                  },
                },
                403,
              );
            if (request.method !== "POST")
              return c.json({ error: { code: "METHOD_NOT_ALLOWED" } }, 405);
            const b = (await request.clone().json()) as Record<string, unknown>;
            if (b.adult !== true || b.acceptedRules !== true)
              return c.json(
                {
                  error: {
                    code: "ELIGIBILITY_REQUIRED",
                    message:
                      "The pilot is for adults who accept the community rules.",
                  },
                },
                400,
              );
            const handle = String(b.handle || "")
              .toLowerCase()
              .trim();
            const email = String(b.email || "")
              .toLowerCase()
              .trim();
            if (
              !/^[a-z0-9_]{3,24}$/.test(handle) ||
              !email.includes("@") ||
              String(b.inviteCode || "").length < 24
            )
              return c.json(
                {
                  error: {
                    code: "INVALID_INVITATION",
                    message: "Check your invitation, email and handle.",
                  },
                },
                400,
              );
            signupId = crypto.randomUUID();
            const claim = await pool.query(
              `UPDATE public.pilot_invitations SET consumed_user=$1,handle=$2,claimed_at=now(),adult_attested_at=now(),rules_accepted_at=now()
    WHERE token_hash=$3 AND email=$4 AND expires_at>now() AND consumed_user IS NULL RETURNING token_hash`,
              [signupId, handle, await hashToken(String(b.inviteCode)), email],
            );
            if (!claim.rowCount)
              return c.json(
                {
                  error: {
                    code: "INVALID_INVITATION",
                    message:
                      "This invitation is invalid, expired, or already used.",
                  },
                },
                403,
              );
            request = new Request(request.url, {
              method: "POST",
              headers: request.headers,
              body: JSON.stringify({
                email,
                password: b.password,
                name: handle,
                callbackURL: c.env.APP_URL + "/login?verified=1",
              }),
            });
          }

          const auth = createAuth(c.env, pool, signupId, true);
          if (path === "change-password" && request.method === "POST")
            request = new Request(request.url, {
              method: "POST",
              headers: request.headers,
              body: JSON.stringify({ ...incoming, revokeOtherSessions: true }),
            });
          const response = await auth.handler(request);
          if (path === "change-password" && response.ok && memberToLock) {
            await pool.query(
              'DELETE FROM public.auth_session WHERE "userId"=$1',
              [memberToLock],
            );
            await pool.query(
              "DELETE FROM public.auth_verification WHERE value=$1",
              [memberToLock],
            );
            await pool.query(
              "UPDATE public.auth_user SET credentials_changed_at=now() WHERE id=$1",
              [memberToLock],
            );
            const user = (
              await pool.query(
                "SELECT email FROM public.auth_user WHERE id=$1",
                [memberToLock],
              )
            ).rows[0];
            if (user)
              await enqueueAccountEmail(
                c.env,
                pool,
                memberToLock,
                user.email,
                "Your Porchday password changed",
                `Your password changed and previous login sessions were revoked. Sign in again. If this was not you, report it at ${c.env.APP_URL}/recovery.`,
              );
          }
          if (changedEmailUser && response.status < 400) {
            const current = await pool.query(
              "SELECT email FROM public.auth_user WHERE id=$1",
              [changedEmailUser.id],
            );
            if (current.rows[0]?.email !== changedEmailUser.email) {
              await pool.query(
                'DELETE FROM public.auth_session WHERE "userId"=$1',
                [changedEmailUser.id],
              );
              await pool.query(
                "DELETE FROM public.auth_verification WHERE value=$1",
                [changedEmailUser.id],
              );
              await pool.query(
                "UPDATE public.auth_user SET credentials_changed_at=now() WHERE id=$1",
                [changedEmailUser.id],
              );
              for (const address of [
                changedEmailUser.email,
                current.rows[0].email,
              ])
                await enqueueAccountEmail(
                  c.env,
                  pool,
                  changedEmailUser.id,
                  address,
                  "Your Porchday email changed",
                  `Your login email changed. Sign in again using the verified new address. If you did not authorize this, report a stolen account at ${c.env.APP_URL}/recovery.`,
                );
            }
          }
          if (signupId && !response.ok) {
            // A downstream email failure can occur after the account exists. Never reissue that claim.
            await pool.query(
              `UPDATE public.pilot_invitations SET consumed_user=NULL,handle=NULL,claimed_at=NULL,adult_attested_at=NULL,rules_accepted_at=NULL
    WHERE consumed_user=$1 AND NOT EXISTS(SELECT 1 FROM public.auth_user WHERE id=$1)`,
              [signupId],
            );
          }
          return response;
        };
        const response = await handle();
        // The journal wrapper observes the committed database cursor. No R2
        // operation happens while this request holds SQL/advisory locks.
        await client.query("COMMIT");
        transaction = false;
        return response;
      } catch (error) {
        if (transaction) await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    };
    const response = proof?.journal
      ? await withPrivacyJournal(c.env, work)
      : await work();
    committedAndConfirmed = true;
    return response;
  } catch (error) {
    if (error instanceof AuthRejection)
      return c.json({ error: { code: error.code } }, error.status);
    if (error instanceof JournalError)
      return c.json(
        {
          error: {
            code: "PRIVACY_CHECKPOINT_REQUIRED",
            message:
              "The account change could not be safely confirmed. Please try again later.",
          },
        },
        503,
      );
    event("error", { code: "auth_failed", environment: c.env.ENVIRONMENT });
    return c.json(
      {
        error: {
          code: "AUTH_UNAVAILABLE",
          message:
            "Account services are temporarily unavailable. Please try again.",
        },
      },
      503,
    );
  } finally {
    // Reads and MFA/session-only operations cannot enqueue mail. Cron/queue
    // retries remain responsible for previously queued delivery failures.
    if (committedAndConfirmed && authMailRoutes.has(path))
      c.executionCtx.waitUntil(
        processAccountEmails(c.env).catch(() =>
          event("error", {
            code: "email_outbox_retry",
            environment: c.env.ENVIRONMENT,
          }),
        ),
      );
    c.executionCtx.waitUntil(physicalPool.end());
  }
});
