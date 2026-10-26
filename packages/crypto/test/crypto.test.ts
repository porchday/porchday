import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import * as pgp from 'openpgp';
import { authorizeDevice, canonicalJson, createRecoverySecret, decryptArchive, decryptObject, encryptArchive, encryptObject, fingerprint, generateDeviceKeys, reactionTag, signStatement, unlockPrivateKey, verifyDeviceAuthorization, verifyStatement, validateEncryptedPrivateKey, type ContentContext, type DeviceKeys, type UnlockedPrivateKey } from '../src/index.ts';

let alice: DeviceKeys, bob: DeviceKeys, outsider: DeviceKeys;
let aliceKey: UnlockedPrivateKey, bobKey: UnlockedPrivateKey, outsiderKey: UnlockedPrivateKey;
const context = (): ContentContext => ({ id: 'post-1', kind: 'post', authorId: 'alice', authorDeviceId: 'alice-phone', audience: 'connections', parentId: null, groupId: null, epoch: 5, createdAt: new Date().toISOString(), expiresAt: null, revision: 1 });
const recipients = () => [{ memberId: 'alice', deviceId: 'alice-phone', publicKey: alice.publicKey }, { memberId: 'bob', deviceId: 'bob-laptop', publicKey: bob.publicKey }];
before(async () => {
  [alice, bob, outsider] = await Promise.all([generateDeviceKeys('alice', 'alice-phone'), generateDeviceKeys('bob', 'bob-laptop'), generateDeviceKeys('eve', 'eve-phone')]);
  [aliceKey, bobKey, outsiderKey] = await Promise.all([unlockPrivateKey(alice.encryptedPrivateKey, alice.recoverySecret, alice.fingerprint), unlockPrivateKey(bob.encryptedPrivateKey, bob.recoverySecret, bob.fingerprint), unlockPrivateKey(outsider.encryptedPrivateKey, outsider.recoverySecret, outsider.fingerprint)]);
});

test('signed encrypted content is readable by each intended recipient, never an outsider', async () => {
  const c = context(), payload = { text: 'Dinner on the porch? 👋', reactionSecret: createRecoverySecret() };
  const envelope = await encryptObject({ context: c, payload, signingKey: aliceKey, recipients: recipients() });
  assert.ok(!JSON.stringify(envelope).includes(payload.text));
  for (const privateKey of [aliceKey, bobKey]) assert.deepEqual(await decryptObject({ envelope, expectedContext: c, privateKey, authorPublicKey: alice.publicKey }), payload);
  await assert.rejects(decryptObject({ envelope, expectedContext: c, privateKey: outsiderKey, authorPublicKey: alice.publicKey }), /not a recipient/);
  const message = await pgp.readMessage({ armoredMessage: envelope.ciphertext });
  const packet = [...message.packets].find(p => p instanceof pgp.SymEncryptedIntegrityProtectedDataPacket);
  assert.equal((packet as unknown as { version: number })?.version, 2, 'RFC9580 authenticated encryption packet required');
});

test('an attacker cannot relabel object, author, audience, parent, epoch or expiration', async () => {
  const c = context(), envelope = await encryptObject({ context: c, payload: 'private', signingKey: aliceKey, recipients: recipients() });
  const changes: Partial<ContentContext>[] = [{ id: 'different-post' }, { authorId: 'eve' }, { audience: 'only_me' }, { audience: 'friends' }, { parentId: 'unrelated-parent' }, { epoch: 6 }, { expiresAt: new Date(Date.now() + 60_000).toISOString() }, { revision: 2 }];
  for (const change of changes) {
    const changed = { ...envelope, context: { ...c, ...change } };
    await assert.rejects(decryptObject({ envelope: changed, expectedContext: c, privateKey: bobKey, authorPublicKey: alice.publicKey }), /context mismatch/);
    await assert.rejects(decryptObject({ envelope: changed, expectedContext: changed.context, privateKey: bobKey, authorPublicKey: alice.publicKey }), /binding mismatch|Author key/);
  }
});

test('friends-only remains signed and encrypted to its exact recipient set', async () => {
  const c: ContentContext = { ...context(), audience: 'friends' };
  const envelope = await encryptObject({ context: c, payload: { text: 'Friends only' }, signingKey: aliceKey, recipients: recipients() });
  assert.deepEqual(await decryptObject({ envelope, expectedContext: c, privateKey: bobKey, authorPublicKey: alice.publicKey }), { text: 'Friends only' });
  await assert.rejects(decryptObject({ envelope, expectedContext: c, privateKey: outsiderKey, authorPublicKey: alice.publicKey }), /not a recipient/);
  for (const audience of ['connections', 'family'] as const) {
    const changed = { ...envelope, context: { ...c, audience } };
    await assert.rejects(decryptObject({ envelope: changed, expectedContext: changed.context, privateKey: bobKey, authorPublicKey: alice.publicKey }), /binding mismatch/);
  }
});

