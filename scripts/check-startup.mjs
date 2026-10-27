/** Real App/Vault/Avatar startup with synthetic HTTP and mocked cryptography/remembered keys. */
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {writeFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {chromium,webkit} from 'playwright';
const root=process.argv[2] || process.cwd(), output=process.argv[3];
const id='11111111-1111-4111-8111-111111111111', deviceId='22222222-2222-4222-8222-222222222222', postId='33333333-3333-4333-8333-333333333333';
const device={id:deviceId,member_id:id,public_key:'synthetic',fingerprint:'fixture',created_at:'2026-10-26T00:00:00Z',revoked_at:null};
const envelope=(kind,objectId)=>({context:{kind,id:objectId,authorId:id,authorDeviceId:deviceId,expiresAt:null,parentId:null,groupId:null},ciphertext:'fixture',recipients:[{fingerprint:'fixture'}]});
const member={id,handle:'fixture',status:'active',connection_count:0,envelope:envelope('profile',id)};
const row={id:postId,author_id:id,created_at:'2026-10-26T00:00:00Z',expires_at:null,audience:'only_me',envelope:envelope('post',postId)};
const bundle=await build({entryPoints:[path.join(root,'apps/web/src/main.tsx')],bundle:true,write:false,format:'iife',platform:'browser',loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{}'},plugins:[{name:'synthetic-crypto',setup(b){
 b.onResolve({filter:/^virtual:/},()=>({path:'empty',namespace:'empty'}));b.onLoad({filter:/.*/,namespace:'empty'},()=>({contents:'',loader:'js'}));
 b.onResolve({filter:/^@porchday\/crypto$/},()=>({path:'crypto',namespace:'fixture'}));
 b.onResolve({filter:/^@porchday\/crypto\/browser$/},()=>({path:'memory',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',resolveDir:root,contents:args.path==='crypto'?`export * from ${JSON.stringify(path.join(root,'packages/crypto/src/index.ts'))};export const fingerprint=async()=>"fixture";export const decryptObject=async({envelope})=>envelope.context.kind==='profile'?{}:{text:'Startup fixture ready'};`:`export * from ${JSON.stringify(path.join(root,'packages/crypto/src/browser.ts'))};export const recallDevice=async()=>({getFingerprint:()=>"fixture"});`}));
}}]});
let calls=[];
const server=http.createServer(async(req,res)=>{
 if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');return res.end(bundle.outputFiles[0].contents);}
 if(!req.url.startsWith('/api/')){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><div id="root"></div><script src="/bundle.js"></script>');}
 calls.push({path:req.url,method:req.method});await new Promise(r=>setTimeout(r,150));res.setHeader('Content-Type','application/json');
 if(req.url.startsWith('/api/v1/me'))return res.end(JSON.stringify({...member,...(req.url.includes('bootstrap=1')?{startup_devices:[device]}:{})}));
 if(req.url==='/api/v1/devices')return res.end(JSON.stringify({items:[device]}));
 if(req.url.startsWith('/api/v1/devices/'))return res.end(JSON.stringify({device}));
 if(req.url==='/api/v1/feed')return res.end(JSON.stringify({items:[row]}));
 if(req.url==='/api/v1/posts/'+postId)return res.end(JSON.stringify({post:row,comments:[],reactions:[]}));
 res.end('{"items":[]}');
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;const results=[];
try{for(const engine of [chromium,webkit]){
 const browser=await engine.launch();try{for(let i=0;i<(engine===chromium?5:1);i++){
 calls=[];const context=await browser.newContext({serviceWorkers:'block'});await context.addInitScript(({id,deviceId})=>{localStorage.setItem('porchday-device:'+id,deviceId);const observer=new MutationObserver(()=>{if(document.getElementById('root')?.textContent.includes('Startup fixture ready')){window.fixtureReadyMs=performance.now();observer.disconnect();}});observer.observe(document,{childList:true,subtree:true});},{id,deviceId});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const start=performance.now();await page.goto(origin+'/app');await page.getByText('Startup fixture ready',{exact:true}).waitFor();const readyMs=Math.round(await page.evaluate(()=>window.fixtureReadyMs));await page.waitForTimeout(750);
 const summary={engine:engine.name(),readyMs,me:calls.filter(x=>x.path.startsWith('/api/v1/me')).length,devices:calls.filter(x=>x.path==='/api/v1/devices').length,authorKeys:calls.filter(x=>x.path.startsWith('/api/v1/devices/')).length,writes:calls.filter(x=>x.method!=='GET').length};
 assert.deepEqual(errors,[]);assert.equal(await page.locator('.pending-save-status').count(),0);assert.equal(summary.writes,0);
 if(root===process.cwd()){assert.equal(summary.me,1);assert.equal(summary.devices,0);assert.equal(summary.authorKeys,0);}
 results.push(summary);await context.close();
 }}finally{await browser.close();}
}if(output)await writeFile(output,JSON.stringify({method:'Real web App/Vault/Avatar, synthetic HTTP 150ms delay and mocked cryptography/remembered key; not hosted latency.',results},null,2),{mode:0o600,flag:'wx'});console.log(JSON.stringify(results));}finally{server.close();}
