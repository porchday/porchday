/** Synthetic browser regression for the real feed-proposal hook and controls. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {chromium,webkit} from 'playwright';
const fixture=`import React from 'react';import {createRoot} from 'react-dom/client';import {useFeedFeatures,FeedFeatureCard} from './apps/web/src/FeedFeatures';
function App(){const f=useFeedFeatures(true);return <><div role="alert">{f.error}</div>{f.features.map(x=><FeedFeatureCard key={x.id} feature={x} busy={f.busy||f.paused} onVote={v=>f.vote(x.id,v)}/>)}<button disabled={f.busy} onClick={f.refresh}>Refresh proposals</button>{f.cursor&&<button disabled={f.busy} onClick={f.more}>Load more</button>}</>};createRoot(document.getElementById('root')).render(<App/>);`;
const bundle=await build({stdin:{contents:fixture,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{}'}});
const css=await readFile('apps/web/src/styles.css');
let cards,denied,paused,failVote,failRead,legacy,reads,writes;
const reset=()=>{cards=[{id:'one',title:'First feature',plan:'A concise plan',score:0,my_vote:0,status:'voting',created_at:'2026-10-30T10:00:00Z'},{id:'two',title:'Older feature',plan:'Another plan',score:0,my_vote:0,status:'voting',created_at:'2026-10-29T10:00:00Z'}];denied=paused=failVote=failRead=legacy=false;reads=0;writes=[];};
const server=createServer(async(req,res)=>{
 if(req.url==='/check.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].contents);return;}
 if(req.url==='/styles.css'){res.setHeader('Content-Type','text/css');res.end(css);return;}
 if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><main id="root" style="padding:12px;max-width:900px;margin:auto"></main><script src="/check.js"></script></html>');return;}
 res.setHeader('Content-Type','application/json');
 if(req.url.startsWith('/api/v1/builder-chat/features?')) {
  reads++;if(denied||failRead){res.statusCode=denied?404:503;res.end(JSON.stringify({error:{code:denied?'NOT_FOUND':'UNAVAILABLE'}}));return;}
  const more=new URL(req.url,'http://localhost').searchParams.has('cursor');
  res.end(JSON.stringify({items:(more?cards:cards.slice(0,1)).filter(x=>x.status==='voting'),next_cursor:more?null:'older',paused,feed_eligible:!legacy}));return;
 }
 if(req.method==='PUT' && req.url.endsWith('/vote')) {
  const chunks=[];for await(const c of req)chunks.push(c);const value=JSON.parse(Buffer.concat(chunks)).value;writes.push(value);
  await new Promise(resolve=>setTimeout(resolve,100));
  if(failVote){res.statusCode=409;res.end(JSON.stringify({error:{code:'FEATURE_LOCKED',message:'Voting has closed.'}}));return;}
  cards[0].my_vote=value;cards[0].score=value;res.end('{"ok":true}');return;
 }
 res.statusCode=404;res.end('{}');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try {
 browser=await (process.env.TEST_BROWSER==='webkit'?webkit:chromium).launch({headless:true});
 for(const width of [320,390,1280]) {
  reset();const page=await browser.newPage({viewport:{width,height:900}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const origin=`http://127.0.0.1:${server.address().port}`;await page.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());
  await page.goto(origin);await page.getByRole('heading',{name:'First feature'}).waitFor();assert.equal(reads,1);
  const first=page.getByRole('article',{name:'Feature proposal: First feature'});
  await first.getByRole('button',{name:'Support +1'}).focus();await page.keyboard.press('Enter');
  await first.getByText('Your vote: Support',{exact:true}).waitFor();assert.deepEqual(writes,[1]);
  await first.getByRole('button',{name:'Remove my vote'}).click();await first.getByText('Your vote: Not voted',{exact:true}).waitFor();assert.deepEqual(writes,[1,0]);
  await page.getByRole('button',{name:'Load more',exact:true}).click();await page.getByRole('heading',{name:'Older feature'}).waitFor();assert.equal(await page.locator('article').count(),2);
  cards[0].score=2;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await first.getByText('Net votes: +2 / +3 needed',{exact:true}).waitFor();assert.equal(await page.locator('article').count(),2);
  failVote=true;cards[0].status='queued';await first.getByRole('button',{name:'Against −1'}).click();await page.getByRole('alert').getByText('Voting has closed.').waitFor();assert.equal(await first.count(),0);
  paused=true;await page.getByRole('button',{name:'Refresh proposals',exact:true}).click();await page.waitForFunction(()=>document.querySelector('article button')?.disabled===true);
  failRead=true;await page.getByRole('button',{name:'Refresh proposals',exact:true}).click();await page.getByRole('alert').getByText('Feature proposals could not be refreshed. Try again.').waitFor();assert.equal(await page.locator('article').count(),0);
  failRead=false;await page.getByRole('button',{name:'Refresh proposals',exact:true}).click();await page.getByRole('heading',{name:'Older feature'}).waitFor();
  denied=true;await page.getByRole('button',{name:'Refresh proposals',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('article'));
  denied=false;legacy=true;await page.getByRole('button',{name:'Refresh proposals',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('article')&&!document.querySelector('button:disabled'));assert.equal(await page.locator('article').count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
  await page.close();
 }
 console.log('Feed proposal voting, readback, duplicate pagination, stale dispatch, pause, access loss and 320/390/1280px checks passed.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
