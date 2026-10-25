/** Explicit, bounded A-only staging fixture. No operator credentials or device-revocation guesses. */
import { randomUUID } from 'node:crypto';
import { canonicalJson, createReactionSecret, decryptObject, encryptObject, reactionTag, unlockPrivateKey,
  type ContentContext, type EncryptedEnvelope, type UnlockedPrivateKey } from '../packages/crypto/src/index.js';
import { check, readPrivate, writePrivate, SmokeClient, SmokeError, stagingOrigin } from './hosted-smoke-support.js';
import { readHostedFixture, socialFixtureText, type HostedSocialFixture } from './hosted-ios-support.js';
import { expectedSocialContext, requireSyntheticA, socialArguments, verifyBaseline, type Baseline } from './hosted-social-interop-support.js';

const directory = 'artifacts/private/hosted-smoke/';
type Intent = { v: 1; synthetic: true; phase: 'native-social'; createdAt: string; fixture: HostedSocialFixture; baseline: Baseline;
  webDeviceId: string; webPublicKey: string; postSecret: string; commentSecret: string; replySecret: string };
type Result = { phase: string; complete: boolean; failure: string | null; logout: boolean; mutationUnconfirmed: boolean; cleanup?: boolean; nativeDeviceId?: string };
let phase = 'preflight', attempt = '', api: SmokeClient | undefined, signedIn = false, loginAttempted = false;
let intent: Intent | undefined, account: any, key: UnlockedPrivateKey | undefined;
let operationComplete = false, cleanupConfirmed: boolean | undefined, failure: string | null = null, nativeDeviceId: string | undefined;
let mutationUnconfirmed = false;
let preparedConfirmed = false;
const file = (suffix: string) => directory + `native-social-${attempt}-${suffix}.json`;
const safeError = (error: unknown) => error instanceof SmokeError && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'SOCIAL_INTEROP_FAILED';

async function baseline(): Promise<Baseline> {
  const profile = await api!.json('/api/v1/profiles/member/' + account.id);
  const devices = await api!.json('/api/v1/devices');
  const backup = await api!.json('/api/v1/keys/backup');
  check(Array.isArray(devices.items) && backup.envelope?.v === 1, 'BASELINE_INVALID');
  return { profile, devices: devices.items, backup: backup.envelope };
}

async function login() {
  api = new SmokeClient(); loginAttempted = true;
  await api.json('/api/auth/sign-in/email', 'POST', { email: account.email, password: account.password });
  signedIn = true;
  const session = await api.json('/api/auth/get-session'), me = await api.json('/api/v1/me');
  check(session.user?.email?.toLowerCase() === account.email.toLowerCase() && session.user.emailVerified === true &&
    me.id === account.id && me.handle === account.handle && me.status === 'active', 'VERIFIED_A_REQUIRED');
  key = await unlockPrivateKey(account.device.keys.encryptedPrivateKey, account.device.keys.recoverySecret, account.device.keys.fingerprint);
}

async function logout(): Promise<boolean> {
  if (!api || !loginAttempted) return true;
  const cookie = api.cookieHeader();
  // A failed sign-in may have created a session before its response was lost.
  // The cleanup is attempted, but a failure never replaces the original code.
  const response = await api.request('/api/auth/sign-out', 'POST', {});
  check(response.status === 200 || !signedIn && response.status === 401, 'SIGNOUT_UNCONFIRMED');
  const session = await api.json('/api/auth/get-session');
  check(!session?.user?.id, 'SESSION_NOT_CLEARED');
  if (cookie) {
    const replay = await api.request('/api/v1/me', 'GET', undefined, cookie);
    check(replay.status === 401, 'SAVED_SESSION_NOT_REVOKED');
  }
  return true;
}

async function seal(payload: unknown, c: Pick<ContentContext, 'id' | 'kind' | 'parentId' | 'expiresAt'>) {
  const query = new URLSearchParams({ audience: 'only_me' });
  if (c.kind !== 'post') query.set('post_id', intent!.fixture.webPostId);
  const audience = await api!.json('/api/v1/audiences?' + query);
  check(!audience.pending_members?.length && audience.devices?.length > 0 && audience.devices.length <= 8 &&
    audience.devices.every((d: any) => d.member_id === account.id), 'PRIVATE_AUDIENCE_REQUIRED');
  return encryptObject({ payload, signingKey: key!, context: { ...c, authorId: account.id, authorDeviceId: account.device.id,
    audience: 'only_me', groupId: null, epoch: audience.epoch, createdAt: new Date().toISOString(), revision: 1 },
  recipients: audience.devices.map((d: any) => ({ memberId: d.member_id, deviceId: d.id, publicKey: d.public_key })) });
}

