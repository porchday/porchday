// Signed-out local browsers, synthetic receipts only; no messages are sent.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';
const root=resolve(import.meta.dirname,'..');
const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {PlatformInvitation} from './apps/web/src/PlatformInvitation';import './apps/web/src/styles.css';import './apps/web/src/retro.css';createRoot(document.getElementById('root')).render(<PlatformInvitation canInvite={true}/>);`,resolveDir:root,loader:'tsx'},bundle:true,write:false,outdir:'unused-invitation-test',format:'esm',platform:'browser',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'public-css',setup(b){b.onResolve({filter:/^\/(?:fonts\.css|[^/]+\.svg)$/},args=>({path:args.path,external:true}));}}]});
const js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).contents,css=bundle.outputFiles.find(f=>f.path.endsWith('.css')).contents;
const now=new Date().toISOString(),expiry=new Date(Date.now()+86400000).toISOString();
let rows=[],listError=false,pages=false,sends=0,delaySend=false;
const item=(email,status='pending',id=email)=>({id,email,status,requested_at:now,expires_at:expiry});
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 const send=(value,status=200,mime='application/json')=>{res.writeHead(status,{'Content-Type':mime,'Cache-Control':'no-store'});res.end(mime==='application/json'?JSON.stringify(value):value);};
 if(url.pathname==='/fixture.js')return send(js,200,'text/javascript');
 if(url.pathname==='/fixture.css')return send(css,200,'text/css');
 if(url.pathname==='/fonts.css')return send('',200,'text/css');
 if(url.pathname==='/api/v1/platform-invitations'){
  if(req.method==='GET')return listError?send({},503):send({items:url.searchParams.has('cursor')?[item('older@example.test','expired')]:rows,next_cursor:pages&&!url.searchParams.has('cursor')?'page-two':null});
  if(req.method==='POST'){
   sends++;let body='';for await(const part of req)body+=part;
   if(delaySend)await new Promise(resolve=>setTimeout(resolve,150));
   rows.unshift(item(JSON.parse(body).email));return send({accepted:true},202);
  }
 }
 if(url.pathname.endsWith('.svg'))return send('',404,'image/svg+xml');
 send('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><main id="root"></main><script type="module" src="/fixture.js"></script></body></html>',200,'text/html');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
try{
 for(const [name,engine] of Object.entries({chromium,webkit})){
  const browser=await engine.launch();try{
   const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
   rows=[];listError=false;pages=false;sends=0;delaySend=true;
   await page.goto(origin);await page.getByText('No invitations yet.',{exact:true}).waitFor();
   const recipient='sample.person@example.test';await page.getByLabel('Their email address').fill(recipient);
   await page.getByRole('button',{name:'Send invitation',exact:true}).click();
   assert.equal(await page.getByLabel('Their email address').isDisabled(),true);
   await page.getByRole('list',{name:'Your platform invitations'}).getByText(recipient,{exact:true}).waitFor();
   assert.equal(sends,1);assert.equal(await page.getByLabel('Their email address').inputValue(),'');
   rows=[item(recipient,'joined'),item('awaiting@example.test'),item('expired@example.test','expired')];pages=true;
   await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByText('Joined',{exact:true}).waitFor();
   assert.equal(await page.getByText('Pending',{exact:true}).count(),1);assert.equal(await page.getByText('Expired',{exact:true}).count(),1);
   await page.getByRole('button',{name:'Load more invitations',exact:true}).click();await page.getByText('older@example.test',{exact:true}).waitFor();
   assert.equal(await page.getByRole('list',{name:'Your platform invitations'}).locator('li').count(),4);
   assert.equal(await page.getByRole('button',{name:'Load more invitations',exact:true}).count(),0);
   listError=true;await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByText('Could not load your invitations. Try again.',{exact:true}).waitFor();
   listError=false;rows=[item('a'.repeat(64)+'@'+'b'.repeat(63)+'.example.test')];pages=false;
   await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.invitation-list li').length===1);
   assert.equal(await page.getByText('Could not load your invitations. Try again.',{exact:true}).count(),0);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   assert.deepEqual(errors,[]);console.log(`${name}: empty, submit refresh, single-send, statuses, pagination, retry, narrow layout passed`);
  }finally{await browser.close();}
 }
}finally{await new Promise(resolve=>server.close(resolve));}
