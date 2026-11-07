// Real browser codec/OPFS probe using synthetic media only.
import {build} from 'esbuild';import {createServer} from 'node:http';import {readFileSync} from 'node:fs';import {resolve} from 'node:path';import {chromium,webkit} from 'playwright';import assert from 'node:assert/strict';
const compiled=await build({stdin:{contents:"export * from './apps/web/src/video-prepare.ts'",resolveDir:process.cwd()},bundle:true,format:'esm',platform:'browser',write:false});
const fixture=readFileSync(process.env.VIDEO_PREPARATION_FIXTURE??'apps/web/test/fixtures/synthetic-video.mp4');
const server=createServer((req,res)=>{if(req.url==='/entry.js'){res.setHeader('Content-Type','text/javascript');res.end(compiled.outputFiles[0].contents);}else if(req.url==='/clip.mp4'){res.setHeader('Content-Type','video/mp4');res.end(fixture);}else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><body><script type="module">import * as video from "/entry.js";window.video=video;</script></body></html>');}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
try{for(const[name,driver]of Object.entries({chrome:chromium,chromium,webkit}).filter(([name])=>!process.env.VIDEO_PREPARATION_BROWSERS||process.env.VIDEO_PREPARATION_BROWSERS.split(',').includes(name))){
 const browser=await driver.launch({headless:true,...(name==='chrome'?{channel:'chrome'}:{})});try{const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.video);
 const result=await page.evaluate(async()=>{const source=new File([await(await fetch('/clip.mp4')).blob()],'clip.mp4',{type:'video/mp4'}),info=await window.video.inspectVideo(source);const abort=new AbortController();let prepared;try{prepared=await window.video.prepareLargeVideo(source,{resolution:720,start:0,end:info.duration,signal:abort.signal});return{prepared:true,info,size:prepared.blob.size,width:prepared.width,height:prepared.height,poster:prepared.poster.length};}catch(error){return{prepared:false,info,error:error.message,cause:error.cause,stack:error.stack};}finally{await prepared?.dispose();}});
 if(name==='chrome'){
  const trim=await page.evaluate(async()=>{const source=new File([await(await fetch('/clip.mp4')).blob()],'clip.mp4',{type:'video/mp4'});const prepared=await window.video.prepareLargeVideo(source,{resolution:720,start:0.1,end:0.4,signal:new AbortController().signal});try{return{size:prepared.blob.size,duration:prepared.duration};}finally{await prepared.dispose();}});
  assert(trim.size>0);assert(Math.abs(trim.duration-0.3)<0.01);console.log(JSON.stringify({browser:name,transcodeAndTrim:trim}));
 }
 console.log(JSON.stringify({browser:name,...result}));if(process.env.VIDEO_PREPARATION_REQUIRE_SUCCESS==='1')assert.equal(result.prepared,true,result.error);assert.equal(result.info.audio,true);assert(result.info.duration>0);
 // Codec availability differs by platform. Unsupported environments must give
 // explicit guidance and never silently discard the source audio.
 if(result.prepared&&result.info.duration>=30){assert(result.size<result.info.duration*400_000,'720p output exceeded its 1.8Mbps video + 128kbps audio budget');}
 if(!result.prepared)assert.match(result.error,/cannot prepare|AAC|encoder|decoder|codec|WebCodecs|OPFS|storage|supported/i);
 }finally{await browser.close();}
}}finally{await new Promise(r=>server.close(r));}
