import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRecoverySecret,generateDeviceKeys,unlockPrivateKey} from '../src/index.ts';
import {wrapRecoverySecret,unwrapRecoverySecret,splitContactRecoverySecret,combineContactRecoveryShares,sealRecoveryPayload,openRecoveryPayload,deviceBackupBinding,readRecoveryBackup,type RecoveryBinding} from '../src/recovery.ts';
test('recovery capsules bind account and credential, authenticate ciphertext, and require the PRF secret',async()=>{
 const secret=createRecoverySecret(),key=crypto.getRandomValues(new Uint8Array(32)),binding={memberId:'one',credential:'one'};
 const capsule=await wrapRecoverySecret(secret,key,binding);assert.equal(await unwrapRecoverySecret(capsule,key,binding),secret);
 await assert.rejects(unwrapRecoverySecret(capsule,key,{...binding,memberId:'two'}));await assert.rejects(unwrapRecoverySecret(capsule,crypto.getRandomValues(new Uint8Array(32)),binding));
 const tampered={...capsule,ciphertext:(capsule.ciphertext[0]==='A'?'B':'A')+capsule.ciphertext.slice(1)};await assert.rejects(unwrapRecoverySecret(tampered,key,binding));assert.ok(!JSON.stringify(capsule).includes(secret));
});
test('any two distinct shares recover, a repeated share cannot count twice',async()=>{
 const secret=createRecoverySecret(),shares=await splitContactRecoverySecret(secret);assert.equal(shares.length,3);
 for(const [a,b] of [[0,1],[0,2],[1,2]])assert.equal(await combineContactRecoveryShares([shares[a],shares[b]]),secret);
 await assert.rejects(combineContactRecoveryShares([shares[0]]));await assert.rejects(combineContactRecoveryShares([shares[0],shares[0]]));
});
test('device pairing preserves the original recovery kit without giving the authorizer the recovery secret',async()=>{
 const secret=createRecoverySecret(),old=await generateDeviceKeys('member','old',secret),authority=await generateDeviceKeys('member','recovery',secret),newDevice=await generateDeviceKeys('member','new',createRecoverySecret());
 const oldKey=await unlockPrivateKey(old.encryptedPrivateKey,secret),newKey=await unlockPrivateKey(newDevice.encryptedPrivateKey,newDevice.recoverySecret);
 const binding:RecoveryBinding={v:1,purpose:'porchday-device-transfer',memberId:'member',methodId:'request',requestId:'request',recipientFingerprint:newDevice.fingerprint};
 const ciphertext=await sealRecoveryPayload(binding,{armor:oldKey.armor()},newDevice.publicKey,oldKey);
 assert.equal((await openRecoveryPayload<{armor:string}>(ciphertext,binding,newKey,old.publicKey)).armor,oldKey.armor());
 await assert.rejects(openRecoveryPayload(ciphertext,{...binding,requestId:'different'},newKey,old.publicKey));
 await assert.rejects(openRecoveryPayload(ciphertext,binding,oldKey,old.publicKey));
 const entry={id:'new',public_key:newDevice.publicKey,fingerprint:newDevice.fingerprint,recovery_ciphertext:await sealRecoveryPayload(deviceBackupBinding('member',{id:'new'},authority.fingerprint),newKey.armor(),authority.publicKey,newKey)};
 const backup={v:1 as const,devices:[{id:'old',public_key:old.publicKey,fingerprint:old.fingerprint,encrypted_private_key:old.encryptedPrivateKey},entry],recovery:{public_key:authority.publicKey,fingerprint:authority.fingerprint,encrypted_private_key:authority.encryptedPrivateKey}};
 const recovered=await readRecoveryBackup(backup,secret,'member');assert.equal(recovered.devices.length,2);assert.equal(recovered.devices[1].key.getFingerprint(),newKey.getFingerprint());await assert.rejects(readRecoveryBackup(backup,secret,'other-member'));
});
