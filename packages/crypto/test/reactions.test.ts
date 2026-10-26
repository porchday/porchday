import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {crc32} from 'node:zlib';
import {reactionTag, encryptObject, decryptObject, unlockPrivateKey, type ContentContext} from '../src/index.ts';
import {LEGACY_REACTIONS, UNICODE_EMOJI, canonicalUnicode, unicodeReaction, unicodeMetadata, customReaction, customPngBytes,
  validateReactionPayload, validateCustomPng, reactionDisplay, type ReactionPayload} from '../src/reactions.ts';
const vectors = JSON.parse(await readFile(new URL('./fixtures/reactions-v1.json', import.meta.url), 'utf8'));
const custom = vectors.vectors.at(-1).payload as Extract<ReactionPayload, {custom: unknown}>;
const png = customPngBytes(custom.custom.png);

test('pinned Unicode metadata is reproducible and every qualified/unqualified alias has one identity', async () => {
  execFileSync('python3', [new URL('../../../scripts/generate-unicode-emoji.py', import.meta.url).pathname, '--check']);
  assert.equal(UNICODE_EMOJI.length, 3944);
  let forms = 0;
  for (const entry of UNICODE_EMOJI) {
    assert.equal(canonicalUnicode(entry.unicode), entry.unicode);
    for (const alias of entry.aliases) {assert.equal(canonicalUnicode(alias), entry.unicode); forms++;}
  }
  assert.equal(forms, 5216);
  assert.equal(unicodeMetadata('🫩')?.name, 'face with bags under eyes');
  assert.equal(canonicalUnicode('1⃣'), '1️⃣');
  assert.equal(canonicalUnicode('👨‍👩‍👧‍👦'), '👨‍👩‍👧‍👦');
  assert.notEqual(canonicalUnicode('👌🏽'), canonicalUnicode('👌'));
  for (const invalid of ['', 'hello', '👍👍', '🏻', ' 👍', '\ud800', '☀︎', 'x'.repeat(1000)]) assert.equal(canonicalUnicode(invalid), null);
});

