import {base64ToBytes,bytesToBase64} from '@porchday/crypto';
import {wrapRecoverySecret,unwrapRecoverySecret,type RecoveryCapsule} from '@porchday/crypto/recovery';
export type RecoveryPasskey={credentialId:string;salt:string;rpId:string;recoveryFingerprint:string;backupEligible:boolean;capsule:RecoveryCapsule};
const b64url=(value:ArrayBuffer)=>bytesToBase64(new Uint8Array(value)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const fromUrl=(value:string)=>new Uint8Array(base64ToBytes(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4)));
const random=()=>crypto.getRandomValues(new Uint8Array(32));
type PRF={enabled?:boolean;results?:{first:ArrayBuffer}};
type Output={prf?:PRF};
function result(credential:PublicKeyCredential){const first=(credential.getClientExtensionResults() as Output).prf?.results?.first;if(!first||first.byteLength!==32)throw Error('This passkey, browser or device cannot unlock encrypted backups. Use another provider or pair a trusted device.');return new Uint8Array(first);}
function validate(credential:PublicKeyCredential,challenge:Uint8Array,creation:boolean){
 const data=JSON.parse(new TextDecoder().decode(credential.response.clientDataJSON));
 if(data.origin!==location.origin||data.crossOrigin===true||data.type!==(creation?'webauthn.create':'webauthn.get')||data.challenge!==b64url(challenge.buffer as ArrayBuffer))throw Error('Passkey response did not match this request.');
 const response=credential.response as AuthenticatorAssertionResponse & AuthenticatorAttestationResponse;
 const authData=creation?response.getAuthenticatorData():response.authenticatorData;
 const flags=new Uint8Array(authData)[32];if(flags===undefined||(flags&5)!==5)throw Error('Unlock your passkey with biometrics or its PIN.');
 return !!(flags&8);
}
export function passkeyRecoveryAvailable(){return typeof PublicKeyCredential!=='undefined'&&!!navigator.credentials&&window.isSecureContext;}
function binding(memberId:string,id:string,value:Pick<RecoveryPasskey,'credentialId'|'salt'|'rpId'|'recoveryFingerprint'>){return{v:1,purpose:'porchday-passkey-recovery',memberId,methodId:id,credentialId:value.credentialId,salt:value.salt,rpId:value.rpId,recoveryFingerprint:value.recoveryFingerprint};}
async function evaluate(value:Pick<RecoveryPasskey,'credentialId'|'salt'|'rpId'>){
 if(value.rpId!==location.hostname)throw Error('Use this passkey on the Porchday address where you created it.');
 const challenge=random();
 const credential=await navigator.credentials.get({publicKey:{challenge,rpId:value.rpId,allowCredentials:[{type:'public-key',id:fromUrl(value.credentialId)}],userVerification:'required',timeout:120000,extensions:{prf:{eval:{first:new Uint8Array(base64ToBytes(value.salt))}}} as AuthenticationExtensionsClientInputs}}) as PublicKeyCredential|null;
 if(!credential||b64url(credential.rawId)!==value.credentialId)throw Error('Passkey recovery was cancelled.');
 validate(credential,challenge,false);return result(credential);
}
export async function enrollRecoveryPasskey(memberId:string,handle:string,id:string,recoveryFingerprint:string,secret:string):Promise<RecoveryPasskey>{
 if(!passkeyRecoveryAvailable())throw Error('Passkeys are unavailable here. Pair another trusted device instead.');
 const challenge=random(),salt=bytesToBase64(random()),rpId=location.hostname;
 const credential=await navigator.credentials.create({publicKey:{challenge,rp:{id:rpId,name:'Porchday'},user:{id:new TextEncoder().encode(memberId),name:handle,displayName:handle},pubKeyCredParams:[{type:'public-key',alg:-7},{type:'public-key',alg:-257}],authenticatorSelection:{residentKey:'required',userVerification:'required'},attestation:'none',timeout:120000,extensions:{prf:{eval:{first:new Uint8Array(base64ToBytes(salt))}}} as AuthenticationExtensionsClientInputs}}) as PublicKeyCredential|null;
 if(!credential)throw Error('Passkey setup was cancelled.');
 const backupEligible=validate(credential,challenge,true),credentialId=b64url(credential.rawId),metadata={credentialId,salt,rpId,recoveryFingerprint,backupEligible};
 let material:Uint8Array;
 if((credential.getClientExtensionResults() as Output).prf?.results?.first)material=result(credential);
 else material=await evaluate(metadata);
 try{
  const capsule=await wrapRecoverySecret(secret,material,binding(memberId,id,metadata));
  const passkey={...metadata,capsule};
  // A separate assertion proves the saved passkey can reproduce the wrapping key.
  if(await unlockRecoveryPasskey(memberId,id,passkey)!==secret)throw Error('Passkey recovery verification failed.');
  return passkey;
 }finally{material.fill(0);}
}
export async function unlockRecoveryPasskey(memberId:string,id:string,value:RecoveryPasskey){
 const material=await evaluate(value);try{return await unwrapRecoverySecret(value.capsule,material,binding(memberId,id,value));}finally{material.fill(0);}
}
