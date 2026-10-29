import {initializePrivacyJournal,readJournalControl,beginPrivacyIntent,completePrivacyIntent,assertJournalReadable,quarantineJournal,verifyJournalChain} from '../../apps/api/src/privacy-journal.ts';
import {createHash,randomUUID} from 'node:crypto';
/** Local workerd/SQLite evidence only. Never contact a hosted service. */
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'porchday-journal-probe-'));
const {outputFiles}=await build({entryPoints:['experiments/journal-store/fault-fixtures.ts'],bundle:true,write:false,format:'esm',external:['cloudflare:workers']});
let mf,stub,checks=0;
async function start(){
 mf=new Miniflare({...convertV4MiniflareOptions({name:'journal-store-probe',modules:true,script:outputFiles[0].text,compatibilityDate:'2026-10-25',durableObjects:{PROBE:{className:'JournalStoreProbe',useSQLite:true},FAILED_SYNC:{className:'FailedSyncProbe',useSQLite:true},FAILED_TX:{className:'FailedTransactionProbe',useSQLite:true}},}),resourcePersistencePath:dir});
 const namespace=await mf.getDurableObjectNamespace('PROBE');stub=namespace.get(namespace.idFromName('synthetic-contract-check'));
}
async function call(path,value,status=200){const r=await stub.fetch('https://probe.invalid/'+path,{method:'POST',body:JSON.stringify(value)});assert.equal(r.status,status);return status===200?r.json():r.text();}
const key='synthetic/'+'a'.repeat(32)+'/control';
try{
 await start();
 assert.equal((await mf.dispatchFetch('https://probe.invalid/put')).status,404);checks++;
 assert.equal(await call('get',{key}),null);checks++;
 const first=await call('put',{key,value:'original\n"bytes"',onlyIf:{etagDoesNotMatch:'*'}});
 assert.deepEqual(await call('get',{key}),{value:'original\n"bytes"',etag:first.etag});checks++;
 assert.equal(await call('put',{key,value:'overwrite',onlyIf:{etagDoesNotMatch:'*'}}),null);checks++;
 const race=await Promise.all(Array.from({length:12},(_,i)=>call('put',{key,value:'race-'+i,onlyIf:{etagMatches:first.etag}})));
 assert.equal(race.filter(Boolean).length,1);assert.notEqual(race.find(Boolean).etag,first.etag);checks++;
 const committed=await call('get',{key});
 // Discard a successful reply, then repeat the same conditional request.
 await call('put',{key,value:'lost reply',onlyIf:{etagMatches:committed.etag}});
 assert.equal(await call('put',{key,value:'lost reply',onlyIf:{etagMatches:committed.etag}}),null);
 const recovered=await call('get',{key});assert.equal(recovered.value,'lost reply');checks++;
 await mf.dispose();await start();assert.deepEqual(await call('get',{key}),recovered);checks++;
 for(const input of [{key:'control.json'},{key,value:'x'},{key,value:'x',onlyIf:{etagMatches:recovered.etag,etagDoesNotMatch:'*'}},{key,value:'x',onlyIf:{bogus:'*'}},{key,value:'x'.repeat(256*1024+1),onlyIf:{etagMatches:recovered.etag}}]){
  await call('put',input,400);checks++;
 }
 assert.deepEqual(await call('get',{key}),recovered);checks++;
 for(let i=0;i<63;i++)await call('put',{key:key+'_'+i,value:'bounded',onlyIf:{etagDoesNotMatch:'*'}});
 await call('put',{key:key+'_overflow',value:'refused',onlyIf:{etagDoesNotMatch:'*'}},503);
 assert.equal(await call('get',{key:key+'_overflow'}),null);checks++;
 assert.deepEqual(await call('get',{key}),recovered);checks++;
 await call('put',{key,value:'x'.repeat(2*1024*1024+1),onlyIf:{etagMatches:recovered.etag}},413);checks++;
 const normalStub=stub;
 for(const [binding,persisted] of [['FAILED_SYNC',true],['FAILED_TX',false]]){
  const namespace=await mf.getDurableObjectNamespace(binding);stub=namespace.get(namespace.idFromName('synthetic-fault'));
  assert.equal(await call('put',{key,value:'uncertain',onlyIf:{etagDoesNotMatch:'*'}},503),'');checks++;
  const read=await call('get',{key});assert.equal(read?.value??null,persisted?'uncertain':null);checks++;
  if(persisted){assert.equal(await call('put',{key,value:'replayed',onlyIf:{etagDoesNotMatch:'*'}}),null);checks++;}
 }
 stub=normalStub;
 const payloadNamespace=await mf.getDurableObjectNamespace('PROBE');
 stub=payloadNamespace.get(payloadNamespace.idFromName('synthetic-payload-boundaries'));
 const escaped='\0'.repeat(256*1024);
 let payload=await call('put',{key,value:escaped,onlyIf:{etagDoesNotMatch:'*'}});
 assert.equal((await call('get',{key})).value,escaped);checks++;
 const unicode='🌽'.repeat(65536);
 payload=await call('put',{key,value:unicode,onlyIf:{etagMatches:payload.etag}});
 assert.equal((await call('get',{key})).value,unicode);checks++;
 await call('put',{key,value:unicode+'🌽',onlyIf:{etagMatches:payload.etag}},400);
 assert.equal((await call('get',{key})).value,unicode);checks++;
 // Exercise the existing journal algorithm unchanged against the SQLite adapter.
 const protocolNamespace=await mf.getDurableObjectNamespace('PROBE');
 stub=protocolNamespace.get(protocolNamespace.idFromName('synthetic-existing-protocol'));
 const mapped=name=>'synthetic/'+'b'.repeat(32)+'/'+createHash('sha256').update(name).digest('hex');
 const store={
  async get(name){const row=await call('get',{key:mapped(name)});return row?{etag:row.etag,text:async()=>row.value}:null;},
  put(name,value,options){return call('put',{key:mapped(name),value,onlyIf:options?.onlyIf});},
 };
 const generation=randomUUID();let events=[];
 const db={status:async()=>({generation,sequence:String(events.length),quarantined:false}),page:async after=>events.slice(Number(after),Number(after)+200)};
 await initializePrivacyJournal(store,db);
 const initial=await readJournalControl(store);
 await store.put('control.json',JSON.stringify({...initial.value,mode:'active',reason:null}),{onlyIf:{etagMatches:initial.etag}});
 const intents=await Promise.all([beginPrivacyIntent(store,db),beginPrivacyIntent(store,db)]);
 events=Array.from({length:200},(_,i)=>({sequence:String(i+1),id:randomUUID(),occurred_at:new Date().toISOString(),decision:{action:'reaction',kind:'post_reactions',target:randomUUID(),member:randomUUID(),tag:'a'.repeat(128)}}));
 await Promise.all(intents.map(intent=>completePrivacyIntent(store,db,intent)));
 const completed=await readJournalControl(store);assert.equal(completed.value.sequence,'200');assert.deepEqual(completed.value.pending,[]);checks++;
 const batchBytes=Buffer.byteLength(await (await store.get(completed.value.head.key)).text());assert.ok(batchBytes>32768&&batchBytes<256*1024);checks++;
 for(const intent of intents){assert.ok(await store.get('intents/'+intent.id+'.json'));assert.ok(await store.get('receipts/'+intent.id+'.json'));}checks++;
 const saved=events;events=events.slice(0,-1);await assert.rejects(()=>assertJournalReadable(store,db),/DATABASE_ROLLBACK_DETECTED/);events=saved;checks++;
 await quarantineJournal(store,'synthetic_verification');
 const chain=await verifyJournalChain(store);assert.deepEqual(chain.batches.flat(),events);checks++;
 console.log(JSON.stringify({checks,batchBytes,passed:true,runtime:'local workerd SQLite',hostedLatencyEvidence:false}));
}finally{await mf?.dispose();await rm(dir,{recursive:true,force:true});}