test('legacy aliases and their historical MAC vectors stay exact, new descriptors reproduce cross-platform vectors', async () => {
  assert.deepEqual(await unicodeReaction('❤'), {emoji: 'love'});
  assert.deepEqual(await unicodeReaction('☀'), {emoji: 'sunshine'});
  for (const entry of LEGACY_REACTIONS) assert.deepEqual(await unicodeReaction(entry.unicode), {emoji: entry.id});
  for (const row of vectors.vectors) {
    assert.deepEqual(await validateReactionPayload(row.payload), row.payload);
    assert.equal(await reactionTag({...vectors, emoji: row.payload.emoji}), row.tag);
    assert.match(row.tag, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(reactionDisplay(row.payload).name);
  }
  const renamed = await customReaction('another_name', png);
  assert.equal(renamed.emoji, custom.emoji);
  assert.notEqual(await reactionTag({...vectors, emoji: custom.emoji, memberId: 'different-member'}), vectors.vectors.at(-1).tag);
  assert.notEqual(await reactionTag({...vectors, emoji: custom.emoji, targetId: 'different-target'}), vectors.vectors.at(-1).tag);
});

test('rejects mismatched descriptors, noncanonical aliases, invalid IDs and unexpected plaintext fields', async () => {
  const unicode = await unicodeReaction('👌🏽');
  for (const invalid of [null, [], {}, {emoji: 'unknown'}, {emoji: 'like', unicode: '👍'}, {...unicode, unicode: '👌'},
    {emoji: 'u1_' + '0'.repeat(64), unicode: '👌🏽'}, {...unicode, extra: 'value'},
    {...custom, emoji: 'c1_' + '0'.repeat(64)}, {...custom, custom: {...custom.custom, name: '<script>'}},
    {...custom, custom: {...custom.custom, png: custom.custom.png + '\n'}},
    {...custom, custom: {...custom.custom, url: 'https://example.test/private'}}]) {
    await assert.rejects(validateReactionPayload(invalid));
  }
  for (const id of ['u1_' + 'A'.repeat(64), 'u1_' + 'a'.repeat(63), 'c1_' + 'f'.repeat(65), '😀', 'a'.repeat(41)])
    await assert.rejects(reactionTag({...vectors, emoji: id}));
  await assert.rejects(unicodeReaction('not an emoji'));
  await assert.rejects(customReaction('Bad Name', png));
});

function chunk(kind: string, data: Uint8Array) {
  const type = Buffer.from(kind), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, crc]);
}
const withHeader = (change: (header: Uint8Array) => void) => {
  const header = png.slice(16, 29); change(header);
  return Buffer.concat([png.slice(0, 8), chunk('IHDR', header), png.slice(33)]);
};
test('validates bounded static PNG structure, checksums and byte identity before any image decoder', async () => {
  assert.deepEqual(validateCustomPng(png), {width: 1, height: 1});
  assert.deepEqual(await customReaction('green_dot', png), custom);
  const oversized = withHeader(header => new DataView(header.buffer).setUint32(0, 129));
  const badColor = withHeader(header => {header[9] = 7;});
  const checksum = png.slice(); checksum[20] ^= 1;
  const apng = Buffer.concat([png.slice(0, 33), chunk('acTL', Buffer.alloc(8)), png.slice(33)]);
  const metadata = Buffer.concat([png.slice(0, 33), chunk('iCCP', Buffer.alloc(8)), png.slice(33)]);
  const duplicate = Buffer.concat([png.slice(0, 33), png.slice(8, 33), png.slice(33)]);
  const noData = Buffer.concat([png.slice(0, 33), chunk('IEND', Buffer.alloc(0))]);
  for (const bad of [new Uint8Array(32769), png.slice(0, -1), Buffer.from('<svg/>'), checksum, oversized, badColor, apng, metadata, duplicate, noData, Buffer.concat([png, Buffer.of(0)])])
    assert.throws(() => validateCustomPng(bad));
  for (const bad of ['', custom.custom.png.replace(/=/g, ''), 'data:image/png;base64,' + custom.custom.png, 'A'.repeat(43693)])
    assert.throws(() => customPngBytes(bad));
});

test('new Unicode and custom reactions round-trip as signed encrypted payloads with exact parent and MAC binding', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/openpgp-v1.json', import.meta.url), 'utf8'));
  const alice = await unlockPrivateKey(fixture.alice.encryptedPrivateKey, fixture.alice.recoverySecret, fixture.alice.fingerprint);
  const bob = await unlockPrivateKey(fixture.bob.encryptedPrivateKey, fixture.bob.recoverySecret, fixture.bob.fingerprint);
  for (const row of vectors.vectors.filter((entry: {name: string}) => !entry.name.startsWith('legacy'))) {
    const context: ContentContext = {id: row.tag, kind: 'reaction', authorId: 'fixture-alice', authorDeviceId: 'fixture-alice-phone',
      audience: 'connections', parentId: vectors.targetId, groupId: null, epoch: 1, createdAt: new Date().toISOString(), expiresAt: null, revision: 1};
    const envelope = await encryptObject({context, payload: row.payload, signingKey: alice, recipients: [
      {memberId: 'fixture-alice', deviceId: 'fixture-alice-phone', publicKey: fixture.alice.publicKey},
      {memberId: 'fixture-bob', deviceId: 'fixture-bob-phone', publicKey: fixture.bob.publicKey},
    ]});
    assert.ok(!envelope.ciphertext.includes(row.payload.emoji));
    const decrypted = await decryptObject({envelope, expectedContext: context, privateKey: bob, authorPublicKey: fixture.alice.publicKey});
    assert.deepEqual(await validateReactionPayload(decrypted), row.payload);
    assert.equal(await reactionTag({...vectors, emoji: (decrypted as ReactionPayload).emoji}), context.id);
    await assert.rejects(decryptObject({envelope, expectedContext: {...context, parentId: 'another-post'}, privateKey: bob, authorPublicKey: fixture.alice.publicKey}));
  }
});
