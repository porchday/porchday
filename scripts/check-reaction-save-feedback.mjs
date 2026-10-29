/** Local browser regression: real Reactions/useAction/API/pending-save UI;
 * synthetic identity, deferred encryption/write/readback, no remote traffic. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Reactions } from './apps/web/src/Social';
import { PendingSaveStatus } from './apps/web/src/ui';
import { pendingSaves } from './apps/web/src/pending-saves';
import { createReactionSecret, reactionTag } from '@porchday/crypto';
const gate = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b}); return {promise,resolve,reject}; };
const secret = createReactionSecret(), payload = {emoji:'like'};
const tag = await reactionTag({secret,targetId:'post',memberId:'other',emoji:'like'});
const rows = [{member_id:'other',reaction_tag:tag,envelope:{context:{id:tag,authorId:'other',kind:'reaction',parentId:'post'}}}];
const state = window.fixture = { seal:gate(), write:gate(), reload:gate(), seals:0,writes:0,reloads:0,feedbackMs:null,started:0,status:()=>pendingSaves.getStatus() };
window.testVault = {member:{id:'me',status:'active'},device:{id:'device'},open:async()=>payload,
 seal:()=>{state.seals++;return state.seal.promise;}};
window.fetch = async (url,options) => {
 if (!String(url).startsWith('/api/v1/posts/post/reactions/') || options.method !== 'PUT') throw new Error('Unexpected request');
 state.writes++;return state.write.promise;
};
const observer = new MutationObserver(() => {
 if (!document.querySelector('.pending-save-status') || state.feedbackMs !== null) return;
 requestAnimationFrame(()=>requestAnimationFrame(()=>{
  const e=document.querySelector('.pending-save-status');
  if(e && e.getBoundingClientRect().height>0 && document.visibilityState==='visible') state.feedbackMs=performance.now()-state.started;
 }));
});observer.observe(document.body,{subtree:true,childList:true});
document.addEventListener('click',e=>{if(e.target.closest('.reaction-chip'))state.started=performance.now()},true);
createRoot(document.getElementById('root')).render(<><PendingSaveStatus/><Reactions
 target={{id:'post',envelope:{context:{kind:'post',audience:'only_me'}}}}
 payload={{reactionSecret:secret}} reactions={rows} reload={()=>{state.reloads++;return state.reload.promise;}}/></>);
`;
const bundle = await build({ stdin:{contents:fixture,resolveDir:process.cwd(),sourcefile:'reaction-feedback-fixture.tsx',loader:'tsx'},bundle:true,write:false,format:'esm',platform:'browser',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'synthetic-vault',setup(b){b.onLoad({filter:/\/vault\.tsx$/},()=>({contents:'export function useVault(){return window.testVault}',loader:'js'}));}}] });
const css = await readFile('apps/web/src/styles.css','utf8');
const server = createServer((req,res)=>{
 if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);}
 else if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css);}
 else if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/fixture.js"></script>');}
 else {res.statusCode=404;res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const origin=`http://127.0.0.1:${server.address().port}`;
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 async function begin(){
  await page.goto(origin);
  await page.locator('.reaction-chip').waitFor();
  await page.locator('.reaction-chip').click();
  await page.waitForFunction(()=>window.fixture.seals===1);
 }
 await begin();
 assert.equal(await page.evaluate(()=>window.fixture.status()),'saving','encryption must already be covered by save feedback and guard');
 await page.waitForFunction(()=>window.fixture.feedbackMs!==null);
 assert.equal(await page.locator('.reaction-chip').getAttribute('aria-pressed'),'false','pending reaction is not shown as confirmed');
 assert.equal(await page.locator('.reaction-add').isDisabled(),true);
 assert.equal(await page.evaluate(()=>window.dispatchEvent(new Event('beforeunload',{cancelable:true}))),false,'navigation guard covers encryption');
 assert.equal(await page.evaluate(()=>window.fixture.writes),0);
 const feedbackMs=await page.evaluate(()=>window.fixture.feedbackMs);
 // Synthetic dispatched double-click must not launch a second encryption/write.
 await page.locator('.reaction-chip').dispatchEvent('click');
 assert.equal(await page.evaluate(()=>window.fixture.seals),1);
 await page.evaluate(()=>window.fixture.seal.resolve({synthetic:true}));
 await page.waitForFunction(()=>window.fixture.writes===1);
 assert.equal(await page.evaluate(()=>window.fixture.status()),'saving');
 await page.evaluate(()=>window.fixture.write.resolve(Response.json({})));
 await page.waitForFunction(()=>window.fixture.reloads===1);
 assert.equal(await page.evaluate(()=>window.fixture.status()),'saving','keep guard through readback');
 await page.evaluate(()=>window.fixture.reload.resolve());
 await page.waitForFunction(()=>window.fixture.status()==='');
 assert.equal(await page.locator('.reaction-chip').isEnabled(),true);
 // Encryption rejection clears the guard, reports failure, and never writes.
 await begin();
 await page.evaluate(()=>window.fixture.seal.reject(new Error('Synthetic encryption failure')));
 await page.getByText('Synthetic encryption failure',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.fixture.status()),'');
 assert.equal(await page.evaluate(()=>window.fixture.writes),0);
 // Server rejection must not create a selected/confirmed reaction or reload.
 await begin();
 await page.evaluate(()=>window.fixture.seal.resolve({synthetic:true}));
 await page.waitForFunction(()=>window.fixture.writes===1);
 await page.evaluate(()=>window.fixture.write.resolve(Response.json({message:'Synthetic write failure'},{status:503})));
 await page.getByText('Synthetic write failure',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.fixture.status()),'');
 assert.equal(await page.evaluate(()=>window.fixture.reloads),0);
 assert.equal(await page.locator('.reaction-chip').getAttribute('aria-pressed'),'false');
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({checks:'encryption, duplicate, response, readback, encryption failure, server failure',feedbackMs,browser:browser.version(),physicalDevice:false,p99Acceptance:false}));
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
