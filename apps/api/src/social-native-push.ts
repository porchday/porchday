import { Hono, type Context } from "hono";
import { z } from "zod";
import postgres from "postgres";
import { importPKCS8, SignJWT } from "jose";
import type { Db } from "./db.js";
import type { Env, Variables } from "./types.js";

export type NativePushEnv = {
  APNS_TEAM_ID?: string;
  APNS_KEY_ID?: string;
  APNS_BUNDLE_ID?: string;
  APNS_PRIVATE_KEY?: string;
};
type C = Context<{ Bindings: Env; Variables: Variables }>;
type Dependencies = {
  tx<T>(c: C, fn: (db: Db) => Promise<T>): Promise<T>;
  body<T>(c: C, schema: z.ZodType<T>, maxBytes?: number): Promise<T>;
  fail(code: string, status?: 400 | 403 | 404 | 409 | 413 | 429): never;
  id(raw: string | undefined): string;
};
export const nativeSubscriptionSchema = z
  .object({
    // Apple does not promise a fixed device-token length. Bound input bytes, not a single model's length.
    token: z.string().regex(/^(?:[0-9a-f]{2}){32,100}$/),
    environment: z.enum(["production", "sandbox"]),
  })
  .strict();
type Subscription = z.infer<typeof nativeSubscriptionSchema>;

export function nativePushConfigured(env: NativePushEnv): boolean {
  return (
    /^[A-Z0-9]{10}$/.test(env.APNS_TEAM_ID || "") &&
    /^[A-Z0-9]{10}$/.test(env.APNS_KEY_ID || "") &&
    /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(env.APNS_BUNDLE_ID || "") &&
    (env.APNS_BUNDLE_ID?.length || 0) <= 255 &&
    !!env.APNS_PRIVATE_KEY?.startsWith("-----BEGIN PRIVATE KEY-----")
  );
}

export function registerNativePushRoutes(
  app: Hono<{ Bindings: Env; Variables: Variables }>,
  deps: Dependencies,
) {
  const { tx, body, fail, id } = deps;
  app.get("/native-push/config", (c) =>
    c.json({ enabled: nativePushConfigured(c.env) }),
  );
  app.get("/native-push/subscriptions", async (c) =>
    c.json({
      items: await tx(
        c,
        (db) => db`
    select id,environment,created_at,last_used_at,session_id=${c.get("sessionId")} as current_session
    from app.native_push_subscriptions order by created_at desc`,
      ),
    }),
  );
  app.post("/native-push/subscriptions", async (c) => {
    if (!nativePushConfigured(c.env)) fail("NATIVE_PUSH_NOT_CONFIGURED", 409);
    const input = await body(c, nativeSubscriptionSchema, 1024);
    if (!c.get("sessionId")) fail("UNAUTHORIZED", 403);
    try {
      return c.json(
        await tx(c, async (db) => {
          const [row] =
            await db`select app.register_native_push(${c.get("sessionId")},${input.token},${input.environment}) as id`;
          return { id: row.id };
        }),
        201,
      );
    } catch (error) {
      const code = (error as Error).message;
      if (
        ["NATIVE_PUSH_TOKEN_IN_USE", "NATIVE_PUSH_DEVICE_LIMIT"].includes(code)
      )
        fail(code, 409);
      throw error;
    }
  });
  app.delete("/native-push/subscriptions/:id", async (c) =>
    c.json(
      await tx(c, async (db) => {
        await db`delete from app.native_push_subscriptions where id=${id(c.req.param("id"))}`;
        return { ok: true };
      }),
    ),
  );
  app.delete("/native-push/subscriptions", async (c) =>
    c.json(
      await tx(c, async (db) => {
        // Turning off native delivery does not silently opt a browser out of Web Push.
        await db`delete from app.native_push_subscriptions where member_id=${c.get("memberId")}`;
        return { ok: true };
      }),
    ),
  );
}

/** Apple receives a generic update only, never social identifiers or private content. */
export const GENERIC_NATIVE_PAYLOAD = JSON.stringify({
  aps: { alert: { title: "Porchday", body: "You have a new update" } },
});

export async function signNativeProviderToken(
  env: NativePushEnv,
  now = Date.now(),
): Promise<string> {
  if (!nativePushConfigured(env)) throw new Error("NATIVE_PUSH_NOT_CONFIGURED");
  const key = await importPKCS8(env.APNS_PRIVATE_KEY!, "ES256");
  return new SignJWT({ iss: env.APNS_TEAM_ID!, iat: Math.floor(now / 1000) })
    .setProtectedHeader({ alg: "ES256", kid: env.APNS_KEY_ID!, typ: "JWT" })
    .sign(key);
}

