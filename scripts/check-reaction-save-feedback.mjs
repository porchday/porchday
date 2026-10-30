/** Local browser regression: real Reactions/useAction/API/pending-save UI;
 * synthetic identity, deferred encryption/write/readback, no remote traffic. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';
import { tinyPng } from '../apps/web/test/emoji-fixtures.ts';

const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Reactions } from './apps/web/src/Social';
import { PendingSaveStatus } from './apps/web/src/ui';
import { pendingSaves } from './apps/web/src/pending-saves';
import { createReactionSecret, reactionTag } from '@porchday/crypto';
import { customReaction } from '@porchday/crypto/reactions';
const gate = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b}); return {promise,resolve,reject}; };
const secret = createReactionSecret(), payload = location.search==='?custom' ? await customReaction('test_image', Uint8Array.from(${JSON.stringify([...tinyPng()])})) : {emoji:'like'};
const tag = await reactionTag({secret,targetId:'post',memberId:'other',emoji:payload.emoji});
const myTag = await reactionTag({secret,targetId:'post',memberId:'me',emoji:payload.emoji});
const mine={comment_id:'post',member_id:'me',reaction_tag:myTag,envelope:{context:{id:myTag,authorId:'me',kind:'reaction',parentId:'post'}}};
const rows = [{member_id:'other',reaction_tag:tag,envelope:{context:{id:tag,authorId:'other',kind:'reaction',parentId:'post'}}}];
if(location.search==='?mine') rows.push(mine);
const state = window.fixture = { seal:gate(), write:gate(), read:gate(), reads:0, methods:[], reload:gate(), seals:0,writes:0,reloads:0,feedbackMs:null,started:0,status:()=>pendingSaves.getStatus() };
state.confirm = () => state.read.resolve(Response.json({reactions:[...rows,mine],comment_reactions:[mine]}));
state.absent = () => state.read.resolve(Response.json({reactions:rows}));
window.testVault = {member:{id:'me',status:'active'},device:{id:'device'},open:async()=>payload,
 seal:()=>{state.seals++;return state.seal.promise;}};
window.fetch = async (url,options) => {
 if (String(url)==='/api/v1/posts/post' || String(url)==='/api/v1/posts/parent') { state.reads++; return (await state.read.promise).clone(); }
 if (!['posts','comments'].some(kind=>String(url).startsWith('/api/v1/'+kind+'/post/reactions/')) || !['PUT','DELETE'].includes(options.method)) throw new Error('Unexpected request');
 state.writes++;state.methods.push(options.method);return (await state.write.promise).clone();
};
const observer = new MutationObserver(() => {
 if (!document.querySelector('.pending-save-status') || state.feedbackMs !== null) return;
 requestAnimationFrame(()=>requestAnimationFrame(()=>{
  const e=document.querySelector('.pending-save-status');
  if(e && e.getBoundingClientRect().height>0 && document.visibilityState==='visible') state.feedbackMs=performance.now()-state.started;
 }));
});observer.observe(document.body,{subtree:true,childList:true});
document.addEventListener('click',e=>{if(e.target.closest('.reaction-chip'))state.started=performance.now()},true);
function App(){const [targetId,setTargetId]=React.useState('post');state.changeTarget=setTargetId;return <><PendingSaveStatus/><Reactions
 target={{id:targetId,post_id:'parent',envelope:{context:{kind:location.search==='?comment'?'comment':'post',audience:'only_me'}}}}
 payload={{reactionSecret:secret}} reactions={targetId==='post'?rows:[]} reload={()=>{state.reloads++;return state.reload.promise;}}/></>;}
createRoot(document.getElementById('root')).render(<App/>);
`;
const bundle = await build({ stdin:{contents:fixture,resolveDir:process.cwd(),sourcefile:'reaction-feedback-fixture.tsx',loader:'tsx'},bundle:true,write:false,format:'esm',platform:'browser',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'synthetic-vault',setup(b){b.onLoad({filter:/\/vault\.tsx$/},()=>({contents:'export function useVault(){return window.testVault}',loader:'js'}));}}] });
const css = await readFile('apps/web/src/styles.css','utf8');
const server = createServer((req,res)=>{
 if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);}
 else if(req.url==='/style.css'){res.setHeader('Content-Type','text/css');res.end(css);}
 else if(req.url==='/' || req.url==='/?mine' || req.url==='/?custom' || req.url==='/?comment'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/fixture.js"></script>');}
 else {res.statusCode=404;res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
 browser=await (process.env.TEST_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
 const page=await browser.newPage({viewport:{width:390,height:844}});
 const origin=`http://127.0.0.1:${server.address().port}`;
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 page.setDefaultTimeout(8000);
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
 assert.equal(await page.locator('.reaction-chip').getAttribute('aria-pressed'),'true','pending selection appears before encryption completes');
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
 await page.waitForFunction(()=>window.fixture.reads===1);
 assert.equal(await page.evaluate(()=>window.fixture.status()),'saving','keep guard through readback');
 await page.evaluate(()=>window.fixture.confirm());
 await page.waitForFunction(()=>window.fixture.status()==='');
 assert.equal(await page.locator('.reaction-chip').isEnabled(),true);
 // Encryption rejection clears the guard, reports failure, and never writes.
 await begin();
 await page.evaluate(()=>window.fixture.seal.reject(new Error('Synthetic encryption failure')));
 await page.getByText('Synthetic encryption failure',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.fixture.status()),'');
 assert.equal(await page.evaluate(()=>window.fixture.writes),0);
 // Definitive rejection restores the previous count and selection.
 await begin();
 await page.evaluate(()=>window.fixture.seal.resolve({synthetic:true}));
 await page.waitForFunction(()=>window.fixture.writes===1);
 await page.evaluate(()=>window.fixture.write.resolve(Response.json({message:'Synthetic write failure'},{status:400})));
 await page.getByText('Synthetic write failure',{exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.fixture.status()),'');
 assert.equal(await page.evaluate(()=>window.fixture.reloads),0);
 assert.equal(await page.locator('.reaction-chip').getAttribute('aria-pressed'),'false');
 // Lost write response: reconcile committed state without resending or toggling.
 await begin();
 await page.evaluate(()=>window.fixture.seal.resolve({synthetic:true}));
 await page.waitForFunction(()=>window.fixture.writes===1);
 await page.evaluate(()=>window.fixture.write.reject(new TypeError('Synthetic lost response')));
 await page.waitForFunction(()=>window.fixture.reads===1);
 await page.evaluate(()=>window.fixture.confirm());
 await page.waitForFunction(()=>window.fixture.status()==='');
 assert.equal(await page.locator('.reaction-chip').getAttribute('aria-pressed'),'true');
 assert.equal(await page.evaluate(()=>window.fixture.writes),1);
 // An unconfirmed result stays pending and cannot be toggled into a deletion.
 await begin();
 await page.evaluate(()=>window.fixture.seal.resolve({synthetic:true}));
 await page.waitForFunction(()=>window.fixture.writes===1);
 await page.evaluate(()=>window.fixture.write.reject(new TypeError('Synthetic lost response')));
 await page.waitForFunction(()=>window.fixture.reads===1);
 await page.evaluate(()=>window.fixture.absent());
 await page.getByText('Reaction not yet confirmed.',{exact:true}).waitFor();
 assert.equal(await page.locator('.reaction-chip').isDisabled(),true);
 assert.equal(await page.locator('.reaction-chip').getAttribute('aria-pressed'),'true');
 assert.equal(await page.getByRole('button',{name:'Check and retry reaction'}).isVisible(),true);
 // Explicit retry reads first, then replays the same PUT, never a DELETE.
 await page.evaluate(()=>{
  window.fixture.read.promise=Promise.resolve(Response.json({reactions:[]}));
  window.fixture.write.promise=Promise.resolve(Response.json({}));
 });
 await page.getByRole('button',{name:'Check and retry reaction'}).click();
 await page.waitForFunction(()=>window.fixture.writes===2);
 assert.deepEqual(await page.evaluate(()=>window.fixture.methods),['PUT','PUT']);
 await page.waitForFunction(()=>window.fixture.status()==='');
 // Removing one's emoji updates immediately without an encryption request.
 await page.goto(origin+'?mine');
 await page.locator('.reaction-chip[aria-pressed="true"]').waitFor();
 await page.locator('.reaction-chip').click();
 await page.waitForFunction(()=>window.fixture.writes===1);
 assert.equal(await page.locator('.reaction-chip').getAttribute('aria-pressed'),'false');
 assert.match(await page.locator('.reaction-chip').getAttribute('aria-label'), /1 person$/);
 assert.equal(await page.evaluate(()=>window.fixture.seals),0);
 assert.deepEqual(await page.evaluate(()=>window.fixture.methods),['DELETE']);
 await page.evaluate(()=>{
  window.fixture.write.resolve(Response.json({}));
  window.fixture.read.resolve(Response.json({reactions:[]}));
 });
 await page.waitForFunction(()=>window.fixture.status()==='');
 assert.equal(await page.locator('.reaction-chip').count(),0);
 // Comment reactions reconcile through their parent post's comment-reaction rows.
 await page.goto(origin+'?comment');
 await page.locator('.reaction-chip').waitFor();
 await page.locator('.reaction-chip').click();
 await page.waitForFunction(()=>window.fixture.seals===1);
 await page.evaluate(()=>window.fixture.seal.resolve({synthetic:true}));
 await page.waitForFunction(()=>window.fixture.writes===1);
 await page.evaluate(()=>{window.fixture.write.resolve(Response.json({}));window.fixture.confirm();});
 await page.waitForFunction(()=>window.fixture.status()==='');
 assert.equal(await page.locator('.reaction-chip').getAttribute('aria-pressed'),'true');
 // Custom image reactions use the same pending state after PNG validation.
 await page.goto(origin+'?custom');
 await page.locator('.reaction-chip').waitFor();
 await page.locator('.reaction-chip').click();
 await page.waitForFunction(()=>window.fixture.seals===1);
 assert.equal(await page.locator('.reaction-chip').getAttribute('aria-pressed'),'true');
 await page.evaluate(()=>window.fixture.seal.reject(new Error('Custom save failed')));
 await page.getByText('Custom save failed',{exact:true}).waitFor();
 assert.equal(await page.locator('.reaction-chip').getAttribute('aria-pressed'),'false');
 // Picker closes before encryption finishes and leaves a keyboard focus target.
 await page.goto(origin);
 await page.getByRole('button',{name:'Add a reaction',exact:true}).click();
 await page.locator('.emoji-grid button').first().press('Enter');
 await page.waitForFunction(()=>window.fixture.seals===1);
 assert.equal(await page.getByRole('dialog').count(),0);
 assert.equal(await page.getByText('Saving reaction…',{exact:true}).evaluate(e=>e===document.activeElement),true);
 // A late completion from a previous target cannot publish into a different post.
 await page.evaluate(()=>window.fixture.changeTarget('second-post'));
 await page.waitForFunction(()=>!document.querySelector('.reaction-chip'));
 await page.evaluate(()=>window.fixture.seal.resolve({synthetic:true}));
 await page.waitForFunction(()=>window.fixture.status()==='');
 assert.equal(await page.evaluate(()=>window.fixture.writes),0);
 assert.equal(await page.locator('.reaction-chip').count(),0);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({checks:'optimistic add/remove, encryption failure, rejection, lost reply reconciliation, idempotent retry, duplicate suppression',feedbackMs,browser:browser.version(),physicalDevice:false,p99Acceptance:false}));
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
