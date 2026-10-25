import {createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey} from 'jose';
import {createMiddleware} from 'hono/factory';
import {authPool} from './auth';
import type {Env, Variables} from './types';

export type StaffRole = 'recovery' | 'moderation';
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** The assertion is verified at the origin too, including when workers.dev is used. */
export async function verifyStaffAssertion(assertion: string, issuer: string, audience: string, key: JWTVerifyGetKey) {
  const {payload} = await jwtVerify(assertion, key, {
    issuer, audience, algorithms: ['RS256'], requiredClaims: ['sub', 'email', 'iat', 'exp'],
    clockTolerance: 5, maxTokenAge: '8h',
  });
  if (payload.type !== 'app' || typeof payload.sub !== 'string' || typeof payload.email !== 'string') throw new Error('Invalid staff identity');
  return {subject: payload.sub, email: payload.email.toLowerCase()};
}

export function requireStaff(role: StaffRole) {
  return createMiddleware<{Bindings: Env; Variables: Variables}>(async (c, next) => {
    const issuer = c.env.STAFF_ACCESS_ISSUER;
    const audience = c.env.STAFF_ACCESS_AUDIENCE;
    if (!issuer || !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) || !audience) {
      return c.json({error: {code: 'STAFF_NOT_CONFIGURED'}}, 503);
    }
    const assertion = c.req.header('Cf-Access-Jwt-Assertion');
    if (!assertion || assertion.length > 16000) return c.json({error: {code: 'STAFF_AUTH_REQUIRED'}}, 401);
    let identity;
    try {
      let keys = keySets.get(issuer);
      if (!keys) { keys = createRemoteJWKSet(new URL(issuer + '/cdn-cgi/access/certs')); keySets.set(issuer, keys); }
      identity = await verifyStaffAssertion(assertion, issuer, audience, keys);
    } catch { return c.json({error: {code: 'STAFF_AUTH_REQUIRED'}}, 401); }
    const pool = authPool(c.env);
    try {
      const {rows} = await pool.query('SELECT roles FROM public.staff_users WHERE subject=$1 AND lower(email)=$2 AND active', [identity.subject, identity.email]);
      if (!rows[0]?.roles?.includes(role)) return c.json({error: {code: 'STAFF_ROLE_REQUIRED'}}, 403);
      c.set('staffSubject', identity.subject); c.set('staffRoles', rows[0].roles);
    } finally { c.executionCtx.waitUntil(pool.end()); }
    await next();
  });
}
