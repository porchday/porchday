/** Local synthetic component checks; no hosted member data or real cryptography. */
import {build} from 'esbuild';
import {chromium, webkit} from 'playwright';
import http from 'node:http';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const root=process.cwd();
const result=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{PostCard}from'./apps/web/src/Social';import{PendingSaveStatus,useRoute,navigate}from'./apps/web/src/ui';import{withPendingSave}from'./apps/web/src/pending-saves';window.startSave=()=>withPendingSave(()=>new Promise((resolve,reject)=>{window.endSave=resolve;window.failSave=reject})).catch(()=>{});window.nav=navigate;function Route(){const path=useRoute();return <output id='route'>{path}</output>}
const rows=Array.from({length:30},(_,i)=>({id:'post-'+i,author_id:'self',created_at:new Date().toISOString(),expires_at:null,audience:'only_me',envelope:{ciphertext:'x',context:{id:'post-'+i,authorId:'self',revision:1,expiresAt:null}}}));
createRoot(document.getElementById('root')).render(<><Route/><PendingSaveStatus/><a id='next' href='/next'>Next</a>{rows.map(row=><div style={{minHeight:600}} key={row.id}><PostCard row={row} onChange={()=>{}}/></div>)}</>);`,resolveDir:root,loader:'tsx'},plugins:[{name:'synthetic-only',setup(b){
b.onResolve({filter:/^@porchday\/crypto$/},()=>({path:'crypto',namespace:'fixture'}));
b.onResolve({filter:/^\.\/vault$/},()=>({path:'vault',namespace:'fixture'}));
b.onResolve({filter:/^\.\/MemberAvatar$/},()=>({path:'avatar',namespace:'fixture'}));
b.onResolve({filter:/^\.\/photo-safety$/},()=>({path:'photo',namespace:'fixture'}));
b.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:args.path==='crypto'?`export const signStatement=async()=>({}),bytesToBase64=()=>'',base64ToBytes=()=>new Uint8Array(),createReactionSecret=()=>'',reactionTag=()=>'';`:args.path==='vault'?`export const useVault=()=>({member:{id:'self',handle:'fixture',status:'active'},device:{id:'device'},seal:async(content,context)=>{await new Promise(r=>window.releaseSeal=r);return{context,ciphertext:'sealed'}},open:async row=>row.id.startsWith('post-')?{text:'Synthetic post',media:[{id:row.id.replace('post-','media-'),mime:'image/jpeg',alt:'Fixture',width:400,height:300}]}:{mime:'image/jpeg',bytes:'AA=='}});export const useOptionalVault=useVault;export const Fingerprint=()=>null;export const VaultProvider=({children})=>children;`:args.path==='avatar'?`export const MemberAvatar=()=>null;`:`export const validatedPhoto=async()=>({blob:new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="green"/></svg>'],{type:'image/svg+xml'})}); export const jpegDimensions=()=>({width:400,height:300}),jpegSource=()=>null,PHOTO_ACCEPT='',PHOTO_SOURCE_MAX_BYTES=50000000,photoSourceMime=()=>'',stripCanvasJpegMetadata=x=>x;` }));
}}],bundle:true,write:false,platform:'browser',format:'iife',define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{}'}});
let calls=[], pendingWrite, failWrite=false;
const server=http.createServer(async(req,res)=>{
 if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');return res.end(result.outputFiles[0].contents);}
 if(!req.url.startsWith('/api/')){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><style>body{margin:0}#root{max-width:700px}figure{margin:0}img{width:400px;height:300px}.photo-placeholder{height:300px}</style><div id="root"></div><script src="/bundle.js"></script>');}
 calls.push({url:req.url,method:req.method});
 if(req.method==='PUT')await new Promise(resolve=>pendingWrite=resolve);
 res.setHeader('Content-Type','application/json');res.statusCode=req.method==='PUT'&&failWrite?500:200;
 res.end(req.url.includes('/media/')?JSON.stringify({context:{expiresAt:null}}):JSON.stringify({comments:[],reactions:[]}));
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
try {for(const engine of [chromium,webkit]){
 calls=[];const browser=await engine.launch();
 try{
  const context=await browser.newContext({viewport:{width:800,height:800},serviceWorkers:'block'});const page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);await page.locator('img').first().waitFor();
  assert(calls.filter(x=>x.url.includes('/media/')).length<5,'offscreen photos deferred');
  await page.locator('article').nth(29).scrollIntoViewIfNeeded();await page.locator('article').nth(29).locator('img').waitFor();
  assert(calls.some(x=>x.url.includes('media-29')),'scroll fetches photo');
  await page.goto(origin);await page.locator('img').first().waitFor();
  await page.locator('#next').click();await page.waitForFunction(()=>location.pathname==='/next');
  await page.evaluate(()=>{window.startSave();});await page.locator('.pending-save-status').waitFor();
  await page.evaluate(()=>window.nav('/blocked'));assert.equal(new URL(page.url()).pathname,'/next');
  await page.goBack();await page.waitForFunction(()=>location.pathname==='/next');assert.equal(new URL(page.url()).pathname,'/next');
  await page.locator('#next').click();assert.equal(new URL(page.url()).pathname,'/next');
  assert.equal(await page.evaluate(()=>!window.dispatchEvent(new Event('beforeunload',{cancelable:true}))),true);
  await page.evaluate(()=>window.endSave());await page.locator('.pending-save-status').waitFor({state:'hidden'});
  assert.equal(await page.evaluate(()=>!window.dispatchEvent(new Event('beforeunload',{cancelable:true}))),false);
  await page.evaluate(()=>window.nav('/done'));await page.waitForFunction(()=>location.pathname==='/done');
  for(const fail of [true,false]){
   failWrite=fail;pendingWrite=undefined;
   const card=page.locator('article').first();await card.getByRole('button',{name:'Post options',exact:true}).click();
   await card.getByRole('button',{name:'Edit text',exact:true}).click();await card.getByRole('textbox',{name:'Edit your post'}).fill('Changed immediately');
   await card.getByRole('button',{name:'Save changes',exact:true}).click();
   await card.locator('.post-text').getByText('Changed immediately',{exact:true}).waitFor();await page.locator('.pending-save-status').waitFor();
   assert.equal(await page.evaluate(()=>!window.dispatchEvent(new Event('beforeunload',{cancelable:true}))),true,'protected during encryption');
   await page.evaluate(()=>window.releaseSeal());
   await page.waitForFunction(()=>!!document.querySelector('.pending-save-status'));
   for(let i=0;i<100&&!pendingWrite;i++)await new Promise(r=>setTimeout(r,10));assert(pendingWrite);pendingWrite();
   await page.locator('.pending-save-status').waitFor({state:'hidden'});
   if(fail){await card.getByText(/Save was not confirmed/).waitFor();assert.equal(await card.getByRole('textbox').inputValue(),'Changed immediately');await card.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await card.locator('.post-text').innerText(),'Synthetic post');}
   else assert.equal(await card.locator('.post-text').innerText(),'Changed immediately');
  }
  // Independent/nested requests keep the warning until every save settles.
  await page.evaluate(()=>{window.startSave();window.endFirst=window.endSave;window.startSave();});await page.evaluate(()=>window.endFirst());assert.equal(await page.locator('.pending-save-status').count(),1);await page.evaluate(()=>window.failSave(new Error('synthetic failure')));await page.locator('.pending-save-status').waitFor({state:'hidden'});
  assert.deepEqual(errors,[]);await context.close();
  const fallback=await browser.newContext();await fallback.addInitScript(()=>{window.IntersectionObserver=undefined});const fallbackPage=await fallback.newPage();calls=[];await fallbackPage.goto(origin);await fallbackPage.locator('article').nth(29).locator('img').waitFor({state:'attached'});assert(calls.some(x=>x.url.includes('media-29')));await fallback.close();
  console.log(engine.name()+': deferred photos, scroll, observer fallback, saving during encryption/request, navigation guard, concurrent saves, optimistic success and failure rollback passed');
 }finally{await browser.close();}
}}finally{server.close();}
