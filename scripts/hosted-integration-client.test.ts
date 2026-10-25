import { describe, it, expect } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { assertOwnedPage, authorizeURL, classifyMutation, createPKCE, openCallback, parseTokenPair,
  integrationScopes, performUIAction, type IntegrationBoundary } from './hosted-integration-client-support.js';

function boundary(): IntegrationBoundary {
  const pkce = createPKCE();
  return { ...pkce, name: 'Synthetic client', purpose: 'Own ciphertext test', redirect: 'http://127.0.0.1:49321/callback',
    clientId: randomUUID(), grantIds: new Set([randomUUID()]), registrationStarted: false, consentStarted: false };
}
function ownPage(member: string) {
  return { posts: [{ id: randomUUID(), author_id: member, envelope: { v: 1, protocol: 'porchday-openpgp-v1',
    context: { authorId: member }, recipients: [{ memberId: member }], ciphertext: '-----BEGIN PGP MESSAGE-----\nsynthetic' } }], next_cursor: null };
}

describe('Hosted integration runner safety', () => {
  it('settles a pending response after early click failure and discards both raw diagnostics', async () => {
    let settled = false;
    const response = new Promise<never>((_, reject) => setTimeout(() => { settled = true; reject(Error('private callback URL')); }, 10));
    await expect(performUIAction(response, async () => { throw Error('private field value'); })).rejects.toThrow('UI_ACTION_FAILED');
    expect(settled).toBe(true);
    await expect(performUIAction(Promise.reject(Error('private provider body')), async () => {})).rejects.toThrow('UI_RESPONSE_FAILED');
    await expect(performUIAction(Promise.resolve('safe result'), async () => {})).resolves.toBe('safe result');
  });
  it('refuses missing, extra and wrong-account arguments before fixture, browser or network access', () => {
    for (const args of [[], ['--run'], ['--run', '--attempt=12345678', '--account=B'], ['--run', '--attempt=../../private']]) {
      const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/hosted-integration-client.ts', ...args], {
        encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH },
      });
      expect(r.status).toBe(1); expect(r.stdout).toBe('');
      expect(r.stderr).toContain('EXPLICIT_INTEGRATION_ATTEMPT_REQUIRED');
      expect(r.stderr).not.toMatch(/password|recoverySecret|https:| at /);
    }
  });
  it('uses S256 with independent random state, excludes the verifier from the browser URL and permits only exact loopback callbacks', () => {
    const pkce = createPKCE(), other = createPKCE();
    expect(pkce.challenge).toBe(createHash('sha256').update(pkce.verifier).digest('base64url'));
    expect(pkce.state).not.toBe(other.state); expect(pkce.state).not.toBe(pkce.verifier);
    const url = new URL(authorizeURL(randomUUID(), 'http://127.0.0.1:49321/callback', pkce));
    expect(url.searchParams.get('scope')).toBe('profile:read content:read');
    expect(url.href).not.toContain(pkce.verifier);
    for (const uri of ['http://localhost:49321/callback', 'https://evil.invalid/callback',
      'http://127.0.0.1/callback', 'http://127.0.0.1:49321/callback?other=1', 'http://user@127.0.0.1:49321/callback']) {
      expect(() => authorizeURL(randomUUID(), uri, pkce)).toThrow('LOOPBACK_CALLBACK_REQUIRED');
    }
  });
  it('the real loopback receiver rejects bad state, duplicate parameters, hostile Host and replay, then clears the callback URL', async () => {
    const pkce = createPKCE(), code = createPKCE().state, callback = await openCallback(pkce.state);
    try {
      const send = (query: string, headers?: Record<string, string>) => fetch(callback.redirect + query, { redirect: 'manual', headers });
      expect((await send(`?code=${code}&state=${createPKCE().state}`)).status).toBe(400);
      expect((await send(`?code=${code}&state=${pkce.state}&state=${pkce.state}`)).status).toBe(400);
      const hostileHostStatus = await new Promise<number>((resolve, reject) => {
        const req = request(callback.redirect + `?code=${code}&state=${pkce.state}`, { headers: { Host: 'evil.invalid' } },
          response => { response.resume(); resolve(response.statusCode!); });
        req.on('error', reject); req.end();
      });
      expect(hostileHostStatus).toBe(400);
      expect((await fetch(callback.redirect, { method: 'POST', body: 'sensitive', redirect: 'manual' })).status).toBe(400);
      expect(callback.hasCode()).toBe(false);
      const response = await send(`?code=${code}&state=${pkce.state}`);
      expect(response.status).toBe(303); expect(response.headers.get('location')).toBe('/complete');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(await response.text()).toBe(''); expect(await callback.waitForCode()).toBe(code);
      const complete = await fetch(callback.origin + '/complete');
      expect(complete.status).toBe(200); expect(await complete.text()).not.toMatch(new RegExp(code + '|' + pkce.state));
      expect((await send(`?code=${code}&state=${pkce.state}`)).status).toBe(400);
    } finally { await callback.close(); }
  });
  it('gates registration and consent to one exact client, exact scopes, exact PKCE and no extra fields', () => {
    const b = boundary();
    const registration = { name: b.name, purpose: b.purpose, redirect_uri: b.redirect };
    expect(classifyMutation('POST', '/api/v1/integrations/clients', registration, b)).toBe('register');
    expect(() => classifyMutation('POST', '/api/v1/integrations/clients', { ...registration, redirect_uri: 'https://evil.invalid' }, b)).toThrow();
    b.registrationStarted = true;
    expect(() => classifyMutation('POST', '/api/v1/integrations/clients', registration, b)).toThrow('REGISTRATION_BOUNDARY');
    const body = { client_id: b.clientId, redirect_uri: b.redirect, scope: [...integrationScopes],
      code_challenge: b.challenge, code_challenge_method: 'S256', state: b.state, consent: true };
    expect(classifyMutation('POST', '/api/v1/integrations/authorize', body, b)).toBe('consent');
    for (const edit of [{ scope: ['profile:read', 'media:read'] }, { client_id: randomUUID() },
      { code_challenge_method: 'plain' }, { state: createPKCE().state }, { consent: false }, { extra: 'value' }]) {
      expect(() => classifyMutation('POST', '/api/v1/integrations/authorize', { ...body, ...edit }, b)).toThrow('CONSENT_BOUNDARY');
    }
    b.consentStarted = true;
    expect(() => classifyMutation('POST', '/api/v1/integrations/authorize', body, b)).toThrow('CONSENT_BOUNDARY');
  });
  it('allows revoking only captured grants and refuses all content, key, profile, relationship and account writes', () => {
    const b = boundary(), grant = [...b.grantIds][0];
    expect(classifyMutation('DELETE', '/api/v1/integrations/' + grant, undefined, b)).toBe('revoke');
    expect(() => classifyMutation('DELETE', '/api/v1/integrations/' + randomUUID(), undefined, b)).toThrow('REVOKE_BOUNDARY');
    for (const [method, path] of [['POST', '/api/v1/posts'], ['POST', '/api/v1/devices'], ['PUT', '/api/v1/profiles/me'],
      ['DELETE', '/api/v1/account'], ['POST', '/api/v1/connections/requests'], ['POST', '/api/auth/change-password']]) {
      expect(() => classifyMutation(method, path, {}, b)).toThrow('UNEXPECTED_BROWSER_MUTATION');
    }
  });
  it('checks ownership and encrypted envelope shape without accepting keys or plaintext fields', () => {
    const member = randomUUID(), page = ownPage(member);
    expect(assertOwnedPage('posts', page, member)).toBe(1);
    const wrong = structuredClone(page); wrong.posts[0].author_id = randomUUID();
    expect(() => assertOwnedPage('posts', wrong, member)).toThrow('INTEGRATION_NOT_OWNED');
    const wrongAuthor = structuredClone(page); wrongAuthor.posts[0].envelope.context.authorId = randomUUID();
    expect(() => assertOwnedPage('posts', wrongAuthor, member)).toThrow('CIPHERTEXT_ENVELOPE_REQUIRED');
    for (const key of ['recoverySecret', 'encrypted_private_key', 'password', 'text']) {
      const leaked: any = structuredClone(page); leaked.posts[0][key] = 'never print me';
      expect(() => assertOwnedPage('posts', leaked, member)).toThrow('INTEGRATION_PRIVATE_MATERIAL');
    }
    expect(() => assertOwnedPage('posts', { ...page, next_cursor: 'x'.repeat(4097) }, member)).toThrow('UNEXPECTED_RESOURCE_SHAPE');
  });
  it('accepts only bounded bearer pairs for exactly the granted scopes', () => {
    const pair = { token_type: 'Bearer', access_token: createPKCE().state, refresh_token: createPKCE().state,
      scope: 'profile:read content:read', expires_in: 600 };
    expect(parseTokenPair(pair)).toEqual({ access: pair.access_token, refresh: pair.refresh_token });
    for (const change of [{ scope: 'profile:read content:read media:read' }, { expires_in: 601 }, { access_token: 'bad' }])
      expect(() => parseTokenPair({ ...pair, ...change })).toThrow('TOKEN_RESPONSE_INVALID');
  });
});
