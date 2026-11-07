import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'];
const seen=new Set(),calls=[];let failOnce=true;
const bundle=await build({stdin:{contents:`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {FeedUnreadProvider,FeedBadge,FeedReadControls,ReadableFeedItem} from './apps/web/src/FeedUnread';
function App(){const[ready,setReady]=useState(false);return <FeedUnreadProvider><FeedBadge/><FeedReadControls/><button onClick={()=>setReady(true)}>Unlock</button><ReadableFeedItem item={{kind:'post',id:'${ids[0]}'}} ready={ready}><article style={{height:500}} data-feed-readable={ready?'true':'false'}>Locked first post</article></ReadableFeedItem><ReadableFeedItem item={{kind:'post',id:'${ids[1]}'}} ready={true}><article style={{height:1800}} data-feed-readable="true">Tall second post</article></ReadableFeedItem><ReadableFeedItem item={{kind:'photo',id:'${ids[2]}'}} ready={true} photo><article style={{height:400}} data-feed-readable="true"><img className="viewable-photo" src="/broken"/>Broken photo</article></ReadableFeedItem></FeedUnreadProvider>};createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'iife',define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{}'},plugins:[{name:'vault-fixture',setup(b){b.onResolve({filter:/^\.\/vault$/},()=>({path:'vault',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const useVault=()=>({member:{id:'self',status:'active'}});`,loader:'js'}));}}]});
const server=createServer(async(req,res)=>{const path=req.url?.split('?')[0];const send=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
 if(path==='/fixture.js'){res.setHeader('Content-Type','text/javascript');return res.end(bundle.outputFiles[0].text);}
 if(path==='/api/v1/feed/unread')return send({count:3-seen.size});
 if(path==='/api/v1/feed/read'){const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());calls.push(body.items);if(failOnce){failOnce=false;return send({error:{code:'TEMPORARY'}},503);}for(const item of body.items)seen.add(item.id);return send({count:3-seen.size});}
 if(path==='/api/v1/feed/read-all'){ids.forEach(x=>seen.add(x));return send({count:0});}
 if(path==='/broken'){res.writeHead(404);return res.end();}
 res.setHeader('Content-Type','text/html');res.end('<html><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();
try{
 const page=await browser.newPage({viewport:{width:390,height:800}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{window.badges=[];navigator.setAppBadge=async n=>window.badges.push(n);navigator.clearAppBadge=async()=>window.badges.push(0);});
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByText('3 unread',{exact:true}).waitFor();
 await page.waitForTimeout(1400);assert.equal(calls.length,0,'locked/offscreen cards cannot acknowledge');
 await page.getByRole('button',{name:'Unlock',exact:true}).click();await page.waitForTimeout(400);await page.evaluate(()=>scrollTo(0,2000));await page.waitForTimeout(400);await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(400);assert.equal(calls.length,0,'fast scrolling must restart dwell');
 await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
 await page.waitForTimeout(1300);assert.equal(calls.length,0,'background visibility cannot acknowledge');
 await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));});
 await page.waitForTimeout(7500);assert(seen.has(ids[0]),'failed batch retries and succeeds');assert(!seen.has(ids[1]),'less than half viewport of tall card remains unread');
 await page.evaluate(()=>scrollTo(0,800));await page.waitForTimeout(3500);assert(seen.has(ids[1]),'tall card can become read');
 await page.evaluate(()=>scrollTo(0,document.body.scrollHeight));await page.waitForTimeout(3500);assert(!seen.has(ids[2]),'unreadable image cannot become read');
 await page.getByRole('button',{name:'Mark all as read'}).click();await page.getByText('You’re caught up',{exact:true}).waitFor();assert.equal(seen.size,3);assert.equal(await page.evaluate(()=>window.badges.at(-1)),0);
 assert.deepEqual(errors,[]);console.log('Feed read browser: locked/offscreen/fast/background/tall/broken cards, retry and mark-all passed.');
}finally{await browser.close();await new Promise(r=>server.close(r));}
