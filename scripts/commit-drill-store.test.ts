import {expect,test,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createCommitDrillStore} from './commit-drill-store';
import {beginPrivacyIntent,publishAuthPrivacyCommitScope,type JournalStore} from '../apps/api/src/privacy-journal';

function fixture(){
 const generation=randomUUID(),control={v:1,generation,mode:'active',sequence:'0',head:null,pending:[],reason:null};
 const objects=new Map<string,{etag:string;value:string}>([['control.json',{etag:'1',value:JSON.stringify(control)}]]);let serial=1;
 const backing:JournalStore={get:vi.fn(async key=>{const value=objects.get(key);return value?{etag:value.etag,text:async()=>value.value}:null;}),put:vi.fn(async(key,value,condition)=>{
  const old=objects.get(key);if(condition?.onlyIf?.etagDoesNotMatch==='*'&&old||condition?.onlyIf?.etagMatches&&old?.etag!==condition.onlyIf.etagMatches)return null;
  const etag=String(++serial);objects.set(key,{etag,value});return{etag};
 })};
 const events:any[]=[],retain=vi.fn(async e=>{events.push(e);}),assertScope=vi.fn();
 const gate=createCommitDrillStore({store:backing,retain,assertScope});
 const db={status:async()=>({generation,sequence:'0',quarantined:false}),page:async()=>[]};
 return{generation,control,objects,backing,events,retain,assertScope,gate,db};
}

test('actual registration and scope functions work through the restricted parent store',async()=>{
 const f=fixture(),intent=await beginPrivacyIntent(f.gate.store,f.db),scope=await publishAuthPrivacyCommitScope(f.gate.store,f.db,intent);
 expect(scope.operationId).toBe(intent.id);expect(f.gate.operationId()).toBe(intent.id);
 expect(JSON.parse(f.objects.get('control.json')!.value).pending).toEqual([intent]);
 expect(f.objects.has(`commit-scopes/v1/${intent.id}.json`)).toBe(true);
 expect(f.events.filter(e=>e.method==='put'&&e.phase==='intent')).toHaveLength(3);
 expect(f.events.every(e=>!('value'in e)&&!('etag'in e))).toBe(true);
});

test.each(['receipts/other.json','batches/other.json','media/other','intents/other.json'])('rejects out-of-scope key %s before I/O',async key=>{
 const f=fixture();await expect(f.gate.store.get(key)).rejects.toThrow('RECONCILIATION_REQUIRED');expect(f.backing.get).not.toHaveBeenCalled();
 await expect(f.gate.store.get('control.json')).rejects.toThrow();
});

test.each(['quarantine','retire','sequence','generation','foreign_pending'])('rejects control mutation %s without dispatch',async change=>{
 const f=fixture(),intent=await beginPrivacyIntent(f.gate.store,f.db);const current=await f.gate.store.get('control.json'),value=JSON.parse(await current!.text());
 if(change==='quarantine')value.mode='quarantine';if(change==='retire')value.pending=[];if(change==='sequence')value.sequence='1';if(change==='generation')value.generation=randomUUID();if(change==='foreign_pending')value.pending.push({id:randomUUID(),started_at:intent.started_at});
 const calls=vi.mocked(f.backing.put).mock.calls.length;
 await expect(f.gate.store.put('control.json',JSON.stringify(value),{onlyIf:{etagMatches:current!.etag}})).rejects.toThrow('RECONCILIATION_REQUIRED');
 expect(f.backing.put).toHaveBeenCalledTimes(calls);
});

test('retention failure before dispatch cannot create an intent',async()=>{
 const f=fixture(),gate=createCommitDrillStore({store:f.backing,assertScope:f.assertScope,retain:async()=>{throw Error('private disk error');}});
 await expect(beginPrivacyIntent(gate.store,f.db)).rejects.toThrow('RECONCILIATION_REQUIRED');expect(f.backing.put).not.toHaveBeenCalled();
});

test('lost successful write reply seals the store and preserves the original intent record',async()=>{
 const f=fixture(),original=f.backing.put;f.backing.put=vi.fn(async(...args)=>{await original(...args);throw Error('private network detail');});
 await expect(beginPrivacyIntent(f.gate.store,f.db)).rejects.toThrow('RECONCILIATION_REQUIRED');
 expect(f.backing.put).toHaveBeenCalledTimes(1);expect(f.events).toHaveLength(1);expect(f.events[0]).toMatchObject({phase:'intent',method:'put'});
 expect(f.objects.size).toBe(2);await expect(beginPrivacyIntent(f.gate.store,f.db)).rejects.toThrow();expect(f.backing.put).toHaveBeenCalledTimes(1);
});

