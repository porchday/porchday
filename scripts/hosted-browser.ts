/** Real staging UI acceptance in a new, private test browser; never attach to a user's browser. */
import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdir, chmod, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { check, readPrivate, writePrivate, stagingOrigin } from './hosted-smoke-support.js';

const directory = 'artifacts/private/hosted-smoke/';
const phase = process.argv[2];
check(phase === 'session', 'BROWSER_PHASE_REQUIRED');
const attempt = process.argv.find(a => a.startsWith('--attempt='))?.slice(10);
check(attempt && /^[a-f0-9]{8}$/.test(attempt), 'EXPLICIT_BROWSER_ATTEMPT_REQUIRED');
let stage = 'preflight';
let context: BrowserContext | undefined;
let page: Page | undefined;
let signedIn = false;
let completed = false;
let savedSessionCookie = '';
const observed: Record<string, unknown> = {};
const progress = (value: string) => { stage = value; console.log(JSON.stringify({ phase, stage })); };

try {
  const state = await readPrivate<any>(directory + 'state.json');
  const a = state.accounts?.[0];
  check(state.v === 1 && state.synthetic === true && state.origin === stagingOrigin &&
    a?.handle?.startsWith('qa_' + state.run + '_') && a.id && !a.deleted &&
    a.device?.enrolled && a.password?.length >= 32 && a.device.keys.recoverySecret,
  'VERIFIED_SYNTHETIC_A_REQUIRED');
  check(state.interop?.expectedPostText && Date.parse(state.interop.expiresAt) > Date.now() + 5 * 60_000,
    'LIVE_HISTORY_FIXTURE_REQUIRED');
  const health = await fetch(stagingOrigin + '/health', { redirect: 'error' });
  const release = await health.json() as any;
  check(health.ok && release.status === 'ok' && release.environment === 'staging', 'STAGING_HEALTH_REQUIRED');
  // Exclusive creation refuses blind replay after an uncertain run. A deliberate new attempt
  // reuses this fixture-only profile, so an already remembered device is not re-enrolled.
  await writePrivate(directory + `browser-${phase}-${attempt}.intent.json`, {
    v: 1, synthetic: true, origin: stagingOrigin, phase, startedAt: new Date().toISOString(),
    member: a.id, release, effects: ['normal login', 'recovery-authorized browser device',
      'explicit remembered device', 'empty-profile initialization if needed', 'normal logout'],
  }, true);
  const profile = resolve(directory + 'isolated-browser-profile');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const profileStat = await lstat(profile);
  check(profileStat.isDirectory() && !profileStat.isSymbolicLink() &&
    profile.startsWith(resolve(directory) + '/'), 'ISOLATED_BROWSER_DIRECTORY_REQUIRED');
  await chmod(profile, 0o700);
  context = await chromium.launchPersistentContext(profile, {
    headless: true, viewport: { width: 1280, height: 900 }, acceptDownloads: true,
    serviceWorkers: 'allow',
  });
  context.setDefaultTimeout(30_000);
  page = context.pages()[0] || await context.newPage();
  await page.goto(stagingOrigin + '/login');
  check(new URL(page.url()).origin === stagingOrigin, 'LOGIN_ORIGIN_CHANGED');
  progress('login');
  await page.getByLabel('Email address', { exact: true }).fill(a.email);
  await page.getByLabel('Password', { exact: true }).fill(a.password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.waitForURL(stagingOrigin + '/app');
  signedIn = true;
  savedSessionCookie = (await context.cookies(stagingOrigin)).map(c => `${c.name}=${c.value}`).join('; ');
  check(savedSessionCookie, 'BROWSER_SESSION_COOKIE_MISSING');
  progress('recovery-unlock');
  await page.getByRole('heading', { name: 'Unlock this device', exact: true }).waitFor();
  await page.getByLabel('Encryption recovery secret', { exact: true }).fill(a.device.keys.recoverySecret);
  await page.getByRole('checkbox', { name: /Remember this private device/ }).check();
  await page.getByRole('button', { name: 'Unlock' }).click();
  await page.getByText('FROM YOUR PEOPLE', { exact: true }).waitFor({ timeout: 90_000 });
  await page.getByRole('button', { name: 'Newest first', exact: true }).waitFor();
  observed.defaultHome = new URL(page.url()).pathname === '/app';
  observed.historyVisible = false;
  if (state.interop && Date.parse(state.interop.expiresAt) > Date.now()) {
    await page.getByText(state.interop.expectedPostText, { exact: true }).waitFor({ timeout: 45_000 });
    observed.historyVisible = true;
  }
  progress('remembered-storage');
  const remembered = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('porchday-device-v1');
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(new Error('IDB unavailable'));
    });
    try {
      const rows = await new Promise<any[]>((resolve, reject) => {
        const r = db.transaction('devices', 'readonly').objectStore('devices').getAll();
        r.onsuccess = () => resolve(r.result); r.onerror = () => reject(new Error('IDB read failed'));
      });
      return { count: rows.length, protected: rows.length > 0 && rows.every(r =>
        r.wrappingKey instanceof CryptoKey && r.wrappingKey.extractable === false &&
        r.ciphertext instanceof ArrayBuffer && !('recoverySecret' in r) && !('privateKey' in r)) };
    } finally { db.close(); }
  });
  check(remembered.protected, 'REMEMBERED_DEVICE_NOT_PROTECTED');
  observed.remembered = remembered;
  await page.screenshot({ path: directory + `browser-${attempt}-home.png`, fullPage: true });
  await chmod(directory + `browser-${attempt}-home.png`, 0o600);
  await page.setViewportSize({ width: 375, height: 812 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'MOBILE_HORIZONTAL_OVERFLOW');
  observed.mobileNoOverflow = true;
  await page.screenshot({ path: directory + `browser-${attempt}-mobile.png`, fullPage: true });
  await chmod(directory + `browser-${attempt}-mobile.png`, 0o600);
  await page.setViewportSize({ width: 1280, height: 900 });
  progress('cache-and-offline');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await page.getByText('FROM YOUR PEOPLE', { exact: true }).waitFor({ timeout: 60_000 });
  check(await page.evaluate(() => !!navigator.serviceWorker.controller), 'SERVICE_WORKER_NOT_CONTROLLING');
  const cache = await page.evaluate(async () => {
    const names = await caches.keys();
    const urls = (await Promise.all(names.map(async n => (await (await caches.open(n)).keys()).map(r => new URL(r.url))))).flat();
    const publicFiles = new Set(['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/icon-192.png',
      '/icon-512.png', '/apple-touch-icon.png', '/porch-pattern.svg', '/wallpaper-checker.svg',
      '/wallpaper-daisies.svg', '/wallpaper-diamonds.svg', '/fonts.css', '/third-party-notices.txt']);
    return { cacheCount: names.length, entryCount: urls.length, publicOnly: urls.length > 0 && urls.every(u =>
      u.origin === location.origin && !u.search && (publicFiles.has(u.pathname) || u.pathname.startsWith('/assets/'))) };
  });
  check(cache.publicOnly, 'PRIVATE_CACHE_ENTRY_FOUND');
  observed.cache = cache;
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'You’re offline', exact: true }).waitFor();
  check(await page.getByText('FROM YOUR PEOPLE', { exact: true }).count() === 0, 'OFFLINE_PRIVATE_FEED_VISIBLE');
  observed.authenticatedColdOfflinePrivateContentAbsent = true;
  await context.setOffline(false);
  await page.reload();
  await page.getByText('FROM YOUR PEOPLE', { exact: true }).waitFor({ timeout: 60_000 });
  progress('signout');
  await page.getByRole('button', { name: 'Sign out', exact: true }).filter({ visible: true }).click();
  await page.waitForURL(stagingOrigin + '/login');
  const revoked = await context.request.get(stagingOrigin + '/api/v1/me', {
    headers: { Cookie: savedSessionCookie }, maxRedirects: 0,
  });
  check([401, 403].includes(revoked.status()), 'SAVED_SESSION_STILL_AUTHORIZED');
  const authSession = await context.request.get(stagingOrigin + '/api/auth/get-session', {
    headers: { Cookie: savedSessionCookie }, maxRedirects: 0,
  });
  check(authSession.status() === 200 && !(await authSession.json())?.user, 'SAVED_AUTH_SESSION_STILL_LIVE');
  signedIn = false;
  const remaining = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('porchday-device-v1'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(new Error('IDB unavailable'));
    });
    try { return await new Promise<number>((resolve, reject) => {
      const r = db.transaction('devices', 'readonly').objectStore('devices').count();
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(new Error('IDB read failed'));
    }); } finally { db.close(); }
  });
  check(remaining === 0, 'SIGNOUT_RETAINED_KEYS');
  await page.goto(stagingOrigin + '/app');
  await page.getByRole('button', { name: 'Log in', exact: true }).waitFor();
  check(await page.getByText('FROM YOUR PEOPLE', { exact: true }).count() === 0, 'SIGNOUT_PRIVATE_FEED_VISIBLE');
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'You’re offline', exact: true }).waitFor();
  observed.signout = { rememberedKeys: remaining, savedSessionRevoked: true, onlineLoginRequired: true, coldOfflinePrivateContentAbsent: true };
  await context.setOffline(false);
  await page.goto(stagingOrigin + '/login');
  completed = true;
  await writePrivate(directory + `browser-${phase}-${attempt}.result.json`, {
    v: 1, completedAt: new Date().toISOString(), browser: context.browser()?.version(),
    release, checks: observed, complete: true,
  }, true);
  console.log(JSON.stringify({ phase, stage: 'passed', checks: observed }));
} catch {
  // Playwright raw errors can include field values, URLs or page content. Never print them.
  console.error(JSON.stringify({ phase, stage, error: 'HOSTED_BROWSER_CHECK_FAILED' }));
  process.exitCode = 1;
} finally {
  if (context && page) {
    try {
      await context.setOffline(false);
      if (!completed) {
        const logout = page.getByRole('button', { name: 'Sign out', exact: true }).filter({ visible: true });
        if (await logout.count() === 1) await logout.click().catch(() => {});
        // Normal auth endpoint, same origin and this test browser's own cookie.
        // Also handles a successful login whose following UI navigation timed out.
        const cookie = savedSessionCookie || (await context.cookies(stagingOrigin)).map(c => `${c.name}=${c.value}`).join('; ');
        await context.request.post(stagingOrigin + '/api/auth/sign-out', {
          headers: { Origin: stagingOrigin, Cookie: cookie }, data: {}, maxRedirects: 0,
        });
        const ended = await context.request.get(stagingOrigin + '/api/auth/get-session', {
          headers: { Cookie: cookie }, maxRedirects: 0,
        });
        check(ended.status() === 200 && !(await ended.json())?.user, 'CLEANUP_SESSION_STILL_LIVE');
        signedIn = false;
      }
    } catch { console.error(JSON.stringify({ phase, stage: 'cleanup', warning: 'BROWSER_SIGNOUT_NOT_CONFIRMED' })); }
    if (!completed) {
      try {
        if (new URL(page.url()).origin === stagingOrigin) await page.evaluate(async () => {
          const databases = await indexedDB.databases();
          if (!databases.some(d => d.name === 'porchday-device-v1')) return;
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const r = indexedDB.open('porchday-device-v1'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(new Error('IDB unavailable'));
          });
          try { await new Promise<void>((resolve, reject) => {
            const tx = db.transaction('devices', 'readwrite'); tx.objectStore('devices').clear();
            tx.oncomplete = () => resolve(); tx.onerror = () => reject(new Error('IDB cleanup failed'));
          }); } finally { db.close(); }
        });
        await context.clearCookies();
      } catch { console.error(JSON.stringify({ phase, stage: 'cleanup', warning: 'LOCAL_BROWSER_CLEANUP_NOT_CONFIRMED' })); }
    }
    try { await context.close(); }
    catch { console.error(JSON.stringify({ phase, stage: 'cleanup', warning: 'BROWSER_CLOSE_NOT_CONFIRMED' })); }
  }
  if (!completed) console.error(JSON.stringify({ phase, warning: 'INSPECT_RECORDED_ATTEMPT_BEFORE_RETRY' }));
}
