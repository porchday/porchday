import {describe,it,expect,vi} from 'vitest';
import {provePrivacyCommits,privacyCommitScopeSchema} from '../src/privacy-commit-proof';
import {sha256,type JournalControl,type JournalEvent} from '../src/privacy-journal';

async function fixture(){
 const rows=new Map<string,string>(),generation=crypto.randomUUID(),id=crypto.randomUUID(),started_at=new Date().toISOString();
 const intent={id,started_at},original=JSON.stringify({v:1,...intent});rows.set(`intents/${id}.json`,original);
 const control:JournalControl={v:1,generation,mode:'active',sequence:'0',head:null,pending:[intent],reason:null};
 const scope=privacyCommitScopeSchema.parse({v:1,...intent,generation,transaction:'single-auth-transaction',intent_sha256:await sha256(original),baseline:{sequence:'0',head:null}});
 const scopeKey=`commit-scopes/v1/${id}.json`;
 const store={get:vi.fn(async(key:string)=>rows.has(key)?{etag:'test',text:async()=>rows.get(key)!}:null)};
 async function saveScope(){const raw=JSON.stringify(scope);rows.set(scopeKey,raw);return sha256(raw);}
 let digest=await saveScope();
 async function append(decisions:JournalEvent['decision'][]){
  const from=BigInt(control.sequence)+1n,events=decisions.map((decision,i)=>({sequence:String(from+BigInt(i)),id:crypto.randomUUID(),occurred_at:new Date().toISOString(),decision}));
  const batch={v:1,generation,from:String(from),to:events.at(-1)!.sequence,previous:structuredClone(control.head),events};
  const raw=JSON.stringify(batch),hash=await sha256(raw),key=`batches/${generation}/${batch.from}-${batch.to}-${hash}.json`;
  rows.set(key,raw);control.sequence=batch.to;control.head={key,hash};return batch;
 }
 async function reseal(batch:Awaited<ReturnType<typeof append>>){const raw=JSON.stringify(batch),hash=await sha256(raw),key=`batches/${batch.generation}/${batch.from}-${batch.to}-${hash}.json`;rows.set(key,raw);control.head={key,hash};}
 const marker=()=>({kind:'privacy_operation_committed',operation_id:id,scope_sha256:digest});
 return{rows,store,control,intent,scope,scopeKey,append,reseal,marker,saveScope:async()=>{digest=await saveScope();return digest;}};
}

