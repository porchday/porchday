import { Hono } from 'hono';
import { z } from 'zod';
import { fingerprint } from '@porchday/crypto';
import { authPool } from './auth';
import type { Env, Variables } from './types';
/** Mount only behind requireStaff('moderation'); SQL repeats the staff-role check. */
export function createModerationRoutes() {
    const app = new Hono<{
        Bindings: Env;
        Variables: Variables;
    }>();
    app.onError((error, c) => { const code = error.message; if (['STAFF_FORBIDDEN', 'STAFF_KEY_MISMATCH'].includes(code))
        return c.json({ error: { code, message: 'Staff authorization is required.' } }, 403); if (code === 'NOT_FOUND')
        return c.json({ error: { code, message: 'This report is unavailable.' } }, 404); if (['INDEPENDENT_REVIEW_REQUIRED', 'SECURITY_CASE_REQUIRED'].includes(code))
        return c.json({ error: { code, message: code === 'INDEPENDENT_REVIEW_REQUIRED' ? 'An independent moderator must review this appeal.' : 'Use the separate account-security recovery process.' } }, 409); return c.json({ error: { code: 'INVALID_MODERATION_REQUEST', message: 'Check the request and try again.' } }, 400); });
    app.use('*', async (c, next) => { if (!c.get('staffSubject') || !c.get('staffRoles')?.includes('moderation'))
        return c.json({ error: { code: 'STAFF_FORBIDDEN' } }, 403); c.header('Cache-Control', 'private, no-store'); await next(); });
    app.get('/keys', async (c) => { const pool = authPool(c.env); try {
        return c.json({ items: (await pool.query('select * from app.staff_moderator_keys($1)', [c.get('staffSubject')])).rows });
    }
    finally {
        c.executionCtx.waitUntil(pool.end());
    } });
    app.post('/keys', async (c) => { const b = z.object({ id: z.string().uuid(), member_id: z.string().uuid(), public_key: z.string().max(30000), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await c.req.json()); if (await fingerprint(b.public_key) !== b.fingerprint)
        throw Error('STAFF_KEY_MISMATCH'); const pool = authPool(c.env); try {
        await pool.query('select app.register_moderator_key($1,$2,$3,$4,$5)', [c.get('staffSubject'), b.id, b.member_id, b.public_key, b.fingerprint]);
        return c.json({ id: b.id }, 201);
    }
    finally {
        c.executionCtx.waitUntil(pool.end());
    } });
    app.delete('/keys/:id', async (c) => { const pool = authPool(c.env); try {
        await pool.query('select app.revoke_moderator_key($1,$2)', [c.get('staffSubject'), z.string().uuid().parse(c.req.param('id'))]);
        return c.json({ ok: true });
    }
    finally {
        c.executionCtx.waitUntil(pool.end());
    } });
    app.get('/reports', async (c) => { const state = z.enum(['received', 'reviewing', 'resolved', 'appealed']).optional().parse(c.req.query('state')); let before: {
        at: string;
        id: string;
    } | null = null; if (c.req.query('cursor'))
        before = z.object({ at: z.string().datetime(), id: z.string().uuid() }).parse(JSON.parse(atob(c.req.query('cursor')!))); const pool = authPool(c.env); try {
        const { rows } = await pool.query('select * from app.staff_reports($1,$2,$3,$4)', [c.get('staffSubject'), state ?? null, before?.at ?? null, before?.id ?? null]);
        const items = rows.slice(0, 50);
        const last = items.at(-1);
        return c.json({ items, next_cursor: rows.length > 50 && last ? btoa(JSON.stringify({ at: new Date(last.created_at).toISOString(), id: last.id })) : null });
    }
    finally {
        c.executionCtx.waitUntil(pool.end());
    } });
    app.get('/reports/:id', async (c) => { const pool = authPool(c.env); try {
        const { rows } = await pool.query('select app.staff_report($1,$2) as report', [c.get('staffSubject'), z.string().uuid().parse(c.req.param('id'))]);
        return c.json(rows[0].report);
    }
    finally {
        c.executionCtx.waitUntil(pool.end());
    } });
    app.get('/reports/:id/author-key', async (c) => { const pool = authPool(c.env); try {
        const { rows } = await pool.query('select app.report_author_key($1,$2) as key', [c.get('staffSubject'), z.string().uuid().parse(c.req.param('id'))]);
        return c.json(rows[0].key);
    }
    finally {
        c.executionCtx.waitUntil(pool.end());
    } });
    app.post('/reports/:id/actions', async (c) => { const b = z.object({ action: z.enum(['review', 'resolve', 'restrict', 'suspend', 'restore', 'remove_content']), reason_code: z.string().regex(/^[a-z_]{3,60}$/) }).parse(await c.req.json()); const pool = authPool(c.env); try {
        const { rows } = await pool.query('select app.moderate_report($1,$2,$3,$4) as id', [c.get('staffSubject'), z.string().uuid().parse(c.req.param('id')), b.action, b.reason_code]);
        return c.json({ id: rows[0].id });
    }
    finally {
        c.executionCtx.waitUntil(pool.end());
    } });
    return app;
}
/** Mount behind the restricted appeal-session middleware, not normal social access. */
export function createAppealRoutes() {
    const app = new Hono<{
        Bindings: Env;
        Variables: Variables;
    }>();
    app.onError((error, c) => c.json({ error: { code: error.message === 'APPEAL_PENDING' ? 'APPEAL_PENDING' : 'INVALID_APPEAL', message: error.message === 'APPEAL_PENDING' ? 'This action already has an open appeal.' : 'This appeal is unavailable.' } }, 400));
    app.get('/', async (c) => { const { withMember } = await import('./db'); return c.json(await withMember(c.env, c.get('memberId'), async (db) => ({ items: await db `select * from app.member_moderation_actions()` }))); });
    app.post('/', async (c) => { const { withMember } = await import('./db'); const b = z.object({ action_id: z.string().uuid() }).parse(await c.req.json()); return c.json(await withMember(c.env, c.get('memberId'), async (db) => { const [row] = await db `select app.submit_appeal(${b.action_id},null) as id`; return row; }), 201); });
    return app;
}
