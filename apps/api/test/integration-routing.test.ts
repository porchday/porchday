import { expect, test, vi } from 'vitest';
import type { Env } from '../src/types';

vi.mock('../src/privacy-journal', async importOriginal => ({
  ...await importOriginal<typeof import('../src/privacy-journal')>(),
  privacyReadGuard: async (_c: unknown, next: () => Promise<void>) => next(),
}));
import { app } from '../src/index';

test('actual versioned and legacy integration routes reach bearer validation without cookie or Origin authentication', async () => {
  const env = { ENVIRONMENT: 'production', APP_URL: 'https://porchday.test' } as Env;
  for (const prefix of ['/api/integration/v1', '/api/integration']) {
    const invalidExchange = await app.request(prefix + '/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, env);
    expect(invalidExchange.status).toBe(401);
    expect((await invalidExchange.json() as any).error.code).toBe('INVALID_GRANT');
    const missingBearer = await app.request(prefix + '/own/profile', {}, env);
    expect(missingBearer.status).toBe(401);
    expect((await missingBearer.json() as any).error.code).toBe('INVALID_GRANT');
    expect(missingBearer.headers.get('Cache-Control')).toBe('private, no-store');
    const write = await app.request(prefix + '/own/profile', { method: 'POST', headers: { Origin: env.APP_URL } }, env);
    expect(write.status).toBe(404);
  }
  const unsupported = await app.request('/api/integration/v2/own/profile', {}, env);
  expect(unsupported.status).toBe(404);
  const originProtected = await app.request('/api/v1/integrations/authorize', { method: 'POST', body: '{}' }, env);
  expect(originProtected.status).toBe(403);
  expect((await originProtected.json() as any).error.code).toBe('ORIGIN_DENIED');
});