describe('independent transaction completion proof (not yet enabled)',()=>{
 it('proves a scoped commit after restart with no receipt or mutable process memory',async()=>{
  const f=await fixture();await f.append([{kind:'session_delete',session_id:crypto.randomUUID()},f.marker()]);
  const restarted={get:async(key:string)=>{const raw=f.rows.get(key);return raw===undefined?null:{etag:'new-process',text:async()=>raw};}};
  expect(await provePrivacyCommits(restarted,structuredClone(f.control))).toEqual(new Map([[f.intent.id,{sequence:'2',scopeSha256:f.marker().scope_sha256}]]));
  expect(f.rows.has(`receipts/${f.intent.id}.json`)).toBe(false);
 });
 it.each(['registered','committed-only-in-sql','orphan-checkpoint'])('does not prove %s',async phase=>{
  const f=await fixture(),before=structuredClone(f.control);
  if(phase==='orphan-checkpoint')await f.append([f.marker()]);
  expect((await provePrivacyCommits(f.store,before)).size).toBe(0);
 });
 it('does not opt an ordinary existing intent into transaction recovery',async()=>{
  const f=await fixture();await f.append([f.marker()]);f.rows.delete(f.scopeKey);
  expect((await provePrivacyCommits(f.store,f.control)).size).toBe(0);
 });
 it('requires the exact original intent bytes, identity, time and generation',async()=>{
  for(const change of ['hash','id','time','generation','transaction','extra']){
   const f=await fixture();await f.append([f.marker()]);const scope:Record<string,unknown>={...f.scope};
   if(change==='hash')scope.intent_sha256='0'.repeat(64);
   if(change==='id')scope.id=crypto.randomUUID();
   if(change==='time')scope.started_at=new Date(0).toISOString();
   if(change==='generation')scope.generation=crypto.randomUUID();
   if(change==='transaction')scope.transaction='multi-step-route';
   if(change==='extra')scope.unreviewed=true;
   f.rows.set(f.scopeKey,JSON.stringify(scope));await expect(provePrivacyCommits(f.store,f.control)).rejects.toThrow('INVALID_JOURNAL_COMMIT_PROOF');
  }
 });
 it.each(['missing','malformed','different-id','different-time'])('refuses %s original intent',async mode=>{
  const f=await fixture();await f.append([f.marker()]);const key=`intents/${f.intent.id}.json`;
  if(mode==='missing')f.rows.delete(key);
  else f.rows.set(key,mode==='malformed'?'no-json':JSON.stringify({v:1,...f.intent,...(mode==='different-id'?{id:crypto.randomUUID()}:{started_at:new Date(0).toISOString()})}));
  await expect(provePrivacyCommits(f.store,f.control)).rejects.toThrow('INVALID_JOURNAL_COMMIT_PROOF');
 });
 it('ignores unrelated commits and refuses a mismatched or duplicate matching marker',async()=>{
  const f=await fixture();await f.append([{...f.marker(),operation_id:crypto.randomUUID()}]);expect((await provePrivacyCommits(f.store,f.control)).size).toBe(0);
  for(const markers of [[{...f.marker(),scope_sha256:'f'.repeat(64)}],[f.marker(),f.marker()],[{...f.marker(),extra:true}]]){
   const g=await fixture();await g.append(markers.map(m=>({...m,operation_id:g.intent.id,...('extra'in m||markers.length===2?{scope_sha256:g.marker().scope_sha256}:{})})));
   await expect(provePrivacyCommits(g.store,g.control)).rejects.toThrow('INVALID_JOURNAL_COMMIT_PROOF');
  }
 });
 it('verifies a nonzero baseline and does not search older history',async()=>{
  const f=await fixture();await f.append([{kind:'earlier'}]);f.scope.baseline=structuredClone({sequence:f.control.sequence,head:f.control.head});await f.saveScope();
  const old=f.control.head!.key;await f.append([f.marker()]);f.rows.delete(old);
  expect((await provePrivacyCommits(f.store,f.control)).get(f.intent.id)?.sequence).toBe('2');
  expect(f.store.get.mock.calls.some(([key])=>key===old)).toBe(false);
 });
 it.each(['orphan-baseline','future-baseline','inside-batch-baseline','marker-before-baseline'])('refuses or leaves unproven %s',async mode=>{
  const f=await fixture();await f.append([{kind:'earlier'}]);
  f.scope.baseline={sequence:'1',head:structuredClone(f.control.head)};
  if(mode==='orphan-baseline')f.scope.baseline.head!.hash='0'.repeat(64);
  if(mode==='future-baseline')f.scope.baseline.sequence='9';
  await f.saveScope();
  if(mode==='inside-batch-baseline'){
   f.control.sequence='0';f.control.head=null;await f.append([{kind:'earlier'},f.marker()]);
  }else if(mode==='marker-before-baseline'){
   const batch=JSON.parse(f.rows.get(f.control.head!.key)!);batch.events[0].decision=f.marker();await f.reseal(batch);
   f.scope.baseline.head=structuredClone(f.control.head);await f.saveScope();
   expect((await provePrivacyCommits(f.store,f.control)).size).toBe(0);return;
  }else await f.append([f.marker()]);
  await expect(provePrivacyCommits(f.store,f.control)).rejects.toThrow('INVALID_JOURNAL_COMMIT_PROOF');
 });
 it.each(['missing','hash','generation','sequence','key','root'])('refuses broken canonical ancestry: %s',async mode=>{
  const f=await fixture(),batch=await f.append([f.marker()]);
  if(mode==='missing')f.rows.delete(f.control.head!.key);
  if(mode==='hash')f.rows.set(f.control.head!.key,'{}');
  if(mode==='generation'){batch.generation=crypto.randomUUID();await f.reseal(batch);}
  if(mode==='sequence'){batch.events[0].sequence='2';await f.reseal(batch);}
  if(mode==='key'){f.rows.set('batches/'+f.control.generation+'/1-2-'+f.control.head!.hash+'.json',f.rows.get(f.control.head!.key)!);f.control.head!.key='batches/'+f.control.generation+'/1-2-'+f.control.head!.hash+'.json';}
  if(mode==='root'){batch.previous=structuredClone(f.control.head);await f.reseal(batch);}
  await expect(provePrivacyCommits(f.store,f.control)).rejects.toThrow(mode==='hash'?'JOURNAL_HASH_MISMATCH':'JOURNAL_GAP');
 });
 it('rejects duplicate or unregistered pending requests',async()=>{
  const f=await fixture();await f.append([f.marker()]);
  for(const intents of [[f.intent,f.intent],[{...f.intent,id:crypto.randomUUID()}],[{...f.intent,started_at:new Date(0).toISOString()}]])await expect(provePrivacyCommits(f.store,f.control,intents)).rejects.toThrow('INVALID_JOURNAL_COMMIT_PROOF');
  f.control.pending.push(f.intent);await expect(provePrivacyCommits(f.store,f.control)).rejects.toThrow('INVALID_JOURNAL_COMMIT_PROOF');
 });
 it.each([true,false])('handles separate registration baselines and partial proof (second marker: %s)',async secondCommitted=>{
  const f=await fixture();await f.append([f.marker()]);
  const intent={id:crypto.randomUUID(),started_at:new Date().toISOString()},original=JSON.stringify({v:1,...intent});
  f.rows.set(`intents/${intent.id}.json`,original);f.control.pending.push(intent);
  const scope={...f.scope,...intent,intent_sha256:await sha256(original),baseline:structuredClone({sequence:f.control.sequence,head:f.control.head})};
  const raw=JSON.stringify(scope);f.rows.set(`commit-scopes/v1/${intent.id}.json`,raw);
  await f.append([secondCommitted?{kind:'privacy_operation_committed',operation_id:intent.id,scope_sha256:await sha256(raw)}:{kind:'unrelated'}]);
  const before=structuredClone(f.control),rows=new Map(f.rows),proof=await provePrivacyCommits(f.store,f.control);
  expect(proof.get(f.intent.id)?.sequence).toBe('1');expect(proof.has(intent.id)).toBe(secondCommitted);
  expect(f.control).toEqual(before);expect(f.rows).toEqual(rows);
 });
 it('bounds reads, traversal and document size, and honors cancellation',async()=>{
  const f=await fixture();await f.append([f.marker()]);await f.append([{kind:'later'}]);
  await expect(provePrivacyCommits(f.store,f.control,undefined,{maxReads:1})).rejects.toThrow('JOURNAL_COMMIT_PROOF_LIMIT');
  await expect(provePrivacyCommits(f.store,f.control,undefined,{maxBatches:1})).rejects.toThrow('JOURNAL_COMMIT_PROOF_LIMIT');
  for(const maxReads of [0,1025,NaN,1.1])await expect(provePrivacyCommits(f.store,f.control,undefined,{maxReads})).rejects.toThrow('JOURNAL_COMMIT_PROOF_LIMIT');
  await expect(provePrivacyCommits(f.store,f.control,undefined,{signal:AbortSignal.abort()})).rejects.toThrow();
  f.rows.set(f.scopeKey,' '.repeat(16385));await expect(provePrivacyCommits(f.store,f.control)).rejects.toThrow('JOURNAL_COMMIT_PROOF_LIMIT');
 });
 it('does not turn store failures into missing evidence',async()=>{
  const f=await fixture();await expect(provePrivacyCommits({get:async()=>{throw Error('private provider detail');}},f.control)).rejects.toThrow('JOURNAL_STORE_READ_FAILED');
  await expect(provePrivacyCommits({get:async()=>({etag:'x',text:async()=>{throw Error('private body detail');}})},f.control)).rejects.toThrow('JOURNAL_STORE_READ_FAILED');
 });
 it('checks cancellation after a read before consuming its body',async()=>{
  const f=await fixture(),controller=new AbortController(),text=vi.fn(async()=>'{}');
  await expect(provePrivacyCommits({get:async()=>{controller.abort();return{etag:'x',text};}},f.control,undefined,{signal:controller.signal})).rejects.toThrow();
  expect(text).not.toHaveBeenCalled();
 });
});
