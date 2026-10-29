import {describe,it,expect,vi} from 'vitest';
import {randomUUID,randomBytes,createECDH,generateKeyPairSync} from 'node:crypto';
import webPush from 'web-push';
import {deliverWebPush} from '../src/social-push';
import {deliverNativePush} from '../src/social-native-push';
import {persistSessionDenial} from '../src/session-denial';
import type {Env} from '../src/types';
const vapid=webPush.generateVAPIDKeys(),curve=createECDH('prime256v1');curve.generateKeys();
const web={endpoint:'https://fcm.googleapis.com/wp/synthetic',keys:{p256dh:curve.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
const native={token:'ab'.repeat(32),environment:'sandbox' as const};
const env={ENVIRONMENT:'production',VAPID_PUBLIC_KEY:vapid.publicKey,VAPID_PRIVATE_KEY:vapid.privateKey,VAPID_SUBJECT:'mailto:push@example.test',APNS_TEAM_ID:'TEAM123456',APNS_KEY_ID:'KEY1234567',APNS_BUNDLE_ID:'com.porchday.app',APNS_PRIVATE_KEY:generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({type:'pkcs8',format:'pem'}).toString()} as Env;
const deliver=(kind:'web'|'native',sessionId:string,store:unknown,send:typeof fetch)=>kind==='web'?deliverWebPush({...env,RECOVERY_JOURNAL:store as R2Bucket},{sessionId,subscription:web},1,send):deliverNativePush({...env,RECOVERY_JOURNAL:store as R2Bucket},{sessionId,subscription:native},1,'synthetic-provider-token',send);
for(const kind of ['web','native'] as const)describe(kind+' isolated delivery guard',()=>{
 it('suppresses the exact denied session and permits an independent session without claiming jobs',async()=>{
  const denied=randomUUID(),other=randomUUID(),records=new Map<string,string>();const store={get:async(key:string)=>records.has(key)?{etag:'one',text:async()=>records.get(key)!}:null,put:async(key:string,text:string)=>{records.set(key,text);return{etag:'one'};}};
  await persistSessionDenial(store,denied);const send=vi.fn(async()=>new Response(null,{status:200}));
  expect(await deliver(kind,denied,store,send)).toMatchObject({outcome:'failed'});expect(send).not.toHaveBeenCalled();expect(await deliver(kind,other,store,send)).toMatchObject({outcome:'sent'});expect(send).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(send.mock.calls)).not.toContain(denied);expect(JSON.stringify(send.mock.calls)).not.toContain(other);
 });
 it('fails closed on missing, failed or conflicting denial reads',async()=>{
  const send=vi.fn(async()=>new Response(null,{status:200}));for(const store of [undefined,{get:async()=>{throw Error('unavailable');}},{get:async()=>({etag:'one',text:async()=>'{}'})}])expect(await deliver(kind,randomUUID(),store,send)).toMatchObject({outcome:'retry'});expect(send).not.toHaveBeenCalled();
 });
 it('does not send when an otherwise-valid denial read completes after its deadline',async()=>{
  vi.useFakeTimers();try{let resolve!:(x:null)=>void;const store={get:()=>new Promise<null>(r=>{resolve=r;})},send=vi.fn(async()=>new Response(null,{status:200}));const result=deliver(kind,randomUUID(),store,send);await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'));await vi.advanceTimersByTimeAsync(2001);expect(await result).toMatchObject({outcome:'retry'});resolve(null);await Promise.resolve();expect(send).not.toHaveBeenCalled();}finally{vi.useRealTimers();}
 });
 it('retains redirect and retry handling for permitted sessions',async()=>{
  const store={get:async()=>null};expect(await deliver(kind,randomUUID(),store,async()=>new Response(null,{status:307}))).toMatchObject({outcome:'failed'});
  expect(await deliver(kind,randomUUID(),store,async()=>new Response(null,{status:429,headers:{'retry-after':'120'}}))).toMatchObject({outcome:'retry',delay:120});
 });
});
