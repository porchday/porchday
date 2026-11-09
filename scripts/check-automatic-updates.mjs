/** Synthetic public-shell update checks; no hosted accounts or private data. */
import {build} from 'esbuild';
import {chromium,webkit} from 'playwright';
import http from 'node:http';
import assert from 'node:assert/strict';
const bytes=(await build({stdin:{contents:`import{startAutomaticUpdates}from'./apps/web/src/automatic-updates';import{withPendingSave}from'./apps/web/src/pending-saves';window.reloads=0;window.start=()=>window.stop=startAutomaticUpdates({idleMs:100,checkMs:100,reload:()=>window.reloads++});window.save=()=>withPendingSave(()=>new Promise(r=>window.finish=r));`,resolveDir:process.cwd()},bundle:true,write:false,format:'iife',platform:'browser'})).outputFiles[0].contents;
const a='a'.repeat(24),b='b'.repeat(24);let published=a;
const server=http.createServer((req,res)=>{if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');return res.end(bytes);}if(req.url==='/sw.js'){res.statusCode=404;return res.end();}res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta name="porchday-build" content="${req.url==='/app-shell'?published:a}"><form><textarea></textarea><input type="text"></form><div id="root"></div><script src="/bundle.js"></script>`);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
try{for(const type of [chromium,webkit]){const browser=await type.launch();try{
for(const scenario of ['idle','draft','saved-draft','save','dialog','playback','input','offline','unchanged']){
 published=a;const context=await browser.newContext();const page=await context.newPage();await page.goto(origin);await page.waitForFunction(()=>window.start);published=scenario==='unchanged'?a:b;
 await page.evaluate(s=>{
  if(s==='draft')document.querySelector('form').setAttribute('data-unsaved-draft','true');
  if(s==='saved-draft'){document.querySelector('form').setAttribute('data-draft-saved','true');document.querySelector('textarea').value='Saved encrypted draft';}
  if(s==='dialog'){const d=document.createElement('dialog');d.open=true;document.body.append(d);}
  if(s==='playback'){const v=document.createElement('video');Object.defineProperty(v,'paused',{value:false});document.body.append(v);}
  if(s==='save')void window.save();
  if(s==='offline')Object.defineProperty(navigator,'onLine',{value:false,configurable:true});
  window.start();
  if(s==='input'){const input=document.querySelector('input');input.value='Unsubmitted profile edit';input.dispatchEvent(new Event('input',{bubbles:true}));}
 },scenario);
 if(['idle','saved-draft'].includes(scenario))await page.waitForFunction(()=>window.reloads===1);
 else{await page.waitForTimeout(400);assert.equal(await page.evaluate(()=>window.reloads),0,`${type.name()} ${scenario} must defer`);
 if(scenario!=='unchanged'){await page.evaluate(s=>{if(s==='draft')document.querySelector('form').removeAttribute('data-unsaved-draft');if(s==='dialog')document.querySelector('dialog').remove();if(s==='playback')document.querySelector('video').remove();if(s==='input')document.querySelector('form').remove();if(s==='save')window.finish();if(s==='offline')Object.defineProperty(navigator,'onLine',{value:true});},scenario);await page.waitForFunction(()=>window.reloads===1);}}
 await page.evaluate(()=>window.stop());await context.close();
}console.log(type.name()+': silent updates, saved drafts, pending saves, unsaved edits, playback, dialogs, offline and unchanged versions passed');
}finally{await browser.close();}}}finally{await new Promise(r=>server.close(r));}
