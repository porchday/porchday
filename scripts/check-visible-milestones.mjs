/** Local Chromium verification. No hosted credentials or network requests. */
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright';
const {outputFiles}=await build({entryPoints:['apps/web/src/visible-milestone.ts'],bundle:true,write:false,format:'iife',globalName:'Milestones'});
const browser=await chromium.launch({headless:true});
let checks=0;
try {
 const page=await browser.newPage({viewport:{width:600,height:400}});
 await page.route('**/*',route=>route.abort());
 async function scene(html){
  await page.goto('about:blank');await page.setContent(html);
  await page.addScriptTag({content:outputFiles[0].text});
  await page.evaluate(()=>{window.marks=0;window.valid=true;window.stop=Milestones.observeVisibleMilestone(document.querySelector('#target'),()=>window.valid,()=>window.marks++);});
 }
 async function absent(){await page.waitForTimeout(120);assert.equal(await page.evaluate(()=>window.marks),0);checks++;}
 const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
 await scene('<p id="target" style="position:absolute;top:1800px">Decrypted synthetic post</p>');
 await absent();await page.locator('#target').scrollIntoViewIfNeeded();await page.waitForFunction(()=>window.marks===1);checks++;
 await page.evaluate(()=>window.dispatchEvent(new Event('visibilitychange')));await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.marks),1);checks++;
 await scene(`<img id="target" width="100" height="100" src="${png}">`);
 await page.waitForFunction(()=>window.marks===1);assert.equal(await page.locator('#target').evaluate(img=>img.complete&&img.naturalWidth>0),true);checks++;
 await scene('<img id="target" width="100" height="100" src="data:image/png;base64,broken">');await absent();
 await scene('<p id="target" style="position:absolute;top:1800px">Expired synthetic post</p>');
 await page.evaluate(()=>window.valid=false);await page.locator('#target').scrollIntoViewIfNeeded();await absent();
 await scene('<p id="target" style="position:absolute;top:1800px">Unmounted synthetic post</p>');
 await page.evaluate(()=>{window.stop();document.querySelector('#target').remove();});await absent();
 await scene(`<div style="opacity:0"><img id="target" width="100" height="100" src="${png}"></div>`);await absent();
 await scene('<p id="target" style="position:absolute;top:1800px">Hidden tab</p>');
 await page.evaluate(()=>Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'}));
 await page.locator('#target').scrollIntoViewIfNeeded();await absent();
 await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));});
 await page.waitForFunction(()=>window.marks===1);checks++;
 console.log(JSON.stringify({checks,passed:true,browser:'Chromium',physicalPhoneEvidence:false}));
}finally{await browser.close();}
