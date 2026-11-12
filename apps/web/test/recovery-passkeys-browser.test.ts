import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {chromium} from 'playwright';
it('uses a real WebAuthn PRF credential to recover after reload and rejects a different account',async()=>{
 const bundle=await build({stdin:{contents:"export * from './apps/web/src/recovery-passkeys';",resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',write:false});
 const browser=await chromium.launch();try{
  const page=await browser.newPage(),session=await page.context().newCDPSession(page);
  await session.send('WebAuthn.enable');await session.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',ctap2Version:'ctap2_1',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true,hasPrf:true}});
  await page.route('http://localhost:43194/**',route=>route.fulfill(new URL(route.request().url()).pathname==='/module.js'?{contentType:'text/javascript',body:bundle.outputFiles[0].text}:{contentType:'text/html',body:'<script type="module">window.recovery=await import("/module.js")</script>'}));
  await page.goto('http://localhost:43194/');await page.waitForFunction(()=>!!(window as any).recovery);
  const capsule=await page.evaluate(async()=>{const r=(window as any).recovery;return r.enrollRecoveryPasskey('synthetic-member','synthetic','method-one','a'.repeat(64),'s'.repeat(43));});
  expect(capsule).toHaveProperty('capsule');expect(JSON.stringify(capsule)).not.toContain('s'.repeat(43));
  await page.reload();await page.waitForFunction(()=>!!(window as any).recovery);
  expect(await page.evaluate(async value=>(window as any).recovery.unlockRecoveryPasskey('synthetic-member','method-one',value),capsule)).toBe('s'.repeat(43));
  const wrong=await page.evaluate(async value=>{try{await(window as any).recovery.unlockRecoveryPasskey('other-member','method-one',value);return false;}catch{return true;}},capsule);expect(wrong).toBe(true);
 }finally{await browser.close();}
});
it('does not count a sign-in-only passkey as recovery',async()=>{
 const bundle=await build({stdin:{contents:"export * from './apps/web/src/recovery-passkeys';",resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',write:false});
 const browser=await chromium.launch();try{const page=await browser.newPage(),session=await page.context().newCDPSession(page);await session.send('WebAuthn.enable');await session.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true,hasPrf:false}});
 await page.route('http://localhost:43194/**',route=>route.fulfill(new URL(route.request().url()).pathname==='/module.js'?{contentType:'text/javascript',body:bundle.outputFiles[0].text}:{contentType:'text/html',body:'<script type="module">window.recovery=await import("/module.js")</script>'}));await page.goto('http://localhost:43194/');await page.waitForFunction(()=>!!(window as any).recovery);
 const error=await page.evaluate(async()=>{try{await(window as any).recovery.enrollRecoveryPasskey('synthetic-member','synthetic','method-one','a'.repeat(64),'s'.repeat(43));return '';}catch(e){return String(e);}});expect(error).toContain('cannot unlock encrypted backups');
 }finally{await browser.close();}
});
