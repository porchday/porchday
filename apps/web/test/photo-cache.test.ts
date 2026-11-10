import {describe,it,expect,vi} from 'vitest';
import {request} from '../src/api';
import {photoEpoch} from '../src/photo-cache';
import {PhotoCache,schedulePhoto,photoMatches,photoCache} from '../src/photo-cache';
const photo=(expiresAt:number|null=null)=>({blob:new Blob(['photo']),width:10,height:10,expiresAt});
describe('verified photo memory cache',()=>{
 it('retains photos for reactions/comments but invalidates deletion and access denial',async()=>{
  const original=globalThis.fetch;globalThis.fetch=vi.fn(async()=>Response.json({ok:true}));
  try{const before=photoEpoch();await request('/photos/id/interactions',{method:'POST'});await request('/photos/id/interactions/comment',{method:'DELETE'});await request('/posts/id/comments/comment',{method:'DELETE'});expect(photoEpoch()).toBe(before);
   await request('/photos/id',{method:'DELETE'});expect(photoEpoch()).toBe(before+1);
   globalThis.fetch=vi.fn(async()=>Response.json({error:'denied'},{status:403}));await expect(request('/photos/id')).rejects.toThrow();expect(photoEpoch()).toBe(before+2);
  }finally{globalThis.fetch=original;}
 });
 it('targets background media/history writes without evicting unrelated photos',async()=>{
  const original=globalThis.fetch;globalThis.fetch=vi.fn(async()=>Response.json({ok:true}));photoCache.clear();
  const a=JSON.stringify({id:'visible'}),b=JSON.stringify({id:'background'}),loadA=vi.fn(async()=>({...photo(),parentId:'post-a'})),loadB=vi.fn(async()=>({...photo(),parentId:'post-b'}));
  try{
   await photoCache.read(a,async()=>{},loadA);await photoCache.read(b,async()=>{},loadB);
   await request('/media',{method:'POST',body:JSON.stringify({id:'new-media'})});await request('/api/v1/media/new-media/bytes',{method:'PUT'});
   await request('/posts/post-b/audience-refresh',{method:'POST'});await request('/media/new-media',{method:'DELETE'});
   await photoCache.read(a,async()=>{},loadA);expect(loadA).toHaveBeenCalledTimes(1);
   await photoCache.read(b,async()=>{},loadB);expect(loadB).toHaveBeenCalledTimes(2);
   await request('/connections/peer',{method:'DELETE'});await photoCache.read(a,async()=>{},loadA);expect(loadA).toHaveBeenCalledTimes(2);
   globalThis.fetch=vi.fn(async()=>Response.json({}, {status:403}));await expect(request('/unrelated')).rejects.toThrow();
   await photoCache.read(a,async()=>{},loadA);expect(loadA).toHaveBeenCalledTimes(3);
  }finally{globalThis.fetch=original;photoCache.clear();}
 });
 it('rejects scoped invalidated pending work without disturbing its replacement or unrelated loads',async()=>{
  const cache=new PhotoCache(),a=JSON.stringify({id:'a'}),b=JSON.stringify({id:'b'});let releaseA!:(v:ReturnType<typeof photo>)=>void,releaseB!:(v:ReturnType<typeof photo>)=>void;
  const old=cache.read(a,async()=>{},()=>new Promise(resolve=>{releaseA=resolve;}));const oldResult=old.catch(error=>error);
  const other=cache.read(b,async()=>{},()=>new Promise(resolve=>{releaseB=resolve;}));
  cache.clear(key=>photoMatches(key,{mediaId:'a'}));
  const replacement=vi.fn(async()=>photo());await cache.read(a,async()=>{},replacement);
  releaseA(photo());expect(await oldResult).toBeInstanceOf(Error);
  releaseB(photo());await other;await cache.read(a,async()=>{},replacement);expect(replacement).toHaveBeenCalledTimes(1);cache.clear();
 });
 it('invalidates unknown parent scopes conservatively',()=>{
  expect(photoMatches(JSON.stringify({id:'a'}),{parentId:'post-a'})).toBe(true);
  expect(photoMatches(JSON.stringify({id:'a'}),{parentId:'post-a'},{parentId:null})).toBe(false); // Signed root media cannot belong to this post.
  expect(photoMatches(JSON.stringify({id:'a'}),{parentId:'post-a'},{parentId:'post-b'})).toBe(false);
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
   const tiny=new PhotoCache();for(let i=0;i<257;i++)await tiny.read(String(i),async()=>{},async()=>photo());
   const again=vi.fn(async()=>photo());await tiny.read('0',async()=>{},again);expect(again).toHaveBeenCalledTimes(1);tiny.clear();
  }finally{vi.useRealTimers();}
 });
 it('retains a realistic twenty-screen photo history beyond two minutes without redecoding',async()=>{
  let now=0;const cache=new PhotoCache(undefined,undefined,()=>now),loads=vi.fn(async()=>({...photo(),blob:new Blob([new Uint8Array(512*1024)]),width:2400,height:1600}));
  for(let i=0;i<80;i++)await cache.read(String(i),async()=>{},loads);
  now=10*60_000;for(let i=79;i>=0;i--)await cache.read(String(i),async()=>{},loads);
  expect(loads).toHaveBeenCalledTimes(80);cache.clear();
 });
 it('keeps session blobs across foreground revalidation but rejects suspended pending work',async()=>{
  const cache=new PhotoCache(),load=vi.fn(async()=>photo()),authorize=vi.fn(async()=>{});await cache.read('warm',authorize,load);
  let done!:(v:ReturnType<typeof photo>)=>void;const pending=cache.read('pending',authorize,()=>new Promise(resolve=>done=resolve));cache.cancelPending();done(photo());await expect(pending).rejects.toThrow('access changed');
  await cache.read('warm',authorize,load);expect(load).toHaveBeenCalledTimes(1);expect(authorize).toHaveBeenCalledTimes(1);cache.clear();
 });
 it('reserves a fourth slot for visible work ahead of speculative photos',async()=>{
  const release:Array<()=>void>=[],order:string[]=[];
  const work=(id:string)=>()=>new Promise<void>(resolve=>{order.push(id);release.push(resolve);});
  const first=Array.from({length:3},(_,i)=>schedulePhoto(work(String(i)),()=>0,new AbortController().signal));
  const far=schedulePhoto(work('far'),()=>-6,new AbortController().signal),visible=schedulePhoto(work('visible'),()=>1,new AbortController().signal);
  expect(order).toEqual(['0','1','2','visible']);release.slice().forEach(fn=>fn());await Promise.all([...first,visible]);
  expect(order).toContain('far');release.at(-1)!();await far;
 });
 it('denied access evicts cached bytes and cannot display a warm result',async()=>{
  const cache=new PhotoCache(),load=vi.fn(async()=>photo());await cache.read('a',async()=>{},load);
  await expect(cache.read('a',async()=>{throw Error('denied');},load)).rejects.toThrow('denied');
  await cache.read('a',async()=>{},load);expect(load).toHaveBeenCalledTimes(2);
 });
 it('enforces expiry and LRU compressed-byte budgets',async()=>{
  let now=0;const cache=new PhotoCache(526,100,()=>now),load=vi.fn(async()=>photo());
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
