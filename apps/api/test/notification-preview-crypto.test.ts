import {test,expect} from 'vitest';
import {generateDeviceKeys,unlockPrivateKey} from '../../../packages/crypto/src/index';
import {notificationKey,sealPreview,openPreview,type PreviewIdentity,type PreviewContext} from '../../../packages/crypto/src/notification-preview';
test('notification-only keys decrypt signed content and reject tampering, wrong recipient and expiry',async()=>{
 const member=crypto.randomUUID(),device=crypto.randomUUID(),a=await generateDeviceKeys(member,device),author=await unlockPrivateKey(a.encryptedPrivateKey,a.recoverySecret),key=await notificationKey();
 const identity:PreviewIdentity={v:1,purpose:'porchday-notification-key',memberId:crypto.randomUUID(),deviceId:crypto.randomUUID(),keyId:crypto.randomUUID(),publicKey:key.publicKey};
 const context:PreviewContext={v:1,purpose:'porchday-notification-preview',kind:'post',id:crypto.randomUUID(),authorId:member,authorDeviceId:device,revision:1,expiresAt:null};
 const encrypted=await sealPreview(context,{text:'A private caption'},[identity],author);expect(JSON.stringify(encrypted)).not.toContain('A private caption');expect(key.privateKey.extractable).toBe(false);
 expect(await openPreview(encrypted,context,identity,key.privateKey,a.publicKey)).toEqual({text:'A private caption'});
 await expect(openPreview(encrypted,context,{...identity,memberId:crypto.randomUUID()},key.privateKey,a.publicKey)).rejects.toThrow();
 await expect(openPreview(encrypted,{...context,id:crypto.randomUUID()},identity,key.privateKey,a.publicKey)).rejects.toThrow();
 const altered=structuredClone(encrypted);altered.statement.ciphertext=altered.statement.ciphertext.slice(0,-4)+'AAAA';await expect(openPreview(altered,context,identity,key.privateKey,a.publicKey)).rejects.toThrow();
 const expired={...context,expiresAt:'2020-01-01T00:00:00Z'};await expect(openPreview(await sealPreview(expired,{text:'old'},[identity],author),expired,identity,key.privateKey,a.publicKey)).rejects.toThrow();
});
