/** Recovery envelopes use standard primitives; no plaintext recovery material leaves the caller. */
import * as pgp from 'openpgp';
import {split, combine} from 'shamir-secret-sharing';
import {canonicalJson, base64ToBytes, bytesToBase64, unlockPrivateKey, type UnlockedPrivateKey} from './index.ts';
const config: Partial<pgp.Config> = {v6Keys:true,aeadProtect:true,preferredSymmetricAlgorithm:pgp.enums.symmetric.aes256,preferredAEADAlgorithm:pgp.enums.aead.gcm,preferredCompressionAlgorithm:pgp.enums.compression.uncompressed,allowUnauthenticatedMessages:false,allowUnauthenticatedStream:false,maxDecompressedMessageSize:1500000};
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
export type RecoveryBinding={v:1;purpose:'porchday-recovery-share'|'porchday-recovery-response'|'porchday-device-transfer'|'porchday-device-backup';memberId:string;methodId:string;requestId:string;recipientFingerprint:string};
export type RecoveryCapsule={v:1;iv:string;ciphertext:string};
export async function recoveryDigest(value:unknown){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(canonicalJson(value)))),x=>x.toString(16).padStart(2,'0')).join('');}
function data(value:string){return encoder.encode(value);}
async function capsuleKey(material:Uint8Array,binding:unknown){
 if(material.byteLength!==32)throw Error('Invalid recovery key');
 const key=await crypto.subtle.importKey('raw',new Uint8Array(material),'HKDF',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:data('porchday-recovery-capsule-v1'),info:data(canonicalJson(binding))},key,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function wrapRecoverySecret(secret:string,material:Uint8Array,binding:unknown):Promise<RecoveryCapsule>{
 if(!/^[A-Za-z0-9_-]{43}$/.test(secret))throw Error('Invalid recovery secret');
 const key=await capsuleKey(material,binding),iv=crypto.getRandomValues(new Uint8Array(12));
 const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:data(canonicalJson(binding))},key,data(secret));
 return {v:1,iv:bytesToBase64(iv),ciphertext:bytesToBase64(new Uint8Array(cipher))};
}
export async function unwrapRecoverySecret(capsule:RecoveryCapsule,material:Uint8Array,binding:unknown):Promise<string>{
 if(capsule.v!==1||capsule.iv.length!==16||capsule.ciphertext.length!==80)throw Error('Invalid recovery capsule');
 try{const key=await capsuleKey(material,binding),plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(base64ToBytes(capsule.iv)),additionalData:data(canonicalJson(binding))},key,new Uint8Array(base64ToBytes(capsule.ciphertext)));const secret=decoder.decode(plain);if(!/^[A-Za-z0-9_-]{43}$/.test(secret))throw Error();return secret;}catch{throw Error('This recovery method could not unlock the backup.');}
}
export async function sealRecoveryPayload(binding:RecoveryBinding,payload:unknown,recipientPublicKey:string,signer:UnlockedPrivateKey){
 const recipient=await pgp.readKey({armoredKey:recipientPublicKey,config});
 if(recipient.isPrivate()||recipient.getFingerprint()!==binding.recipientFingerprint||recipient.keyPacket.version!==6)throw Error('Recovery recipient mismatch');
 const text=canonicalJson({binding,payload});if(data(text).length>1500000)throw Error('Recovery payload too large');
 return pgp.encrypt({message:await pgp.createMessage({text}),encryptionKeys:recipient,signingKeys:signer,format:'armored',config});
}
export async function openRecoveryPayload<T>(ciphertext:string,binding:RecoveryBinding,recipient:UnlockedPrivateKey,signerPublicKey:string):Promise<T>{
 if(ciphertext.length>2100000||recipient.getFingerprint()!==binding.recipientFingerprint)throw Error('Recovery recipient mismatch');
 const message=await pgp.readMessage({armoredMessage:ciphertext,config});
 const packet=[...message.packets].find(p=>p instanceof pgp.SymEncryptedIntegrityProtectedDataPacket);
 if(!packet||(packet as unknown as {version:number}).version!==2)throw Error('Authenticated recovery encryption required');
 const result=await pgp.decrypt({message,decryptionKeys:recipient,verificationKeys:await pgp.readKey({armoredKey:signerPublicKey,config}),expectSigned:true,format:'utf8',config});
 if(result.signatures.length!==1)throw Error('Recovery signature required');await result.signatures[0].verified;
 const decoded=JSON.parse(result.data);if(canonicalJson(decoded.binding)!==canonicalJson(binding))throw Error('Recovery context mismatch');return decoded.payload;
}
export async function importRecoveryPrivateKey(armor:string,expectedFingerprint:string){
 if(armor.length>30000)throw Error('Invalid transferred key');const key=await pgp.readPrivateKey({armoredKey:armor,config});
 if(!key.isDecrypted()||key.keyPacket.version!==6||key.getFingerprint()!==expectedFingerprint)throw Error('Transferred key mismatch');await key.verifyPrimaryKey();for(const part of key.getKeys()){if(!(part.keyPacket instanceof pgp.SecretKeyPacket || part.keyPacket instanceof pgp.SecretSubkeyPacket))throw Error('Private key material required');await part.keyPacket.validate();}return key;
}
export async function splitContactRecoverySecret(secret:string){
 if(!/^[A-Za-z0-9_-]{43}$/.test(secret))throw Error('Invalid recovery secret');
 const value=base64ToBytes(secret.replace(/-/g,'+').replace(/_/g,'/')+'=');
 try{return (await split(value,3,2)).map(bytesToBase64);}finally{value.fill(0);}
}
export async function combineContactRecoveryShares(shares:string[]){
 if(shares.length!==2||shares[0]===shares[1])throw Error('Two distinct accepted contacts are required');
 const decoded=shares.map(base64ToBytes);if(decoded.some(v=>v.length!==33)||decoded[0][32]===decoded[1][32])throw Error('Invalid recovery shares');
 const secret=await combine(decoded);try{return bytesToBase64(secret).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}finally{secret.fill(0);decoded.forEach(v=>v.fill(0));}
}

export type RecoveryBackupKey={public_key:string;fingerprint:string;encrypted_private_key:string};
export type RecoveryBackupDevice={id:string;public_key:string;fingerprint:string;encrypted_private_key?:string;recovery_ciphertext?:string};
export type RecoveryBackup={v:1;devices:RecoveryBackupDevice[];recovery:RecoveryBackupKey};
export function deviceBackupBinding(memberId:string,device:Pick<RecoveryBackupDevice,'id'>,recoveryFingerprint:string):RecoveryBinding{return{v:1,purpose:'porchday-device-backup',memberId,methodId:device.id,requestId:'',recipientFingerprint:recoveryFingerprint};}
export async function readRecoveryBackup(backup:RecoveryBackup,secret:string,memberId:string){
 if(backup?.v!==1||!backup.devices?.length)throw Error('Incomplete recovery backup');
 const recovery=await unlockPrivateKey(backup.recovery.encrypted_private_key,secret.trim(),backup.recovery.fingerprint);
 const devices=[];
 for(const device of backup.devices){
  if(!!device.encrypted_private_key===!!device.recovery_ciphertext)throw Error('Invalid device backup');
  const key=device.encrypted_private_key?await unlockPrivateKey(device.encrypted_private_key,secret.trim(),device.fingerprint):await importRecoveryPrivateKey(await openRecoveryPayload<string>(device.recovery_ciphertext!,deviceBackupBinding(memberId,device,backup.recovery.fingerprint),recovery,device.public_key),device.fingerprint);
  devices.push({device,key});
 }
 return{devices,recovery};
}
