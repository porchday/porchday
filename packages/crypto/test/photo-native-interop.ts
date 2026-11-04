/** Go harness: synthetic keys only, testing both directions of the new contexts. */
import {readFile, writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {unlockPrivateKey, decryptObject, encryptObject} from '../src/index.ts';
const f=JSON.parse(await readFile(process.argv[2],'utf8'));
const alice=await unlockPrivateKey(f.alice.encryptedPrivateKey,f.alice.recoverySecret,f.alice.fingerprint);
const bob=await unlockPrivateKey(f.bob.encryptedPrivateKey,f.bob.recoverySecret,f.bob.fingerprint);
const result=[];
for(const envelope of f.envelopes){
 assert.deepEqual(await decryptObject({envelope,expectedContext:envelope.context,privateKey:bob,authorPublicKey:f.alice.publicKey}),f.payload);
 result.push(await encryptObject({context:envelope.context,payload:f.payload,signingKey:alice,recipients:f.recipients}));
}
await writeFile(process.argv[3],JSON.stringify(result),{mode:0o600});
