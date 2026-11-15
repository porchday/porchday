import {expect,it} from 'vitest';
import {build} from 'esbuild';
import {chromium,webkit,type Page} from 'playwright';
import {mkdir} from 'node:fs/promises';

const origin='http://localhost:43201';
async function bundle(){
 return (await build({stdin:{contents:`
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
 import {RecoveryManager} from './apps/web/src/RecoveryManager';
 import {generateDeviceKeys,unlockPrivateKey} from './packages/crypto/src/index';
 const id='11111111-1111-4111-8111-111111111111',deviceId='22222222-2222-4222-8222-222222222222';
 const keys=await generateDeviceKeys(id,deviceId),recovery=await generateDeviceKeys(id,'recovery',keys.recoverySecret);
 const device={id:deviceId,member_id:id,public_key:keys.publicKey,fingerprint:keys.fingerprint,revoked_at:null};
 window.fixture={secret:keys.recoverySecret,device,backup:{v:1,devices:[{...device,encrypted_private_key:keys.encryptedPrivateKey}],recovery:{public_key:recovery.publicKey,fingerprint:recovery.fingerprint,encrypted_private_key:recovery.encryptedPrivateKey}}};
 const actor={member:{id,handle:'synthetic',status:'active'},device,privateKey:await unlockPrivateKey(keys.encryptedPrivateKey,keys.recoverySecret),keys:[]};actor.keys=[actor.privateKey];
 function App(){const[done,setDone]=useState(false);return done?<h1>Feed</h1>:<RecoveryManager actor={actor} setup={location.pathname!=='/settings'} onChanged={async()=>{const r=await(await fetch('/api/v1/key-recovery')).json();if(!r.required&&location.pathname!=='/settings')setDone(true);}}/>;}
 createRoot(document.getElementById('root')).render(<App/>);
 `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,format:'esm',write:false,define:{'process.env.NODE_ENV':'"production"'}})).outputFiles[0].text;
}
async function serve(page:Page,source:string){
 const state:any={enabled:true,required:true,check:{kit_checked_at:new Date().toISOString()},methods:[],pairInvitations:[],contacts:[],invitations:[],requests:[],responses:[],devices:[],handles:[]};
 const writes:any[]=[];
 await page.route(origin+'/**',async route=>{
  const r=route.request(),path=new URL(r.url()).pathname;
  if(path==='/module.js')return route.fulfill({contentType:'text/javascript',body:source});
  if(path==='/style.css')return route.fulfill({path:process.cwd()+'/apps/web/src/retro.css',contentType:'text/css'});
  if(path.startsWith('/api/')){
   const fixture=await page.evaluate(()=>(window as any).fixture);
   if(!state.devices.length)state.devices=[fixture.device];
   if(r.method()==='GET'&&path==='/api/v1/key-recovery')return route.fulfill({json:state});
   if(path==='/api/v1/keys/backup')return route.fulfill({json:{envelope:fixture.backup}});
   if(r.method()==='DELETE'&&path.startsWith('/api/v1/devices/')){state.devices.find((d:any)=>path.endsWith(d.id)).revoked_at=new Date().toISOString();return route.fulfill({json:{ok:true}});}
   const body=r.postDataJSON();writes.push({path,body});
   if(path.endsWith('/methods'))state.methods.push({id:body.statement.id,kind:'passkey',record:body,created_at:new Date().toISOString()});
   if(body?.statement?.action==='complete')state.required=false;
   if(body?.statement?.action==='remove')state.methods.find((m:any)=>m.id===body.statement.id).disabled_at=new Date().toISOString();
   return route.fulfill({json:{ok:true}});
  }
  return route.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><main class="wrap"><div id="root"></div></main><script type="module" src="/module.js"></script>'});
 });
 return{state,writes};
}
async function adjacent(page:Page,buttonName:string,role:'status'|'alert'){
 const button=page.getByRole('button',{name:buttonName,exact:true}),feedback=page.getByRole(role);
 await feedback.waitFor();
 await expect.poll(async()=>feedback.evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight;})).toBe(true);
 const gap=await feedback.evaluate((el,name)=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()===name)!;return el.getBoundingClientRect().top-button.getBoundingClientRect().bottom;},buttonName);
 expect(gap).toBeGreaterThanOrEqual(0);expect(gap).toBeLessThan(60);
 expect(await button.isVisible()).toBe(true);
}
it('walks through cancelled then successful passkey setup on a phone without a dead-end Finish button',async()=>{
 const browser=await chromium.launch();try{
  const page=await browser.newPage({viewport:{width:390,height:700}}),{writes}=await serve(page,await bundle()),cdp=await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',ctap2Version:'ctap2_1',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true,hasPrf:true}});
  await page.goto(origin);await page.getByRole('heading',{name:'Step 2 of 2: save a spare key'}).waitFor();
  expect(await page.getByRole('button',{name:'Continue to Porchday'}).count()).toBe(0);
  expect(await page.getByLabel('Passkey name').isVisible()).toBe(false);
  expect(await page.getByRole('heading',{name:'Trusted-contact recovery'}).count()).toBe(0);
  const secret=await page.evaluate(()=>(window as any).fixture.secret);
  await page.getByLabel('Saved encryption recovery secret').fill(secret);
  await page.evaluate(()=>{const create=navigator.credentials.create.bind(navigator.credentials);let first=true;Object.defineProperty(navigator.credentials,'create',{value:(o:any)=>{if(first){first=false;return Promise.reject(new DOMException('Cancelled','NotAllowedError'));}return create(o);}});});
  await page.getByRole('button',{name:'Create a recovery passkey',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Try again'}).waitFor();
  await adjacent(page,'Create a recovery passkey','alert');
  expect(await page.getByLabel('Saved encryption recovery secret').inputValue()).toBe(secret);
  expect(writes.filter(w=>w.path.endsWith('/methods'))).toHaveLength(0);
  await page.getByRole('button',{name:'Create a recovery passkey',exact:true}).click();
  await page.getByRole('heading',{name:'You’re ready'}).waitFor();
  await page.getByRole('button',{name:'Continue to Porchday'}).click();await page.getByRole('heading',{name:'Feed'}).waitFor();
  expect(writes.filter(w=>w.path.endsWith('/methods'))).toHaveLength(1);
  expect(JSON.stringify(writes)).not.toContain(secret);
 }finally{await browser.close();}
},60000);
it.each(['chromium','webkit'] as const)('%s keeps check-secret confirmation beside its button and offers the alternate device path',async engine=>{
 const browser=await(engine==='chromium'?chromium:webkit).launch();try{
  const page=await browser.newPage({viewport:{width:390,height:700}});await serve(page,await bundle());
  await page.goto(origin+'/settings');await page.getByLabel('Saved encryption recovery secret').waitFor();
  await page.getByLabel('Saved encryption recovery secret').fill(await page.evaluate(()=>(window as any).fixture.secret));
  await page.getByRole('button',{name:'Check saved secret',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Your saved recovery note works'}).waitFor();await adjacent(page,'Check saved secret','status');
  expect(await page.getByRole('button',{name:'Create a recovery passkey'}).isEnabled()).toBe(true);
  if(process.env.SIGNUP_SCREENSHOT_DIR){await mkdir(process.env.SIGNUP_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:process.env.SIGNUP_SCREENSHOT_DIR+'/'+engine+'-inline-feedback.png'});}
  await page.goto(origin+'/');await page.getByRole('button',{name:'Use another device instead'}).click();
  expect(await page.getByRole('button',{name:'Create a recovery passkey'}).count()).toBe(0);
  await page.getByRole('button',{name:'Show a QR code for my other device to scan'}).waitFor();
  await page.getByRole('button',{name:'Use a passkey instead'}).click();
  await page.getByRole('button',{name:'Create a recovery passkey'}).waitFor();
 }finally{await browser.close();}
},60000);
it('explains an unsupported recovery passkey beside the button and keeps the other-device option available',async()=>{
 const browser=await chromium.launch();try{
  const page=await browser.newPage({viewport:{width:390,height:700}}),{writes}=await serve(page,await bundle()),cdp=await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true,hasPrf:false}});
  await page.goto(origin);await page.getByLabel('Saved encryption recovery secret').waitFor();
  await page.getByLabel('Saved encryption recovery secret').fill(await page.evaluate(()=>(window as any).fixture.secret));
  await page.getByRole('button',{name:'Create a recovery passkey'}).click();
  await page.getByRole('alert').filter({hasText:'cannot create a spare key'}).waitFor();await adjacent(page,'Create a recovery passkey','alert');
  expect(writes.filter(w=>w.path.endsWith('/methods'))).toHaveLength(0);
  expect(await page.getByRole('button',{name:'Continue to Porchday'}).count()).toBe(0);
  await page.getByRole('button',{name:'Use another device instead'}).click();
  await page.getByRole('heading',{name:'Use another private device'}).waitFor();
 }finally{await browser.close();}
},60000);
it.each(['chromium','webkit'] as const)('%s keeps login and two-step sign-in results next to their submit buttons',async engine=>{
 const source=(await build({stdin:{contents:`
 import React from 'react';import{createRoot}from'react-dom/client';import{AuthPage}from'./apps/web/src/Public';import{MfaSettings}from'./apps/web/src/AccountSecurity';
 createRoot(document.getElementById('root')).render(location.pathname==='/login'?<AuthPage mode="login" onSignedIn={()=>{}}/>:<MfaSettings/>);
 `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,format:'esm',write:false,define:{'process.env.NODE_ENV':'"production"'}})).outputFiles[0].text;
 const browser=await(engine==='chromium'?chromium:webkit).launch();try{
  const page=await browser.newPage({viewport:{width:390,height:700}});let disableCalls=0;
  await page.route(origin+'/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path==='/module.js')return route.fulfill({contentType:'text/javascript',body:source});
   if(path==='/style.css')return route.fulfill({path:process.cwd()+'/apps/web/src/retro.css',contentType:'text/css'});
   if(path==='/api/auth/get-session')return route.fulfill({json:{user:{twoFactorEnabled:true}}});
   if(path==='/api/auth/two-factor/disable'&&++disableCalls>1)return route.fulfill({json:{ok:true}});
   if(path.startsWith('/api/'))return route.fulfill({status:400,json:{message:'Check your password and try again.'}});
   return route.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/module.js"></script>'});
  });
  await page.goto(origin+'/login');await page.getByLabel('Email address',{exact:true}).fill('synthetic@example.test');await page.getByLabel('Password',{exact:true}).fill('synthetic-password');
  await page.getByRole('button',{name:'Log in',exact:true}).click();await adjacent(page,'Log in','alert');
  expect(await page.locator('.porchday-tagline').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  await page.goto(origin+'/mfa');await page.getByLabel('Password to disable two-step sign-in').fill('synthetic-password');
  await page.getByRole('button',{name:'Disable two-step sign-in',exact:true}).click();await adjacent(page,'Disable two-step sign-in','alert');
  await page.getByRole('button',{name:'Disable two-step sign-in',exact:true}).click();
  await page.getByRole('status').filter({hasText:'turned off'}).waitFor();await adjacent(page,'Set up an authenticator','status');
 }finally{await browser.close();}
},60000);

it('shows Continue only after the server confirms both the saved note and a completed device pair',async()=>{
 const browser=await chromium.launch();try{
  const page=await browser.newPage({viewport:{width:390,height:700}}),{state}=await serve(page,await bundle());
  state.pairedDeviceReady=true;state.check=null;
  await page.goto(origin);await page.getByRole('heading',{name:'Step 2 of 2: save a spare key'}).waitFor();
  expect(await page.getByRole('button',{name:'Continue to Porchday'}).count()).toBe(0);
  state.check={kit_checked_at:new Date().toISOString()};await page.reload();
  await page.getByRole('heading',{name:'You’re ready'}).waitFor();
  await page.getByRole('button',{name:'Continue to Porchday'}).click();await page.getByRole('heading',{name:'Feed'}).waitFor();
 }finally{await browser.close();}
},60000);

it('keeps removal confirmation next to the removed method without calling it ready',async()=>{
 const browser=await chromium.launch();try{
  const page=await browser.newPage({viewport:{width:390,height:700}}),{state}=await serve(page,await bundle());
  state.devices=[{id:'22222222-2222-4222-8222-222222222222',fingerprint:'a'.repeat(64)},{id:'44444444-4444-4444-8444-444444444444',fingerprint:'b'.repeat(64)}];
  state.methods=[{id:'33333333-3333-4333-8333-333333333333',kind:'passkey',created_at:new Date().toISOString(),record:{statement:{label:'Spare key',passkey:{backupEligible:true}}}}];
  await page.goto(origin+'/settings');await page.getByText('Manage saved keys and devices',{exact:true}).click();
  page.on('dialog',d=>d.accept());await page.getByRole('button',{name:'Remove method',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Recovery method removed.'}).waitFor();await adjacent(page,'Remove method','status');
  expect(await page.getByRole('button',{name:'Remove method',exact:true}).isDisabled()).toBe(true);
  expect(await page.getByRole('button',{name:'Test passkey',exact:true}).count()).toBe(0);
  expect(await page.getByText(/Removed · Added/).count()).toBe(1);
  await page.getByRole('button',{name:'Revoke device',exact:true}).click();await page.getByRole('status').filter({hasText:'Device access revoked.'}).waitFor();await adjacent(page,'Revoke device','status');
  expect(await page.getByRole('button',{name:'Revoke device',exact:true}).isDisabled()).toBe(true);
 }finally{await browser.close();}
},60000);
