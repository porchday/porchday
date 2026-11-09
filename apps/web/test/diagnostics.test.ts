import {expect,test,afterEach} from 'vitest';
import {build} from 'esbuild';
import {chromium,webkit,type Browser} from 'playwright';
import {safeDiagnosticError,contentRoute} from '../src/diagnostics';
let browser:Browser|undefined;
afterEach(async()=>{await browser?.close();});
test('error diagnostics omit arbitrary messages, credentials and non-app stack frames',()=>{const e=Object.assign(new Error('password=very-secret; token=abcdef'),{code:'SECRET token'});e.stack='Error: very-secret\n at https://porchday.org/assets/main-a.js:4:12\n at https://private.invalid/path?token=abc:3:1';const result=safeDiagnosticError(e);expect(JSON.stringify(result)).not.toContain('secret');expect(result.stack).toBe('/assets/main-a.js:4:12');expect(contentRoute('/settings/account')).toBe(false);expect(contentRoute('/recovery')).toBe(false);expect(contentRoute('/share')).toBe(true);});
test.each(['chromium','webkit'] as const)('%s consent, content exclusions, offline durability, account isolation and stop',async(engine)=>{
 browser=await (engine==='chromium'?chromium:webkit).launch({headless:true});const page=await browser.newPage();
 const bundle=await build({entryPoints:['apps/web/src/diagnostics.ts'],bundle:true,format:'esm',write:false});
 let uploads:any[]=[],fail=false,session=crypto.randomUUID();
 await page.route('http://127.0.0.1:43199/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/module.js')return route.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text});
  if(path==='/api/v1/diagnostics/sessions'&&route.request().method()==='POST'){const b=route.request().postDataJSON();session=crypto.randomUUID();return route.fulfill({json:{id:session,mode:b.mode,started_at:Date.now(),expires_at:Date.now()+86400000}});}
  if(path.endsWith('/events')){if(fail)return route.fulfill({status:503,body:'unavailable'});const b=route.request().postDataJSON();uploads.push(b);return route.fulfill({json:{accepted:b.events.map((e:any)=>e.id)}});}
  if(path.endsWith('/stop'))return route.fulfill({json:{ok:true}});
  if(path.startsWith('/api/'))return route.fulfill({json:{ok:true}});
  return route.fulfill({contentType:'text/html',body:`<main><p>visible caption</p><p data-diagnostic-private>private excluded</p><div hidden><p>hidden excluded</p></div><textarea data-diagnostic-input="post-draft">my draft</textarea><input type=password value="password excluded"><textarea>unmarked excluded</textarea></main><script type=module>window.d=await import('/module.js');window.detach=d.attachDiagnostics('member-a','device-a');window.ready=true;</script>`});
 });
 await page.goto('http://127.0.0.1:43199/share');await page.waitForFunction(()=>Boolean((window as any).ready));
 await page.evaluate(async()=>{const d=(window as any).d;d.captureContent();await d.flushDiagnostics();});expect(uploads).toHaveLength(0);
 await page.evaluate(async()=>{const d=(window as any).d;await d.startDiagnostics('details',false);d.captureContent();d.recordDiagnostic('operation',{stage:'photo.decrypt',outcome:'failed'});await d.flushDiagnostics();});expect(JSON.stringify(uploads)).not.toContain('visible caption');expect(JSON.stringify(uploads)).toContain('photo.decrypt');
 uploads=[];await page.evaluate(async()=>{const d=(window as any).d;await d.startDiagnostics('content',true);d.captureContent();await d.flushDiagnostics();});let captured=JSON.stringify(uploads);expect(captured).toContain('visible caption');expect(captured).toContain('my draft');expect(captured).not.toContain('password excluded');expect(captured).not.toContain('private excluded');expect(captured).not.toContain('hidden excluded');expect(captured).not.toContain('unmarked excluded');
 uploads=[];fail=true;await page.evaluate(async()=>{const d=(window as any).d;d.recordDiagnostic('operation',{stage:'offline-marker',outcome:'failed'});await d.flushDiagnostics();});expect(uploads).toHaveLength(0);
 // A new page restores consent and the persisted outbox, without enabling another account.
 await page.reload();await page.waitForFunction(()=>Boolean((window as any).ready));
 fail=false;await page.evaluate(async()=>{(window as any).detach();(window as any).detach=(window as any).d.attachDiagnostics('member-b','device-b');await (window as any).d.flushDiagnostics();});expect(uploads).toHaveLength(0);
 await page.evaluate(async()=>{(window as any).detach();(window as any).detach=(window as any).d.attachDiagnostics('member-a','device-a');await (window as any).d.flushDiagnostics();});expect(JSON.stringify(uploads)).toContain('offline-marker');
 uploads=[];await page.evaluate(async()=>{const d=(window as any).d;await d.stopDiagnostics();d.recordDiagnostic('operation',{stage:'after-stop',outcome:'failed'});await d.flushDiagnostics();});expect(uploads).toHaveLength(0);
 await page.close();
});
