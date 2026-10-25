/** Invoked by Go tests with short-lived, synthetic test keys only. */
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { unlockPrivateKey, decryptObject, verifyStatement, reactionTag, decryptArchive, base64ToBytes, utf8Decode } from '../src/index.ts';
const f = JSON.parse(await readFile(process.argv[2], 'utf8'));
const bob = await unlockPrivateKey(f.bob.encryptedPrivateKey, f.bob.recoverySecret, f.bob.fingerprint);
const native = await unlockPrivateKey(f.native.encryptedPrivateKey, f.native.recoverySecret, f.native.fingerprint);
assert.deepEqual(await decryptObject({ envelope: f.envelope, expectedContext: f.envelope.context, privateKey: bob, authorPublicKey: f.native.publicKey }), f.payload);
assert.deepEqual(await decryptObject({ envelope: f.envelope, expectedContext: f.envelope.context, privateKey: native, authorPublicKey: f.native.publicKey }), f.payload);
assert.deepEqual(await verifyStatement(f.signature, f.native.publicKey), f.signature.statement);
assert.equal(await reactionTag({ secret: f.reactionSecret, targetId: 'native-object', memberId: 'native-author', emoji: 'like' }), f.reactionTag);
assert.equal(utf8Decode(await decryptArchive(base64ToBytes(f.archive), f.reactionSecret)), 'native archive bytes');
console.log('Native-to-JavaScript encryption, native key recovery, signatures, reaction MAC and archive interop passed.');