test('unsigned, wrong-signer, edited ciphertext and edited recipient lists fail closed', async () => {
  const c = context(), envelope = await encryptObject({ context: c, payload: 'private', signingKey: aliceKey, recipients: recipients() });
  await assert.rejects(decryptObject({ envelope, expectedContext: c, privateKey: bobKey, authorPublicKey: outsider.publicKey }), /Author key/);
  const changed = structuredClone(envelope); changed.recipients[1].memberId = 'eve';
  await assert.rejects(decryptObject({ envelope: changed, expectedContext: c, privateKey: bobKey, authorPublicKey: alice.publicKey }), /binding mismatch/);
  const unsigned = await pgp.encrypt({ message: await pgp.createMessage({ text: 'unsigned' }), encryptionKeys: await pgp.readKey({ armoredKey: bob.publicKey }) });
  await assert.rejects(decryptObject({ envelope: { ...envelope, ciphertext: unsigned }, expectedContext: c, privateKey: bobKey, authorPublicKey: alice.publicKey }));
  const lines = envelope.ciphertext.split('\n'); const bodyLine = lines.findLastIndex(x => x.length > 40 && /^[A-Za-z0-9+/]+$/.test(x));
  lines[bodyLine] = lines[bodyLine].slice(0, 10) + (lines[bodyLine][10] === 'A' ? 'B' : 'A') + lines[bodyLine].slice(11);
  await assert.rejects(decryptObject({ envelope: { ...envelope, ciphertext: lines.join('\n') }, expectedContext: c, privateKey: bobKey, authorPublicKey: alice.publicKey }));
});

test('service expiration is enforced before returning plaintext', async () => {
  const c = { ...context(), expiresAt: new Date(Date.now() + 30_000).toISOString() };
  const envelope = await encryptObject({ context: c, payload: 'ephemeral', signingKey: aliceKey, recipients: recipients() });
  await assert.rejects(decryptObject({ envelope, expectedContext: c, privateKey: bobKey, authorPublicKey: alice.publicKey, now: Date.now() + 60_000 }), /expired/);
});

test('a new audience snapshot excludes departed devices cryptographically', async () => {
  const c = { ...context(), epoch: 6 };
  const envelope = await encryptObject({ context: c, payload: 'after removal', signingKey: aliceKey, recipients: recipients().slice(0, 1) });
  await assert.rejects(decryptObject({ envelope, expectedContext: c, privateKey: bobKey, authorPublicKey: alice.publicKey }), /not a recipient/);
  await assert.rejects(pgp.decrypt({ message: await pgp.readMessage({ armoredMessage: envelope.ciphertext }), decryptionKeys: bobKey }));
});

