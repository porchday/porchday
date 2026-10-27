import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import type { Env, Variables } from '../src/types';
import { incidentControls } from '../src/incident-controls';

const mutations = vi.hoisted(() => ({ journal: vi.fn() }));
vi.mock('../src/session', async importOriginal => ({
  ...await importOriginal<typeof import('../src/session')>(),
  requireMember: async (c: any, next: () => Promise<void>) => {
    if (c.req.header('X-Test-Member') !== 'synthetic') return c.json({ error: { code: 'UNAUTHORIZED' } }, 401);
    await next();
  },
}));
vi.mock('../src/privacy-journal', async importOriginal => ({
  ...await importOriginal<typeof import('../src/privacy-journal')>(),
  privacyReadGuard: async (_c: unknown, next: () => Promise<void>) => next(),
  privacyMutationMiddleware: async (_c: unknown, next: () => Promise<void>) => { mutations.journal(); await next(); },
}));
import { app as actualApp } from '../src/index';

const origin = 'https://porchday.test';
const allPaused = { APP_URL: origin, ENVIRONMENT: 'production', CONTENT_WRITES_PAUSED: 'true', MEDIA_UPLOADS_PAUSED: 'true', SOCIAL_INVITATIONS_PAUSED: 'true' } as Env;
const pausedRoutes: [keyof Env, string, string, string][] = [
  ['MEDIA_UPLOADS_PAUSED', 'POST', '/media', 'UPLOADS_PAUSED'],
  ['MEDIA_UPLOADS_PAUSED', 'PUT', '/media/11111111-1111-4111-8111-111111111111/bytes', 'UPLOADS_PAUSED'],
  ['SOCIAL_INVITATIONS_PAUSED', 'POST', '/connections/requests', 'INVITATIONS_PAUSED'],
  ['SOCIAL_INVITATIONS_PAUSED', 'POST', '/platform-invitations', 'INVITATIONS_PAUSED'],
  ['SOCIAL_INVITATIONS_PAUSED', 'POST', '/connections/requests/request/accept', 'INVITATIONS_PAUSED'],
  ['SOCIAL_INVITATIONS_PAUSED', 'POST', '/groups/group/invitations', 'INVITATIONS_PAUSED'],
  ['SOCIAL_INVITATIONS_PAUSED', 'POST', '/group-invitations/invitation/accept', 'INVITATIONS_PAUSED'],
  ['CONTENT_WRITES_PAUSED', 'PUT', '/profiles/me', 'POSTING_PAUSED'],
  ['CONTENT_WRITES_PAUSED', 'PUT', '/emoji-library', 'POSTING_PAUSED'],
  ['CONTENT_WRITES_PAUSED', 'POST', '/posts', 'POSTING_PAUSED'],
  ['CONTENT_WRITES_PAUSED', 'POST', '/posts/post/comments', 'POSTING_PAUSED'],
  ['CONTENT_WRITES_PAUSED', 'POST', '/posts/post/reshare', 'POSTING_PAUSED'],
  ['CONTENT_WRITES_PAUSED', 'POST', '/posts/post/audience-refresh', 'POSTING_PAUSED'],
  ['CONTENT_WRITES_PAUSED', 'PUT', '/connections/connection/history', 'POSTING_PAUSED'],
  ['CONTENT_WRITES_PAUSED', 'PUT', '/posts/post', 'POSTING_PAUSED'],
  ['CONTENT_WRITES_PAUSED', 'PUT', '/comments/comment', 'POSTING_PAUSED'],
  ['CONTENT_WRITES_PAUSED', 'PUT', '/posts/post/reactions/tag', 'POSTING_PAUSED'],
  ['CONTENT_WRITES_PAUSED', 'PUT', '/comments/comment/reactions/tag', 'POSTING_PAUSED'],
  ['CONTENT_WRITES_PAUSED', 'POST', '/groups', 'POSTING_PAUSED'],
  ['CONTENT_WRITES_PAUSED', 'PUT', '/groups/group', 'POSTING_PAUSED'],
  ['CONTENT_WRITES_PAUSED', 'PUT', '/media/media/attachment', 'POSTING_PAUSED'],
  ['CONTENT_WRITES_PAUSED', 'POST', '/imports', 'POSTING_PAUSED'],
];

test('actual API authenticates first and pauses every publishing path before the mutation journal or handlers', async () => {
  mutations.journal.mockClear();
  for (const [, method, path, code] of pausedRoutes) {
    const response = await actualApp.request(origin + '/api/v1' + path, { method, headers: { Origin: origin, 'X-Test-Member': 'synthetic' }, body: '{}' }, allPaused);
    expect(response.status, path).toBe(503);
    expect((await response.json() as any).error.code, path).toBe(code);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  }
  const anonymous = await actualApp.request(origin + '/api/v1/posts', { method: 'POST', headers: { Origin: origin }, body: '{}' }, allPaused);
  expect(anonymous.status).toBe(401);
  expect(mutations.journal).not.toHaveBeenCalled();
});

test('selective pauses do not consume bodies or prevent other writes reaching their normal authorization', async () => {
  const downstream = vi.fn();
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', incidentControls);
  app.all('*', c => { downstream(); return c.json({ body: c.req.raw.bodyUsed ? 'consumed' : 'unread' }); });
  for (const [flag, method, path] of pausedRoutes) {
    const request = new Request(origin + '/api/v1' + path, { method, body: 'synthetic private draft' });
    const active = { [flag]: 'true' } as unknown as Env;
    const blocked = await app.fetch(request, active);
    expect(blocked.status).toBe(503);
    expect(request.bodyUsed).toBe(false);
    const otherFlags = { ...allPaused, [flag]: 'false' };
    const allowed = await app.request('/api/v1' + path, { method, body: '{}' }, otherFlags);
    expect(allowed.status, path).toBe(200);
    expect(await allowed.json()).toEqual({ body: 'unread' });
  }
  expect(downstream).toHaveBeenCalledTimes(pausedRoutes.length);
});

test('all pauses preserve reads, deletion, safety, ownership transfer, keys and export handlers', async () => {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('*', incidentControls);
  // A downstream deny proves the pause does not grant access or replace normal checks.
  app.all('*', c => c.json({ error: { code: 'NORMAL_AUTHORIZATION' } }, 403));
  const preserved: [string, string][] = [
    ...['/feed', '/posts/post', '/media/media/bytes'].map(path => ['GET', '/api/v1' + path] as [string, string]),
    ...['/account', '/posts/post', '/comments/comment', '/media/media', '/groups/group', '/connections/member', '/posts/post/reactions/tag', '/integrations/grant'].map(path => ['DELETE', '/api/v1' + path] as [string, string]),
    ['POST', '/api/v1/connections/requests/request/decline'], ['PUT', '/api/v1/groups/group/members/member'],
    ['PUT', '/api/v1/blocks/member'], ['PUT', '/api/v1/mutes/member'], ['POST', '/api/v1/reports'],
    ['POST', '/api/v1/exports'], ['POST', '/api/v1/exports/export/validate'], ['POST', '/api/v1/devices/challenge'],
    ['POST', '/api/v1/devices'], ['PUT', '/api/v1/keys/backup'], ['PATCH', '/api/v1/me'],
    ['POST', '/api/account-recovery/reports'], ['POST', '/api/member-appeals'],
  ];
  for (const [method, path] of preserved) {
    const response = await app.request(path, { method }, allPaused);
    expect(response.status, path).toBe(403);
    expect(await response.json()).toEqual({ error: { code: 'NORMAL_AUTHORIZATION' } });
    expect(response.headers.get('Retry-After')).toBeNull();
  }
});
