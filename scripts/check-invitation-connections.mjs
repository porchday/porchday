/** Real invitation component in Chromium, isolated synthetic transport. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const fixture=`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {PlatformInvitation} from './apps/web/src/PlatformInvitation';
let items=[];
window.calls=[];
window.fetch=async(url,options={})=>{
 window.calls.push({url:String(url),method:options.method||'GET',body:options.body?JSON.parse(options.body):null});
 if(options.method==='POST' && String(url).endsWith('/revoke')){items[0].status='revoked';return Response.json({revoked:true});}
 if(options.method==='POST'){const data=JSON.parse(options.body);items=[{id:'00000000-0000-4000-8000-000000000001',email:data.email,kind:data.kind,status:'pending',requested_at:'2026-10-31T00:00:00Z',expires_at:'2026-11-07T00:00:00Z'}];return Response.json({accepted:true},{status:202});}
 return Response.json({items,next_cursor:null});
};
createRoot(document.getElementById('root')).render(<PlatformInvitation canInvite={true}/>);
`;
const bundle=await build({stdin:{contents:fixture,resolveDir:process.cwd(),sourcefile:'invitation-fixture.tsx',loader:'tsx'},bundle:true,write:false,format:'esm',platform:'browser',define:{'process.env.NODE_ENV':'"production"'}});
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/fixture.js'?'text/javascript':'text/html');res.end(req.url==='/fixture.js'?bundle.outputFiles[0].text:'<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
 browser=await chromium.launch({headless:true});const page=await browser.newPage();
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.getByText('No invitations yet.').waitFor();
 await page.getByLabel('Their email address').fill('synthetic@example.test');
 await page.getByLabel('Connect as').selectOption('family');
 await page.getByText(/automatically connect as Family/).waitFor();
 await page.getByRole('button',{name:'Send invitation',exact:true}).click();
 await page.getByText('Pending',{exact:true}).waitFor();
 await page.getByText('Connect as Family',{exact:true}).waitFor();
 const calls=await page.evaluate(()=>window.calls);
 assert.deepEqual(calls.find(c=>c.method==='POST').body,{email:'synthetic@example.test',kind:'family'});
 assert(calls.some(c=>c.url==='/api/v1/platform-invitations?v=2'));
 await page.getByRole('button',{name:'Revoke invitation'}).click();
 await page.getByText('Revoked',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:'Revoke invitation'}).count(),0);
 console.log('Invitation label, consent, pending receipt and revocation browser checks passed.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
