import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env, Variables } from '../src/types';
const db = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn(), hash: vi.fn() }));
vi.mock('../src/auth', () => ({ authPool: () => db, hashToken: db.hash, createAuth: vi.fn() }));
import { authRoutes } from '../src/auth-routes';
const token = 'synthetic-invitation-token-for-policy';
beforeEach(() => {
  db.query.mockReset().mockResolvedValueOnce({ rows: [{ count: 1 }] }).mockResolvedValue({ rowCount: 1, rows: [{}] });
  db.end.mockReset().mockResolvedValue(undefined);
  db.hash.mockReset().mockResolvedValue('synthetic-hash');
});
async function request(body: unknown, origin = 'https://example.test', method = 'POST') {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.route('/api/auth', authRoutes);
  const pending: Promise<unknown>[] = [];
  const result = await app.fetch(new Request('https://example.test/api/auth/invitation-policy', {
    method, headers: { Origin: origin, 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  }), { APP_URL: 'https://example.test', BETTER_AUTH_SECRET: 'test' } as Env,
  { waitUntil(p: Promise<unknown>) { pending.push(p); } } as ExecutionContext);
  await Promise.all(pending);
  return result;
}
it('checks an unconsumed unexpired invitation without consuming it or creating a session', async () => {
  const response = await request({ inviteCode: token });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ accepted: true });
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(db.query.mock.calls[1][0]).toContain('consumed_user IS NULL AND expires_at>now()');
  expect(db.query.mock.calls[1][0]).toMatch(/^SELECT/);
  expect(db.query).toHaveBeenCalledTimes(2);
  expect(db.end).toHaveBeenCalledOnce();
});
it('rejects a missing, expired or consumed invitation', async () => {
  db.query.mockReset().mockResolvedValueOnce({ rows: [{ count: 1 }] }).mockResolvedValue({ rowCount: 0, rows: [] });
  expect((await request({ inviteCode: token })).status).toBe(403);
});
it.each([{}, { inviteCode: '' }, { inviteCode: 'bad token' }])('rejects malformed requests before invitation lookup: %j', async body => {
  expect((await request(body)).status).toBe(403);
  expect(db.query).toHaveBeenCalledTimes(1);
});
it('preserves same-origin checks and rate limiting', async () => {
  expect((await request({ inviteCode: token }, 'https://other.test')).status).toBe(403);
  expect(db.query).toHaveBeenCalledTimes(1);
  db.query.mockReset().mockResolvedValue({ rows: [{ count: 11 }] });
  expect((await request({ inviteCode: token })).status).toBe(429);
  expect(db.query).toHaveBeenCalledTimes(1);
});
it('does not accept token-bearing GET URLs', async () => {
  expect((await request({}, 'https://example.test', 'GET')).status).toBe(405);
  expect(db.query).not.toHaveBeenCalled();
});

it('returns connection/history context only when requested, with no recipient identity', async () => {
  db.query.mockReset().mockResolvedValueOnce({ rows: [{ count: 1 }] }).mockResolvedValue({rowCount:1,rows:[{connection_kind:'family',connection_history:'future',expires_at:'2026-12-01T00:00:00Z'}]});
  expect(await (await request({inviteCode:token,details:true})).json()).toEqual({accepted:true,kind:'family',history:'future',expiresAt:'2026-12-01T00:00:00Z'});
});
