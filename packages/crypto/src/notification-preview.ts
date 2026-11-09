/** Notification-only keys. Account and recovery keys never leave the normal vault. */
import {base64ToBytes,bytesToBase64,canonicalJson,signStatement,verifyStatement,type SignedStatement,type UnlockedPrivateKey} from './index.ts';
const encode=(x:unknown)=>new TextEncoder().encode(canonicalJson(x));
export type PreviewIdentity={v:1;purpose:'porchday-notification-key';memberId:string;deviceId:string;keyId:string;publicKey:string};
export type PreviewContext={v:1;purpose:'porchday-notification-preview';kind:'post'|'photo';id:string;authorId:string;authorDeviceId:string;revision:number;expiresAt:string|null};
export type PreviewContent={text:string;image?:string};
export type PreviewWrap={keyId:string;memberId:string;deviceId:string;ephemeral:string;iv:string;ciphertext:string};
export type PreviewPackage={context:PreviewContext;iv:string;ciphertext:string;recipients:PreviewWrap[]};
export async function notificationKey(){const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);return{privateKey:pair.privateKey,publicKey:bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey)))};}
export function previewBinding(context:PreviewContext,key:Pick<PreviewIdentity,'keyId'|'memberId'|'deviceId'>){return{...context,keyId:key.keyId,memberId:key.memberId,deviceId:key.deviceId};}
async function wrappingKey(privateKey:CryptoKey,publicKey:string,binding:unknown){
 const remote=await crypto.subtle.importKey('raw',base64ToBytes(publicKey),{name:'ECDH',namedCurve:'P-256'},false,[]);
 const secret=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:remote},privateKey,256));
 try{const material=await crypto.subtle.importKey('raw',secret,'HKDF',false,['deriveKey']);return await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:new Uint8Array(32),info:encode(binding)},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);}finally{secret.fill(0);}
}
export async function sealPreview(context:PreviewContext,content:PreviewContent,keys:PreviewIdentity[],author:UnlockedPrivateKey):Promise<SignedStatement<PreviewPackage>>{
 if(!keys.length||keys.length>1000||new Set(keys.map(k=>k.keyId)).size!==keys.length)throw Error('INVALID_PREVIEW_RECIPIENTS');
 if([...content.text].length>240||content.image&&(!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(content.image)||content.image.length>24000))throw Error('INVALID_PREVIEW_CONTENT');
 const clear=encode(content);if(clear.length>26000)throw Error('PREVIEW_TOO_LARGE');
 const raw=crypto.getRandomValues(new Uint8Array(32)),iv=crypto.getRandomValues(new Uint8Array(12));
 try{const aes=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['encrypt']);const ciphertext=bytesToBase64(new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encode(context)},aes,clear)));
 const ephemeral=await notificationKey();const recipients:PreviewWrap[]=[];
 for(const key of keys){const binding=previewBinding(context,key),wrap=await wrappingKey(ephemeral.privateKey,key.publicKey,binding),nonce=crypto.getRandomValues(new Uint8Array(12));recipients.push({keyId:key.keyId,memberId:key.memberId,deviceId:key.deviceId,ephemeral:ephemeral.publicKey,iv:bytesToBase64(nonce),ciphertext:bytesToBase64(new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:encode(binding)},wrap,raw)))});}
 return await signStatement({context,iv:bytesToBase64(iv),ciphertext,recipients},author);
 }finally{raw.fill(0);clear.fill(0);}
}
export async function openPreview(signed:SignedStatement<PreviewPackage>,expected:PreviewContext,identity:PreviewIdentity,privateKey:CryptoKey,authorPublicKey:string):Promise<PreviewContent>{
 const p=await verifyStatement(signed,authorPublicKey);if(canonicalJson(p.context)!==canonicalJson(expected)||expected.purpose!=='porchday-notification-preview'||expected.v!==1||expected.expiresAt&&(!Number.isFinite(Date.parse(expected.expiresAt))||Date.parse(expected.expiresAt)<=Date.now()))throw Error('PREVIEW_CONTEXT_MISMATCH');
 const recipient=p.recipients.find(r=>r.keyId===identity.keyId&&r.memberId===identity.memberId&&r.deviceId===identity.deviceId);if(!recipient)throw Error('PREVIEW_NOT_ADDRESSED');
 const binding=previewBinding(expected,identity),wrap=await wrappingKey(privateKey,recipient.ephemeral,binding),raw=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:base64ToBytes(recipient.iv),additionalData:encode(binding)},wrap,base64ToBytes(recipient.ciphertext)));
 try{const aes=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);const plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:base64ToBytes(p.iv),additionalData:encode(expected)},aes,base64ToBytes(p.ciphertext)));try{if(plain.length>26000)throw Error('PREVIEW_TOO_LARGE');const c=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));if(typeof c.text!=='string'||[...c.text].length>240||c.image&&(!/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(c.image)||c.image.length>24000))throw Error('INVALID_PREVIEW_CONTENT');return c;}finally{plain.fill(0);}}finally{raw.fill(0);}
}
