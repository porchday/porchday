import { createMiddleware } from 'hono/factory';
import type { Env, Variables } from './types';

const accountPages = new Set([
  '/login', '/verify', '/forgot', '/reset', '/stolen-account', '/recovery',
  '/appeals', '/account-deletion',
]);
const publicAssets = new Set([
  '/index.html', '/app-shell', '/app-shell.html', '/sw.js', '/manifest.webmanifest',
  '/fonts.css', '/color-scheme.js', '/third-party-notices.txt', '/favicon.ico',
]);
const rootAsset = /^\/(?:[^/]+\.(?:png|svg|ico|jpg|jpeg|webp|gif|woff2?|ttf|otf|wasm))$/i;
const beneath = (path: string, root: string) => path === root || path.startsWith(root + '/');

function exactSecureOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      value !== url.origin || !url.hostname) throw new Error('INVALID_APPLICATION_DOMAIN');
  return url.origin;
}

function legacyAccountPage(path: string): boolean {
  return accountPages.has(path) || beneath(path, '/app') || beneath(path, '/staff');
}

function keepLegacyPath(path: string): boolean {
  return legacyAccountPage(path) || beneath(path, '/api') || path === '/health' ||
    beneath(path, '/.well-known') || beneath(path, '/assets') || beneath(path, '/fonts') ||
    beneath(path, '/source') || publicAssets.has(path) || rootAsset.test(path);
}

/** Keep existing devices on their original origin while new public navigation
 * uses the canonical site. Cookies and browser encryption storage do not move
 * across origins. Never derive trust from Host/forwarded headers or mutate the
 * shared Cloudflare bindings: scheduled work must keep the canonical APP_URL. */
export const applicationDomains = createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
  if (c.env.LEGACY_APP_URL === undefined) return next();
  let canonical: string, legacy: string, aliases: string[];
  try {
    canonical = exactSecureOrigin(c.env.APP_URL);
    legacy = exactSecureOrigin(c.env.LEGACY_APP_URL);
    aliases = [canonical, legacy].map(origin => 'https://www.' + new URL(origin).hostname);
    if (new Set([canonical, legacy, ...aliases]).size !== 4)
      throw new Error('INVALID_APPLICATION_DOMAIN');
  } catch {
    c.header('Cache-Control', 'no-store');
    return c.json({ error: { code: 'DOMAIN_CONFIGURATION_INVALID', message: 'This service is temporarily unavailable.' } }, 503);
  }
  const url = new URL(c.req.url);
  const readNavigation = ['GET', 'HEAD'].includes(c.req.method);
  const httpOrigins = [canonical, legacy, ...aliases].map(origin => origin.replace(/^https:/, 'http:'));
  if (httpOrigins.includes(url.origin)) {
    c.header('Cache-Control', 'no-store');
    if (!readNavigation) {
      c.header('Allow', 'GET, HEAD');
      return c.json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Open the secure website to use this action.' } }, 405);
    }
    const target = url.origin === legacy.replace(/^https:/, 'http:') && keepLegacyPath(url.pathname)
      ? legacy : canonical;
    return c.redirect(target + url.pathname + url.search, 307);
  }
  if (aliases.includes(url.origin)) {
    c.header('Cache-Control', 'no-store');
    if (!readNavigation) {
      c.header('Allow', 'GET, HEAD');
      return c.json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Open the primary website to use this action.' } }, 405);
    }
    return c.redirect(canonical + url.pathname + url.search, 307);
  }
  if (url.origin !== canonical && url.origin !== legacy) {
    c.header('Cache-Control', 'no-store');
    return c.json({ error: { code: 'UNTRUSTED_APPLICATION_ORIGIN', message: 'This request could not be verified.' } }, 421);
  }
  if (url.origin === canonical) return next();
  if (readNavigation && !keepLegacyPath(url.pathname)) {
    // Concatenation preserves the configured authority even for a path starting
    // with //; URL(path, canonical) would allow a network-path open redirect.
    // Leave the fragment absent so browsers retain invitation/recovery fragments.
    c.header('Cache-Control', 'no-store');
    return c.redirect(canonical + url.pathname + url.search, 307);
  }
  c.env = { ...c.env, APP_URL: legacy };
  await next();
  if (legacyAccountPage(url.pathname) || ['/app-shell', '/app-shell.html'].includes(url.pathname))
    c.header('X-Robots-Tag', 'noindex');
});
