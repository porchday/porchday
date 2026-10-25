/** Browser regression against a loopback dev server; all API replies are synthetic. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';

const target=new URL(process.argv[2]||'http://127.0.0.1:5173');
if(process.argv.length>3||target.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(target.hostname)||target.username||target.password||target.pathname!=='/'||target.search||target.hash)throw Error('LOOPBACK_ORIGIN_REQUIRED');
const browser=await chromium.launch({headless:true});
try{
 for(const roles of [[],['recovery'],['moderation']] as string[][]){
  const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
  const api:string[]=[],identity={subject:'synthetic-reviewer',email:'reviewer@example.test',roles};
  let denied=false,delayDetail=false,releaseDetail:()=>void=()=>{},detailStarted:()=>void=()=>{},logoutRequested=false;
  const pending=new Promise<void>(resolve=>{releaseDetail=resolve;});
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin!==target.origin)return route.abort();
   if(url.pathname==='/cdn-cgi/access/logout'){
    logoutRequested=route.request().isNavigationRequest();
    return route.fulfill({contentType:'text/html',body:'<h1>Synthetic staff logout reached</h1>'});
   }
   if(!url.pathname.startsWith('/api/'))return route.continue();
   api.push(url.pathname);
   const json=(body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
   if(url.pathname==='/api/staff/identity')return json(identity);
   if(url.pathname==='/api/staff/recovery/cases')return denied?json({error:{code:'STAFF_ROLE_REQUIRED'}},403):json({cases:[{id:'synthetic-case',created_at:'2026-10-25T12:00:00Z',state:'submitted'}]});
   if(url.pathname==='/api/staff/recovery/cases/synthetic-case'){
    detailStarted();if(delayDetail)await pending;
    return json({id:'synthetic-case',state:'submitted',account_reference:'synthetic-private-reference',safe_email:'safe@example.test',contact_verified_at:'2026-10-25T12:00:00Z',description:'Synthetic sensitive case description'});
   }
   if(url.pathname==='/api/staff/moderation/reports')return json({items:[]});
   if(url.pathname==='/api/staff/moderation/keys')return json({items:[]});
   return json({error:{code:'AUTH_REQUIRED'}},401);
  });
  await page.goto(target.origin+'/staff');
  await page.getByText('Signed in as',{exact:false}).waitFor();
  if(!roles.length){
   await page.getByText('Your sign-in is verified.',{exact:false}).waitFor();
   assert.deepEqual(api,['/api/staff/identity']);
  }else if(roles.includes('recovery')){
   await page.getByRole('button',{name:'Account recovery case'}).click();
   await page.getByText('Synthetic sensitive case description',{exact:true}).waitFor();
   denied=true;
   await page.getByRole('button',{name:'Refresh',exact:true}).click();
   await page.getByText('Sign in through Cloudflare Access with your staff email and personal MFA device.',{exact:true}).waitFor();
   assert.equal(await page.getByText('Synthetic sensitive case description',{exact:true}).count(),0);
   assert.equal(await page.getByText('synthetic-private-reference',{exact:true}).count(),0);
   // Start a second detail load, revoke access, then let that old response arrive.
   denied=false;
   await page.getByRole('button',{name:'Check staff access',exact:true}).click();
   await page.getByRole('button',{name:'Account recovery case'}).waitFor();
   delayDetail=true;
   const started=new Promise<void>(resolve=>{detailStarted=resolve;});
   await page.getByRole('button',{name:'Account recovery case'}).click();
   await started;
   denied=true;
   await page.getByRole('button',{name:'Refresh',exact:true}).click();
   await page.getByText('Sign in through Cloudflare Access with your staff email and personal MFA device.',{exact:true}).waitFor();
   const lateResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/staff/recovery/cases/synthetic-case');
   releaseDetail();
   await (await lateResponse).finished();
   await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())));
   assert.equal(await page.getByText('Synthetic sensitive case description',{exact:true}).count(),0);
   denied=false;
   await page.getByRole('button',{name:'Check staff access',exact:true}).click();
   await page.getByRole('button',{name:'Sign out of staff access',exact:true}).click();
   await page.getByRole('heading',{name:'Synthetic staff logout reached'}).waitFor();
   assert.equal(logoutRequested,true);
  }else{
   await page.getByRole('heading',{name:'Community reports',exact:true}).waitFor();
   await page.getByRole('link',{name:'Open trusted-device staff view'}).waitFor();
   assert.equal(await page.getByRole('button',{name:'Register this device for report evidence'}).count(),0);
  }
  assert.equal(api.some(path=>path.startsWith('/api/v1/')||path.startsWith('/api/auth/')),false);
  await context.close();
 }
 console.log(JSON.stringify({staff_entry:'passed',pending_identity:true,recovery_without_member_or_vault:true,confirmed_access_loss_clears_cases:true,late_response_invalidated:true,logout_document_navigation:true,moderation_vault_explicit:true}));
}finally{await browser.close();}