test('recovery is independent of login and rejects wrong or substituted key backups', async () => {
  assert.match(alice.recoverySecret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(alice.fingerprint, await fingerprint(alice.publicKey));
  await assert.rejects(unlockPrivateKey(alice.encryptedPrivateKey, 'login-password'), /256-bit/);
  await assert.rejects(unlockPrivateKey(alice.encryptedPrivateKey, createRecoverySecret()));
  await assert.rejects(unlockPrivateKey(bob.encryptedPrivateKey, bob.recoverySecret, alice.fingerprint), /fingerprint/);
  await assert.rejects(unlockPrivateKey(aliceKey.armor(), alice.recoverySecret), /unprotected/);
});

test('trusted devices authorize an exact fresh device challenge', async () => {
  const statement = { v: 1 as const, purpose: 'porchday-device-authorization' as const, memberId: 'alice', authorizingDeviceId: 'alice-phone', deviceId: 'alice-tablet', fingerprint: bob.fingerprint, challenge: createRecoverySecret(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const signed = await authorizeDevice(statement, aliceKey);
  assert.deepEqual(await verifyDeviceAuthorization(signed, alice.publicKey, statement), statement);
  await assert.rejects(verifyDeviceAuthorization(signed, outsider.publicKey, statement));
  await assert.rejects(verifyDeviceAuthorization(signed, alice.publicKey, { ...statement, challenge: createRecoverySecret() }), /binding mismatch/);
  await assert.rejects(verifyDeviceAuthorization(signed, alice.publicKey, statement, Date.now() + 120_000), /not valid/);
});

test('lifecycle update signatures bind every field', async () => {
  const signed = await signStatement({ purpose: 'shorten-expiry', id: 'post-1', expiresAt: '2027-01-01T00:00:00.000Z', nonce: createRecoverySecret() }, aliceKey);
  assert.deepEqual(await verifyStatement(signed, alice.publicKey), signed.statement);
  await assert.rejects(verifyStatement({ ...signed, statement: { ...signed.statement, expiresAt: '2030-01-01T00:00:00.000Z' } }, alice.publicKey));
});

test('reaction tags are secret, per-target/member and preserve multiple distinct emoji', async () => {
  const options = { secret: createRecoverySecret(), targetId: 'post-1', memberId: 'alice', emoji: 'like' };
  const tag = await reactionTag(options);
  assert.equal(tag, await reactionTag(options));
  for (const change of [{ emoji: 'love' }, { targetId: 'comment-1' }, { memberId: 'bob' }, { secret: createRecoverySecret() }]) assert.notEqual(tag, await reactionTag({ ...options, ...change }));
});

test('encrypted portable archives survive byte-for-byte and reject wrong secrets/tampering', async () => {
  const plaintext = new TextEncoder().encode('{"profile":"A porch person","photos":[0,255]}');
  const { ciphertext, secret } = await encryptArchive(plaintext);
  assert.deepEqual(await decryptArchive(ciphertext, secret), plaintext);
  await assert.rejects(decryptArchive(ciphertext, createRecoverySecret()));
  const changed = ciphertext.slice(); changed[changed.length - 5] ^= 1;
  await assert.rejects(decryptArchive(changed, secret));
});

test('canonical binding is deterministic and rejects unrepresentable JSON', () => {
  assert.equal(canonicalJson({ b: 2, a: ['🌻', 1] }), '{"a":["🌻",1],"b":2}');
  for (const bad of [undefined, NaN, new Date(), { a: undefined }]) assert.throws(() => canonicalJson(bad));
});

test('duplicate devices and a missing author device fail rather than silently omitting recipients', async () => {
  await assert.rejects(encryptObject({ context: context(), payload: {}, signingKey: aliceKey, recipients: [recipients()[0], recipients()[0]] }), /Duplicate/);
  await assert.rejects(encryptObject({ context: context(), payload: {}, signingKey: aliceKey, recipients: [recipients()[1]] }), /signing device/);
});

test('a 300-friend audience encrypts once for 301 distinct device keys', async t => {
  const start = performance.now();
  const friends = [];
  for (let i = 0; i < 300; i++) {
    const key = await pgp.generateKey({ type: 'curve25519', userIDs: [{ name: `Synthetic friend ${i}` }], format: 'object', config: { v6Keys: true, aeadProtect: true } });
    friends.push({ key: key.privateKey, recipient: { memberId: `synthetic-${i}`, deviceId: `synthetic-device-${i}`, publicKey: key.publicKey.armor() } });
  }
  const encryptStart = performance.now(), c = context();
  const envelope = await encryptObject({ context: c, payload: { text: 'All 300 friends' }, signingKey: aliceKey, recipients: [recipients()[0], ...friends.map(f => f.recipient)] });
  const decryptStart = performance.now();
  assert.equal(envelope.recipients.length, 301);
  assert.deepEqual(await decryptObject({ envelope, expectedContext: c, privateKey: friends[299].key, authorPublicKey: alice.publicKey }), { text: 'All 300 friends' });
  t.diagnostic(`301-device test: key preparation ${Math.round(encryptStart - start)}ms; encryption ${Math.round(decryptStart - encryptStart)}ms; one recipient decrypt ${Math.round(performance.now() - decryptStart)}ms; armored ciphertext ${envelope.ciphertext.length} characters. Desktop result, not mobile benchmark.`);
});


test('server backup validation rejects plaintext private material and mismatched public keys', async () => {
  await validateEncryptedPrivateKey(alice.encryptedPrivateKey, alice.fingerprint);
  await assert.rejects(validateEncryptedPrivateKey(aliceKey.armor()), /encrypted/);
  await assert.rejects(validateEncryptedPrivateKey(alice.encryptedPrivateKey, bob.fingerprint), /fingerprint/);
  await assert.rejects(fingerprint(alice.encryptedPrivateKey), /private key material/);
});
