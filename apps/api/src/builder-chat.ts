import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import postgres from 'postgres';
import { z } from 'zod';
import { withMember } from './db';
import { authPool } from './auth';
import type { Env, Variables } from './types';

/** See design/builder-chat.md. Raise the version when the disclosure text changes. */
export const BUILDER_CHAT = {
  disclosureVersion: 1,
  messageLength: 2000,
  dailyMessages: 100,
  queueLength: 20,
  turnSeconds: 600,
  onlineSeconds: 30,
} as const;
const PROGRESS = ['reading', 'editing', 'testing', 'committing', 'working'] as const;
type C = Context<{ Bindings: Env; Variables: Variables }>;

/** Anything other than an explicit 'false' keeps builder chat paused. */
export const builderChatPaused = (env: Pick<Env, 'BUILDER_CHAT_PAUSED'>) => env.BUILDER_CHAT_PAUSED !== 'false';

const errors: Record<string, [number, string]> = {
  NOT_FOUND: [404, ''],
  FORBIDDEN: [403, 'This account cannot send builder chat messages right now.'],
  DISCLOSURE_REQUIRED: [409, 'Read and accept the builder chat notice first.'],
  INVALID_MESSAGE: [400, 'Write a message of up to 2,000 characters.'],
  IN_FLIGHT: [409, 'Wait for Codex to answer your current message before sending another.'],
  DAILY_LIMIT: [429, `You can send up to ${BUILDER_CHAT.dailyMessages} builder chat messages a day. Please try again tomorrow.`],
  QUEUE_FULL: [429, 'Codex is busy, try again later.'],
  BUILDER_CHAT_PAUSED: [503, 'Builder chat is paused by the Porchday team.'],
};
class BuilderChatError extends Error {}
function fail(c: C, code: string) {
  const [status, message] = errors[code];
  if (code === 'BUILDER_CHAT_PAUSED') c.header('Retry-After', '300');
  return c.json({ error: message ? { code, message } : { code } }, status as 400);
}
const knownCode = (error: unknown) => {
  const text = error instanceof Error ? error.message : '';
  return Object.hasOwn(errors, text) ? text : null;
};

const memberLimit = bodyLimit({ maxSize: 8192, onError: c => c.json({ error: { code: 'INVALID_MESSAGE', message: errors.INVALID_MESSAGE[1] } }, 400) });
const messageInput = z.object({ message: z.string().max(BUILDER_CHAT.messageLength) }).strict();
const disclosureInput = z.object({ version: z.literal(BUILDER_CHAT.disclosureVersion) }).strict();

async function state(c: C) {
  const [row] = await withMember(c.env, c.get('memberId'), db => db`select app.builder_chat_state() as state`);
  return row.state as null | { disclosure_version: number | null; bridge_seen_at: string | null; bridge_activity?: string; ahead: number; sent_today: number; messages: unknown[] };
}

/** Mounted under /api/v1 after member authentication. Members who are not on
 * the allowlist receive 404 from every route, including during a pause. */
export function createBuilderChatRoutes() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('/builder-chat/*', memberLimit);
  app.onError((error, c) => {
    const code = knownCode(error);
    if (code) return fail(c, code);
    // Before migration 050 is applied the feature does not exist yet. Answer
    // like any other unavailable page instead of adding 503s for every member.
    if ((error as { code?: string }).code === '42883') return fail(c, 'NOT_FOUND');
    if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof BuilderChatError) return fail(c, 'INVALID_MESSAGE');
    throw error;
  });
  app.get('/builder-chat', async c => {
    const value = await state(c);
    if (!value) return fail(c, 'NOT_FOUND');
    const seen = value.bridge_seen_at ? Date.parse(value.bridge_seen_at) : 0;
    return c.json({
      activity: Date.now() - seen < BUILDER_CHAT.onlineSeconds * 1000 ? value.bridge_activity ?? 'unknown' : 'offline',
      paused: builderChatPaused(c.env),
      online: Date.now() - seen < BUILDER_CHAT.onlineSeconds * 1000,
      disclosure: { version: BUILDER_CHAT.disclosureVersion, accepted: (value.disclosure_version ?? 0) >= BUILDER_CHAT.disclosureVersion },
      ahead: Number(value.ahead),
      sent_today: Number(value.sent_today),
      limits: { message_length: BUILDER_CHAT.messageLength, daily_messages: BUILDER_CHAT.dailyMessages },
      messages: value.messages,
    });
  });
  app.post('/builder-chat/disclosure', async c => {
    const { version } = disclosureInput.parse(await c.req.json());
    await withMember(c.env, c.get('memberId'), db => db`select app.builder_chat_accept(${version})`);
    return c.json({ ok: true });
  });
  app.post('/builder-chat/messages', async c => {
    if (builderChatPaused(c.env)) return fail(c, (await state(c)) ? 'BUILDER_CHAT_PAUSED' : 'NOT_FOUND');
    const { message } = messageInput.parse(await c.req.json());
    if (!message.trim()) throw new BuilderChatError();
    const [row] = await withMember(c.env, c.get('memberId'), db =>
      db`select app.builder_chat_send(${message},${BUILDER_CHAT.disclosureVersion},${BUILDER_CHAT.dailyMessages},${BUILDER_CHAT.queueLength}) as id`);
    return c.json({ id: row.id }, 201);
  });
  app.get('/builder-chat/export', async c => {
    const [row] = await withMember(c.env, c.get('memberId'), db => db`select app.builder_chat_export() as value`);
    if (!row.value) return fail(c, 'NOT_FOUND');
    c.header('Content-Disposition', 'attachment; filename="porchday-builder-chat.json"');
    return c.json(row.value);
  });
  return app;
}

