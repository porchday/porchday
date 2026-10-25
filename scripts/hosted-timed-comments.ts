/** Opt-in A-only real UI deadline acceptance; never attaches to the user's browser. */
import { chromium, type BrowserContext, type Page, type Request, type Locator } from 'playwright';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { decryptObject, encryptObject, signStatement, unlockPrivateKey, type EncryptedEnvelope,
  type UnlockedPrivateKey } from '@porchday/crypto';
import { check, readPrivate, writePrivate, stagingOrigin, SmokeClient, SmokeError } from './hosted-smoke-support.js';
import { explicitAttempt, captureTimedWrite, assertTimedPayload, responseAfterAction, uuid,
  type ExpectedWrite, type TimedBoundary, type CapturedWrite } from './hosted-timed-comments-support.js';

const directory = 'artifacts/private/hosted-smoke/', phase = 'timed-comments';
let stage = 'preflight', attempt = '', sequence = 0, complete = false, cleanupArmed = false;
let blocked = false, uncertain = false, loginStarted = false, shortened = false;
let context: BrowserContext | undefined, page: Page | undefined, a: any, savedCookie = '';
let boundary: TimedBoundary | undefined, key: UnlockedPrivateKey | undefined, editor: SmokeClient | undefined;
let baselineProfile = '', baselineDevices = '', postText = '', result: Record<string, unknown> | undefined;
const publicKeys = new Map<string, string>(), mutations: Promise<void>[] = [];
const expectedTexts = new Map<string, string>();
const progress = (next: string) => { stage = next; console.log(JSON.stringify({ phase, stage })); };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const deviceRows = (value: any): any[] => Array.isArray(value) ? value : value.items || value.devices || [];
const deviceDigest = (value: any) => digest(deviceRows(value).map(d => [d.id, d.fingerprint, d.revoked_at]).sort());
async function receipt(kind: string, value: unknown) {
  await writePrivate(directory + `timed-comments-${attempt}-${String(++sequence).padStart(3, '0')}-${kind}.json`, value, true);
}
async function api(path: string, method = 'GET', expected = 200) {
  check(context && (method === 'GET' && (['/api/v1/me', '/api/v1/devices'].includes(path) ||
    boundary?.postId && path === '/api/v1/posts/' + boundary.postId) || method === 'DELETE' && boundary &&
    (path === '/api/v1/posts/' + boundary.postId || path.startsWith('/api/v1/comments/') &&
      boundary.captured.get(path.slice('/api/v1/comments/'.length))?.kind === 'comment')), 'TIMED_API_BOUNDARY');
  const response = await context!.request.fetch(stagingOrigin + path, {
    method, headers: { Origin: stagingOrigin }, maxRedirects: 0, timeout: 30000,
  });
  check(response.status() === expected, 'TIMED_API_STATUS');
  check(response.headers()['cache-control']?.includes('no-store'), 'PRIVATE_RESPONSE_CACHEABLE');
  return response.json();
}
async function opened(envelope: EncryptedEnvelope) {
  check(key && envelope?.context.authorId === a.id && publicKeys.has(envelope.context.authorDeviceId), 'TIMED_AUTHOR_BOUNDARY');
  return decryptObject<any>({ envelope, expectedContext: envelope.context, privateKey: key!,
    authorPublicKey: publicKeys.get(envelope.context.authorDeviceId)! });
}
function observe(request: Request) {
  mutations.push(new Promise<void>(resolve => {
    const finish = (failed = false) => {
      if (failed) { uncertain = true; blocked = true; }
      clearTimeout(timer); context!.off('requestfinished', done); context!.off('requestfailed', bad); resolve();
    };
    const done = (r: Request) => { if (r === request) finish(); };
    const bad = (r: Request) => { if (r === request) finish(true); };
    const timer = setTimeout(() => finish(true), 45000);
    context!.on('requestfinished', done); context!.on('requestfailed', bad);
  }));
}
function form() { return page!.locator('form.comment-composer'); }
async function warning(parent: string, reply: boolean, fromPost = false) {
  const text = await form().locator('.timer-warning').innerText();
  check(text.includes(reply ? 'This reply will be deleted with the comment on' : 'This comment will be deleted with the post on') &&
    text.includes('You can make its timeout shorter.') &&
    text.includes('This deadline is inherited from the original post.') === fromPost, 'TIMED_WARNING_WORDING');
  const shown = await form().locator('.timer-warning strong').innerText();
  const expected = await page!.evaluate(value => {
    let timeZone: string | undefined;
    try { timeZone = localStorage.getItem('porchday-timezone') || undefined; if (timeZone) new Intl.DateTimeFormat(undefined, { timeZone }).format(); }
    catch { timeZone = undefined; }
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(value));
  }, parent);
  check(shown === expected, 'TIMED_WARNING_DEADLINE');
}
async function selectCustom(locator: Locator, expiry: string) {
  await locator.getByLabel('Expiration', { exact: true }).selectOption('custom');
  // This test's browser timezone is UTC; the shipped datetime-local conversion remains unchanged.
  await locator.getByLabel('Custom expiration date and time', { exact: true }).fill(expiry.slice(0, 16));
}
async function submit(planned: ExpectedWrite, keyboard = false) {
  check(boundary && !boundary.expected && !cleanupArmed, 'TIMED_WRITE_NOT_ARMED');
  boundary.expected = planned;
  const path = planned.kind === 'post' ? '/api/v1/posts' : '/api/v1/posts/' + boundary.postId + '/comments';
  const target = planned.kind === 'post' ? page!.locator('form.composer') : form();
  const button = target.getByRole('button', { name: planned.kind === 'post' ? 'Share' : planned.parentId === boundary.postId ? 'Comment' : 'Reply', exact: true });
  const response = await responseAfterAction(page!.waitForResponse(r => r.url() === stagingOrigin + path && r.request().method() === 'POST'), async () => {
    if (keyboard) { await button.focus(); check(await button.evaluate(node => document.activeElement === node), 'KEYBOARD_FOCUS_MISSING'); await page!.keyboard.press('Enter'); }
    else await button.click();
  });
  check(response.status() === planned.expectedStatus && planned.capturedId, 'TIMED_SUBMISSION_STATUS');
  const body = await response.json(), captured = boundary.captured.get(planned.capturedId)!;
  if (planned.expectedStatus === 201) {
    check(body.id === captured.id, 'TIMED_ID_MISMATCH'); captured.accepted = true;
    expectedTexts.set(captured.id, planned.text);
    await page!.getByText(planned.text, { exact: true }).waitFor({ timeout: 60000 });
    if (planned.kind === 'comment') await page!.getByLabel('Write a comment', { exact: true }).waitFor();
  } else check(body?.error?.code === 'PARENT_DEADLINE_CHANGED', 'REAL_STALE_DEADLINE_REQUIRED');
  await receipt('submission', { ...captured, status: response.status() }); boundary.expected = undefined;
  return captured;
}
async function comment(text: string, parentId: string, parentExpiry: string, expiry = parentExpiry, keyboard = false) {
  const reply = parentId !== boundary!.postId;
  await form().getByLabel(reply ? 'Write a reply' : 'Write a comment', { exact: true }).fill(text);
  if (expiry === parentExpiry) await form().getByLabel('Expiration', { exact: true }).selectOption('inherit');
  else await selectCustom(form(), expiry);
  return submit({ kind: 'comment', parentId, expiresAt: expiry, acknowledged: parentExpiry, text, expectedStatus: 201 }, keyboard);
}
async function replyTo(text: string) {
  const row = page!.locator('.comment').filter({ has: page!.getByText(text, { exact: true }) });
  await row.getByRole('button', { name: 'Reply', exact: true }).click();
  await form().getByLabel('Write a reply', { exact: true }).waitFor();
}
async function cleanup() {
  cleanupArmed = true; if (!context || !boundary?.postId) return;
  const response = await context.request.get(stagingOrigin + '/api/v1/posts/' + boundary.postId, { maxRedirects: 0, timeout: 30000 });
  check([200, 404].includes(response.status()), 'TIMED_CLEANUP_READ_FAILED');
  if (response.status() === 200) {
    const row = (await response.json()).post, c = row?.envelope?.context;
    check(c?.id === boundary.postId && c.authorId === a.id && c.kind === 'post' && c.audience === 'only_me' &&
      c.groupId === null && c.parentId === null && boundary.captured.has(c.id) &&
      (await opened(row.envelope)).text === postText, 'TIMED_CLEANUP_OWNERSHIP');
    await receipt('delete-parent-intent', { id: boundary.postId });
    await api('/api/v1/posts/' + boundary.postId, 'DELETE');
  }
  await api('/api/v1/posts/' + boundary.postId, 'GET', 404);
  // Ordinary endpoints must deny every captured child after the parent deletion.
  // This proves API-level cascade/access removal, not physical backup erasure.
  for (const value of boundary.captured.values()) if (value.kind === 'comment')
    await api('/api/v1/comments/' + value.id, 'DELETE', 404);
  check(!uncertain, 'TIMED_MUTATION_OUTCOME_UNCONFIRMED');
  await receipt('cleanup', { postDeleted: true, childIDsDenied: boundary.captured.size - 1, physicalBackupErasureClaimed: false });
}

