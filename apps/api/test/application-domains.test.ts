import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import type { Env, Variables } from '../src/types';

const database = vi.hoisted(() => ({ query: vi.fn(), end: vi.fn(), environments: [] as { APP_URL: string }[] }));
vi.mock('../src/auth', async importOriginal => ({
  ...await importOriginal<typeof import('../src/auth')>(),
  authPool: (env: Env) => { database.environments.push(env); return database; },
}));
import { app } from '../src/index';
import { applicationDomains } from '../src/application-domains';

const canonical = 'https://porchday.org', legacy = 'https://porchday.com';
const context = { waitUntil: (_promise: Promise<unknown>) => {}, passThroughOnException() {}, props: {} } as ExecutionContext;
function environment(extra: Partial<Env> = {}): Env {
  return {
    APP_URL: canonical, LEGACY_APP_URL: legacy, ENVIRONMENT: 'development',
    BETTER_AUTH_SECRET: 'synthetic-domain-test-only-'.repeat(3),
    ASSETS: { fetch: async (request: Request) => new Response(new URL(request.url).pathname) },
    ...extra,
  } as unknown as Env;
}
async function request(url: string, init: RequestInit = {}, env = environment()) {
  return app.fetch(new Request(url, init), env, context);
}

beforeEach(() => {
  database.environments.length = 0;
  database.query.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes('INSERT INTO public.auth_rate_limits')) return { rows: [{ count: 1 }] };
    if (sql.includes('FROM public.auth_user WHERE email=')) return { rows: [{
      id: '00000000-0000-4000-8000-000000000001', email: 'fixture@example.test', status: 'active',
    }] };
    if (sql.includes('FROM public.used_email_links')) return { rows: [{}], rowCount: 1 };
    throw new Error('Unexpected synthetic query');
  });
  database.end.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('canonical domain transition through the actual Worker routes', () => {
  it('redirects only legacy public GET/HEAD navigation, retaining path and query', async () => {
    for (const path of ['/', '/about', '/principles', '/contact', '/privacy', '/community', '/join', '/unknown-page']) {
      for (const method of ['GET', 'HEAD']) {
        const response = await request(legacy + path + '?view=plain', { method });
        expect(response.status).toBe(307);
        expect(response.headers.get('Location')).toBe(canonical + path + '?view=plain');
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      }
    }
    const response = await request(legacy + '/join?invite=synthetic#invite=fragment-only');
    expect(response.headers.get('Location')).toBe(canonical + '/join?invite=synthetic');
  });

  it('retains legacy account routes, installed shell assets and well-known responses', async () => {
    for (const path of ['/app', '/app/post/fixture', '/login', '/verify', '/forgot', '/reset',
      '/stolen-account', '/recovery', '/appeals', '/staff', '/staff/moderation', '/account-deletion',
      '/sw.js', '/manifest.webmanifest', '/app-shell', '/app-shell.html', '/index.html', '/assets/client.js',
      '/assets/openpgp/openpgp.mjs', '/fonts.css', '/color-scheme.js', '/fonts/font.woff2', '/icon-192-hash.png',
      '/logo.svg', '/wallpaper-checker.svg', '/third-party-notices.txt', '/source/client.tar.gz',
      '/.well-known/example']) {
      const response = await request(legacy + path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('Location'), path).toBeNull();
      expect(await response.text()).toBe(path);
    }
    expect((await request(legacy + '/app')).headers.get('X-Robots-Tag')).toBe('noindex');
    for (const shell of ['/app-shell', '/app-shell.html'])
      expect((await request(legacy + shell)).headers.get('X-Robots-Tag')).toBe('noindex');
    expect((await request(canonical + '/app')).headers.get('X-Robots-Tag')).toBeNull();
    expect((await request(legacy + '/health')).status).toBe(200);
    expect((await request(legacy + '/.well-known/apple-app-site-association')).status).toBe(404);
  });

  it('keeps exact same-origin mutation checks on both API hosts without CORS relaxation', async () => {
    for (const host of [canonical, legacy]) {
      const allowed = await request(host + '/api/unknown', { method: 'POST', headers: { Origin: host }, body: '{}' });
      expect(allowed.status).toBe(404);
      expect(allowed.headers.get('Access-Control-Allow-Origin')).toBeNull();
      for (const origin of [host === canonical ? legacy : canonical, 'https://untrusted.example', 'null', '']) {
        const denied = await request(host + '/api/unknown', { method: 'POST', headers: { Origin: origin }, body: '{}' });
        expect(denied.status).toBe(403);
        expect(await denied.json()).toMatchObject({ error: { code: 'ORIGIN_DENIED' } });
        expect(denied.headers.get('Location')).toBeNull();
      }
    }
    const notRedirected = await request(legacy + '/join', { method: 'POST', body: 'synthetic' });
    expect(notRedirected.status).toBe(404);
    expect(notRedirected.headers.get('Location')).toBeNull();
  });

  it('keeps the asset handler’s extensionless shell normalization on the legacy origin', async () => {
    const env = environment({ ASSETS: { fetch: async (incoming: Request) => {
      const path = new URL(incoming.url).pathname;
      return path === '/app-shell.html'
        ? new Response(null, { status: 307, headers: { Location: '/app-shell' } })
        : new Response('synthetic public shell', { headers: { 'Content-Type': 'text/html' } });
    } } as unknown as Fetcher });
    const normalized = await request(legacy + '/app-shell.html', {}, env);
    expect(normalized.status).toBe(307);
    const target = new URL(normalized.headers.get('Location')!, legacy);
    expect(target.href).toBe(legacy + '/app-shell');
    const shell = await request(target.href, {}, env);
    expect(shell.status).toBe(200);
    expect(shell.headers.get('Location')).toBeNull();
    expect(shell.headers.get('X-Robots-Tag')).toBe('noindex');
    expect(await shell.text()).toBe('synthetic public shell');
  });

  it('preserves old email callback validation and replay protection on the legacy auth endpoint', async () => {
    const env = environment();
    const token = await new SignJWT({ email: 'fixture@example.test' }).setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(env.BETTER_AUTH_SECRET));
    for (const host of [canonical, legacy]) {
      const link = new URL(host + '/api/auth/verify-email');
      link.searchParams.set('token', token);
      link.searchParams.set('callbackURL', host + '/login?verified=1');
      const response = await request(link.href, {}, env);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'LINK_ALREADY_USED' } });
      expect(database.environments.at(-1)?.APP_URL).toBe(host);
      for (const callback of [(host === canonical ? legacy : canonical) + '/login', 'https://untrusted.example/login']) {
        link.searchParams.set('callbackURL', callback);
        const denied = await request(link.href, {}, env);
        expect(await denied.json()).toMatchObject({ error: { code: 'INVALID_LINK' } });
      }
    }
    expect(env.APP_URL).toBe(canonical);
  });

  it('redirects exact www aliases but never forwards their mutation bodies', async () => {
    for (const host of ['https://www.porchday.org', 'https://www.porchday.com']) {
      for (const path of ['/app/post/fixture?view=all', '/api/auth/verify-email?token=synthetic', '/manifest.webmanifest']) {
        const response = await request(host + path);
        expect(response.status).toBe(307);
        expect(response.headers.get('Location')).toBe(canonical + path);
      }
      for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
        const response = await request(host + '/api/auth/sign-in/email', { method, body: 'synthetic' });
        expect(response.status).toBe(405);
        expect(response.headers.get('Location')).toBeNull();
        expect(response.headers.get('Allow')).toBe('GET, HEAD');
      }
    }
  });

  it('never derives trust or redirect authority from headers, unknown hosts or network paths', async () => {
    const headers = { Host: 'untrusted.example', 'X-Forwarded-Host': 'untrusted.example' };
    const response = await request(legacy + '//untrusted.example/path?next=https://elsewhere.example', { headers });
    expect(response.headers.get('Location')).toBe(canonical + '//untrusted.example/path?next=https://elsewhere.example');
    expect(new URL(response.headers.get('Location')!).origin).toBe(canonical);
    for (const host of ['https://untrusted.example', 'https://porchday.com.untrusted.example',
      'https://www.porchday.com.untrusted.example', 'http://untrusted.example', 'http://porchday.com:8443', 'https://porchday.com:8443']) {
      const denied = await request(host + '/app', { headers: { Host: 'porchday.com', 'X-Forwarded-Host': 'porchday.org' } });
      expect(denied.status).toBe(421);
      expect(denied.headers.get('Location')).toBeNull();
    }
  });

  it('upgrades known HTTP navigation without forwarding mutation bodies or stranding legacy keys', async () => {
    for (const [host, path, target] of [
      ['http://porchday.org', '/app', canonical],
      ['http://porchday.org:80', '/api/auth/verify-email', canonical],
      ['http://porchday.com', '/app', legacy],
      ['http://porchday.com', '/login', legacy],
      ['http://porchday.com', '/sw.js', legacy],
      ['http://porchday.com', '/join', canonical],
      ['http://porchday.com', '/about', canonical],
      ['http://www.porchday.com', '/app', canonical],
      ['http://www.porchday.org', '/api/auth/verify-email', canonical],
    ]) {
      for (const method of ['GET', 'HEAD']) {
        const response = await request(host + path + '?view=plain', { method });
        expect(response.status).toBe(307);
        expect(response.headers.get('Location')).toBe(target + path + '?view=plain');
        expect(response.headers.get('Cache-Control')).toBe('no-store');
      }
      const denied = await request(host + '/api/auth/sign-in/email', { method: 'POST', headers: { Origin: target }, body: 'synthetic' });
      expect(denied.status).toBe(405);
      expect(denied.headers.get('Location')).toBeNull();
    }
  });

  it('fails closed on malformed or overlapping configured origins', async () => {
    for (const legacyOrigin of ['', canonical, legacy + '/', legacy + '/app', legacy + '?x=1', legacy + '#x',
      'http://porchday.com', 'https://user:fixture@porchday.com', 'https://porchday.com:8443']) {
      const response = await request(canonical + '/', {}, environment({ LEGACY_APP_URL: legacyOrigin }));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: 'DOMAIN_CONFIGURATION_INVALID' } });
      expect(response.headers.get('Location')).toBeNull();
    }
    expect((await request(canonical + '/', {}, environment({ APP_URL: canonical + '/path' }))).status).toBe(503);
    expect((await request(canonical + '/', {}, environment({ LEGACY_APP_URL: 'https://www.porchday.org' }))).status).toBe(503);
    expect((await request(legacy + '/', {}, environment({ APP_URL: 'https://www.porchday.com' }))).status).toBe(503);
  });

  it('leaves staging and local proxy behavior unchanged when the feature is absent', async () => {
    const staging = environment({ APP_URL: 'https://staging.porchday.com', LEGACY_APP_URL: undefined, ENVIRONMENT: 'staging' });
    const response = await request('https://staging.porchday.com/', {}, staging);
    expect(response.status).toBe(200); expect(response.headers.get('Location')).toBeNull();
    expect(await response.text()).toBe('/');
    const dev = environment({ APP_URL: 'http://localhost:5173', LEGACY_APP_URL: undefined });
    expect((await request('http://localhost:8787/', {}, dev)).status).toBe(200);
    expect((await request('http://localhost:8787/api/unknown', { method: 'POST', headers: { Origin: dev.APP_URL } }, dev)).status).toBe(404);
  });
});

it('clones request bindings without changing shared bindings during concurrent requests', async () => {
  const env = Object.freeze(environment());
  let resume!: () => void;
  const wait = new Promise<void>(resolve => { resume = resolve; });
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const harness = new Hono<{ Bindings: Env; Variables: Variables }>();
  harness.use('*', applicationDomains);
  harness.get('/app/probe', async c => {
    if (new URL(c.req.url).origin === legacy) { started(); await wait; }
    return c.json({ origin: c.env.APP_URL, sameBindings: c.env === env, sameAssets: c.env.ASSETS === env.ASSETS });
  });
  const oldRequest = harness.request(legacy + '/app/probe', {}, env);
  await running;
  const newResponse = await harness.request(canonical + '/app/probe', {}, env);
  expect(await newResponse.json()).toEqual({ origin: canonical, sameBindings: true, sameAssets: true });
  resume();
  expect(await (await oldRequest).json()).toEqual({ origin: legacy, sameBindings: false, sameAssets: true });
  expect(env.APP_URL).toBe(canonical);
});
