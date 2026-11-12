/** Synthetic browser check of the real avatar provider, store, and viewport hook. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {chromium, firefox, webkit} from 'playwright';
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {MemberAvatar, MemberAvatarProvider} from './apps/web/src/MemberAvatar';
window.reads=[];
window.fetch=async url=>{window.reads.push(String(url));return Response.json({});};
const root=createRoot(document.getElementById('root'));
window.remove=()=>root.unmount();
root.render(<MemberAvatarProvider><div style={{height:100}}><MemberAvatar memberId="visible"/><MemberAvatar memberId="visible"/></div><div style={{height:3000}}/><div id="distant"><MemberAvatar memberId="distant"/></div></MemberAvatarProvider>);
`;
const bundle=await build({stdin:{contents:fixture,resolveDir:process.cwd(),loader:'tsx'},bundle:true,write:false,format:'esm',platform:'browser',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'synthetic-vault',setup(b){b.onLoad({filter:/\/vault\.tsx$/},()=>({contents:'export function useVault(){return {member:{id:"viewer",handle:"viewer",status:"active"},device:{id:"device"},profileVersion:0,open:async()=>({})};}',loader:'js'}));}}]});
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/fixture.js'?'text/javascript':'text/html');res.end(req.url==='/fixture.js'?bundle.outputFiles[0].text:'<!doctype html><style>.avatar{display:inline-block;width:40px;height:40px}</style><div id="root"></div><script type="module" src="/fixture.js"></script>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try {
 for(const [name,engine] of Object.entries({chromium,firefox,webkit})){
  const browser=await engine.launch({headless:true});
  try{
   const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.goto(`http://127.0.0.1:${server.address().port}`);
   await page.waitForFunction(()=>window.reads.length>=1);
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   assert.deepEqual(await page.evaluate(()=>window.reads),['/api/v1/profiles/member/visible'],'offscreen author must not compete at startup; visible duplicates share one read');
   await page.locator('#distant').scrollIntoViewIfNeeded();
   await page.waitForFunction(()=>window.reads.length===2);
   assert.deepEqual(await page.evaluate(()=>window.reads),['/api/v1/profiles/member/visible','/api/v1/profiles/member/distant']);
   await page.evaluate(()=>window.remove());
   assert.deepEqual(errors,[]);
   // Browsers without IntersectionObserver retain the eager compatibility fallback.
   await page.addInitScript(()=>{window.IntersectionObserver=undefined;});
   await page.reload();await page.waitForFunction(()=>window.reads.length===2);
   assert.deepEqual((await page.evaluate(()=>window.reads)).sort(),['/api/v1/profiles/member/distant','/api/v1/profiles/member/visible']);
   assert.deepEqual(errors,[]);
   console.log(name+': visible deduplication, deferred profile read, scroll and fallback passed');
  }finally{await browser.close();}
 }
}finally{await new Promise(r=>server.close(r));}
