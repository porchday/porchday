import {describe,it,expect,vi} from 'vitest';
import {request} from '../src/api';
import {photoEpoch} from '../src/photo-cache';
import {PhotoCache,schedulePhoto} from '../src/photo-cache';
const photo=(expiresAt:number|null=null)=>({blob:new Blob(['photo']),width:10,height:10,expiresAt});
describe('verified photo memory cache',()=>{
 it('retains photos for reactions/comments but invalidates deletion and access denial',async()=>{
  const original=globalThis.fetch;globalThis.fetch=vi.fn(async()=>Response.json({ok:true}));
  try{const before=photoEpoch();await request('/photos/id/interactions',{method:'POST'});await request('/photos/id/interactions/comment',{method:'DELETE'});await request('/posts/id/comments/comment',{method:'DELETE'});expect(photoEpoch()).toBe(before);
   await request('/photos/id',{method:'DELETE'});expect(photoEpoch()).toBe(before+1);
   globalThis.fetch=vi.fn(async()=>Response.json({error:'denied'},{status:403}));await expect(request('/photos/id')).rejects.toThrow();expect(photoEpoch()).toBe(before+2);
  }finally{globalThis.fetch=original;}
 });
 it('coalesces concurrent reads; warm reuse still authorizes without decoding again',async()=>{
  const cache=new PhotoCache(),authorize=vi.fn(async()=>{}),load=vi.fn(async()=>photo());
  await Promise.all(Array.from({length:20},()=>cache.read('account:key:media:proof',authorize,load)));
  await cache.read('account:key:media:proof',authorize,load);
  expect(load).toHaveBeenCalledTimes(1);expect(authorize).toHaveBeenCalledTimes(1);
 });
 it('expires idle entries proactively and caps tiny-photo entry count',async()=>{
  vi.useFakeTimers();try{const cache=new PhotoCache(),load=vi.fn(async()=>photo(Date.now()+50)),authorize=vi.fn(async()=>{});
   await cache.read('a',authorize,load);await vi.advanceTimersByTimeAsync(60);
   await cache.read('a',authorize,async()=>photo());expect(authorize).not.toHaveBeenCalled();cache.clear();
   const tiny=new PhotoCache();for(let i=0;i<97;i++)await tiny.read(String(i),async()=>{},async()=>photo());
   const again=vi.fn(async()=>photo());await tiny.read('0',async()=>{},again);expect(again).toHaveBeenCalledTimes(1);tiny.clear();
  }finally{vi.useRealTimers();}
 });
 it('denied access evicts cached bytes and cannot display a warm result',async()=>{
  const cache=new PhotoCache(),load=vi.fn(async()=>photo());await cache.read('a',async()=>{},load);
  await expect(cache.read('a',async()=>{throw Error('denied');},load)).rejects.toThrow('denied');
  await cache.read('a',async()=>{},load);expect(load).toHaveBeenCalledTimes(2);
 });
 it('enforces expiry and LRU byte plus decoded-pixel budgets',async()=>{
  let now=0;const cache=new PhotoCache(1326,100,()=>now),load=vi.fn(async()=>photo());
  for(const key of ['a','b','a','c','a','b'])await cache.read(key,async()=>{},load);
  expect(load).toHaveBeenCalledTimes(4);now=101;await cache.read('b',async()=>{},load);expect(load).toHaveBeenCalledTimes(5);
  await expect(cache.read('expired',async()=>{},async()=>photo(100))).rejects.toThrow('expired');
 });
 it('rejects late completions after logout or invalidation',async()=>{
  const cache=new PhotoCache();let done!:(v:ReturnType<typeof photo>)=>void;
  const pending=cache.read('a',async()=>{},()=>new Promise(resolve=>{done=resolve;}));
  await Promise.resolve();cache.clear();done(photo());await expect(pending).rejects.toThrow('access changed');
  const load=vi.fn(async()=>photo());await cache.read('a',async()=>{},load);expect(load).toHaveBeenCalledTimes(1);
 });
 it('keeps different account/key/proof identities separate and never retains oversized images',async()=>{
  const cache=new PhotoCache(100),load=vi.fn(async()=>photo());
  for(const key of ['account1:key1:proof1','account1:key1:proof1','account2:key2:proof1'])await cache.read(key,async()=>{},load);
  expect(load).toHaveBeenCalledTimes(3);
 });
 it('bounds concurrent preloads and removes queued work outside the viewport',async()=>{
  let active=0,max=0;const release:Array<()=>void>=[];
  const work=()=>new Promise<number>(resolve=>{active++;max=Math.max(max,active);release.push(()=>{active--;resolve(1);});});
  const controller=new AbortController();const first=Array.from({length:3},()=>schedulePhoto(work,()=>0,new AbortController().signal));
  const canceled=schedulePhoto(work,()=>0,controller.signal);controller.abort();await expect(canceled).rejects.toThrow('nearby');
  release.forEach(fn=>fn());await Promise.all(first);expect(max).toBe(3);expect(release).toHaveLength(3);
 });
});
