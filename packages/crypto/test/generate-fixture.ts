/** These generated, deliberately published TEST keys must NEVER be used for live accounts. */
import { writeFile } from 'node:fs/promises';
import { generateDeviceKeys, unlockPrivateKey, encryptObject, canonicalJson, createRecoverySecret, signStatement } from '../src/index.ts';
const alice = await generateDeviceKeys('fixture-alice', 'fixture-alice-phone');
const bob = await generateDeviceKeys('fixture-bob', 'fixture-bob-phone');
const key = await unlockPrivateKey(alice.encryptedPrivateKey, alice.recoverySecret);
const context = { id: 'fixture-post-1', kind: 'post' as const, authorId: 'fixture-alice', authorDeviceId: 'fixture-alice-phone', audience: 'connections' as const, parentId: null, groupId: null, epoch: 1, createdAt: new Date().toISOString(), expiresAt: null, revision: 1 };
const payload = { text: 'Hello from the porch 🌻', alt: 'A blue chair', reactionSecret: createRecoverySecret(), photo: 'AAECA/7/' };
const recipients = [{ memberId: 'fixture-alice', deviceId: 'fixture-alice-phone', publicKey: alice.publicKey }, { memberId: 'fixture-bob', deviceId: 'fixture-bob-phone', publicKey: bob.publicKey }];
const envelope = await encryptObject({ context, payload, signingKey: key, recipients });
const statement = { purpose: 'porchday-interop-test', memberId: 'fixture-alice', nonce: 'fixed-test-nonce' };
const signature = await signStatement(statement, key);
await writeFile(new URL('./fixtures/openpgp-v1.json', import.meta.url), JSON.stringify({ warning: 'PUBLIC TEST KEYS ONLY. NEVER USE FOR REAL ACCOUNTS.', alice, bob, envelope, payload, canonicalPayload: canonicalJson({ v: 1, protocol: envelope.protocol, context, recipients: envelope.recipients, payload }), signature }, null, 2) + '\n');
