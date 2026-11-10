// Real component, observer, image decoder and styles. Synthetic authenticated
// transport/vault; signature and server authorization use separate integration tests.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {chromium,webkit} from 'playwright';
const bundle=await build({stdin:{contents:`
import React from 'react';import {createRoot} from 'react-dom/client';
import {CachedEncryptedPhoto} from './apps/web/src/CachedEncryptedPhoto';
import {invalidatePhotos} from './apps/web/src/photo-cache';
import {request} from './apps/web/src/api';
import {attachDiagnostics,startDiagnostics,flushDiagnostics,captureContent} from './apps/web/src/diagnostics';
window.enableDiagnostics=async()=>{attachDiagnostics('fixture-member','fixture-device');await startDiagnostics('content',true);};
window.idleWork=async()=>{for(let i=0;i<3;i++){await request('/media',{method:'POST',body:JSON.stringify({id:'background-'+i})});await request('/api/v1/media/background-'+i+'/bytes',{method:'PUT',body:'{}'});await request('/posts/other-parent/audience-refresh',{method:'POST',body:'{}'});await request('/media/background-'+i,{method:'DELETE'});captureContent();}await flushDiagnostics();};
window.createdUrls=0;const createUrl=URL.createObjectURL.bind(URL);URL.createObjectURL=(blob)=>{window.createdUrls++;return createUrl(blob);};window.photoTop=Number(new URLSearchParams(location.search).get('top')||0);
window.invalidatePhotos=invalidatePhotos;window.scope='one';window.gets=0;window.heads=0;window.denied=false;window.release=null;
const canvas=document.createElement('canvas');canvas.width=600;canvas.height=400;canvas.getContext('2d').fillRect(0,0,600,400);window.bytes=canvas.toDataURL('image/jpeg').split(',')[1];
window.fetch=async(url,options={})=>{if(String(url).includes('/diagnostics/'))return Response.json(String(url).endsWith('/sessions')?{id:'fixture-recording',mode:'content',started_at:Date.now(),expires_at:Date.now()+3600000}:{accepted:JSON.parse(options.body||'{}').events?.map(e=>e.id)||[]});if(!['GET','HEAD'].includes(options.method||'GET'))return Response.json({ok:true});if(window.denied)return new Response(null,{status:403});if(options.method==='HEAD'){window.heads++;return new Response(null,{status:window.denied?403:200});}window.gets++;await new Promise(resolve=>window.release=resolve);return Response.json({context:{parentId:'visible-parent',expiresAt:window.expiry||null},payload:{mime:'image/jpeg',bytes:window.bytes}});};
const root=createRoot(document.getElementById('root'));
window.renderPhoto=()=>root.render(<><div style={{height:window.photoTop}}/><CachedEncryptedPhoto media={{id:'photo',mime:'image/jpeg',width:600,height:400,alt:'Synthetic landscape',name:'photo'}}/><p id='anchor'>Reading anchor</p><div style={{height:24000}}/></>);window.renderPhoto();
`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"'},plugins:[...(process.env.PHOTO_BASELINE==='1'?[{name:'baseline',setup(b){b.onLoad({filter:/apps\/web\/src\/(api\.ts|photo-cache\.ts|CachedEncryptedPhoto\.tsx)$/},args=>({contents:execFileSync('git',['show','4313174:'+args.path.slice(process.cwd().length+1)],{encoding:'utf8'}),loader:args.path.endsWith('.tsx')?'tsx':'ts'}));}}]:[]),{name:'vault-fixture',setup(b){b.onResolve({filter:/^\.\/vault$/},()=>({path:'vault',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const useVault=()=>({member:{id:window.scope},device:{id:'device'},keys:[{getFingerprint:()=>window.scope}],open:async row=>row.envelope.payload});`,loader:'js'}));}}]});
const css=await readFile('apps/web/src/styles.css','utf8');
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><main><div id="root" style="max-width:600px"></div></main><script>${bundle.outputFiles[0].text}</script></body></html>`);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{for(const engine of [chromium,webkit]){const browser=await engine.launch();try{for(const width of [390,1200]){
 const page=await browser.newPage({viewport:{width,height:800}}),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.release!==null);
 const before=await page.locator('#anchor').boundingBox();await page.evaluate(()=>window.release());await page.locator('.stable-photo-frame img').waitFor();const after=await page.locator('#anchor').boundingBox();assert.equal(before.y,after.y,'slow decode moved reading anchor');
 await page.evaluate(()=>window.originalImage=document.querySelector('.stable-photo-frame img'));
 for(const diagnostics of [false,true]){if(diagnostics)await page.evaluate(()=>window.enableDiagnostics());await page.evaluate(()=>window.idleWork());await page.waitForTimeout(100);assert(await page.evaluate(()=>window.originalImage===document.querySelector('.stable-photo-frame img')),'idle background writes replaced visible image (diagnostics='+diagnostics+')');assert.equal(await page.evaluate(()=>window.gets),1,'idle background writes downloaded unrelated visible image');}
await page.evaluate(()=>window.renderPhoto());await page.waitForTimeout(50);assert(await page.evaluate(()=>window.originalImage===document.querySelector('.stable-photo-frame img')),'equivalent refresh unmounted image');assert.equal(await page.evaluate(()=>window.gets),1);
 // Keep the first image warm across a twenty-screen excursion, releasing its
 // decoded display surface while retaining the verified JPEG/object URL.
 await page.evaluate(()=>window.scrollTo({top:15000,behavior:'instant'}));await page.waitForFunction(()=>!document.querySelector('.stable-photo-frame img'));
 await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await page.locator('.stable-photo-frame img').waitFor();
 assert.equal(await page.evaluate(()=>window.gets),1,'twenty-screen return downloaded bytes');assert.equal(await page.evaluate(()=>window.heads),0,'retained viewport unnecessarily reauthorized');
 await page.evaluate(()=>window.scrollTo({top:22000,behavior:'instant'}));await page.waitForFunction(()=>!document.querySelector('.stable-photo-frame img'));await page.waitForTimeout(100);
 await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await page.locator('.stable-photo-frame img').waitFor();assert.equal(await page.evaluate(()=>window.gets),1,'warm scroll downloaded bytes again');assert.equal(await page.evaluate(()=>window.heads),1,'new warm consumer skipped authorization');assert.equal(await page.locator('#anchor').evaluate(e=>e.getBoundingClientRect().y+scrollY),before.y);
 await page.evaluate(()=>window.invalidatePhotos({parentId:'visible-parent'}));await page.waitForFunction(()=>window.gets===2);assert.equal(await page.locator('.stable-photo-frame img').count(),0);await page.evaluate(()=>window.release());await page.locator('.stable-photo-frame img').waitFor();
 await page.evaluate(()=>{window.denied=true;window.invalidatePhotos();});await page.getByText('This attachment is no longer available.').waitFor();assert.equal(await page.locator('.stable-photo-frame img').count(),0);
 await page.evaluate(()=>{window.denied=false;window.scope='two';window.renderPhoto();});await page.waitForFunction(()=>window.gets===3);await page.evaluate(()=>window.release());await page.locator('.stable-photo-frame img').waitFor();
 await page.evaluate(()=>{window.expiry=new Date(Date.now()+1000).toISOString();window.invalidatePhotos();});await page.waitForFunction(()=>window.gets===4);await page.evaluate(()=>window.release());await page.locator('.stable-photo-frame img').waitFor();await page.getByText('This attachment expired.').waitFor();assert.equal(await page.locator('.stable-photo-frame img').count(),0);assert.deepEqual(errors,[]);await page.close();
 const ahead=await browser.newPage({viewport:{width,height:800}});await ahead.goto(`http://127.0.0.1:${server.address().port}?top=4000`);
 await ahead.waitForFunction(()=>window.gets===1&&window.release!==null);assert.equal(await ahead.locator('.stable-photo-frame img').count(),0,'distant prefetch mounted a decoded image');
 await ahead.evaluate(()=>window.release());await ahead.waitForFunction(()=>window.createdUrls===1);
 await ahead.evaluate(()=>window.scrollTo({top:4000,behavior:'instant'}));await ahead.locator('.stable-photo-frame img').waitFor();assert.equal(await ahead.evaluate(()=>window.gets),1);assert.equal(await ahead.evaluate(()=>window.heads),0);await ahead.close();

} }finally{await browser.close();}}console.log('Chromium/WebKit mobile/desktop: five-screen prefetch without distant decoded-image mounts; twenty-screen return without network/decryption; idle background sharing with diagnostics off/on preserves the visible image and avoids downloads; affected-parent invalidation still reloads; zero anchor movement on delayed decode; stable image identity; warm scrolling no byte/decrypt reload; fresh access denial, account changes and expiry passed.');}finally{server.close();}
