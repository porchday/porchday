/** Opt-in real UI/PKCE test. External requests never carry a member cookie or encryption key. */
import { chromium, type BrowserContext, type Page, type Request } from 'playwright';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readPrivate, writePrivate, stagingOrigin } from './hosted-smoke-support.js';
import { assertOwnedPage, authorizeURL, classifyMutation, createPKCE, ensure, explicitAttempt,
  integrationScopes, IntegrationCheckError, openCallback, parseTokenPair, uuid,
  performUIAction, type IntegrationBoundary } from './hosted-integration-client-support.js';

const directory = 'artifacts/private/hosted-smoke/', phase = 'integration-client';
let stage = 'preflight', attempt = '', sequence = 0, complete = false, mutationBlocked = false;
let mutationUnconfirmed = false;
let context: BrowserContext | undefined, page: Page | undefined;
let callback: Awaited<ReturnType<typeof openCallback>> | undefined, boundary: IntegrationBoundary | undefined;
let a: any, savedCookie = '', baselineDevices = '', baselineProfile = '', baselineClients = new Set<string>();
let loginStarted = false, cleanupArmed = false;
let result: Record<string, unknown> | undefined;
const inFlight: Promise<void>[] = [], totals: Record<string, number> = {};
const progress = (next: string) => { stage = next; console.log(JSON.stringify({ phase, stage })); };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const devices = (value: any) => (Array.isArray(value) ? value : value.items || value.devices || [])
  .map((row: any) => [row.id, row.fingerprint, row.revoked_at]).sort();
