/** Exercise hosted-controller bounds locally; no hosted requests or credentials. */
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
const token='synthetic-local-token-never-used-on-a-hosted-worker';
const run='c'.repeat(32);let checks=0;
async function instance({expired=false,fault=false}={}){
 const {outputFiles}=await build({stdin:{contents:`export {default} from './hosted';export {${fault?'FailedSyncProbe':'JournalStoreProbe'}} from './${fault?'fault-fixtures':'worker'}';`,resolveDir:resolve('experiments/journal-store'),sourcefile:'controller-test.ts'},bundle:true,write:false,format:'esm',external:['cloudflare:workers']});
 return new Miniflare(convertV4MiniflareOptions({name:'bounded-controller',modules:true,script:outputFiles[0].text,compatibilityDate:'2026-10-25',bindings:{PROBE_TOKEN:token,PROBE_RUN:run,PROBE_EXPIRES:new Date(Date.now()+(expired?-60000:600000)).toISOString()},durableObjects:{PROBE:{className:fault?'FailedSyncProbe':'JournalStoreProbe',useSQLite:true}}}));
}
const request=(mf,path='/run',auth=token,method='POST')=>mf.dispatchFetch('https://probe.invalid'+path,{method,headers:{authorization:'Bearer '+auth}});
let mf;
try{
 mf=await instance();
 for(const [path,auth,method] of [['/run','wrong','POST'],['/unknown',token,'POST'],['/run',token,'GET'],['/run','x'.repeat(600),'POST']]){assert.equal((await request(mf,path,auth,method)).status,404);checks++;}
 const responses=await Promise.all([request(mf),request(mf)]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);checks++;
 const result=await responses.find(r=>r.status===200).json();
 assert.equal(result.outcome,'success');assert.equal(result.acceptanceClaim,false);assert.equal(result.shapeOnly,true);
 assert.ok(result.recordBytes.batch>32768&&result.recordBytes.registered>20000);checks++;
 assert.equal(result.spans.length,11);assert.equal(result.spans.filter(s=>s.operation==='write').length,6);assert.equal(result.spans.filter(s=>s.operation==='read').length,5);checks++;
 assert.ok(result.spans.every(s=>s.outcome==='success'&&Number.isFinite(s.durationMs)&&s.durationMs>=0));checks++;
 assert.equal((await request(mf)).status,409);checks++;
 assert.deepEqual(await (await request(mf,'/result',token,'GET')).json(),result);checks++;
 assert.ok(!JSON.stringify(result).includes(token));checks++;
 await mf.dispose();mf=await instance({fault:true});
 assert.equal((await request(mf)).status,503);checks++;
 assert.equal((await request(mf)).status,409);checks++; // Uncertain lease was committed; never replay.
 assert.equal((await request(mf,'/result',token,'GET')).status,409);checks++;
 await mf.dispose();mf=await instance({expired:true});
 assert.equal((await request(mf)).status,404);checks++;
 const namespace=await mf.getDurableObjectNamespace('PROBE');const stub=namespace.get(namespace.idFromName('single-use-'+run));
 const lease=await stub.fetch('https://probe.invalid/get',{method:'POST',body:JSON.stringify({key:'synthetic/'+run+'/lease'})});
 assert.equal(await lease.json(),null);checks++;
 console.log(JSON.stringify({checks,passed:true,hostedTraffic:false,latencyAcceptance:false}));
}finally{await mf?.dispose();}