test('scope cannot change the intent digest or canonical generation',async()=>{
 const f=fixture(),intent=await beginPrivacyIntent(f.gate.store,f.db);await publishAuthPrivacyCommitScope(f.gate.store,f.db,intent);
 const key=`commit-scopes/v1/${intent.id}.json`,scope=JSON.parse(f.objects.get(key)!.value);scope.intent_sha256='0'.repeat(64);const calls=vi.mocked(f.backing.put).mock.calls.length;
 await expect(f.gate.store.put(key,JSON.stringify(scope),{onlyIf:{etagDoesNotMatch:'*'}})).rejects.toThrow('RECONCILIATION_REQUIRED');expect(f.backing.put).toHaveBeenCalledTimes(calls);
});

test('deadline seals slow I/O; late completion never enables a second request',async()=>{
 const f=fixture();let release!:(value:null)=>void;f.backing.get=vi.fn(()=>new Promise(resolve=>{release=resolve;}));
 const gate=createCommitDrillStore({store:f.backing,assertScope:f.assertScope,retain:f.retain,timeoutMs:100});
 await expect(gate.store.get('control.json')).rejects.toThrow('RECONCILIATION_REQUIRED');release(null);await Promise.resolve();
 await expect(gate.store.get('control.json')).rejects.toThrow();expect(f.backing.get).toHaveBeenCalledTimes(1);
});

test('explicit close, expired scope, and oversized content prevent dispatch',async()=>{
 const f=fixture();f.gate.close();await expect(f.gate.store.get('control.json')).rejects.toThrow();expect(f.backing.get).not.toHaveBeenCalled();
 let now=0;const expired=createCommitDrillStore({store:f.backing,retain:f.retain,assertScope:f.assertScope,now:()=>now});now=60000;await expect(expired.store.get('control.json')).rejects.toThrow();
 const large=createCommitDrillStore({store:f.backing,retain:f.retain,assertScope:f.assertScope});await expect(large.store.put('control.json','x'.repeat(65537))).rejects.toThrow();expect(f.backing.put).not.toHaveBeenCalled();
});

test('a preexisting intent cannot be adopted even when its bytes match',async()=>{
 const f=fixture(),intent={v:1 as const,id:randomUUID(),started_at:new Date().toISOString()},key=`intents/${intent.id}.json`,text=JSON.stringify(intent);
 f.objects.set(key,{etag:'foreign',value:text});
 await expect(f.gate.store.put(key,text,{onlyIf:{etagDoesNotMatch:'*'}})).rejects.toThrow('RECONCILIATION_REQUIRED');
 expect(f.objects.get(key)!.etag).toBe('foreign');expect(JSON.parse(f.objects.get('control.json')!.value).pending).toEqual([]);
});

test('registration preserves a concurrent fresh pending operation exactly',async()=>{
 const f=fixture(),other={id:randomUUID(),started_at:new Date().toISOString()};
 f.objects.set('control.json',{etag:'foreign',value:JSON.stringify({...f.control,pending:[other]})});
 const owned=await beginPrivacyIntent(f.gate.store,f.db);await publishAuthPrivacyCommitScope(f.gate.store,f.db,owned);
 expect(JSON.parse(f.objects.get('control.json')!.value).pending).toEqual([other,owned]);
});

test('caller mutation during retention cannot change the validated write condition',async()=>{
 const f=fixture(),condition={onlyIf:{etagDoesNotMatch:'*'}};
 const gate=createCommitDrillStore({store:f.backing,assertScope:f.assertScope,retain:async()=>{condition.onlyIf.etagDoesNotMatch='changed';}});
 const intent={v:1,id:randomUUID(),started_at:new Date().toISOString()};
 await gate.store.put(`intents/${intent.id}.json`,JSON.stringify(intent),condition);
 expect(vi.mocked(f.backing.put).mock.calls[0][2]).toEqual({onlyIf:{etagDoesNotMatch:'*'}});
});
