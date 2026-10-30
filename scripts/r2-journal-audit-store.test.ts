import {describe,it,expect,vi} from 'vitest';
import {R2JournalAuditStore} from './r2-journal-audit-store.js';
import {readJournalControl,provePrivacyReceipts,sha256} from '../apps/api/src/privacy-journal.js';
import {provePrivacyCommits} from '../apps/api/src/privacy-commit-proof.js';
const make=(request:typeof fetch,signal=new AbortController().signal)=>new R2JournalAuditStore({accountId:'a'.repeat(32),apiToken:'synthetic-test-token',bucket:'synthetic-journal',signal,fetch:request});
describe('content-only R2 journal audit reader',()=>{
 it.each([undefined,'W/"weak"','"provider-tag"'])('reads proof bytes without trusting REST tag %s',async etag=>{
  const request=vi.fn<typeof fetch>(async(input,init)=>{
   expect(String(input)).toContain('/objects/commit-scopes%2Fv1%2Fexample.json');
   expect(init?.method).toBe('GET');expect(init?.redirect).toBe('error');
   expect(new Headers(init?.headers).has('if-match')).toBe(false);
   return new Response('{"v":1}',{headers:etag?{etag}:{}});
  });
  const object=await make(request).get('commit-scopes/v1/example.json');
  expect(await object?.text()).toBe('{"v":1}');expect(object?.etag).toMatch(/^audit-content-sha256:[a-f0-9]{64}$/);
 });
 it('rejects all writes before any request, even after a successful read',async()=>{
  const request=vi.fn<typeof fetch>(async()=>new Response('{}')),store=make(request);
  await store.get('control.json');await expect(store.put()).rejects.toThrow('R2_AUDIT_READ_ONLY');expect(request).toHaveBeenCalledTimes(1);
 });
 it.each(['','../control.json','a/../b','a/./b','a\u0000b'])('rejects unsafe key %j before requesting',async key=>{
  const request=vi.fn<typeof fetch>();await expect(make(request).get(key)).rejects.toThrow('R2_AUDIT_KEY_INVALID');expect(request).not.toHaveBeenCalled();
 });
 it('distinguishes absent objects from failed or partial responses',async()=>{
  expect(await make(async()=>new Response(null,{status:404})).get('control.json')).toBeNull();
  for(const status of [206,301,403,500])await expect(make(async()=>new Response('private provider details',{status})).get('control.json')).rejects.toThrow('R2_AUDIT_READ_FAILED');
 });
 it('bounds declared and streamed bodies and cancels an oversized stream',async()=>{
  await expect(make(async()=>new Response('{}',{headers:{'content-length':String(1024*1024+1)}})).get('control.json')).rejects.toThrow('R2_AUDIT_OBJECT_LIMIT');
  const cancel=vi.fn();const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(1024*1024));c.enqueue(new Uint8Array(1));},cancel});
  await expect(make(async()=>new Response(stream)).get('control.json')).rejects.toThrow('R2_AUDIT_OBJECT_LIMIT');expect(cancel).toHaveBeenCalled();
 });
 it('honors cancellation even if transport or body ignores its signal',async()=>{
  for(const body of [false,true]){
   const abort=new AbortController(),cancel=vi.fn();
   const request:typeof fetch=body?async()=>new Response(new ReadableStream({cancel})):()=>new Promise(()=>{});
   const pending=make(request,abort.signal).get('control.json');await Promise.resolve();await Promise.resolve();abort.abort();
   await expect(pending).rejects.toThrow('R2_AUDIT_READ_FAILED');
  }
 });
 it('rejects a pre-aborted request without I/O and hides transport errors',async()=>{
  const abort=new AbortController();abort.abort();const request=vi.fn<typeof fetch>();await expect(make(request,abort.signal).get('control.json')).rejects.toThrow('R2_AUDIT_READ_FAILED');expect(request).not.toHaveBeenCalled();
  await expect(make(async()=>{throw Error('private transport details');}).get('control.json')).rejects.toThrow(/^R2_AUDIT_READ_FAILED$/);
 });
 it('rejects invalid UTF-8 rather than changing the bytes used by proof hashes',async()=>{
  await expect(make(async()=>new Response(new Uint8Array([0xff]))).get('control.json')).rejects.toThrow('R2_AUDIT_READ_FAILED');
 });
 it('feeds canonical marker and receipt proof without ETags, while rejecting altered batch bytes',async()=>{
  const id=crypto.randomUUID(),generation=crypto.randomUUID(),started_at=new Date().toISOString(),intent={v:1 as const,id,started_at};
  const intentText=JSON.stringify(intent),scope={v:1,id,started_at,generation,transaction:'single-auth-transaction',intent_sha256:await sha256(intentText),baseline:{sequence:'0',head:null}},scopeText=JSON.stringify(scope),scopeSha256=await sha256(scopeText);
  const batch=JSON.stringify({v:1,generation,from:'1',to:'1',previous:null,events:[{sequence:'1',id:crypto.randomUUID(),occurred_at:started_at,decision:{kind:'privacy_operation_committed',operation_id:id,scope_sha256:scopeSha256}}]}),hash=await sha256(batch),key=`batches/${generation}/1-1-${hash}.json`,head={key,hash};
  const rows=new Map([
   ['control.json',JSON.stringify({v:1,generation,mode:'active',sequence:'1',head,pending:[{id,started_at}],reason:null})],
   [`intents/${id}.json`,intentText],[`commit-scopes/v1/${id}.json`,scopeText],[key,batch],
   [`receipts/${id}.json`,JSON.stringify({v:1,id,generation,sequence:'1',head})],
  ]);
  const store=make(async(input,init)=>{expect(init?.method).toBe('GET');const raw=rows.get(decodeURIComponent(String(input).split('/objects/')[1]));return raw===undefined?new Response(null,{status:404}):new Response(raw);});
  const control=await readJournalControl(store);
  expect((await provePrivacyCommits(store,control.value)).get(id)).toEqual({sequence:'1',scopeSha256});
  expect((await provePrivacyReceipts(store,control.value)).has(id)).toBe(true);
  rows.set(key,batch+' ');await expect(provePrivacyCommits(store,control.value)).rejects.toThrow('JOURNAL_HASH_MISMATCH');
 });
});
