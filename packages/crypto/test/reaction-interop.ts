/** Invoked only by native tests with existing synthetic fixture keys. */
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {encryptObject, decryptObject, unlockPrivateKey, reactionTag, type ContentContext} from '../src/index.ts';
import {validateReactionPayload} from '../src/reactions.ts';
const fixture = JSON.parse(await readFile(new URL('./fixtures/openpgp-v1.json', import.meta.url), 'utf8'));
const vectors = JSON.parse(await readFile(new URL('./fixtures/reactions-v1.json', import.meta.url), 'utf8'));
const alice = await unlockPrivateKey(fixture.alice.encryptedPrivateKey, fixture.alice.recoverySecret, fixture.alice.fingerprint);
const bob = await unlockPrivateKey(fixture.bob.encryptedPrivateKey, fixture.bob.recoverySecret, fixture.bob.fingerprint);
if (process.argv[2] === 'generate') {
  const reactions = [];
  for (const row of vectors.vectors) {
    const context: ContentContext = {id: row.tag, kind: 'reaction', authorId: vectors.memberId, authorDeviceId: 'fixture-alice-phone',
      audience: 'connections', parentId: vectors.targetId, groupId: null, epoch: 1, createdAt: new Date().toISOString(), expiresAt: null, revision: 1};
    const envelope = await encryptObject({context, payload: row.payload, signingKey: alice, recipients: [
      {memberId: 'fixture-alice', deviceId: 'fixture-alice-phone', publicKey: fixture.alice.publicKey},
      {memberId: 'fixture-bob', deviceId: 'fixture-bob-phone', publicKey: fixture.bob.publicKey},
    ]});
    reactions.push({tag: row.tag, payload: row.payload, envelope});
  }
  await writeFile(process.argv[3], JSON.stringify({secret: vectors.secret, targetId: vectors.targetId, memberId: vectors.memberId, reactions}), {mode: 0o600});
} else if (process.argv[2] === 'verify') {
  const data = JSON.parse(await readFile(process.argv[3], 'utf8'));
  assert.equal(data.reactions.length, 12);
  for (const row of data.reactions) {
    const payload = await decryptObject({envelope: row.envelope, expectedContext: row.envelope.context, privateKey: bob, authorPublicKey: fixture.alice.publicKey});
    assert.deepEqual(await validateReactionPayload(payload), row.payload);
    assert.equal(await reactionTag({secret: vectors.secret, targetId: vectors.targetId, memberId: vectors.memberId, emoji: row.payload.emoji}), row.tag);
    assert.equal(row.envelope.context.id, row.tag);
    assert.equal(row.envelope.context.parentId, vectors.targetId);
  }
  console.log('12 native reaction descriptors, signed ciphertexts and MACs verified in JavaScript.');
} else throw Error('Specify generate or verify');
