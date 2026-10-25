import {describe,it,expect} from 'vitest';
import {captureDestinationProfile,assertDistinctDestination,endSessionOnce} from './hosted-archive-migration-support.js';
import {captureArchiveImport} from './hosted-browser-archive-support.js';
import {localOrigin,localVerificationLink} from './archive-local-environment.js';
import type {EncryptedEnvelope} from '@porchday/crypto';
const member='22222222-2222-4222-8222-222222222222',source='11111111-1111-4111-8111-111111111111',device='33333333-3333-4333-8333-333333333333';
const oldId='44444444-4444-4444-8444-444444444444',newId='55555555-5555-4555-8555-555555555555',job='66666666-6666-4666-8666-666666666666';
const created='2026-10-25T00:00:00.000Z',expires='2026-10-25T20:00:00.000Z';
const previous={v:1,protocol:'porchday-openpgp-v1',ciphertext:'fixture',context:{id:member,kind:'profile',authorId:member,authorDeviceId:device,audience:'connections',parentId:null,groupId:null,epoch:1,createdAt:created,expiresAt:null,revision:1},recipients:[{memberId:member,deviceId:device,fingerprint:'a'.repeat(64)}]} as EncryptedEnvelope;
const boundary=()=>({member,device,originalIds:new Set([source,oldId]),sources:new Map([[`${source}:post:${oldId}`,{id:oldId,journal_kind:'post',created_at:created,expires_at:expires}]]),media:new Map(),posts:new Set<string>()});
describe('clean destination migration boundaries',()=>{
 it('does not repeat a confirmed signout during finally, and never marks a failed signout confirmed',async()=>{
  const state={ended:false};let calls=0;const end=async()=>{calls++;if(calls>1)throw Error('Unauthenticated after first signout');};
  await endSessionOnce(state,end);await endSessionOnce(state,end);expect(calls).toBe(1);expect(state.ended).toBe(true);
  const failed={ended:false};await expect(endSessionOnce(failed,async()=>{throw Error('Synthetic uncertain response');})).rejects.toThrow();expect(failed.ended).toBe(false);
 });
 it('admits only the explicit loopback origin and intended verification recipient/callback',()=>{
  expect(localOrigin('http://127.0.0.1:44811')).toBe('http://127.0.0.1:44811');
  for(const origin of ['https://staging.porchday.com','http://127.0.0.1.evil.test:44811','http://user:password@127.0.0.1:44811','http://127.0.0.1:80'])expect(()=>localOrigin(origin)).toThrow();
  const origin='http://127.0.0.1:44811',message={to:'synthetic@example.test',text:`Verify: ${origin}/api/auth/verify-email?token=local-only&callbackURL=${encodeURIComponent(origin+'/login?verified=1')}`};
  expect(localVerificationLink(message,message.to,origin)).toContain('/api/auth/verify-email?');
  expect(()=>localVerificationLink(message,'different@example.test',origin)).toThrow();
  expect(()=>localVerificationLink({...message,text:message.text.replace(encodeURIComponent(origin+'/login?verified=1'),encodeURIComponent('https://example.test/login'))},message.to,origin)).toThrow();
 });
 it('requires both a new account and different cryptographic identity',()=>{
  const a={id:source,device:{keys:{fingerprint:'source-key'}}};expect(()=>assertDistinctDestination(a,{id:member,fingerprint:'new-key'})).not.toThrow();
  expect(()=>assertDistinctDestination(a,{id:source,fingerprint:'new-key'})).toThrow();expect(()=>assertDistinctDestination(a,{id:member,fingerprint:'source-key'})).toThrow();
 });
 it('permits the new destination profile revision, never source replacement or added recipients',()=>{
  const envelope={...previous,context:{...previous.context,audience:'only_me' as const,revision:2}},body={id:job,posts:[],profile:{envelope}};
  expect(captureDestinationProfile(body,boundary(),previous)).toBe(envelope);
  for(const change of [{id:source},{authorId:source},{revision:1},{createdAt:'2026-10-24T00:00:00.000Z'},{audience:'connections'}])expect(()=>captureDestinationProfile({...body,profile:{envelope:{...envelope,context:{...envelope.context,...change}}}},boundary(),previous)).toThrow();
  expect(()=>captureDestinationProfile({...body,profile:{envelope:{...envelope,recipients:[...envelope.recipients,{memberId:source,deviceId:device,fingerprint:'b'.repeat(64)}]}}},boundary(),previous)).toThrow();
  expect(()=>captureDestinationProfile({...body,posts:[{}]},boundary(),previous)).toThrow();
 });
 it('preserves source identity and absolute timestamps while making new private destination entries',()=>{
  const envelope={...previous,context:{...previous.context,id:newId,kind:'post' as const,audience:'only_me' as const,expiresAt:expires}},body={id:job,posts:[{envelope,source_id:`${source}:post:${oldId}`,media_ids:[]}]};
  expect(captureArchiveImport(body,boundary()).posts[0].id).toBe(newId);
  expect(()=>captureArchiveImport({...body,posts:[{...body.posts[0],envelope:{...envelope,context:{...envelope.context,expiresAt:null}}}]},boundary())).toThrow();
  expect(()=>captureArchiveImport({...body,posts:[{...body.posts[0],source_id:`${member}:post:${oldId}`}]},boundary())).toThrow();
  const expired=boundary();expired.sources.clear();expect(()=>captureArchiveImport(body,expired)).toThrow();
 });
});
