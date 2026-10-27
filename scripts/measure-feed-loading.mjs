import {build} from 'esbuild';
import {chromium} from 'playwright';
import http from 'node:http';
import {writeFile} from 'node:fs/promises';
const root=process.cwd(), output=process.argv[2];
if (!output) throw new Error("Usage: node scripts/measure-feed-loading.mjs output.json");
const result=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{PostCard}from'./apps/web/src/Social';
const rows=Array.from({length:30},(_,i)=>({id:'post-'+i,author_id:'self',created_at:new Date().toISOString(),expires_at:null,audience:'only_me',envelope:{ciphertext:'x',context:{id:'post-'+i,authorId:'self',revision:1,expiresAt:null}}}));
createRoot(document.getElementById('root')).render(<>{rows.map(row=><div style={{minHeight:600}} key={row.id}><PostCard row={row} onChange={()=>{}}/></div>)}</>);`,resolveDir:root,loader:'tsx'},plugins:[{name:'synthetic-only',setup(b){
b.onResolve({filter:/^\.\/vault$/},()=>({path:'vault',namespace:'fixture'}));
b.onResolve({filter:/^\.\/MemberAvatar$/},()=>({path:'avatar',namespace:'fixture'}));
b.onResolve({filter:/^\.\/photo-safety$/},()=>({path:'photo',namespace:'fixture'}));
b.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'js',contents:args.path==='vault'?`export const useVault=()=>({member:{id:'self',handle:'fixture',status:'active'},device:{id:'device'},open:async row=>row.id.startsWith('post-')?{text:'Synthetic post',media:[{id:row.id.replace('post-','media-'),mime:'image/jpeg',alt:'Fixture',width:400,height:300}]}:{mime:'image/jpeg',bytes:'AA=='}});export const useOptionalVault=useVault;export const Fingerprint=()=>null;export const VaultProvider=({children})=>children;`:args.path==='avatar'?`export const MemberAvatar=()=>null;`:`export const validatedPhoto=async()=>({blob:new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="green"/></svg>'],{type:'image/svg+xml'})}); export const jpegDimensions=()=>({width:400,height:300}),jpegSource=()=>null,PHOTO_ACCEPT='',PHOTO_SOURCE_MAX_BYTES=50000000,photoSourceMime=()=>'',stripCanvasJpegMetadata=x=>x;` }));
}}],bundle:true,write:false,platform:'browser',format:'iife',define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{}'}});
let active=0,queue=[],calls=[];const server=http.createServer(async(req,res)=>{
 if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');return res.end(result.outputFiles[0].contents);}
 if(!req.url.startsWith('/api/')){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><style>body{margin:0}#root{max-width:700px}figure{margin:0}img{width:400px;height:300px}.photo-placeholder{height:300px}</style><div id="root"></div><script src="/bundle.js"></script>');}
 calls.push(req.url);if(active>=6)await new Promise(resolve=>queue.push(resolve));active++;
 await new Promise(resolve=>setTimeout(resolve,150));res.setHeader('Content-Type','application/json');
 res.end(req.url.includes('/media/')?JSON.stringify({context:{expiresAt:null},padding:'x'.repeat(100000)}):JSON.stringify({comments:[],reactions:[]}));active--;queue.shift()?.();
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch();const samples=[];
try{for(let i=0;i<5;i++){
 calls=[];const context=await browser.newContext({viewport:{width:800,height:800},serviceWorkers:'block'});const page=await context.newPage();const start=performance.now();await page.goto(origin);await page.locator('img').first().waitFor();await page.locator('img').first().evaluate(img=>img.decode());const firstPhotoMs=performance.now()-start;await page.waitForTimeout(1800);samples.push({firstPhotoMs:Math.round(firstPhotoMs),detailRequests:calls.filter(x=>x.includes('/posts/')).length,photoRequests:calls.filter(x=>x.includes('/media/')).length,syntheticPhotoResponseBytes:calls.filter(x=>x.includes('/media/')).length*100000});await context.close();
}const results={method:'5 fresh Chromium contexts, 30 synthetic cards, 800x800 viewport, six server slots, 150ms response delay, 100KB synthetic media envelope padding. Real card/fetch lifecycle; mocked vault, avatar and image validation. Not a hosted or cryptographic benchmark.',samples};await writeFile(output,JSON.stringify(results,null,2));console.log(JSON.stringify(results));}finally{await browser.close();server.close();}