async function publish(path: string, method: string, body: unknown, status = 200) {
  mutationUnconfirmed = true;
  const result = await api!.json(path, method, body, status);
  mutationUnconfirmed = false;
  return result;
}

async function prepare(state: any) {
  const snapshot = await baseline();
  check(snapshot.devices.some(d => d.id === account.device.id && !d.revoked_at && d.fingerprint === account.device.keys.fingerprint) &&
    snapshot.devices.filter(d => !d.revoked_at).length < 8 && snapshot.backup.devices.length < 32, 'ENROLLMENT_CAPACITY_REQUIRED');
  const expiry = Date.now() + 7_200_000;
  const fixture: HostedSocialFixture = { v: 2, synthetic: true, scenario: 'comments-reactions', origin: stagingOrigin,
    run: state.run, attempt, expiresAt: new Date(expiry).toISOString(), email: account.email, password: account.password,
    memberId: account.id, recoverySecret: account.device.keys.recoverySecret, webPostId: randomUUID(), webCommentId: randomUUID(),
    webReplyId: randomUUID(), nativeCommentId: randomUUID(), nativeReplyId: randomUUID(),
    webCommentExpiresAt: new Date(expiry - 600_000).toISOString(), webReplyExpiresAt: new Date(expiry - 1_200_000).toISOString() };
  readHostedFixture(Buffer.from(JSON.stringify(fixture)).toString('base64'));
  intent = { v: 1, synthetic: true, phase: 'native-social', createdAt: new Date().toISOString(), fixture, baseline: snapshot,
    webDeviceId: account.device.id, webPublicKey: account.device.keys.publicKey,
    postSecret: createReactionSecret(), commentSecret: createReactionSecret(), replySecret: createReactionSecret() };
  // Exclusive immutable intent before the first content mutation; an uncertain run is never replayed.
  await writePrivate(file('intent'), intent, true);
  try {
    await publish('/api/v1/posts', 'POST', { envelope: await seal({ text: socialFixtureText(fixture, 'post'),
      reactionSecret: intent.postSecret, media: [] }, { id: fixture.webPostId, kind: 'post', parentId: null, expiresAt: fixture.expiresAt }), media_ids: [] }, 201);
    for (const [id, parent, kind, secret, expiry, parentExpiry] of [
      [fixture.webCommentId, fixture.webPostId, 'web-comment', intent.commentSecret, fixture.webCommentExpiresAt, fixture.expiresAt],
      [fixture.webReplyId, fixture.webCommentId, 'web-reply', intent.replySecret, fixture.webReplyExpiresAt, fixture.webCommentExpiresAt],
    ] as const) {
      await publish('/api/v1/posts/' + fixture.webPostId + '/comments', 'POST', { envelope: await seal({
        text: socialFixtureText(fixture, kind), reactionSecret: secret }, { id, kind: 'comment', parentId: parent, expiresAt: expiry }),
      parent_expires_at: parentExpiry }, 201);
    }
    for (const [kind, target, secret, expiry] of [
      ['posts', fixture.webPostId, intent.postSecret, fixture.expiresAt],
      ['comments', fixture.webCommentId, intent.commentSecret, fixture.webCommentExpiresAt],
    ] as const) for (const emoji of ['like', 'love']) {
      const tag = await reactionTag({ secret, targetId: target, memberId: account.id, emoji });
      await publish(`/api/v1/${kind}/${target}/reactions/${tag}`, 'PUT', { envelope: await seal({ emoji },
        { id: tag, kind: 'reaction', parentId: target, expiresAt: expiry }) });
    }
    await verifyContent(false);
    verifyBaseline(snapshot, await baseline(), account.id, null);
    await writePrivate(file('fixture'), fixture, true);
  } catch (error) {
    // Deleting the one preallocated parent is idempotent; never delete or revoke an inferred ID.
    try {
      await deleteFixture(); verifyBaseline(snapshot, await baseline(), account.id, null);
      // A missing row does not prove that a timed-out publication cannot commit later.
      cleanupConfirmed = !mutationUnconfirmed;
    } catch { cleanupConfirmed = false; }
    throw error;
  }
}

async function openRow(row: any, id: string, kind: 'post' | 'comment' | 'reaction', parent: string | null,
  expiry: string, authorDeviceId: string, publicKey: string) {
  check(row?.envelope, 'ENVELOPE_MISSING');
  const expectedContext = expectedSocialContext(row.envelope, intent!.fixture, { id, kind, parent, expiry, authorDeviceId });
  if (kind !== 'reaction') check(row.id === id, 'RESOURCE_ID_MISMATCH');
  return decryptObject<Record<string, any>>({ envelope: row.envelope as EncryptedEnvelope, expectedContext, privateKey: key!, authorPublicKey: publicKey });
}

