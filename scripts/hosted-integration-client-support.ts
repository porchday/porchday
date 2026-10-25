import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { stagingOrigin } from './hosted-smoke-support.js';

export const integrationScopes = ['profile:read', 'content:read'] as const;
export const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const token = /^[A-Za-z0-9_-]{43}$/;

export class IntegrationCheckError extends Error {}
export function ensure(value: unknown, code: string): asserts value {
  if (!value) throw new IntegrationCheckError(code);
}
export function explicitAttempt(args: string[]): string {
  ensure(args.length === 2 && args[0] === '--run' && /^--attempt=[a-f0-9]{8}$/.test(args[1]),
    'EXPLICIT_INTEGRATION_ATTEMPT_REQUIRED');
  return args[1].slice(10);
}
/** Handle both rejections immediately and settle the response wait even if its UI click fails. */
export async function performUIAction<T>(response: Promise<T>, action: () => Promise<unknown>): Promise<T> {
  const observed = response.then(value => ({ ok: true as const, value }), () => ({ ok: false as const }));
  const acted = Promise.resolve().then(action).then(() => true, () => false);
  const [result, actionSucceeded] = await Promise.all([observed, acted]);
  ensure(actionSucceeded, 'UI_ACTION_FAILED');
  ensure(result.ok, 'UI_RESPONSE_FAILED');
  return result.value;
}
export function createPKCE() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'),
    state: randomBytes(32).toString('base64url') };
}
export function authorizeURL(clientId: string, redirect: string, pkce: ReturnType<typeof createPKCE>) {
  ensure(uuid.test(clientId), 'CLIENT_ID_INVALID');
  const callback = new URL(redirect);
  ensure(callback.hostname === '127.0.0.1' && callback.protocol === 'http:' && !!callback.port &&
    callback.pathname === '/callback' && !callback.username && !callback.password && !callback.search && !callback.hash,
  'LOOPBACK_CALLBACK_REQUIRED');
  const url = new URL('/app/integrations/authorize', stagingOrigin);
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirect,
    scope: integrationScopes.join(' '), code_challenge: pkce.challenge,
    code_challenge_method: 'S256', state: pkce.state }).toString();
  return url.href;
}

/** The only listener is an ephemeral IPv4 loopback port; no request URLs or bodies are logged. */
export async function openCallback(expectedState: string) {
  ensure(token.test(expectedState), 'CALLBACK_STATE_INVALID');
  let server: Server, origin = '', received: string | undefined, closed = false;
  let waiting: ((code: string) => void) | undefined;
  server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const reject = () => { response.writeHead(400, { 'Content-Type': 'text/plain' }); response.end('Invalid callback.'); };
    try {
      if (closed || request.method !== 'GET' || request.headers.host !== new URL(origin).host ||
          !request.url?.startsWith('/') || request.url.startsWith('//') || request.url.length > 2048) return reject();
      const url = new URL(request.url, origin);
      if (url.origin !== origin || url.hash) return reject();
      if (url.pathname === '/complete' && !url.search && received) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><title>Porchday integration check</title><p>Authorization received. This test will revoke its access automatically.</p>');
        return;
      }
      const state = url.searchParams.get('state'), code = url.searchParams.get('code');
      if (url.pathname !== '/callback' || received || url.searchParams.size !== 2 ||
          url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1 ||
          !state || !token.test(state) || !code || !token.test(code) ||
          !timingSafeEqual(Buffer.from(state), Buffer.from(expectedState))) return reject();
      received = code;
      // A redirect chain ends at a clean URL; neither code nor state enters the response body.
      response.writeHead(303, { Location: '/complete' }); response.end();
      waiting?.(code);
    } catch { reject(); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  ensure(address && typeof address === 'object', 'CALLBACK_LISTEN_FAILED');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin, redirect: origin + '/callback', hasCode: () => !!received,
    waitForCode(timeout = 60000): Promise<string> {
      if (received) return Promise.resolve(received);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting = undefined; reject(new IntegrationCheckError('CALLBACK_TIMEOUT')); }, timeout);
        waiting = code => { clearTimeout(timer); waiting = undefined; resolve(code); };
      });
    },
    async close() {
      closed = true; waiting = undefined; received = undefined;
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}