async function digest(value: string) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}
/** Constant-time comparison of digests, so timing does not reveal the token. */
export async function bridgeTokenMatches(presented: string, expected: string | undefined) {
  if (!expected || expected.length < 32 || !presented) return false;
  const [a, b] = await Promise.all([digest(presented), digest(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}
const requireBridge = createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  // Without a configured token the bridge surface does not exist.
  if (!c.env.BUILDER_BRIDGE_TOKEN) return c.json({ error: { code: 'NOT_FOUND' } }, 404);
  if (!(await bridgeTokenMatches(token, c.env.BUILDER_BRIDGE_TOKEN))) return c.json({ error: { code: 'BRIDGE_AUTH_REQUIRED' } }, 401);
  await next();
});
async function jobs<T>(env: Env, work: (sql: postgres.Sql) => Promise<T>) {
  const sql = postgres(env.HYPERDRIVE_JOBS.connectionString, { max: 1, prepare: true, fetch_types: false, idle_timeout: 5, connect_timeout: 10 });
  try { return await work(sql); } finally { await sql.end({ timeout: 1 }); }
}
const commitHash = z.string().regex(/^[0-9a-f]{7,40}$/);
const claimInput = z.object({ take: z.boolean(), waiting_on: z.enum(['request_file', 'other_work']).default('other_work') }).strict();
const progressInput = z.object({ reply: z.string().max(20000), progress: z.enum(PROGRESS).nullable() }).strict();
const finishInput = z.object({
  status: z.enum(['answered', 'timed_out', 'failed']),
  reply: z.string().max(20000),
  commits: z.array(commitHash).max(50),
  held_back: z.array(z.string().regex(/^[a-z0-9_]{1,40}$/)).max(20),
}).strict();

/** Mounted at /api/builder-bridge, outside cookie authentication. Only the
 * bridge on the builder machine holds the token. */
export function createBuilderBridgeRoutes() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', bodyLimit({ maxSize: 65536, onError: c => c.json({ error: { code: 'TOO_LARGE' } }, 413) }));
  app.use('*', requireBridge);
  app.onError((error, c) => {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: { code: 'INVALID_REQUEST' } }, 400);
    throw error;
  });
  app.get('/status', c => c.json({ paused: builderChatPaused(c.env), environment: c.env.ENVIRONMENT }));
  // {take:false} only records that the bridge is connected.
  app.post('/claim', async c => {
    const { take, waiting_on } = claimInput.parse(await c.req.json());
    const paused = builderChatPaused(c.env);
    const [row] = await jobs(c.env, sql => sql`select app.builder_chat_poll(${BUILDER_CHAT.turnSeconds},${take && !paused},${waiting_on}) as message`);
    return c.json({ paused, message: row.message ?? null, turn_seconds: BUILDER_CHAT.turnSeconds });
  });
  app.post('/messages/:id/progress', async c => {
    const id = z.uuid().parse(c.req.param('id'));
    const body = progressInput.parse(await c.req.json());
    // A pause stops new turns; a turn already running finishes normally.
    const [row] = await jobs(c.env, sql => sql`select app.builder_chat_progress(${id},${body.reply},${body.progress}) as value`);
    return c.json({ continue: row.value === true });
  });
  app.post('/messages/:id/finish', async c => {
    const id = z.uuid().parse(c.req.param('id'));
    const body = finishInput.parse(await c.req.json());
    const [row] = await jobs(c.env, sql => sql`select app.builder_chat_finish(${id},${body.status},${body.reply},
      array(select jsonb_array_elements_text(${sql.json(body.commits)})),array(select jsonb_array_elements_text(${sql.json(body.held_back)}))) as value`);
    return c.json({ recorded: row.value === true });
  });
  return app;
}

/** Read-only operator view, behind Cloudflare Access and the builder_chat role. */
export function createStaffBuilderChatRoutes() {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.get('/', async c => {
    const pool = authPool(c.env);
    try {
      const { rows } = await pool.query('SELECT app.builder_chat_staff_view($1) AS value', [c.get('staffSubject')]);
      return c.json({ paused: builderChatPaused(c.env), ...rows[0].value });
    } finally { c.executionCtx.waitUntil(pool.end()); }
  });
  return app;
}