async function receipt(kind: string, value: unknown) {
  await writePrivate(directory + `integration-${attempt}-${String(++sequence).padStart(3, '0')}-${kind}.json`, value, true);
}
async function memberAPI(path: string, method = 'GET') {
  ensure(context && (method === 'GET' && ['/api/v1/me', '/api/v1/devices', '/api/v1/integrations'].includes(path) ||
    method === 'DELETE' && boundary?.grantIds.has(path.slice('/api/v1/integrations/'.length)) &&
    path.startsWith('/api/v1/integrations/')), 'MEMBER_API_BOUNDARY');
  const response = await context!.request.fetch(stagingOrigin + path, {
    method, headers: { Origin: stagingOrigin }, maxRedirects: 0, timeout: 30000,
  });
  ensure(response.status() === 200, 'MEMBER_API_FAILED');
  ensure(response.headers()['cache-control']?.includes('no-store'), 'PRIVATE_RESPONSE_CACHEABLE');
  return response.json();
}
/** Separate cookie-free HTTP client: only fixed token/read routes; redirects are never followed. */
async function external(path: string, options: { access?: string; body?: unknown; expected?: number } = {}) {
  ensure(path === '/api/integration/v1/token' ||
    /^\/api\/integration\/v1\/own\/(profile|content|media|exports)(\?.*)?$/.test(path) ||
    ['/api/v1/feed', '/api/v1/keys/backup', '/api/v1/devices'].includes(path), 'EXTERNAL_ROUTE_BOUNDARY');
  ensure((options.body !== undefined) === (path === '/api/integration/v1/token'), 'EXTERNAL_METHOD_BOUNDARY');
  const url = new URL(path, stagingOrigin);
  ensure(url.origin === stagingOrigin && !url.hash, 'EXTERNAL_ORIGIN_BOUNDARY');
  const response = await fetch(url, { method: options.body ? 'POST' : 'GET', redirect: 'error',
    cache: 'no-store', signal: AbortSignal.timeout(30000), headers: {
      ...(options.access ? { Authorization: `Bearer ${options.access}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    }, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
  ensure(response.status === (options.expected ?? 200), 'EXTERNAL_STATUS_MISMATCH');
  ensure(response.headers.get('cache-control')?.includes('no-store'), 'PRIVATE_RESPONSE_CACHEABLE');
  const reader = response.body?.getReader(); ensure(reader, 'EMPTY_EXTERNAL_RESPONSE');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.length; ensure(bytes <= 12 * 1024 * 1024, 'EXTERNAL_RESPONSE_LIMIT'); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (response.status !== 200) ensure(body?.error && typeof body.error.code === 'string', 'EXPECTED_DENIAL_MISSING');
  return body;
}
function observeRequest(request: Request) {
  inFlight.push(new Promise<void>(resolve => {
    const finish = (failed = false) => {
      if (failed) { mutationBlocked = true; mutationUnconfirmed = true; }
      clearTimeout(timer); context!.off('requestfinished', done); context!.off('requestfailed', failedEvent); resolve();
    };
    const done = (value: Request) => { if (value === request) finish(); };
    const failedEvent = (value: Request) => { if (value === request) finish(true); };
    const timer = setTimeout(() => finish(true), 45000);
    context!.on('requestfinished', done); context!.on('requestfailed', failedEvent);
  }));
}
async function captureOwnedGrant() {
  if (!boundary?.registrationStarted) return;
  const listing = await memberAPI('/api/v1/integrations');
  const clients = listing.clients.filter((client: any) => !baselineClients.has(client.id) &&
    client.name === boundary!.name && client.purpose === boundary!.purpose && client.redirect_uri === boundary!.redirect);
  ensure(clients.length <= 1, 'AMBIGUOUS_NEW_CLIENT');
  if (!clients.length) return;
  ensure(uuid.test(clients[0].id) && (!boundary.clientId || boundary.clientId === clients[0].id), 'CLIENT_ID_CHANGED');
  boundary.clientId = clients[0].id;
  const grants = listing.grants.filter((grant: any) => grant.client_id === boundary!.clientId);
  ensure(grants.length <= 1 && grants.every((grant: any) => uuid.test(grant.id) &&
    JSON.stringify([...grant.scopes].sort()) === JSON.stringify([...integrationScopes].sort())), 'GRANT_CAPTURE_BOUNDARY');
  for (const grant of grants) boundary.grantIds.add(grant.id);
  await receipt('captured-identities', { clientId: boundary.clientId, grantIds: [...boundary.grantIds],
    registeredClientHasNoDeleteEndpoint: true });
}
async function revokeCaptured() {
  if (!context || !boundary?.registrationStarted) return;
  await captureOwnedGrant();
  for (const grantId of boundary.grantIds) {
    await receipt('cleanup-revoke-intent', { grantId, clientId: boundary.clientId });
    await memberAPI('/api/v1/integrations/' + grantId, 'DELETE');
  }
  const listing = await memberAPI('/api/v1/integrations');
  ensure(listing.grants.filter((g: any) => boundary!.grantIds.has(g.id)).every((g: any) => !!g.revoked_at), 'GRANT_REVOKE_UNCONFIRMED');
  ensure(!listing.grants.some((g: any) => g.client_id === boundary!.clientId && !g.revoked_at), 'GRANT_REMAINS_ACTIVE');
  // A transport failure/timeout can leave a late commit even after a clean list read.
  // Revoke captured grants first, but never label that uncertain attempt fully cleaned.
  ensure(!mutationUnconfirmed, 'GRANT_MUTATION_OUTCOME_UNCONFIRMED');
  await receipt('cleanup', { grantsRevoked: boundary.grantIds.size, clientId: boundary.clientId ?? null,
    residualRegisteredClient: !!boundary.clientId });
}

try {
  attempt = explicitAttempt(process.argv.slice(2));
  const state = await readPrivate<any>(directory + 'state.json'); a = state.accounts?.[0];
  ensure(state.v === 1 && state.synthetic === true && state.origin === stagingOrigin && /^[a-f0-9]{10}$/.test(state.run) &&
    a?.handle === `qa_${state.run}_0` && uuid.test(a.id) && !a.deleted && a.device?.enrolled &&
    a.password?.length >= 32 && a.device.keys.recoverySecret && state.accounts[2]?.deleted === true,
  'SYNTHETIC_A_ONLY_REQUIRED');
  const health = await fetch(stagingOrigin + '/health', { redirect: 'error', signal: AbortSignal.timeout(30000) });
  const release = await health.json() as any;
  ensure(health.ok && release.status === 'ok' && release.environment === 'staging', 'STAGING_HEALTH_REQUIRED');
  const pkce = createPKCE(); callback = await openCallback(pkce.state);
  boundary = { name: `Porchday integration QA ${attempt}`, purpose: 'Temporary synthetic own-ciphertext portability verification.',
    redirect: callback.redirect, challenge: pkce.challenge, state: pkce.state,
    grantIds: new Set(), registrationStarted: false, consentStarted: false };
  await writePrivate(directory + `integration-${attempt}.intent.json`, { v: 1, synthetic: true, origin: stagingOrigin,
    member: a.id, startedAt: new Date().toISOString(), release, clientName: boundary.name, redirect: boundary.redirect,
    effects: ['ordinary A login and existing-device unlock', 'one UI client registration', 'explicit UI own-profile/content consent',
      'cookie-free PKCE exchange and bounded ciphertext reads', 'token rotation', 'UI grant revocation', 'normal signout'],
    residual: 'The current API has no client-delete endpoint; the nonsecret registered client row remains after grant revocation.' }, true);
  const profile = resolve(directory + 'isolated-browser-profile'), stat = await lstat(profile);
  ensure(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, 'EXISTING_ISOLATED_PROFILE_REQUIRED');
  context = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 1280, height: 900 },
    acceptDownloads: false, serviceWorkers: 'block' });
  context.setDefaultTimeout(30000);
  // Blocking service workers here makes the mutation gate complete. This does not test PWA/offline behavior.
  await context.route('**/*', async route => {
    try {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      ensure([stagingOrigin, callback!.origin].includes(url.origin) && !url.username && !url.password, 'BROWSER_ORIGIN_BOUNDARY');
      if (['GET', 'HEAD'].includes(method)) { await route.continue(); return; }
      ensure(url.origin === stagingOrigin, 'BROWSER_MUTATION_ORIGIN');
      const body = request.postData() ? request.postDataJSON() : undefined;
      if (method === 'POST' && url.pathname === '/api/auth/sign-in/email') {
        ensure(stage === 'login' && !loginStarted && body?.email === a.email && body.password === a.password &&
          body.callbackURL === '/app' && Object.keys(body).length === 3, 'LOGIN_BOUNDARY');
        loginStarted = true; await receipt('login-intent', { member: a.id });
      } else {
        const kind = classifyMutation(method, url.pathname, body, boundary!);
        ensure(!cleanupArmed || kind === 'logout' || kind === 'revoke', 'CLEANUP_WRITE_BOUNDARY');
        if (kind === 'register') boundary!.registrationStarted = true;
        if (kind === 'consent') boundary!.consentStarted = true;
        await receipt(kind + '-intent', { clientId: boundary!.clientId ?? null,
          ...(kind === 'revoke' ? { grantId: url.pathname.split('/').at(-1) } : {}) });
      }
      observeRequest(request); await route.continue();
    } catch { mutationBlocked = true; await route.abort().catch(() => {}); }
  });
  page = context.pages()[0] || await context.newPage();
  progress('login'); await page.goto(stagingOrigin + '/login');
  await page.getByLabel('Email address', { exact: true }).fill(a.email);
  await page.getByLabel('Password', { exact: true }).fill(a.password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.waitForURL(stagingOrigin + '/app');
  savedCookie = (await context.cookies(stagingOrigin)).map(c => `${c.name}=${c.value}`).join('; ');
  ensure(savedCookie, 'BROWSER_SESSION_REQUIRED');
  const me = await memberAPI('/api/v1/me'); ensure(me.id === a.id, 'WRONG_MEMBER');
  baselineProfile = digest(me.envelope); const beforeDevices = await memberAPI('/api/v1/devices');
  baselineDevices = digest(devices(beforeDevices));
  const active = await page.evaluate(id => localStorage.getItem(`porchday-device:${id}`), a.id);
  ensure(devices(beforeDevices).some((d: any[]) => d[0] === active && !d[2]), 'EXISTING_DEVICE_REQUIRED');
  baselineClients = new Set((await memberAPI('/api/v1/integrations')).clients.map((c: any) => c.id));
  progress('unlock-existing-device');
  await page.getByRole('heading', { name: 'Unlock this device', exact: true }).waitFor();
  await page.getByLabel('Encryption recovery secret', { exact: true }).fill(a.device.keys.recoverySecret);
  await page.getByRole('checkbox', { name: /Remember this private device/ }).check();
  await page.getByRole('button', { name: 'Unlock my circle', exact: true }).click();
  await page.getByText('FROM YOUR PEOPLE', { exact: true }).waitFor({ timeout: 90000 });
  ensure(baselineDevices === digest(devices(await memberAPI('/api/v1/devices'))), 'DEVICE_SET_CHANGED');
  progress('register-ui'); await page.goto(stagingOrigin + '/app/settings/data');
  await page.getByRole('button', { name: 'Register a tool you’re building', exact: true }).click();
  await page.getByLabel('App name', { exact: true }).fill(boundary.name);
  await page.getByLabel('Purpose', { exact: true }).fill(boundary.purpose);
  await page.getByLabel('Exact HTTPS return URL', { exact: true }).fill(boundary.redirect);
  const registeredResponse = await performUIAction(
    page.waitForResponse(r => r.url() === stagingOrigin + '/api/v1/integrations/clients' && r.request().method() === 'POST'),
    () => page!.getByRole('button', { name: 'Register integration', exact: true }).click());
  ensure(registeredResponse.status() === 201, 'REGISTRATION_FAILED');
  const registeredBody = await registeredResponse.json(); ensure(uuid.test(registeredBody.id), 'CLIENT_ID_INVALID');
  boundary.clientId = registeredBody.id; await captureOwnedGrant();
  const consentURL = authorizeURL(boundary.clientId!, boundary.redirect, pkce);
  progress('cancel-consent'); await page.goto(consentURL);
  await page.getByRole('heading', { name: boundary.name, exact: true }).waitFor();
  await page.getByRole('link', { name: 'Cancel', exact: true }).click();
  await page.waitForURL(stagingOrigin + '/app/settings/data');
  ensure(!callback.hasCode() && !(await memberAPI('/api/v1/integrations')).grants.some((g: any) => g.client_id === boundary!.clientId), 'CANCEL_CREATED_GRANT');
  progress('consent-ui'); await page.goto(consentURL);
  await page.getByRole('heading', { name: boundary.name, exact: true }).waitFor();
  await page.getByText('Your encrypted profile and public handle', { exact: true }).waitFor();
  await page.getByText('Your own encrypted posts, comments, and reactions', { exact: true }).waitFor();
  const grantedResponse = await performUIAction(
    page.waitForResponse(r => r.url() === stagingOrigin + '/api/v1/integrations/authorize' && r.request().method() === 'POST'),
    () => page!.getByRole('button', { name: 'Allow selected access', exact: true }).click());
  ensure(grantedResponse.status() === 200, 'CONSENT_FAILED');
  const grant = await grantedResponse.json(); ensure(uuid.test(grant.grant_id), 'GRANT_ID_INVALID');
  boundary.grantIds.add(grant.grant_id); await captureOwnedGrant();
  const code = await callback.waitForCode(); await page.waitForURL(callback.origin + '/complete');
  ensure(!new URL(page.url()).search, 'CALLBACK_URL_NOT_CLEARED');
  progress('pkce-exchange');
  const exchange = { grant_type: 'authorization_code', client_id: boundary.clientId, redirect_uri: boundary.redirect,
    code, code_verifier: pkce.verifier };
  await external('/api/integration/v1/token', { body: { ...exchange, code_verifier: createPKCE().verifier }, expected: 401 });
  let pair = parseTokenPair(await external('/api/integration/v1/token', { body: exchange }));
  await external('/api/integration/v1/token', { body: exchange, expected: 401 });
  progress('own-ciphertext-read');
  totals.profile = assertOwnedPage('profile', await external('/api/integration/v1/own/profile', { access: pair.access }), a.id);
  for (const section of ['posts', 'comments', 'post_reactions', 'comment_reactions']) {
    let cursor: string | null = null, pages = 0; totals[section] = 0;
    do {
      ensure(++pages <= 4, 'READ_PAGE_LIMIT');
      const query = new URLSearchParams({ section }); if (cursor) query.set('cursor', cursor);
      const response = await external('/api/integration/v1/own/content?' + query, { access: pair.access });
      totals[section] += assertOwnedPage(section, response, a.id); cursor = response.next_cursor;
    } while (cursor !== null);
  }
  ensure(totals.posts > 0, 'OWN_CONTENT_FIXTURE_EMPTY');
  for (const path of ['/api/integration/v1/own/media', '/api/integration/v1/own/exports',
    '/api/v1/feed', '/api/v1/keys/backup', '/api/v1/devices']) {
    await external(path, { access: pair.access, expected: 401 });
  }
  progress('refresh-rotation'); const oldPair = pair;
  pair = parseTokenPair(await external('/api/integration/v1/token', { body: {
    grant_type: 'refresh_token', client_id: boundary.clientId, refresh_token: oldPair.refresh } }));
  await external('/api/integration/v1/own/profile', { access: oldPair.access, expected: 401 });
  await external('/api/integration/v1/token', { body: { grant_type: 'refresh_token',
    client_id: boundary.clientId, refresh_token: oldPair.refresh }, expected: 401 });
  assertOwnedPage('profile', await external('/api/integration/v1/own/profile', { access: pair.access }), a.id);
  progress('revoke-ui'); await page.goto(stagingOrigin + '/app/settings/data');
  const row = page.locator('.member-row').filter({ has: page.getByText(boundary.name, { exact: true }) });
  await row.getByRole('button', { name: 'Revoke', exact: true }).click();
  await row.waitFor({ state: 'detached' });
  await external('/api/integration/v1/own/profile', { access: pair.access, expected: 401 });
  await external('/api/integration/v1/token', { body: { grant_type: 'refresh_token',
    client_id: boundary.clientId, refresh_token: pair.refresh }, expected: 401 });
  await Promise.all(inFlight); ensure(!mutationBlocked, 'UNEXPECTED_OR_UNCONFIRMED_MUTATION');
  cleanupArmed = true; await revokeCaptured();
  ensure(baselineProfile === digest((await memberAPI('/api/v1/me')).envelope), 'PROFILE_CHANGED');
  ensure(baselineDevices === digest(devices(await memberAPI('/api/v1/devices'))), 'DEVICE_SET_CHANGED');
  progress('signout'); await page.getByRole('button', { name: 'Sign out', exact: true }).filter({ visible: true }).click();
  await page.waitForURL(stagingOrigin + '/login');
  const ended = await context.request.get(stagingOrigin + '/api/auth/get-session', {
    headers: { Cookie: savedCookie }, maxRedirects: 0, timeout: 30000 });
  ensure(ended.status() === 200 && !(await ended.json())?.user, 'SESSION_STILL_LIVE');
  complete = true;
  result = { v: 1, completedAt: new Date().toISOString(), release, complete: true, totals,
    uiRegistration: true, cancelCreatesNoGrant: true, uiConsent: true, pkceEnforced: true, codeSingleUse: true,
    ownCiphertextOnly: true, missingScopesDenied: true, memberRoutesDenied: true, refreshRotation: true,
    uiRevocation: true, oldAccessAndRefreshDenied: true, profileAndDevicesUnchanged: true,
    scopedCleanup: true, residualRegisteredClient: true, savedSessionRevoked: true };
} catch (error) {
  const code = error instanceof IntegrationCheckError ? error.message :
    error instanceof Error && error.name === 'TimeoutError' ? 'BROWSER_TIMEOUT' : 'INTEGRATION_OPERATION_FAILED';
  console.error(JSON.stringify({ phase, stage, error: 'HOSTED_INTEGRATION_FAILED', code }));
  process.exitCode = 1;
} finally {
  cleanupArmed = true;
  if (context) {
    await Promise.all(inFlight);
    if (!complete) try { await revokeCaptured(); }
      catch { console.error(JSON.stringify({ phase, warning: 'SCOPED_GRANT_CLEANUP_UNCONFIRMED' })); }
    try {
      const cookie = savedCookie || (await context.cookies(stagingOrigin)).map(c => `${c.name}=${c.value}`).join('; ');
      await context.request.post(stagingOrigin + '/api/auth/sign-out', { headers: { Origin: stagingOrigin, Cookie: cookie },
        data: {}, maxRedirects: 0, timeout: 30000 });
      const ended = await context.request.get(stagingOrigin + '/api/auth/get-session', {
        headers: { Cookie: cookie }, maxRedirects: 0, timeout: 30000 });
      ensure(ended.status() === 200 && !(await ended.json())?.user, 'SESSION_STILL_LIVE');
    } catch { process.exitCode = 1; console.error(JSON.stringify({ phase, warning: 'SIGNOUT_UNCONFIRMED' })); }
    try {
      if (page && new URL(page.url()).origin !== stagingOrigin) await page.goto(stagingOrigin + '/login');
      if (page) await page.evaluate(async () => {
        if (!(await indexedDB.databases()).some(d => d.name === 'porchday-device-v1')) return;
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('porchday-device-v1');
          r.onsuccess = () => resolve(r.result); r.onerror = () => reject(Error('Storage unavailable')); });
        try { await new Promise<void>((resolve, reject) => { const tx = db.transaction('devices', 'readwrite');
          tx.objectStore('devices').clear(); tx.oncomplete = () => resolve(); tx.onerror = () => reject(Error('Storage unavailable')); });
        } finally { db.close(); }
      });
      await context.clearCookies();
    } catch { process.exitCode = 1; console.error(JSON.stringify({ phase, warning: 'LOCAL_CLEANUP_UNCONFIRMED' })); }
    try { await context.close(); }
      catch { process.exitCode = 1; console.error(JSON.stringify({ phase, warning: 'BROWSER_CLOSE_UNCONFIRMED' })); }
  }
  try { await callback?.close(); }
    catch { process.exitCode = 1; console.error(JSON.stringify({ phase, warning: 'CALLBACK_CLOSE_UNCONFIRMED' })); }
  if (complete && !process.exitCode) {
    try {
      await receipt('result', result);
      console.log(JSON.stringify({ phase, stage: 'passed', totals, uiConsent: true, pkceEnforced: true,
        scopedCleanup: true, residualRegisteredClient: true }));
    } catch { process.exitCode = 1; console.error(JSON.stringify({ phase, warning: 'RESULT_RECEIPT_UNCONFIRMED' })); }
  }
  if (!complete) console.error(JSON.stringify({ phase, warning: 'INSPECT_PRIVATE_INTENT_BEFORE_RETRY' }));
}