async function verifyContent(native: boolean) {
  const f = intent!.fixture, detail = await api!.json('/api/v1/posts/' + f.webPostId);
  check(Array.isArray(detail.comments) && detail.comments.length === (native ? 4 : 2), 'COMMENT_COUNT_MISMATCH');
  const post = await openRow(detail.post, f.webPostId, 'post', null, f.expiresAt, intent!.webDeviceId, intent!.webPublicKey);
  check(post.text === socialFixtureText(f, 'post') && post.reactionSecret === intent!.postSecret && canonicalJson(post.media) === '[]', 'WEB_POST_MISMATCH');
  for (const [id, parent, kind, secret, expiry] of [
    [f.webCommentId, f.webPostId, 'web-comment', intent!.commentSecret, f.webCommentExpiresAt],
    [f.webReplyId, f.webCommentId, 'web-reply', intent!.replySecret, f.webReplyExpiresAt],
  ] as const) {
    const payload = await openRow(detail.comments.find((r: any) => r.id === id), id, 'comment', parent, expiry, intent!.webDeviceId, intent!.webPublicKey);
    check(payload.text === socialFixtureText(f, kind) && payload.reactionSecret === secret, 'WEB_COMMENT_MISMATCH');
  }
  let nativePublicKey: string | undefined;
  if (native) {
    const nativeComment = detail.comments.find((r: any) => r.id === f.nativeCommentId), nativeReply = detail.comments.find((r: any) => r.id === f.nativeReplyId);
    const deviceId = nativeComment?.envelope?.context?.authorDeviceId;
    check(typeof deviceId === 'string' && !intent!.baseline.devices.some(d => d.id === deviceId), 'FRESH_NATIVE_AUTHOR_REQUIRED');
    const current = await baseline(), device = current.devices.find(d => d.id === deviceId);
    check(device && device.member_id === account.id && !!device.revoked_at, 'NATIVE_DEVICE_NOT_REVOKED');
    // This ID is observed in signed test content, then validated against the historic key route. It is never used to revoke.
    const author = await api!.json('/api/v1/devices/' + deviceId);
    check(author.id === device.id && author.member_id === account.id && author.public_key === device.public_key &&
      author.fingerprint === device.fingerprint, 'HISTORICAL_NATIVE_KEY_MISMATCH');
    nativePublicKey = author.public_key;
    const inherited = await openRow(nativeComment, f.nativeCommentId, 'comment', f.webPostId, f.expiresAt, deviceId, author.public_key);
    check(inherited.text === socialFixtureText(f, 'native-comment') && inherited.requestedDeadline === f.expiresAt, 'NATIVE_INHERITANCE_MISMATCH');
    const expiry = nativeReply?.envelope?.context?.expiresAt, created = nativeReply?.envelope?.context?.createdAt;
    check(typeof expiry === 'string' && typeof created === 'string' && Date.parse(expiry) <= Date.parse(f.webCommentExpiresAt) &&
      Date.parse(expiry) - Date.parse(created) > 19 * 60_000 && Date.parse(expiry) - Date.parse(created) <= 20 * 60_000 + 1000, 'NATIVE_SHORTER_DEADLINE_MISMATCH');
    const shortened = await openRow(nativeReply, f.nativeReplyId, 'comment', f.webCommentId, expiry, deviceId, author.public_key);
    check(shortened.text === socialFixtureText(f, 'native-reply') && shortened.requestedDeadline === expiry &&
      [inherited, shortened].every(p => /^[A-Za-z0-9_-]{43}$/.test(p.reactionSecret)), 'NATIVE_COMMENT_MISMATCH');
    verifyBaseline(intent!.baseline, current, account.id, deviceId);
    nativeDeviceId = deviceId;
  }
  for (const [rows, target, secret, expiry] of [
    [detail.reactions, f.webPostId, intent!.postSecret, f.expiresAt],
    [detail.comment_reactions, f.webCommentId, intent!.commentSecret, f.webCommentExpiresAt],
  ] as const) {
    const expected = native ? ['like', 'love', 'celebrate'] : ['like', 'love'];
    check(Array.isArray(rows) && rows.length === expected.length, 'REACTION_COUNT_MISMATCH');
    for (const emoji of expected) {
      const tag = await reactionTag({ secret, targetId: target, memberId: account.id, emoji });
      const matches = rows.filter((r: any) => r.reaction_tag === tag && r.member_id === account.id);
      check(matches.length === 1, 'CANONICAL_REACTION_MISSING');
      const isNative = emoji === 'celebrate';
      const payload = await openRow(matches[0], tag, 'reaction', target, expiry,
        isNative ? nativeDeviceId! : intent!.webDeviceId, isNative ? nativePublicKey! : intent!.webPublicKey);
      check(canonicalJson(payload) === canonicalJson({ emoji }), 'REACTION_PAYLOAD_MISMATCH');
    }
  }
}

