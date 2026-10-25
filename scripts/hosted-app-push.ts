/** One opt-in A/B application push check. No operator credentials, SQL writes, content or key enrollment. */
import { chromium, type BrowserContext, type Page } from 'playwright';
import { mkdir, rm, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { readPrivate, writePrivate, stagingOrigin, SmokeClient } from './hosted-smoke-support.js';
import { validatePushSubscription } from '../apps/api/src/social-push.js';
import { AppPushError, ensure, bounded, explicitAttempt, assertInitialPair, mutationKind, isExpectedNotification,
  assertOutboxEvidence, uuid, type Boundary } from './hosted-app-push-support.js';

const directory = 'artifacts/private/hosted-smoke/';
let attempt = '', stage = 'preflight', sequence = 0;
let context: BrowserContext | undefined, page: Page | undefined, bClient: SmokeClient | undefined;
let boundary: Boundary | undefined, profile = '', profileCreated = false;
let aLoginStarted = false, bLoginStarted = false, changedBlock = false, requestStarted = false, subscriptionStarted = false;
let subscribed = false, passed = false, cleanupPassed = false, subscriptionBody: any, failure: string | undefined;
let mutationUnconfirmed = false;
let providerSubscriptionUnconfirmed = false;
let aCookie = '', bCookie = '', beforeA: any, beforeB: any;
const counts = new Map<string,number>();
const progress = (next: string) => { stage = next; console.log(JSON.stringify({phase:'app-web-push',stage})); };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function receipt(kind: string, value: unknown) {
  await writePrivate(directory + `app-push-${attempt}-${String(++sequence).padStart(3,'0')}-${kind}.json`,value,true);
}
async function api(who: 'A' | 'B', path: string, method = 'GET', body?: unknown) {
  ensure(context && bClient && boundary, 'CLIENTS_NOT_READY');
  if (method === 'GET') ensure(['/api/v1/me','/api/v1/blocks','/api/v1/connections','/api/v1/push/config',
    '/api/v1/push/subscriptions','/api/v1/notifications','/api/v1/devices','/api/auth/get-session'].includes(path), 'READ_BOUNDARY');
  else {
    const kind = mutationKind(who,method,path,body,boundary);
    const key = who + ':' + kind; ensure(!counts.has(key),'NO_MUTATION_RETRY'); counts.set(key,1);
    if (kind === 'register-push') {
      ensure(subscriptionBody && hash(body) === hash(subscriptionBody),'SUBSCRIPTION_BOUNDARY');
      await validatePushSubscription(body);
    }
    await receipt(kind + '-intent',{who,requestId:boundary.requestId,subscriptionId:boundary.subscriptionId ?? null});
  }
  try {
    if (who === 'B') {
      const response = await bClient.request(path,method,body);
      if (method !== 'GET' && response.status >= 500) mutationUnconfirmed = true;
      ensure(response.status === 200 || response.status === 201,'B_API_FAILED');
      return await response.json();
    }
    const response = await context.request.fetch(stagingOrigin + path,{method,headers:{Origin:stagingOrigin},
      ...(body === undefined ? {} : {data:body}),maxRedirects:0,timeout:30000});
    if (method !== 'GET' && response.status() >= 500) mutationUnconfirmed = true;
    ensure(response.status() === 200 || response.status() === 201,'A_API_FAILED');
    ensure(response.headers()['cache-control']?.includes('no-store'),'PRIVATE_RESPONSE_CACHEABLE');
    return await response.json();
  } catch(error) {
    if (method !== 'GET' && !(error instanceof AppPushError)) mutationUnconfirmed = true;
    throw error;
  }
}
async function pair(who: 'A' | 'B') {
  const me = await api(who,'/api/v1/me'), blocks = await api(who,'/api/v1/blocks'), connections = await api(who,'/api/v1/connections');
  const devices = await api(who,'/api/v1/devices');
  return {me,blocks,connections,devices, ...(who === 'A' ? {subscriptions:await api(who,'/api/v1/push/subscriptions')} : {})};
}
async function expectRevoked(cookie: string) {
  const response = await fetch(stagingOrigin + '/api/auth/get-session',{headers:{Cookie:cookie},redirect:'error',signal:AbortSignal.timeout(30000)});
  const session = await response.json() as any;
  ensure(response.ok && !session?.user,'SESSION_NOT_REVOKED');
}
async function cleanup() {
  if (boundary) boundary.cleanup = true;
  const failures: string[] = [];
  let browserClosed = !context;
  const step = async (name: string, work: () => Promise<unknown>) => {try {await work();} catch {failures.push(name);} };
  // Restore the safety boundary first even if the provider/notification observation failed.
  if (changedBlock) await step('BLOCK_RESTORE',() => api('A',`/api/v1/blocks/${boundary!.bId}`,'PUT',{}));
  if (requestStarted) await step('REQUEST_CANCEL',() => api('B',`/api/v1/connections/requests/${boundary!.requestId}/decline`,'POST',{}));
  if (subscriptionStarted) {
    await step('SUBSCRIPTION_CAPTURE',async () => {
      const rows = (await api('A','/api/v1/push/subscriptions')).items;
      ensure(rows.length <= 1 && rows.every((r:any) => r.current_session && uuid.test(r.id)),'UNEXPECTED_SUBSCRIPTION');
      if (rows.length) {
        ensure(!boundary!.subscriptionId || boundary!.subscriptionId === rows[0].id,'SUBSCRIPTION_ID_CHANGED');
        boundary!.subscriptionId = rows[0].id;
        await api('A',`/api/v1/push/subscriptions/${rows[0].id}`,'DELETE',{});
      }
    });
    await step('PREFERENCE_RESTORE',() => api('A','/api/v1/me','PATCH',{notification_preferences:{in_app:true,push:false}}));
  }
  if (beforeA && beforeB) await step('PAIR_READBACK',async () => {
    const afterA = await pair('A'), afterB = await pair('B'); assertInitialPair(afterA,afterB,boundary!.aId,boundary!.bId);
    for (const [before,after] of [[beforeA,afterA],[beforeB,afterB]]) {
      ensure(hash(before.me.envelope) === hash(after.me.envelope) && hash(before.devices) === hash(after.devices),'PROFILE_OR_DEVICES_CHANGED');
      const blockIds = (row:any) => row.blocks.items.map((r:any) => r.target).sort();
      ensure(hash(blockIds(before)) === hash(blockIds(after)) && hash(before.connections.items) === hash(after.connections.items), 'ORIGINAL_RELATIONSHIP_CHANGED');
    }
    ensure(!(await api('A','/api/v1/notifications')).items.some((n:any) => n.dedupe_key === `request:${boundary!.requestId}`),'TEST_NOTIFICATION_REMAINS');
  });
  if (page && subscribed) await step('BROWSER_UNSUBSCRIBE',async () => {
    const empty = await bounded(page!.evaluate(async () => {
      const r = await navigator.serviceWorker.ready;
      for (const notification of await r.getNotifications()) notification.close();
      const s = await r.pushManager.getSubscription(); if (s) await s.unsubscribe();
      return (await r.pushManager.getSubscription()) === null;
    }),15000,'BROWSER_UNSUBSCRIBE_TIMEOUT'); ensure(empty,'BROWSER_SUBSCRIPTION_REMAINS');
  });
  if (aLoginStarted) await step('A_LOGOUT',async () => {await api('A','/api/auth/sign-out','POST',{}); if(aCookie)await expectRevoked(aCookie);});
  if (bLoginStarted) await step('B_LOGOUT',async () => {await api('B','/api/auth/sign-out','POST',{}); if(bCookie)await expectRevoked(bCookie);});
  if (context) {
    await step('PERMISSION_CLEAR',() => bounded(context!.clearPermissions(),10000,'PERMISSION_CLEAR_TIMEOUT'));
    await step('COOKIES_CLEAR',() => bounded(context!.clearCookies(),10000,'COOKIES_CLEAR_TIMEOUT'));
    await step('BROWSER_CLOSE',async () => {await bounded(context!.close(),15000,'BROWSER_CLOSE_TIMEOUT');browserClosed=true;});
  }
  if (profileCreated) await step('PROFILE_REMOVE',async () => {
    ensure(profile === resolve(directory + `app-push-profile-${attempt}`),'PROFILE_DELETE_BOUNDARY');
    ensure(browserClosed,'BROWSER_MUST_CLOSE_BEFORE_PROFILE_REMOVAL');
    await rm(profile,{recursive:true,force:false});
  });
  if (mutationUnconfirmed) failures.push('MUTATION_OUTCOME_UNCONFIRMED');
  if (providerSubscriptionUnconfirmed) failures.push('PROVIDER_SUBSCRIPTION_OUTCOME_UNCONFIRMED');
  cleanupPassed = failures.length === 0;
  await receipt('cleanup',{complete:cleanupPassed,failures,originalBlockRestored:changedBlock && !failures.includes('BLOCK_RESTORE'),
    noFriendshipAccepted:true,noContentOrKeyWrites:true,profileRemoved:profileCreated && !failures.includes('PROFILE_REMOVE')});
}

try {
  attempt = explicitAttempt(process.argv.slice(2));
  const s = await readPrivate<any>(directory+'state.json'), a=s.accounts?.[0], b=s.accounts?.[1];
  ensure(s.v===1 && s.synthetic===true && s.origin===stagingOrigin && /^[a-f0-9]{10}$/.test(s.run) && s.accounts[2]?.deleted===true,'SYNTHETIC_STATE_REQUIRED');
  for (const [i,row] of [a,b].entries()) ensure(!row.deleted && row.handle===`qa_${s.run}_${i}` && uuid.test(row.id) && row.password?.length>=32,'SYNTHETIC_ACCOUNT_REQUIRED');
  boundary={aId:a.id,bId:b.id,aHandle:a.handle,requestId:randomUUID(),cleanup:false};
  const health=await fetch(stagingOrigin+'/health',{redirect:'error',signal:AbortSignal.timeout(30000)}), release=await health.json() as any;
  ensure(health.ok && release.status==='ok' && release.environment==='staging','STAGING_HEALTH_REQUIRED');
  await writePrivate(directory+`app-push-${attempt}.intent.json`,{v:1,synthetic:true,origin:stagingOrigin,startedAt:new Date().toISOString(),release,
    aId:a.id,bId:b.id,requestId:boundary.requestId,effects:['one A and B login','fresh Chrome actual provider subscription with deployed VAPID',
      'one A-to-B block temporarily removed','one B-to-A friend request never accepted','normal cron and actual hosted SW notification',
      'restore block, cancel request, revoke subscription, restore preferences, revoke sessions, delete test profile']},true);
  profile=resolve(directory+`app-push-profile-${attempt}`); await mkdir(profile,{mode:0o700}); profileCreated=true;
  const stat=await lstat(profile);ensure(stat.isDirectory()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0,'PRIVATE_PROFILE_REQUIRED');
  context=await chromium.launchPersistentContext(profile,{channel:'chrome',headless:true,viewport:{width:1000,height:800},acceptDownloads:false,
    serviceWorkers:'allow',ignoreDefaultArgs:['--disable-background-networking']}); context.setDefaultTimeout(30000);
  bClient=new SmokeClient(); page=context.pages()[0]||await context.newPage();
  progress('login-and-revalidate');
  await receipt('A-login-intent',{member:a.id}); aLoginStarted=true;
  const login=await context.request.post(stagingOrigin+'/api/auth/sign-in/email',{data:{email:a.email,password:a.password},headers:{Origin:stagingOrigin},maxRedirects:0,timeout:30000});
  ensure(login.status()===200,'A_LOGIN_FAILED');
  aCookie=(await bounded(context.cookies(stagingOrigin),10000,'COOKIE_READ_TIMEOUT')).map(c=>`${c.name}=${c.value}`).join('; ');
  await receipt('B-login-intent',{member:b.id}); bLoginStarted=true;
  await bClient.json('/api/auth/sign-in/email','POST',{email:b.email,password:b.password}); bCookie=bClient.cookieHeader();
  for (const [who,row] of [['A',a],['B',b]] as const) {
    const session=await api(who,'/api/auth/get-session');ensure(session?.user?.email===row.email&&session.user.emailVerified,'VERIFIED_IDENTITY_MISMATCH');
  }
  beforeA=await pair('A');beforeB=await pair('B');assertInitialPair(beforeA,beforeB,a.id,b.id);
  const config=await api('A','/api/v1/push/config');ensure(config.enabled && typeof config.public_key==='string','DEPLOYED_PUSH_NOT_CONFIGURED');
  progress('register-real-subscription'); await page.goto(stagingOrigin+'/');
  await bounded(page.evaluate(async () => {await navigator.serviceWorker.ready;}),30000,'SERVICE_WORKER_TIMEOUT');
  ensure(await bounded(page.evaluate(() => Notification.permission),10000,'PERMISSION_READ_TIMEOUT')==='default','FRESH_PERMISSION_REQUIRED');
  ensure(await bounded(page.evaluate(async () => !(await (await navigator.serviceWorker.ready).pushManager.getSubscription())),10000,'SUBSCRIPTION_READ_TIMEOUT'),'FRESH_SUBSCRIPTION_REQUIRED');
  await receipt('permission-intent',{origin:stagingOrigin}); await bounded(context.grantPermissions(['notifications'],{origin:stagingOrigin}),10000,'PERMISSION_GRANT_TIMEOUT');
  await receipt('provider-subscribe-intent',{deployedPublicKeySHA256:hash(config.public_key)}); subscribed=true;
  try {
    subscriptionBody=await bounded(page.evaluate(async key => {
      const raw=Uint8Array.from(atob(key.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
      return (await (await navigator.serviceWorker.ready).pushManager.subscribe({userVisibleOnly:true,applicationServerKey:raw})).toJSON();
    },config.public_key),45000,'PROVIDER_SUBSCRIPTION_TIMEOUT');
  } catch(error) {providerSubscriptionUnconfirmed=true;throw error;}
  await validatePushSubscription(subscriptionBody);
  ensure(new URL(subscriptionBody.endpoint).hostname==='fcm.googleapis.com','EXPECTED_PROVIDER_REQUIRED');
  subscriptionStarted=true;const registered=await api('A','/api/v1/push/subscriptions','POST',subscriptionBody);
  ensure(uuid.test(registered.id),'SUBSCRIPTION_ID_INVALID');boundary.subscriptionId=registered.id;
  const subs=(await api('A','/api/v1/push/subscriptions')).items;
  ensure(subs.length===1&&subs[0].id===registered.id&&subs[0].current_session,'SESSION_BOUND_REGISTRATION_FAILED');
  ensure((await api('A','/api/v1/me')).notification_preferences.push===true,'PUSH_OPTIN_NOT_SAVED');
  await writePrivate(directory+`app-push-${attempt}.captured.json`,{attempt,aId:a.id,bId:b.id,requestId:boundary.requestId,subscriptionId:registered.id,
    endpointSHA256:hash(subscriptionBody.endpoint)},true);
  ensure(await bounded(page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length),10000,'NOTIFICATION_READ_TIMEOUT')===0,'BASELINE_NOTIFICATION_PRESENT');
  progress('ordinary-request');changedBlock=true;await api('A',`/api/v1/blocks/${b.id}`,'DELETE',{});
  ensure(!(await api('A','/api/v1/blocks')).items.some((r:any)=>r.target===b.id),'BLOCK_REMOVAL_UNCONFIRMED');
  requestStarted=true;const request=await api('B','/api/v1/connections/requests','POST',{id:boundary.requestId,handle:a.handle,kind:'friend'});
  ensure(request.id===boundary.requestId,'REQUEST_ID_MISMATCH');
  const notifications=(await api('A','/api/v1/notifications')).items.filter((n:any)=>isExpectedNotification(n,boundary!));
  ensure(notifications.length===1,'ORDINARY_NOTIFICATION_MISSING');
  await receipt('notification-captured',{notificationId:notifications[0].id,subscriptionId:registered.id,requestId:boundary.requestId});
  progress('waiting-for-normal-cron-and-provider');
  const deadline=Date.now()+180000;let observed=false;
  while(Date.now()<deadline){
    observed=await bounded(page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).some(n=>
      n.title==='Porchday' && n.body==='You have a new update.' && n.tag==='porchday-update' && n.data?.url==='/app')),
      Math.max(1,Math.min(10000,deadline-Date.now())),'NOTIFICATION_OBSERVATION_TIMEOUT');
    if(observed)break;await wait(Math.max(1,Math.min(2500,deadline-Date.now())));
  }
  ensure(observed,'ACTUAL_SW_NOTIFICATION_NOT_OBSERVED');
  await receipt('actual-sw-notification',{observedAt:new Date().toISOString(),title:'Porchday',body:'You have a new update.',tag:'porchday-update',
    noSyntheticEvent:true,noDirectProviderSend:true});
  progress('awaiting-independent-outbox-read');
  const evidencePath=directory+`app-push-${attempt}.outbox.json`, evidenceDeadline=Date.now()+60000;let evidence:any;
  while(Date.now()<evidenceDeadline){
    try {evidence=await readPrivate(evidencePath);break;} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    await wait(2000);
  }
  assertOutboxEvidence(evidence,attempt);passed=true;
} catch(error) {failure=error instanceof AppPushError?error.message:'APP_PUSH_CHECK_FAILED';}
finally {
  const finishedStage = stage;
  if(attempt && profileCreated) {progress('cleanup');try{await cleanup();}catch{cleanupPassed=false;}}
  if(attempt) await writePrivate(directory+`app-push-${attempt}.result.json`,{attempt,complete:passed&&cleanupPassed,stage:finishedStage,
    applicationDeliveryPassed:passed,cleanupComplete:cleanupPassed,error:failure??null,finishedAt:new Date().toISOString()},true).catch(()=>{cleanupPassed=false;});
  console.log(JSON.stringify({phase:'app-web-push',result:passed&&cleanupPassed?'passed':'failed',code:failure??(cleanupPassed?'OK':'CLEANUP_UNCONFIRMED')}));
  if(!passed||!cleanupPassed)process.exitCode=1;
}
