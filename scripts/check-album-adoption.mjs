/** Synthetic browser interaction plus real owner signatures; hosted acceptance is separate. */
import {build} from 'esbuild';
import {chromium,webkit} from 'playwright';
import http from 'node:http';
import assert from 'node:assert/strict';
import {generateDeviceKeys} from '../packages/crypto/src/index.ts';
const owner='00000000-0000-4000-8000-000000000001',device='00000000-0000-4000-8000-000000000002',postId='00000000-0000-4000-8000-000000000003',mediaId='00000000-0000-4000-8000-000000000004',albumId='00000000-0000-4000-8000-000000000005';
const keys=await generateDeviceKeys(owner,device);
const bundle=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`import React from 'react';import{createRoot}from'react-dom/client';import{AttachmentAlbumPicker}from'./apps/web/src/AttachmentAlbumPicker';window.fixtureReady.then(()=>createRoot(document.getElementById('root')).render(<AttachmentAlbumPicker mediaId='${mediaId}' postId='${postId}' day='2001-02-03' onClose={()=>{}} onSaved={()=>{document.getElementById('saved').textContent='Photo saved'}}/>));`},bundle:true,write:false,format:'iife',platform:'browser',define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{}'},plugins:[{name:'fixture',setup(b){
 b.onResolve({filter:/^\.\/vault$/},()=>({path:'vault',namespace:'fixture'}));
 b.onResolve({filter:/^\.\/video$/},()=>({path:'video',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({loader:'js',resolveDir:process.cwd(),contents:path==='video'?`export const validatedMedia=async()=>({width:10,height:20});`:`import{unlockPrivateKey}from'@porchday/crypto';const vault={member:{id:'${owner}',status:'active'},device:{id:'${device}'},open:async row=>row.envelope.payload,seal:async(payload,context)=>({payload,context,recipients:[{memberId:'${owner}',deviceId:'${device}'}]})};window.fixtureReady=unlockPrivateKey(${JSON.stringify(keys.encryptedPrivateKey)},${JSON.stringify(keys.recoverySecret)}).then(key=>vault.privateKey=key);export const useVault=()=>vault;export const useOptionalVault=useVault;export const Fingerprint=()=>null;`}));
}}]});
let writes=[];
const server=http.createServer(async(req,res)=>{
 if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');return res.end(bundle.outputFiles[0].contents);}
 if(!req.url.startsWith('/api/')){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><div id="saved"></div><div id="root"></div><script src="/bundle.js"></script>');}
 const chunks=[];for await(const part of req)chunks.push(part);const raw=Buffer.concat(chunks).toString();const body=raw?JSON.parse(raw):null;
 res.setHeader('Content-Type','application/json');const path=req.url.replace('/api/v1','');
 if(req.method!=='GET'){writes.push({path,method:req.method,body});if(path==='/media')return res.end(JSON.stringify({upload_url:'/media/upload'}));return res.end(JSON.stringify({ok:true}));}
 if(path==='/albums')return res.end(JSON.stringify({items:[{id:albumId,role:'add',envelope:{payload:{name:'Family album'}}},{id:'read-only',role:'read',envelope:{payload:{name:'Read-only album'}}}]}));
 if(path==='/photos/'+mediaId){res.statusCode=404;return res.end(JSON.stringify({error:{code:'NOT_FOUND'}}));}
 if(path==='/posts/'+postId)return res.end(JSON.stringify({post:{id:postId,author_id:owner,expires_at:null,media:[{id:mediaId}],envelope:{payload:{media:[{id:mediaId,mime:'image/jpeg',name:'day.jpg',alt:'Caption'}]}}}}));
 if(path===`/media/${mediaId}/photo-date`)return res.end(JSON.stringify({date:null}));
 if(path===`/media/${mediaId}/bytes`)return res.end(JSON.stringify({context:{kind:'media',parentId:postId,authorId:owner,expiresAt:null},payload:{bytes:'aGVsbG8=',mime:'image/jpeg'}}));
 res.statusCode=404;res.end(JSON.stringify({error:{code:'NOT_FOUND'}}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{for(const engine of [chromium,webkit]){
 writes=[];const browser=await engine.launch();try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  try{await page.getByLabel('Album',{exact:true}).selectOption(albumId,{timeout:10000});}catch(error){console.error({errors,body:await page.locator('body').innerText()});throw error;}
  assert.equal(await page.getByRole('option',{name:'Read-only album'}).count(),0);
  await page.getByRole('button',{name:'Add photo to album',exact:true}).click();
  await page.getByText('Photo saved',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  const saved=writes.find(w=>w.path==='/photos');assert(saved);
  assert.equal(saved.body.id,mediaId);assert.equal(saved.body.source_media_id,mediaId);
  assert.equal(saved.body.source_date.statement.postId,postId);assert.equal(saved.body.source_date.statement.date,'2001-02-03');
  assert.deepEqual(saved.body.grants.map(g=>g.envelope.context.audience),['only_me','album']);
  assert.equal(writes.filter(w=>w.path==='/media').length,2);
  assert(!writes.some(w=>w.path.startsWith('/posts')));
  console.log(engine.name()+': attachment album picker, writable destinations, original identity/date, additive grants and no post rewrite passed');
 }finally{await browser.close();}}
}finally{await new Promise(resolve=>server.close(resolve));}