export function nativePushRequest(
  subscription: Subscription,
  env: NativePushEnv,
  providerToken: string,
) {
  const input = nativeSubscriptionSchema.parse(subscription);
  if (!nativePushConfigured(env)) throw new Error("NATIVE_PUSH_NOT_CONFIGURED");
  const host =
    input.environment === "sandbox"
      ? "api.sandbox.push.apple.com"
      : "api.push.apple.com";
  return {
    url: `https://${host}/3/device/${input.token}`,
    init: {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: {
        authorization: `bearer ${providerToken}`,
        "content-type": "application/json",
        "apns-topic": env.APNS_BUNDLE_ID!,
        "apns-push-type": "alert",
        "apns-priority": "5",
        "apns-expiration": "0",
        "apns-collapse-id": "porchday-update",
      },
      body: GENERIC_NATIVE_PAYLOAD,
    } satisfies RequestInit,
  };
}

/** Read only a bounded, known provider error code; never expose or log response bodies. */
async function providerReason(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  try {
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 1024) return null;
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const result = JSON.parse(new TextDecoder().decode(bytes));
    return typeof result.reason === "string" &&
      /^[A-Za-z]{1,60}$/.test(result.reason)
      ? result.reason
      : null;
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function nativePushOutcome(
  response: Response,
  attempts: number,
  now = Date.now(),
) {
  let outcome: "sent" | "gone" | "retry" | "failed" = "failed";
  let delay = Math.min(3600, 15 * 2 ** Math.min(attempts, 8));
  // Never follow Location or interpret a redirect body as an APNs token failure.
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return { outcome, delay };
  }
  if (response.status === 200) {
    await response.body?.cancel();
    return { outcome: "sent" as const, delay };
  }
  const reason = await providerReason(response);
  if (
    response.status === 410 ||
    [
      "BadDeviceToken",
      "DeviceTokenNotForTopic",
      "ExpiredToken",
      "Unregistered",
    ].includes(reason || "")
  )
    outcome = "gone";
  else if (reason === "Forbidden" || reason === "PayloadTooLarge")
    outcome = "failed";
  else if (
    response.status === 429 ||
    response.status >= 500 ||
    response.status === 403
  ) {
    outcome = "retry";
    // Apple recommends waiting 15 minutes before retrying a 5xx response.
    if (
      response.status >= 500 ||
      response.status === 403 ||
      reason === "TooManyProviderTokenUpdates"
    )
      delay = Math.max(delay, 900);
    const retryAfter = response.headers.get("Retry-After");
    const seconds =
      retryAfter && /^\d+$/.test(retryAfter)
        ? Number(retryAfter)
        : retryAfter
          ? (Date.parse(retryAfter) - now) / 1000
          : 0;
    if (Number.isFinite(seconds))
      delay = Math.min(3600, Math.max(delay, Math.ceil(seconds)));
  }
  return { outcome, delay };
}

async function providerToken(sql: postgres.Sql, env: NativePushEnv) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([env.APNS_TEAM_ID, env.APNS_KEY_ID, env.APNS_PRIVATE_KEY]),
    ),
  );
  const key = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const [cached] =
    await sql`select app.native_provider_token(${key},NULL) as token`;
  if (cached?.token) return cached.token as string;
  const signed = await signNativeProviderToken(env);
  const [saved] =
    await sql`select app.native_provider_token(${key},${signed}) as token`;
  return saved.token as string;
}

/** Jobs role only. Every attempt repeats notification, recipient, session and content-access checks. */
export async function processNativePush(
  env: Pick<Env, "HYPERDRIVE_JOBS"> & NativePushEnv,
  send: typeof fetch = fetch,
) {
  const counts = { sent: 0, retried: 0, skipped: 0 };
  if (!nativePushConfigured(env)) return counts;
  const sql = postgres(env.HYPERDRIVE_JOBS.connectionString, {
    max: 1,
    prepare: false,
    fetch_types: false,
    connect_timeout: 10,
  });
  try {
    const jobs = await sql`select * from app.claim_native_push(20)`;
    if (!jobs.length) return counts;
    const token = await providerToken(sql, env);
    for (let offset = 0; offset < jobs.length; offset += 4) {
      await Promise.all(
        jobs.slice(offset, offset + 4).map(async (job) => {
          const [row] =
            await sql`select app.prepare_native_push(${job.id},${job.lease}) as subscription`;
          if (!row?.subscription) {
            counts.skipped++;
            return;
          }
          let result: Awaited<ReturnType<typeof nativePushOutcome>> = {
            outcome: "retry",
            delay: Math.min(3600, 15 * 2 ** Math.min(Number(job.attempts), 8)),
          };
          try {
            const request = nativePushRequest(row.subscription, env, token);
            result = await nativePushOutcome(
              await send(request.url, request.init),
              Number(job.attempts),
            );
          } catch {
            /* Network failures retry under a lease, with no token-bearing errors logged. */
          }
          await sql`select app.finish_native_push(${job.id},${job.lease},${result.outcome},${result.delay})`;
          if (result.outcome === "sent") counts.sent++;
          else if (result.outcome === "retry") counts.retried++;
          else counts.skipped++;
        }),
      );
    }
    return counts;
  } finally {
    await sql.end({ timeout: 1 });
  }
}
