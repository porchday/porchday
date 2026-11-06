// Synthetic browser journey: serves built assets, never contacts a hosted API.
import {readFileSync,existsSync} from 'node:fs';
import {extname,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
const dist=resolve('apps/web/dist'),mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
for(const [engine,driver] of Object.entries({chromium,webkit})){
 const browser=await driver.launch({headless:true});
 try{
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'}),page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let result=null,signups=0,resends=0;
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   assert.equal(url.origin,'https://porchday.org');
   if(url.pathname.startsWith('/api/')){
    let body={},status=200;
    if(url.pathname==='/api/auth/invitation-policy')body={accepted:true,kind:'family',history:'future',expiresAt:'2026-12-01T00:00:00Z'};
    else if(url.pathname==='/api/auth/verification-result')body={state:result};
    else if(url.pathname==='/api/auth/sign-up/email'){signups++;assert.equal(req.postDataJSON().email,'synthetic@example.test');}
    else if(url.pathname==='/api/auth/send-verification-email')resends++;
    else status=401;
    return route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
   }
   let path=dist+url.pathname;
   if(!extname(path)||!existsSync(path))path=dist+'/app-shell.html';
   await route.fulfill({contentType:mime[extname(path)]||'application/octet-stream',body:readFileSync(path)});
  });
  await page.goto('https://porchday.org/login?verified=1');
  assert.equal(await page.getByText('Enter your email and password.').count(),0);
  assert.equal(await page.getByRole('heading',{name:'Email verified',exact:true}).count(),0);
  await page.goto('https://porchday.org/join#invite=synthetic-invitation-for-browser-test');
  try { await page.getByText('Invitation ready.',{exact:false}).waitFor({timeout:10000}); } catch(error) { console.log(await page.locator('body').innerText(),errors); throw error; }
  assert.match(await page.locator('main').innerText(),/only new posts and photos after you connect/);
  await page.getByLabel('Email address',{exact:true}).fill('synthetic@example.test');
  await page.getByLabel('Your handle',{exact:true}).fill('synthetic');
  await page.getByLabel('Password',{exact:true}).fill('synthetic-only-password');
  await page.getByLabel('I am at least 18 years old.').check();
  await page.getByRole('checkbox').nth(1).check();
  await page.getByRole('button',{name:'Create my account'}).click();
  await page.getByRole('heading',{name:'Check your email.',exact:true}).waitFor();
  assert.match(await page.locator('main').innerText(),/synthetic@example.test/);
  assert.match(await page.locator('main').innerText(),/expires in 1 hour/);
  assert(await page.getByRole('button',{name:/Resend available/}).isDisabled());
  assert.equal(signups,1);assert.equal(resends,0);
  await page.getByRole('link',{name:'I’ve verified my email — log in'}).click();
  assert.equal(await page.getByLabel('Email address',{exact:true}).inputValue(),'synthetic@example.test');
  result='verified';await page.goto('https://porchday.org/login?verification=1');
  await page.getByRole('heading',{name:'Email verified',exact:true}).waitFor();
  assert.equal(await page.getByRole('link',{name:'Join Porchday'}).count(),0);
  for(const state of ['used','expired','invalid','unavailable',null]){
   result=state;await page.goto('https://porchday.org/login?verification=1');
   await page.getByRole('link',{name:'Send a new verification email'}).waitFor();
   assert.equal(await page.getByRole('heading',{name:'Email verified',exact:true}).count(),0);
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({engine,passed:true,checks:['invitation context','signup next steps','resend cooldown','remembered email','no query-only success','server-result states']}));
 }finally{await browser.close();}
}
