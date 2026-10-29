/** Local workerd/SQLite evidence only. Never contact a hosted service. */
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'porchday-journal-probe-'));
const {outputFiles}=await build({entryPoints:['experiments/journal-store/worker.ts'],bundle:true,write:false,format:'esm',external:['cloudflare:workers']});
let mf,stub,checks=0;
async function start(){
 mf=new Miniflare({...convertV4MiniflareOptions({name:'journal-store-probe',modules:true,script:outputFiles[0].text,compatibilityDate:'2026-10-25',durableObjects:{PROBE:{className:'JournalStoreProbe',useSQLite:true}},}),resourcePersistencePath:dir});
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
 for(const input of [{key:'control.json'},{key,value:'x'},{key,value:'x',onlyIf:{etagMatches:recovered.etag,etagDoesNotMatch:'*'}},{key,value:'x',onlyIf:{bogus:'*'}},{key,value:'x'.repeat(32769),onlyIf:{etagMatches:recovered.etag}}]){
  await call('put',input,400);checks++;
 }
 assert.deepEqual(await call('get',{key}),recovered);checks++;
 for(let i=0;i<63;i++)await call('put',{key:key+'_'+i,value:'bounded',onlyIf:{etagDoesNotMatch:'*'}});
 await call('put',{key:key+'_overflow',value:'refused',onlyIf:{etagDoesNotMatch:'*'}},503);
 assert.equal(await call('get',{key:key+'_overflow'}),null);checks++;
 assert.deepEqual(await call('get',{key}),recovered);checks++;
 console.log(JSON.stringify({checks,passed:true,runtime:'local workerd SQLite',hostedLatencyEvidence:false}));
}finally{await mf?.dispose();await rm(dir,{recursive:true,force:true});}
