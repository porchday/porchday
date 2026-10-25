import {describe,expect,it,vi} from 'vitest';
import {initializeEmptyProfile} from '../src/initial-profile';
import {ApiError,type Content,type EncryptedEnvelope} from '../src/api';
import {WALLPAPERS} from '../src/wallpaper';

const envelope = () => ({ciphertext:crypto.randomUUID()}) as unknown as EncryptedEnvelope;

describe('starter wallpaper persistence',()=>{
 it('preserves any saved profile, including older profiles without a wallpaper',async()=>{
  const seal=vi.fn(),save=vi.fn();
  expect(await initializeEmptyProfile({read:async()=>({envelope:envelope()}),seal,save})).toBe(false);
  expect(seal).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();
 });
 it('encrypts one allowed choice and reuses the saved profile on later unlocks',async()=>{
  let stored:EncryptedEnvelope|null=null;
  const payloads:Content[]=[];
  const io={read:async()=>({envelope:stored}),seal:async(profile:Content)=>{payloads.push(profile);return envelope();},save:async(value:EncryptedEnvelope)=>{stored=value;}};
  expect(await initializeEmptyProfile(io)).toBe(true);
  const original=stored;
  expect(await initializeEmptyProfile(io)).toBe(false);
  expect(stored).toBe(original);expect(payloads).toHaveLength(1);
  expect(WALLPAPERS.map(p=>p.id)).toContain(payloads[0].wallpaper);
 });
 it('lets a concurrent saved profile win without replacing it',async()=>{
  let stored:EncryptedEnvelope|null=null;
  const candidates:EncryptedEnvelope[]=[];
  const io={read:async()=>({envelope:stored}),seal:async()=>{const value=envelope();candidates.push(value);return value;},save:async(value:EncryptedEnvelope)=>{
   if(stored)throw new ApiError(409,{error:{code:'REVISION_CHANGED'}});
   stored=value;
  }};
  const results=await Promise.all([initializeEmptyProfile(io),initializeEmptyProfile(io)]);
  expect(results.filter(Boolean)).toHaveLength(1);expect(candidates).toHaveLength(2);
  expect(stored).toBe(candidates[0]);
 });
 it('can recover an ambiguous committed save without randomizing again',async()=>{
  let stored:EncryptedEnvelope|null=null;const seal=vi.fn(async()=>envelope());
  const io={read:async()=>({envelope:stored}),seal,save:async(value:EncryptedEnvelope)=>{stored=value;throw new Error('transport unavailable');}};
  await expect(initializeEmptyProfile(io)).rejects.toThrow('transport unavailable');
  const original=stored;
  expect(await initializeEmptyProfile(io)).toBe(false);
  expect(stored).toBe(original);expect(seal).toHaveBeenCalledTimes(1);
 });
 it('does not claim a failed or unconfirmed write succeeded',async()=>{
  await expect(initializeEmptyProfile({read:async()=>({envelope:null}),seal:async()=>envelope(),save:async()=>{throw new ApiError(409,{error:{code:'REVISION_CHANGED'}});}})).rejects.toMatchObject({code:'REVISION_CHANGED'});
 });
});
