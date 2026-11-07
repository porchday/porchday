// Browser regression for durable encrypted retries and uncertain final POSTs.
import {build} from 'esbuild';import {createServer} from 'node:http';import {chromium} from 'playwright';import assert from 'node:assert/strict';
const bundle=await build({stdin:{contents:"export * from './apps/web/src/video-outbox.ts'",resolveDir:process.cwd()},bundle:true,format:'esm',platform:'browser',write:false});
let received=new Set(),postBody=null,photoBody=null,reservations=0,chunkWrites=0,failOnce=true;
const server=createServer(async(req,res)=>{
 if(req.url==='/entry.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].contents);return;}
 if(!req.url.startsWith('/api/')){res.setHeader('Content-Type','text/html');res.end('<script type="module">import * as outbox from "/entry.js";window.outbox=outbox</script>');return;}
 let body=Buffer.alloc(0);for await(const chunk of req)body=Buffer.concat([body,chunk]);res.setHeader('Content-Type','application/json');
 if(req.url.startsWith('/api/v1/posts/')&&req.method==='GET'){res.statusCode=postBody?200:404;res.end(JSON.stringify(postBody?{post:postBody}:{code:'NOT_FOUND'}));return;}
 if(req.url.startsWith('/api/v1/photos/')&&req.method==='GET'){res.statusCode=photoBody?200:404;res.end(JSON.stringify(photoBody?{photo:photoBody}:{code:'NOT_FOUND'}));return;}
 if(req.url==='/api/v1/photos'){const value=JSON.parse(body);photoBody={owner_id:value.fixtureOwner,photo_date:value.photo_date,expires_at:value.expires_at,grants:value.grants.map(g=>({id:g.envelope.context.id,...g}))};res.statusCode=503;res.end('{}');return;}
 if(req.url==='/api/v1/videos'){reservations++;const value=JSON.parse(body);assert(value.envelope.ciphertext);res.end(JSON.stringify({state:'pending',upload_url:'/api/v1/media/'+value.id+'/bytes'}));return;}
 if(req.url.endsWith('/status')){res.end(JSON.stringify({received:[...received]}));return;}
 if(req.url.includes('/chunks/')){const index=Number(req.url.split('/').at(-1));if(index===1&&failOnce){failOnce=false;res.statusCode=503;res.end('{}');return;}chunkWrites++;received.add(index);res.end('{}');return;}
 if(req.url==='/api/v1/posts'){postBody=JSON.parse(body);res.statusCode=503;res.end('{}');return;}// Commit succeeded but response was lost.
 res.end('{}');
});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch();try{
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.outbox);
 const ids=await page.evaluate(async()=>{
  const owner=crypto.randomUUID(),id=crypto.randomUUID(),mediaId=crypto.randomUUID(),blob=new File([new Uint8Array(4*1024*1024+23)],'video.mp4');
  const manifest=await window.outbox.stageVideo(owner,id,mediaId,{blob,duration:1,width:640,height:480},new AbortController().signal);
  const envelope={context:{id:mediaId},ciphertext:'encrypted-only-fixture'};
  const staged=await window.outbox.stageMedia(owner,id,envelope,manifest);
  await window.outbox.savePublication(owner,id,[staged],{envelope:{context:{id},ciphertext:'encrypted-post'},media_ids:[mediaId]});
  try{await window.outbox.sendPublication(owner,id,new AbortController().signal);throw Error('Expected interruption');}catch(error){if(error.status!==503)throw error;}
  return{owner,id};
 });assert.deepEqual([...received],[0]);assert.equal(chunkWrites,1);
 await page.reload();await page.waitForFunction(()=>window.outbox);
 await page.evaluate(async({owner,id})=>{if((await window.outbox.pendingPublications(owner)).length!==1)throw Error('Missing pending upload');try{await window.outbox.sendPublication(owner,id,new AbortController().signal);throw Error('Expected uncertain post response');}catch(error){if(error.status!==503)throw error;}},ids);
 assert.equal(chunkWrites,2);assert.equal(reservations,2);
 await page.evaluate(async({owner,id})=>{await window.outbox.sendPublication(owner,id,new AbortController().signal);if((await window.outbox.pendingPublications(owner)).length)throw Error('Upload was not settled');},ids);
 assert.equal(chunkWrites,2);assert.equal(reservations,2);console.log('Encrypted outbox resumes after reload without repeating chunks, and settles an uncertain committed post without another write.');
 received=new Set();failOnce=true;chunkWrites=0;reservations=0;
 const photoIDs=await page.evaluate(async()=>{
  const owner=crypto.randomUUID(),id=crypto.randomUUID(),mediaId=crypto.randomUUID(),blob=new File([new Uint8Array(4*1024*1024+23)],'direct.mp4');
  const manifest=await window.outbox.stageVideo(owner,id,mediaId,{blob,duration:1,width:640,height:480},new AbortController().signal);
  const staged=await window.outbox.stageMedia(owner,id,{context:{id:mediaId},ciphertext:'encrypted-video-manifest'},manifest);
  await window.outbox.savePublication(owner,id,[staged],{id,fixtureOwner:owner,photo_date:'2026-11-01',expires_at:null,grants:[{media_id:mediaId,envelope:{context:{id:crypto.randomUUID(),parentId:id,kind:'photo'},ciphertext:'encrypted-video-grant'}}]},'photo');
  try{await window.outbox.sendPublication(owner,id,new AbortController().signal);throw Error('Expected interruption');}catch(error){if(error.status!==503)throw error;}
  return{owner,id};
 });assert.equal(chunkWrites,1);
 await page.reload();await page.waitForFunction(()=>window.outbox);
 await page.evaluate(async({owner,id})=>{try{await window.outbox.sendPublication(owner,id,new AbortController().signal);throw Error('Expected uncertain response');}catch(error){if(error.status!==503)throw error;}},photoIDs);
 assert.equal(chunkWrites,2);assert.equal(reservations,2);
 await page.evaluate(async({owner,id})=>{await window.outbox.sendPublication(owner,id,new AbortController().signal);if((await window.outbox.pendingPublications(owner)).length)throw Error('Pending direct video');},photoIDs);
 assert.equal(chunkWrites,2);assert.equal(reservations,2);console.log('Direct video outbox survives reload, resumes missing chunks and reconciles publication without a post.');
}finally{await browser.close();await new Promise(r=>server.close(r));}