async function deleteFixture() {
  const id = intent!.fixture.webPostId;
  const response = await api!.request('/api/v1/posts/' + id, 'DELETE');
  check([200, 404].includes(response.status), 'PARENT_DELETE_UNCONFIRMED');
  check((await api!.request('/api/v1/posts/' + id)).status === 404, 'PARENT_STILL_VISIBLE');
  // DELETE must now return 404 for every preallocated child. A mistaken surviving
  // child is removed by this authorized cleanup, but that 200 fails the evidence.
  for (const child of [intent!.fixture.webCommentId, intent!.fixture.webReplyId, intent!.fixture.nativeCommentId, intent!.fixture.nativeReplyId]) {
    check((await api!.request('/api/v1/comments/' + child, 'DELETE')).status === 404, 'CHILD_CASCADE_UNCONFIRMED');
  }
  // Reactions are readable only through the now-missing parent detail. Their
  // physical foreign-key cascade is covered by the SQL tests, not an invented GET.
}

async function main() {
  ({ phase, attempt } = socialArguments(process.argv.slice(2)));
  const state = await readPrivate<any>(directory + 'state.json'); account = requireSyntheticA(state);
  if (phase !== 'prepare') {
    intent = await readPrivate<Intent>(file('intent'));
    check(intent.v === 1 && intent.synthetic === true && intent.phase === 'native-social' && intent.fixture.attempt === attempt &&
      intent.fixture.run === state.run && intent.fixture.origin === stagingOrigin && intent.fixture.memberId === account.id &&
      intent.webDeviceId === account.device.id && intent.webPublicKey === account.device.keys.publicKey &&
      intent.fixture.email === account.email && intent.fixture.password === account.password &&
      intent.fixture.recoverySecret === account.device.keys.recoverySecret, 'INTENT_TARGET_MISMATCH');
    // Cleanup remains possible after fixture expiry; it is restricted to the immutable parent ID.
    readHostedFixture(Buffer.from(JSON.stringify(intent.fixture)).toString('base64'), Date.parse(intent.fixture.expiresAt) - 7_200_000);
    try { preparedConfirmed = canonicalJson(await readPrivate(file('fixture'))) === canonicalJson(intent.fixture); }
    catch { /* Failed preparation remains cleanable but cannot become a successful run. */ }
    if (phase === 'check') {
      check(preparedConfirmed, 'PREPARATION_UNCONFIRMED');
      check(Date.parse(intent.fixture.expiresAt) > Date.now(), 'FIXTURE_EXPIRED');
    }
  }
  await login();
  if (phase === 'prepare') await prepare(state);
  else if (phase === 'check') {
    await verifyContent(true);
    await writePrivate(file('verified'), { v: 1, at: new Date().toISOString(), nativeDeviceId,
      signedNativeComments: 2, reactionTargets: 2, finalReactionsPerTarget: 3, historicalKeyVerified: true, originalKeyDecrypts: true,
      profileUnchanged: true, priorDevicesUnchanged: true, priorBackupsPreserved: true }, true);
  } else {
    cleanupConfirmed = false;
    await deleteFixture();
    let receipt: { nativeDeviceId?: string } | undefined;
    try { receipt = await readPrivate(file('verified')); } catch { /* No guessed device ID after a failed native run. */ }
    const current = await baseline();
    verifyBaseline(intent!.baseline, current, account.id, receipt?.nativeDeviceId ?? null);
    nativeDeviceId = receipt?.nativeDeviceId;
    check(preparedConfirmed, 'PREPARATION_UNCONFIRMED');
    cleanupConfirmed = true;
  }
  operationComplete = true;
}

try { await main(); } catch (error) { failure = safeError(error); }
let loggedOut = false;
try { loggedOut = await logout(); } catch { if (!failure) failure = 'SIGNOUT_UNCONFIRMED'; }
const result: Result = { phase, complete: operationComplete && loggedOut && !failure, failure, logout: loggedOut,
  mutationUnconfirmed,
  ...(cleanupConfirmed === undefined ? {} : { cleanup: cleanupConfirmed }), ...(nativeDeviceId ? { nativeDeviceId } : {}) };
if (attempt) {
  try { await writePrivate(file(`${phase}-result-${Date.now()}`), { ...result, at: new Date().toISOString() }, true); }
  catch { failure = 'PRIVATE_RECEIPT_UNCONFIRMED'; result.complete = false; }
}
console.log(JSON.stringify({ step: 'native-social-' + phase, complete: result.complete, code: failure, logout: loggedOut,
  mutationUnconfirmed,
  ...(cleanupConfirmed === undefined ? {} : { cleanup: cleanupConfirmed }) }));
if (!result.complete) process.exitCode = 1;
