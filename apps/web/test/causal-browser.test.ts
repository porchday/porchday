import {it,expect} from 'vitest';
import {build} from 'esbuild';
import {chromium,webkit} from 'playwright';
it.each(['chromium','webkit'] as const)('%s joins response → crypto → write with detailed diagnostics alone',async engine=>{
 const bundle=await build({stdin:{contents:`export * from './apps/web/src/diagnostics';export {traced} from './apps/web/src/tracing';export * from './apps/web/src/causal-links';`,resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',write:false});
 const browser=await(engine==='chromium'?chromium:webkit).launch();
 try{const page=await browser.newPage(),uploads:any[]=[],requests:string[]=[];
 await page.route('http://127.0.0.1:43198/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/module.js')return route.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text});
  if(path==='/api/v1/diagnostics/sessions')return route.fulfill({json:{id:'synthetic-session',mode:'details',started_at:Date.now(),expires_at:Date.now()+86400000}});
  if(path.endsWith('/events')){const b=route.request().postDataJSON();uploads.push(...b.events);return route.fulfill({json:{accepted:b.events.map((e:any)=>e.id)}});}
  if(path==='/api/v1/feed'){const parent=route.request().headers().traceparent;requests.push(parent);return route.fulfill({json:{envelope:{ciphertext:'synthetic-sealed'}},headers:{'X-Porchday-Trace':parent.split('-')[1],'X-Porchday-Span':'b'.repeat(16)}});}
  if(path==='/api/v1/write'){requests.push(route.request().headers().traceparent);return route.fulfill({json:{ok:true}});}
  if(path.startsWith('/api/'))return route.fulfill({json:{ok:true}});
  return route.fulfill({contentType:'text/html',body:`<script type=module>window.d=await import('/module.js');window.detach=d.attachDiagnostics('synthetic-member','synthetic-device');window.ready=true;</script>`});
 });
 await page.goto('http://127.0.0.1:43198/');await page.waitForFunction(()=>!!(window as any).ready);
 const result=await page.evaluate(async()=>{const d=(window as any).d;await d.startDiagnostics('details',false);const data=await(await fetch('/api/v1/feed')).json();const decoded=await d.traced('decrypt',async()=>({text:'private-cleartext'}),d.causeOf(data.envelope));const sealed=await d.traced('encrypt',async()=>({ciphertext:'new-sealed'}),d.causeOf(decoded));await fetch('/api/v1/write',{method:'POST',headers:d.causalRequestHeaders(sealed),body:JSON.stringify(sealed)});await d.flushDiagnostics();const cause=d.causeOf(sealed);await d.stopDiagnostics();return {cause,after:d.causeOf(sealed),performance:localStorage.getItem('porchday-performance-tracing')};});
 expect(result.performance).toBeNull();expect(result.after).toBeUndefined();expect(requests).toHaveLength(2);expect(requests[0].split('-')[1]).toBe(requests[1].split('-')[1]);
 const operations=uploads.filter(e=>e.kind==='operation');expect(operations.length).toBeGreaterThanOrEqual(2);
 const text=JSON.stringify(uploads);expect(text).toContain('decrypt');expect(text).toContain('encrypt');expect(text).not.toContain('private-cleartext');expect(text).not.toContain('synthetic-sealed');expect(text).toContain('b'.repeat(16));
 }finally{await browser.close();}
});