export type IntegrationBoundary = {
  name: string; purpose: string; redirect: string; challenge: string; state: string;
  clientId?: string; grantIds: Set<string>; registrationStarted: boolean; consentStarted: boolean;
};
/** Gate real UI submissions before forwarding them unchanged. No content/key/account mutation is permitted. */
export function classifyMutation(method: string, pathname: string, body: any, boundary: IntegrationBoundary) {
  if (method === 'POST' && pathname === '/api/auth/sign-out') return 'logout' as const;
  if (method === 'POST' && pathname === '/api/v1/integrations/clients') {
    ensure(!boundary.registrationStarted && body && Object.keys(body).length === 3 &&
      body.name === boundary.name && body.purpose === boundary.purpose && body.redirect_uri === boundary.redirect,
    'REGISTRATION_BOUNDARY');
    return 'register' as const;
  }
  if (method === 'POST' && pathname === '/api/v1/integrations/authorize') {
    ensure(!boundary.consentStarted && boundary.clientId && body && Object.keys(body).length === 7 &&
      body.client_id === boundary.clientId && body.redirect_uri === boundary.redirect &&
      JSON.stringify(body.scope) === JSON.stringify(integrationScopes) && body.consent === true &&
      body.code_challenge === boundary.challenge && body.code_challenge_method === 'S256' && body.state === boundary.state,
    'CONSENT_BOUNDARY');
    return 'consent' as const;
  }
  if (method === 'DELETE' && pathname.startsWith('/api/v1/integrations/')) {
    const id = pathname.slice('/api/v1/integrations/'.length);
    ensure(uuid.test(id) && boundary.grantIds.has(id), 'REVOKE_BOUNDARY');
    return 'revoke' as const;
  }
  throw new IntegrationCheckError('UNEXPECTED_BROWSER_MUTATION');
}

const forbiddenFields = new Set(['password', 'email', 'privateKey', 'private_key', 'encrypted_private_key',
  'recoverySecret', 'recovery_secret', 'access_token', 'refresh_token', 'text', 'bio']);
function rejectPrivateMaterial(value: unknown, depth = 0) {
  ensure(depth < 12, 'UNEXPECTED_RESOURCE_SHAPE');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    ensure(!forbiddenFields.has(key), 'INTEGRATION_PRIVATE_MATERIAL');
    rejectPrivateMaterial(child, depth + 1);
  }
}
export function assertOwnedPage(section: string, page: any, memberId: string): number {
  ensure(['profile', 'posts', 'comments', 'post_reactions', 'comment_reactions'].includes(section), 'RESOURCE_SECTION_INVALID');
  rejectPrivateMaterial(page);
  const rows = section === 'profile' ? page.profile ? [page.profile] : [] : page[section];
  ensure(Array.isArray(rows) && rows.length <= 25 && (page.next_cursor === null ||
    typeof page.next_cursor === 'string' && page.next_cursor.length <= 4096), 'UNEXPECTED_RESOURCE_SHAPE');
  for (const row of rows) {
    const owner = section === 'profile' || section.endsWith('reactions') ? row.member_id : row.author_id;
    ensure(owner === memberId, 'INTEGRATION_NOT_OWNED');
    if (section === 'profile' && row.envelope === null) continue;
    const e = row.envelope;
    ensure(e?.v === 1 && e.protocol === 'porchday-openpgp-v1' && e.context?.authorId === memberId &&
      Array.isArray(e.recipients) && typeof e.ciphertext === 'string' &&
      e.ciphertext.startsWith('-----BEGIN PGP MESSAGE-----') &&
      Object.keys(e).sort().join(',') === 'ciphertext,context,protocol,recipients,v', 'CIPHERTEXT_ENVELOPE_REQUIRED');
  }
  return rows.length;
}
export function parseTokenPair(body: any) {
  ensure(body?.token_type === 'Bearer' && token.test(body.access_token) && token.test(body.refresh_token) &&
    typeof body.scope === 'string' && body.scope.split(/\s+/).sort().join(' ') === [...integrationScopes].sort().join(' ') &&
    body.expires_in > 0 && body.expires_in <= 600, 'TOKEN_RESPONSE_INVALID');
  return { access: body.access_token as string, refresh: body.refresh_token as string };
}
