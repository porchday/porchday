import { getSignedCookie, setSignedCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { Env, Variables } from './types';
type AuthContext = Context<{ Bindings: Env; Variables: Variables }>;
export type VerificationResult = 'verified' | 'expired' | 'used' | 'invalid' | 'unavailable';
const states = new Set<VerificationResult>(['verified', 'expired', 'used', 'invalid', 'unavailable']);
const cookieName = 'porchday.verification-result';
// Presentation only: no identity, email, token or authentication authority.
export async function verificationRedirect(c: AuthContext, state: VerificationResult) {
  await setSignedCookie(c, cookieName, JSON.stringify({ state, expires: Date.now() + 300_000 }), c.env.BETTER_AUTH_SECRET, {
    httpOnly: true, secure: new URL(c.env.APP_URL).protocol === 'https:', sameSite: 'Lax', path: '/api/auth/verification-result', maxAge: 300,
  });
  c.header('Cache-Control', 'private, no-store');
  c.header('Referrer-Policy', 'no-referrer');
  return c.redirect(c.env.APP_URL + '/login?verification=1', 303);
}
export async function readVerificationResult(c: AuthContext) {
  c.header('Cache-Control', 'private, no-store');
  const value = await getSignedCookie(c, c.env.BETTER_AUTH_SECRET, cookieName);
  try {
    const result = typeof value === 'string' ? JSON.parse(value) : null;
    if (states.has(result?.state) && Number.isFinite(result.expires) && result.expires > Date.now() && result.expires <= Date.now() + 300_000)
      return c.json({ state: result.state });
  } catch { /* Untrusted or expired presentation state is not success. */ }
  return c.json({ state: null });
}