try {
  attempt = explicitAttempt(process.argv.slice(2));
  const state = await readPrivate<any>(directory + 'state.json'); a = state.accounts?.[0];
  check(state.v === 1 && state.synthetic === true && state.origin === stagingOrigin && /^[a-f0-9]{10}$/.test(state.run) &&
    a?.handle === `qa_${state.run}_0` && uuid.test(a.id) && !a.deleted && a.device?.enrolled &&
    a.password?.length >= 32 && a.device.keys.recoverySecret && state.accounts[2]?.deleted === true, 'SYNTHETIC_A_ONLY_REQUIRED');
  const health = await fetch(stagingOrigin + '/health', { redirect: 'error', signal: AbortSignal.timeout(30000) });
  const release = await health.json() as any;
  check(health.ok && release.status === 'ok' && release.environment === 'staging', 'STAGING_HEALTH_REQUIRED');
  const minute = Math.ceil(Date.now() / 60000) * 60000;
  const parentExpiry = new Date(minute + 120 * 60000).toISOString(), shortExpiry = new Date(minute + 60 * 60000).toISOString();
  const updatedExpiry = new Date(minute + 90 * 60000).toISOString(); postText = `Synthetic timed-comment acceptance ${attempt}`;
  await writePrivate(directory + `timed-comments-${attempt}.intent.json`, { v: 1, synthetic: true, origin: stagingOrigin,
    member: a.id, release, startedAt: new Date().toISOString(), parentExpiry, shortExpiry, updatedExpiry,
    effects: ['A existing-device UI login', 'one private timed UI post', 'five UI comments or replies and one rejected stale submission',
      'one normal signed parent timer shortening in a separate A session', 'captured parent cascade deletion', 'both sessions signout'],
    maxCreatedPosts: 1, maxAcceptedComments: 5, maxCommentAttempts: 6 }, true);
  const profile = resolve(directory + 'isolated-browser-profile'), stat = await lstat(profile);
  check(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0, 'EXISTING_ISOLATED_PROFILE_REQUIRED');
  key = await unlockPrivateKey(a.device.keys.encryptedPrivateKey, a.device.keys.recoverySecret, a.device.keys.fingerprint);
  context = await chromium.launchPersistentContext(profile, { headless: true, viewport: { width: 375, height: 900 },
    timezoneId: 'UTC', acceptDownloads: false, serviceWorkers: 'block' }); context.setDefaultTimeout(30000);
  await context.route('**/*', async route => {
    let forwarded = false;
    try {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      check(url.origin === stagingOrigin && !url.username && !url.password, 'TIMED_BROWSER_ORIGIN');
      if (['GET', 'HEAD'].includes(method)) { await route.continue(); return; }
      check(!url.search && !url.hash, 'TIMED_MUTATION_QUERY');
      const body = request.postData() ? request.postDataJSON() : undefined;
      if (method === 'POST' && url.pathname === '/api/auth/sign-in/email') {
        check(stage === 'login' && !loginStarted && body?.email === a.email && body.password === a.password &&
          body.callbackURL === '/app' && Object.keys(body).length === 3, 'TIMED_LOGIN_BOUNDARY');
        loginStarted = true; await receipt('login-intent', { member: a.id });
      } else if (method === 'POST' && url.pathname === '/api/auth/sign-out') {
        await receipt('signout-intent', { member: a.id });
      } else {
        check(method === 'POST' && !cleanupArmed && boundary?.expected, 'TIMED_UNEXPECTED_MUTATION');
        const captured = captureTimedWrite(url.pathname, body, boundary!);
        boundary!.expected!.capturedId = captured.id;
        assertTimedPayload(await opened(body.envelope), boundary!.expected!);
        boundary!.captured.set(captured.id, captured);
        if (captured.kind === 'post') boundary!.postId = captured.id;
        await receipt('write-intent', captured);
      }
      observe(request); forwarded = true; await route.continue();
    } catch { blocked = true; if (forwarded) uncertain = true; await route.abort().catch(() => {}); }
  });
  page = context.pages()[0] || await context.newPage();
  progress('login'); await page.goto(stagingOrigin + '/login');
  await page.getByLabel('Email address', { exact: true }).fill(a.email);
  await page.getByLabel('Password', { exact: true }).fill(a.password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click(); await page.waitForURL(stagingOrigin + '/app');
  savedCookie = (await context.cookies(stagingOrigin)).map(c => `${c.name}=${c.value}`).join('; ');
  check(savedCookie, 'BROWSER_SESSION_REQUIRED'); const me = await api('/api/v1/me'); check(me.id === a.id, 'WRONG_MEMBER');
  baselineProfile = digest(me.envelope); const beforeDevices = await api('/api/v1/devices'); baselineDevices = deviceDigest(beforeDevices);
  const active = await page.evaluate(id => localStorage.getItem(`porchday-device:${id}`), a.id);
  check(deviceRows(beforeDevices).some(d => d.id === active && !d.revoked_at) && uuid.test(active || ''), 'EXISTING_DEVICE_REQUIRED');
  for (const d of deviceRows(beforeDevices)) if (d.member_id === a.id && !d.revoked_at) publicKeys.set(d.id, d.public_key);
  check(publicKeys.has(active!) && publicKeys.has(a.device.id), 'TRUSTED_KEY_DIRECTORY_REQUIRED');
  boundary = { member: a.id, device: active!, captured: new Map() };
  progress('unlock-existing-device'); await page.getByRole('heading', { name: 'Unlock this device', exact: true }).waitFor();
  await page.getByLabel('Encryption recovery secret', { exact: true }).fill(a.device.keys.recoverySecret);
  await page.getByRole('checkbox', { name: /Remember this private device/ }).check();
  await page.getByRole('button', { name: 'Unlock my circle', exact: true }).click();
  await page.getByText('FROM YOUR PEOPLE', { exact: true }).waitFor({ timeout: 90000 });
  check(baselineDevices === deviceDigest(await api('/api/v1/devices')), 'DEVICE_SET_CHANGED');
  progress('create-private-timed-post'); const composer = page.locator('form.composer');
  await composer.getByLabel('Write a post', { exact: true }).fill(postText);
  await composer.getByLabel('Post audience', { exact: true }).selectOption('only_me');
  await selectCustom(composer, parentExpiry);
  await submit({ kind: 'post', parentId: null, expiresAt: parentExpiry, acknowledged: null, text: postText, expectedStatus: 201 }, true);
  await page.goto(stagingOrigin + '/app/post/' + boundary.postId); await page.getByText(postText, { exact: true }).waitFor();
  await form().getByLabel('Write a comment', { exact: true }).waitFor();
  progress('inherited-warning-and-input-bound'); await warning(parentExpiry, false);
  check(await form().getByLabel('Expiration', { exact: true }).inputValue() === 'inherit', 'DEFAULT_INHERIT_REQUIRED');
  await form().getByLabel('Write a comment', { exact: true }).fill(`Synthetic inherited comment ${attempt}`);
  await selectCustom(form(), new Date(Date.parse(parentExpiry) + 60000).toISOString());
  const custom = form().getByLabel('Custom expiration date and time', { exact: true });
  check(await custom.getAttribute('max') === parentExpiry.slice(0, 16), 'CUSTOM_MAX_MISMATCH');
  check(await custom.evaluate((node: HTMLInputElement) => node.validity.rangeOverflow && !node.checkValidity()), 'CUSTOM_OVERFLOW_NOT_INVALID');
  const countBeforeInvalid = boundary.captured.size;
  await form().getByRole('button', { name: 'Comment', exact: true }).focus(); await page.keyboard.press('Enter');
  check(await custom.evaluate(node => document.activeElement === node) && boundary.captured.size === countBeforeInvalid && !blocked,
    'INVALID_CUSTOM_TIME_SUBMITTED');
  await form().getByLabel('Expiration', { exact: true }).selectOption('inherit');
  const inheritedText = `Synthetic inherited comment ${attempt}`;
  const inherited = await comment(inheritedText, boundary.postId!, parentExpiry, parentExpiry, true);
  progress('shorter-comment'); const shorterText = `Synthetic shorter comment ${attempt}`;
  const shorter = await comment(shorterText, boundary.postId!, parentExpiry, shortExpiry);
  progress('reply-inherits-post'); await replyTo(inheritedText); await warning(parentExpiry, true, true);
  check(await form().getByLabel('Expiration', { exact: true }).inputValue() === 'inherit', 'REPLY_DEFAULT_INHERIT_REQUIRED');
  await comment(`Synthetic inherited reply ${attempt}`, inherited.id, parentExpiry, parentExpiry, true);
  progress('reply-inherits-shorter-comment'); await replyTo(shorterText); await warning(shortExpiry, true, false);
  await form().getByLabel('Expiration', { exact: true }).selectOption('custom');
  check(await form().getByLabel('Custom expiration date and time', { exact: true }).getAttribute('max') === shortExpiry.slice(0, 16),
    'SHORT_REPLY_MAX_MISMATCH');
  await comment(`Synthetic shorter-parent reply ${attempt}`, shorter.id, shortExpiry);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'MOBILE_HORIZONTAL_OVERFLOW');
  progress('stale-draft-prepare'); const draft = `Synthetic preserved stale draft ${attempt}`;
  await form().getByLabel('Write a comment', { exact: true }).fill(draft); await warning(parentExpiry, false);
  // Separate ordinary A session, not a browser state injection or test-only endpoint.
  editor = new SmokeClient(); await receipt('editor-login-intent', { member: a.id });
  await editor.json('/api/auth/sign-in/email', 'POST', { email: a.email, password: a.password });
  check((await editor.json('/api/v1/me')).id === a.id, 'EDITOR_MEMBER_MISMATCH');
  const old = (await editor.json('/api/v1/posts/' + boundary.postId)).post;
  check(old.envelope.context.id === boundary.postId && old.envelope.context.revision === 1 && old.envelope.context.expiresAt === parentExpiry &&
    old.envelope.context.authorId === a.id && old.envelope.context.audience === 'only_me', 'EDITOR_CAPTURED_POST_REQUIRED');
  const payload = await opened(old.envelope); check(payload.text === postText, 'EDITOR_SOURCE_MISMATCH');
  const audience = await editor.json('/api/v1/audiences?' + new URLSearchParams({ audience: 'only_me', post_id: boundary.postId! }));
  check(!audience.pending_members?.length && audience.devices.length > 0 && audience.devices.every((d: any) => d.member_id === a.id), 'EDITOR_AUDIENCE_BOUNDARY');
  const envelope = await encryptObject({ payload, signingKey: key, context: { ...old.envelope.context,
    authorDeviceId: a.device.id, epoch: audience.epoch, revision: 2, expiresAt: updatedExpiry },
    recipients: audience.devices.map((d: any) => ({ memberId: d.member_id, deviceId: d.id, publicKey: d.public_key })) });
  const lifecycle = await signStatement({ purpose: 'porchday-lifecycle', id: boundary.postId, revision: 2, expiresAt: updatedExpiry }, key);
  check(!shortened, 'PARENT_SHORTENING_ALREADY_ATTEMPTED'); shortened = true;
  await receipt('shorten-parent-intent', { id: boundary.postId, oldExpiry: parentExpiry, expiresAt: updatedExpiry, revision: 2 });
  await editor.json('/api/v1/posts/' + boundary.postId, 'PUT', { envelope, lifecycle });
  await warning(parentExpiry, false); check(await form().getByLabel('Write a comment', { exact: true }).inputValue() === draft, 'STALE_DRAFT_CHANGED');
  progress('real-stale-rejection');
  const rejected = await submit({ kind: 'comment', parentId: boundary.postId!, expiresAt: parentExpiry,
    acknowledged: parentExpiry, text: draft, expectedStatus: 409 }, true);
  await form().getByRole('alert').filter({ hasText: 'The parent’s timer changed. Review the updated deadline below, then submit again.' }).waitFor();
  check(await form().getByLabel('Write a comment', { exact: true }).inputValue() === draft, 'REJECTED_DRAFT_LOST');
  await warning(updatedExpiry, false);
  const beforeRetry = await api('/api/v1/posts/' + boundary.postId);
  check(beforeRetry.comments.length === 4 && !beforeRetry.comments.some((r: any) => r.id === rejected.id), 'STALE_ATTEMPT_COMMITTED');
  check(!boundary.expected, 'STALE_ATTEMPT_RETRIED_AUTOMATICALLY');
  progress('explicit-reconfirmation');
  await comment(draft, boundary.postId!, updatedExpiry, updatedExpiry, true);
  const final = await api('/api/v1/posts/' + boundary.postId);
  check(final.post.envelope.context.revision === 2 && final.post.expires_at && Date.parse(final.post.expires_at) === Date.parse(updatedExpiry) &&
    final.comments.length === 5, 'FINAL_TIMED_STATE_MISMATCH');
  for (const row of final.comments) {
    const captured = boundary.captured.get(row.id); check(captured?.accepted && captured.kind === 'comment', 'UNEXPECTED_FINAL_COMMENT');
    check((await opened(row.envelope)).text === expectedTexts.get(row.id) && row.envelope.context.expiresAt === captured.expiresAt &&
      Date.parse(row.effective_expires_at) === Math.min(Date.parse(captured.expiresAt), Date.parse(updatedExpiry)), 'FINAL_COMMENT_DEADLINE_MISMATCH');
  }
  await Promise.all(mutations); check(!blocked, 'TIMED_UNEXPECTED_OR_UNCONFIRMED_MUTATION');
  progress('scoped-cascade-cleanup'); await cleanup();
  check(baselineProfile === digest((await api('/api/v1/me')).envelope) && baselineDevices === deviceDigest(await api('/api/v1/devices')),
    'PROFILE_OR_DEVICES_CHANGED');
  // Leave the deleted post before signing out, with no unsaved draft present.
  await page.goto(stagingOrigin + '/app'); progress('signout');
  await page.getByRole('button', { name: 'Sign out', exact: true }).filter({ visible: true }).click();
  await page.waitForURL(stagingOrigin + '/login');
  const ended = await context.request.get(stagingOrigin + '/api/auth/get-session', { headers: { Cookie: savedCookie }, maxRedirects: 0, timeout: 30000 });
  check(ended.status() === 200 && !(await ended.json())?.user, 'BROWSER_SESSION_STILL_LIVE');
  complete = true; result = { v: 1, completedAt: new Date().toISOString(), release, complete: true,
    createdPosts: 1, acceptedComments: 5, rejectedStaleComments: 1, inheritedWarning: true, shorterComment: true,
    replyOriginalPostWarning: true, replyShorterParentWarning: true, customInputMaxEnforced: true,
    mobileWidth: 375, horizontalOverflow: false, keyboardActivation: true, realParentDeadline409: true,
    draftPreserved: true, explicitReconfirmation: true, decryptedFinalComments: 5, cascadeAPIDenial: true,
    profileAndDevicesUnchanged: true, physicalBackupErasureClaimed: false };
} catch (error) {
  console.error(JSON.stringify({ phase, stage, error: 'HOSTED_TIMED_COMMENTS_FAILED', code: error instanceof SmokeError ? error.message :
    error instanceof Error && error.name === 'TimeoutError' ? 'BROWSER_TIMEOUT' : 'TIMED_OPERATION_FAILED' })); process.exitCode = 1;
} finally {
  cleanupArmed = true;
  if (context) {
    await Promise.all(mutations);
    if (!complete) try { await cleanup(); } catch { process.exitCode = 1; console.error(JSON.stringify({ phase, warning: 'TIMED_CONTENT_CLEANUP_UNCONFIRMED' })); }
    try {
      const cookie = savedCookie || (await context.cookies(stagingOrigin)).map(c => `${c.name}=${c.value}`).join('; ');
      await context.request.post(stagingOrigin + '/api/auth/sign-out', { headers: { Origin: stagingOrigin, Cookie: cookie }, data: {}, maxRedirects: 0, timeout: 30000 });
      const ended = await context.request.get(stagingOrigin + '/api/auth/get-session', { headers: { Cookie: cookie }, maxRedirects: 0, timeout: 30000 });
      check(ended.status() === 200 && !(await ended.json())?.user, 'BROWSER_SESSION_STILL_LIVE');
    } catch { process.exitCode = 1; console.error(JSON.stringify({ phase, warning: 'BROWSER_SIGNOUT_UNCONFIRMED' })); }
    try {
      if (page && new URL(page.url()).origin !== stagingOrigin) await page.goto(stagingOrigin + '/login');
      if (page) await page.evaluate(async () => {
        if (!(await indexedDB.databases()).some(d => d.name === 'porchday-device-v1')) return;
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('porchday-device-v1');
          r.onsuccess = () => resolve(r.result); r.onerror = () => reject(Error('Storage unavailable')); });
        try { await new Promise<void>((resolve, reject) => { const tx = db.transaction('devices', 'readwrite');
          tx.objectStore('devices').clear(); tx.oncomplete = () => resolve(); tx.onerror = () => reject(Error('Storage unavailable')); }); }
        finally { db.close(); }
      });
      await context.clearCookies();
    } catch { process.exitCode = 1; console.error(JSON.stringify({ phase, warning: 'LOCAL_KEY_CLEANUP_UNCONFIRMED' })); }
    try { await context.close(); } catch { process.exitCode = 1; console.error(JSON.stringify({ phase, warning: 'BROWSER_CLOSE_UNCONFIRMED' })); }
  }
  if (editor) try {
    const cookie = editor.cookieHeader(); await editor.json('/api/auth/sign-out', 'POST', {});
    const ended = await editor.request('/api/auth/get-session', 'GET', undefined, cookie);
    check(ended.status === 200 && !(await ended.json() as any)?.user, 'EDITOR_SESSION_STILL_LIVE');
  } catch { process.exitCode = 1; console.error(JSON.stringify({ phase, warning: 'EDITOR_SIGNOUT_UNCONFIRMED' })); }
  if (complete && !process.exitCode) try {
    await receipt('result', { ...result, bothSessionsRevoked: true, localKeysCleared: true });
    console.log(JSON.stringify({ phase, stage: 'passed', acceptedComments: 5, realStaleRejection: true, scopedCleanup: true }));
  } catch { process.exitCode = 1; console.error(JSON.stringify({ phase, warning: 'RESULT_RECEIPT_UNCONFIRMED' })); }
  if (!complete) console.error(JSON.stringify({ phase, warning: 'INSPECT_PRIVATE_INTENT_BEFORE_RETRY' }));
}
