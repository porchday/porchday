import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const fixture=JSON.parse(readFileSync('packages/crypto/test/fixtures/notification-preview-v1.json'));
const worker=await build({stdin:{contents:`import './apps/web/src/notification-preview-sw';self.addEventListener('message',event=>event.waitUntil((async()=>{const result=await self.porchdayNotificationPreview(event.data);event.source.postMessage(result);})()));`,resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'iife',platform:'browser',write:false});
const client=await build({stdin:{contents:`import {savePreviewKey,clearPreviewKeys} from './apps/web/src/notification-preview-store';import{fingerprint}from'@porchday/crypto';window.seed=async(f,pinned=true)=>{await clearPreviewKeys();const i=f.response.identity,raw=Uint8Array.from(atob(i.publicKey),c=>c.charCodeAt(0));const base64url=b=>btoa(String.fromCharCode(...b)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');const key=await crypto.subtle.importKey('jwk',{kty:'EC',crv:'P-256',x:base64url(raw.slice(1,33)),y:base64url(raw.slice(33)),d:f.secret.replaceAll('+','-').replaceAll('/','_').replaceAll('=','')},{name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);const c=f.response.context;await savePreviewKey({identity:i,privateKey:key,pins:pinned?{[c.authorId+':'+c.authorDeviceId]:await fingerprint(f.response.author_key.public_key)}:{}},(await import('./apps/web/src/notification-preview-store')).previewGeneration());};window.clearKeys=clearPreviewKeys;`,resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'iife',platform:'browser',write:false});
let unavailable=false,tampered=false,requests=0;
const server=createServer(async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 if(req.url==='/worker.js'||req.url==='/client.js'){res.setHeader('Content-Type','application/javascript');res.end((req.url==='/worker.js'?worker:client).outputFiles[0].text);return;}
 if(req.url==='/api/notification-preview'){
  requests++;let body='';for await(const part of req)body+=part;
  assert.equal(req.method,'POST');assert.equal(req.headers.cookie,undefined);assert.deepEqual(JSON.parse(body),{token:'ab'.repeat(32)});
  if(unavailable){res.writeHead(404);res.end('{}');return;}
  const data=structuredClone(fixture.response);if(tampered)data.signed.statement.ciphertext='AAAA';
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));return;
 }
 res.setHeader('Content-Type','text/html');res.end('<script src="/client.js"></script>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();
try{
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/`);
 await page.evaluate(async()=>{await navigator.serviceWorker.register('/worker.js');await navigator.serviceWorker.ready;});
 await page.reload();await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
 await page.evaluate(f=>window.seed(f),fixture);
 async function receive(){return page.evaluate(ref=>new Promise(resolve=>{navigator.serviceWorker.addEventListener('message',e=>resolve(e.data),{once:true});navigator.serviceWorker.controller.postMessage(ref);}),{token:'ab'.repeat(32),keyId:fixture.response.identity.keyId});}
 assert.deepEqual(await receive(),{text:'Test-only caption: garden 🌻 / café',url:'/post/'+fixture.response.context.id});
 tampered=true;assert.equal(await receive(),null);tampered=false;
 unavailable=true;assert.equal(await receive(),null);unavailable=false;
 await page.evaluate(f=>window.seed(f,false),fixture);assert.equal(await receive(),null);
 await page.evaluate(()=>window.clearKeys());const before=requests;assert.equal(await receive(),null);assert.equal(requests,before);
 console.log('Notification previews passed in a real service worker: signed content, private key storage, tampering, denied access, untrusted author and logout fallback.');
}finally{await browser.close();await new Promise(r=>server.close(r));}
