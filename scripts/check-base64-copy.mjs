/** Browser equivalence + paired CPU diagnostic; synthetic bytes, no remote I/O.
 * Results are not end-to-end, physical-device or p99 acceptance evidence. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';
const bundle=await build({stdin:{contents:"import {base64ToBytes,bytesToBase64} from './packages/crypto/src/index.ts';window.fixture={base64ToBytes,bytesToBase64};",resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'iife',platform:'browser'});
const server=createServer((req,res)=>{
 res.setHeader('Content-Type',req.url==='/fixture.js'?'text/javascript':'text/html');
 res.end(req.url==='/fixture.js'?bundle.outputFiles[0].text:'<!doctype html><script src="/fixture.js"></script>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
try {
 for(const [name,engine] of Object.entries({chromium,webkit})){
  const browser=await engine.launch({headless:true});
  try{
   const page=await browser.newPage();
   await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
   await page.goto(origin);
   const result=await page.evaluate(()=>{
    const {base64ToBytes,bytesToBase64}=window.fixture;
    const legacy=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
    const equal=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
    const cases=['','YQ','YQ==','YWI','YWI=',' YW\tJj\r\n\f','/+8=','Zh==','Zg=','A','====','YQ===','-_8=','a\u0000','é'];
    for(const value of cases){
     let before,after,be,ae;
     try{before=legacy(value)}catch(e){be=e.name}
     try{after=base64ToBytes(value)}catch(e){ae=e.name}
     if(be!==ae||(!be&&!equal(before,after)))throw Error('Acceptance mismatch');
    }
    const samples=[];
    for(const size of [1024*1024,4*1024*1024]){
     const expected=new Uint8Array(size);for(let i=0;i<size;i++)expected[i]=(i*37+11)%256;
     const value=bytesToBase64(expected);
     // Paired alternating order, one discarded warmup per size/method.
     for(let round=0;round<6;round++){
      for(const method of round%2?['current','legacy']:['legacy','current']){
       const start=performance.now(),bytes=(method==='legacy'?legacy:base64ToBytes)(value),durationMs=performance.now()-start;
       if(!equal(bytes,expected))throw Error('Byte mismatch');
       if(round)samples.push({size,method,durationMs});
      }
     }
    }
    return {equivalenceCases:cases.length,samples};
   });
   assert.equal(result.samples.length,20);
   console.log(JSON.stringify({browser:name,version:browser.version(),...result,physicalDevice:false,p99Acceptance:false}));
  } finally {await browser.close();}
 }
} finally {await new Promise(resolve=>server.close(resolve));}
