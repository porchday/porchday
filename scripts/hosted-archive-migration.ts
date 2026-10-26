/** Opt-in deployed export -> freshly provisioned local account, through both shipped browser UIs. */
import {chromium,type BrowserContext,type Page,type Download,type Request as BrowserRequest} from 'playwright';
import {readFile,lstat,mkdtemp,chmod,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {canonicalJson,createReactionSecret,decryptArchive,decryptObject,encryptObject,unlockPrivateKey,type EncryptedEnvelope,type ContentContext} from '@porchday/crypto';
import {unpackArchive,validateSet,eligibleEntries,type PortableArchive} from '../apps/web/src/archive.js';
import {createArchiveDestination} from './archive-local-environment.js';
import {captureArchiveImport,captureArchiveMedia,type ArchiveBoundary,type ArchiveSource,type CapturedPost} from './hosted-browser-archive-support.js';
import {captureDestinationProfile,assertDistinctDestination,importSourceKey,endSessionOnce} from './hosted-archive-migration-support.js';
import {check,SmokeError,readPrivate,writePrivate,stagingOrigin} from './hosted-smoke-support.js';

const root='artifacts/private/hosted-smoke/',phase='clean-destination-archive';
let stage='preflight',attempt='',sequence=0,complete=false,cleanupGood=true,localOnly=false;
let destination:Awaited<ReturnType<typeof createArchiveDestination>>|undefined,localProfile:string|undefined;
let source:BrowserContext|undefined,sourcePage:Page|undefined,target:BrowserContext|undefined,targetPage:Page|undefined;
const localStatuses:{method:string;route:string;status:number}[]=[];const localAssets:{status:number;type:string|null;kind:string}[]=[];const localPageErrors:string[]=[];
const sourceSession={ended:false};
let sourceCookie='',targetCookie='',state:any,a:any,member='',device='',targetSecret='',targetKey:any,targetPublic='',sourceKey:any;
let baselineProfile='',baselineDevices='',profilePrevious:EncryptedEnvelope|undefined,boundary:ArchiveBoundary|undefined;
let localAccountDeleted=false;
let mode:'onboarding'|'idle'|'import'='onboarding',observerFailure=false,uncertain=false,profileSubmitted=false,sourceMutated=false;
const sourceFixture={postId:randomUUID(),mediaId:randomUUID(),commentId:randomUUID(),text:'',expiresAt:'',photoExpiresAt:'',commentExpiresAt:'',createdAt:''};
const captured=new Map<string,CapturedPost>(),media=new Map<string,{id:string;parentId:string}>(),imported=new Set<string>(),tasks:Promise<void>[]=[];
const downloads:{path:string;name:string}[]=[],parts:PortableArchive[]=[],files=new Map<string,Uint8Array>();
const checksum=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const progress=(next:string)=>{stage=next;console.log(JSON.stringify({phase,stage}));};
async function bounded<T>(work:Promise<T>,ms=30000):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new SmokeError('MIGRATION_OPERATION_TIMEOUT')),ms);})]);}finally{clearTimeout(timer);}}
const list=(v:any):any[]=>Array.isArray(v)?v:v?.items||v?.devices||[];
async function receipt(kind:string,value:unknown){await writePrivate(root+`archive-migration-${attempt}-${String(++sequence).padStart(3,'0')}-${kind}.json`,value,true);}
async function call(ctx:BrowserContext,origin:string,path:string,method='GET',body?:unknown,statuses=[200]){
 check(path.startsWith('/api/')&&!path.includes('://')&&!path.includes('#'),'MIGRATION_API_BOUNDARY');
 const response=await ctx.request.fetch(origin+path,{method,data:body,headers:{Origin:origin},maxRedirects:0,timeout:30000});
 check(statuses.includes(response.status()),'MIGRATION_API_STATUS_'+response.status());
 return response.status()===204?null:await response.json();
}
const sourceAPI=(path:string,method='GET',body?:unknown,statuses=[200])=>call(source!,stagingOrigin,path,method,body,statuses);
const targetAPI=(path:string,method='GET',body?:unknown,statuses=[200])=>call(target!,destination!.origin,path,method,body,statuses);
function track(page:Page,request:BrowserRequest){tasks.push(new Promise<void>(resolve=>{
 const finish=(failed=false)=>{if(failed)uncertain=true;clearTimeout(timer);page.off('requestfinished',done);page.off('requestfailed',bad);resolve();};
 const done=(r:BrowserRequest)=>{if(r===request)finish();},bad=(r:BrowserRequest)=>{if(r===request)finish(true);};
 const timer=setTimeout(()=>finish(true),120000);page.on('requestfinished',done);page.on('requestfailed',bad);
}));}
async function login(page:Page,origin:string,email:string,password:string){
 await page.goto(origin+'/login');await page.getByLabel('Email address',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill(password);
 await page.getByRole('button',{name:'Log in',exact:true}).click();await page.waitForURL(origin+'/app');
}
async function clearKeys(page:Page,origin:string){if(new URL(page.url()).origin!==origin)await page.goto(origin+'/login');await bounded(page.evaluate(async()=>{
 if(!(await indexedDB.databases()).some(d=>d.name==='porchday-device-v1'))return;
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('porchday-device-v1');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('LOCAL_KEY_STORAGE'));});
 try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('devices','readwrite');tx.objectStore('devices').clear();tx.oncomplete=()=>resolve();tx.onerror=()=>reject(Error('LOCAL_KEY_STORAGE'));});}finally{db.close();}
}));}
async function signout(ctx:BrowserContext,page:Page,origin:string,saved:string){
 await ctx.setOffline(false);await call(ctx,origin,'/api/auth/sign-out','POST',{});
 const response=await ctx.request.get(origin+'/api/auth/get-session',{headers:{Cookie:saved},maxRedirects:0,timeout:30000});
 check(response.status()===200&&!(await response.json())?.user,'MIGRATION_SESSION_NOT_REVOKED');await clearKeys(page,origin);await ctx.clearCookies();
}
async function openDestination(e:EncryptedEnvelope){return decryptObject<any>({envelope:e,expectedContext:e.context,privateKey:targetKey,authorPublicKey:targetPublic});}
async function cleanupSource(){
 if(!source||!sourceMutated)return;
 // These two fresh IDs were durably recorded before their first request. The
 // normal endpoints enforce ownership; no SQL delete or outbox completion.
 await sourceAPI('/api/v1/posts/'+sourceFixture.postId,'DELETE',undefined,[200,404]);
 await sourceAPI('/api/v1/media/'+sourceFixture.mediaId,'DELETE');
 for(const path of ['/api/v1/posts/'+sourceFixture.postId,'/api/v1/media/'+sourceFixture.mediaId+'/bytes'])
  check((await source!.request.get(stagingOrigin+path,{maxRedirects:0,timeout:30000})).status()===404,'SOURCE_FIXTURE_STILL_READABLE');
 check(checksum(canonicalJson((await sourceAPI('/api/v1/me')).envelope))===baselineProfile,'SOURCE_PROFILE_CHANGED');
 check(checksum(canonicalJson(list(await sourceAPI('/api/v1/devices')).map(d=>[d.id,d.fingerprint,d.revoked_at]).sort()))===baselineDevices,'SOURCE_DEVICES_CHANGED');
 await receipt('source-cleanup',{postId:sourceFixture.postId,mediaId:sourceFixture.mediaId,memberId:a.id,apiAbsent:true,profileUnchanged:true,devicesUnchanged:true,at:new Date().toISOString(),physicalR2Verified:false});sourceMutated=false;
}
async function saveDownload(download:Download){
 const name=download.suggestedFilename();check(downloads.length<4&&/^porchday-[a-f0-9]{8}-part-\d{3}\.zip\.pgp$/.test(name),'PROTECTED_PART_REQUIRED');
 const path=root+`archive-migration-${attempt}-${name}`;downloads.push({path,name});await download.saveAs(path);await chmod(path,0o600);
 const stat=await lstat(path);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=31*1024*1024&&await download.failure()===null,'PROTECTED_DOWNLOAD_FAILED');
}
try{
 check(process.argv[2]==='--run'&&/^--attempt=[a-f0-9]{8}$/.test(process.argv[3]||'')&&
  (process.argv.length===4||process.argv.length===5&&process.argv[4]==='--local-only'),'EXPLICIT_MIGRATION_ATTEMPT_REQUIRED');
 attempt=process.argv[3].slice(10);localOnly=process.argv[4]==='--local-only';
 await writePrivate(root+`archive-migration-${attempt}.intent.json`,{v:1,synthetic:true,startedAt:new Date().toISOString(),localOnly,effects:['new isolated local database/runtime/account/keys','normal local email capture',...localOnly?[]:['one new A-owned timed fixture','default protected browser export','different-account private browser import including profile','ordinary source fixture deletion'],'normal local account deletion and teardown']},true);
 progress('local-destination');destination=await createArchiveDestination(attempt);
 localProfile=await mkdtemp(join(tmpdir(),'porchday-archive-browser-'+attempt+'-'));await chmod(localProfile,0o700);
 target=await chromium.launchPersistentContext(localProfile,{headless:true,viewport:{width:1280,height:900},acceptDownloads:true,serviceWorkers:'block'});target.setDefaultTimeout(30000);targetPage=target.pages()[0]||await target.newPage();targetPage.on('pageerror',e=>{localPageErrors.push(['TypeError','ReferenceError','SyntaxError','Error'].includes(e.name)?e.name:'OTHER');});targetPage.on('response',r=>{const url=new URL(r.url());if(!url.pathname.startsWith('/api/')&&localAssets.length<30)localAssets.push({status:r.status(),type:r.headers()['content-type']||null,kind:r.request().resourceType()});if(url.origin===destination!.origin&&url.pathname.startsWith('/api/')&&localStatuses.length<50)localStatuses.push({method:r.request().method(),route:url.pathname.replace(/[a-f0-9-]{36}/g,':id'),status:r.status()});});
 await target.route('**/api/**',async route=>{const r=route.request(),url=new URL(r.url());if(!['POST','PUT','DELETE','PATCH'].includes(r.method()))return route.continue();
  try{check(url.origin===destination!.origin,'DESTINATION_ORIGIN_CHANGED');const path=url.pathname,b=r.method()==='DELETE'?undefined:r.postDataJSON();
   if(path==='/api/auth/sign-out'&&r.method()==='POST'){}
   else if(mode==='onboarding'){
    if(path==='/api/auth/sign-up/email')check(b.email===destination!.email&&b.password===destination!.password&&b.handle===destination!.handle&&b.inviteCode===destination!.invite&&b.adult===true&&b.acceptedRules===true,'LOCAL_SIGNUP_BOUNDARY');
    else if(path==='/api/auth/sign-in/email')check(b.email===destination!.email&&b.password===destination!.password,'LOCAL_LOGIN_BOUNDARY');
    else if(path==='/api/v1/devices')check(!device&&b.authorization?.type==='initial'&&b.backup?.devices?.length===1,'LOCAL_INITIAL_ENROLLMENT_ONLY');
    else if(path==='/api/v1/profiles/me')check(member&&b.envelope?.context?.id===member&&b.envelope.context.kind==='profile'&&b.envelope.context.revision===1&&b.envelope.recipients.every((x:any)=>x.memberId===member),'LOCAL_INITIAL_PROFILE_ONLY');
    else check(false,'UNEXPECTED_LOCAL_ONBOARDING_MUTATION');
   }else{
    check(mode==='import'&&boundary,'DESTINATION_IMPORT_NOT_ARMED');
    if(r.method()==='POST'&&path==='/api/v1/media'){const item=captureArchiveMedia(b,boundary);check(media.size<16,'MIGRATION_PHOTO_CAP');await receipt('local-media-intent',item);media.set(item.id,item);boundary.media.set(item.id,item);}
    else if(r.method()==='PUT'&&/^\/api\/v1\/media\/[a-f0-9-]{36}\/bytes$/.test(path)){check(media.has(path.split('/')[4]),'DESTINATION_UPLOAD_NOT_CAPTURED');}
    else if(r.method()==='POST'&&path==='/api/v1/imports'){
     if(b.profile){check(!profileSubmitted,'PROFILE_IMPORT_ALREADY_SUBMITTED');captureDestinationProfile(b,boundary,profilePrevious!);profileSubmitted=true;await receipt('profile-import-intent',{job:b.id,member,revision:b.profile.envelope.context.revision});}
     else{const batch=captureArchiveImport(b,boundary);check(captured.size+batch.posts.length<=40,'MIGRATION_ENTRY_CAP');await receipt('local-import-intent',batch);for(const p of batch.posts){captured.set(p.id,p);boundary.posts.add(p.id);}}
    }else if(r.method()==='PUT'&&/^\/api\/v1\/media\/[a-f0-9-]{36}\/attachment$/.test(path))check(media.get(path.split('/')[4])?.parentId===member&&b.kind==='profile'&&b.target_id===member&&['avatar','cover','background'].includes(b.slot),'DESTINATION_PROFILE_ATTACHMENT_BOUNDARY');
    else check(false,'UNEXPECTED_DESTINATION_MUTATION');
   }
   track(targetPage!,r);await route.continue();
  }catch{observerFailure=true;await route.abort('blockedbyclient').catch(()=>{});}
 });
 targetPage.on('response',response=>{if(response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/v1/imports')tasks.push((async()=>{
  check(response.status()===201,'DESTINATION_IMPORT_REJECTED');const value=await response.json();check(Array.isArray(value.imported)&&value.imported.every((id:string)=>captured.has(id)),'DESTINATION_IMPORT_RECEIPT_INVALID');for(const id of value.imported)imported.add(id);
 })().catch(()=>{observerFailure=true;}));});
 progress('local-signup');await targetPage.goto(destination.origin+'/join');
 progress('local-signup-fields');await targetPage.getByLabel('Email address',{exact:true}).fill(destination.email);await targetPage.getByLabel(/^Your handle/).fill(destination.handle);
 await targetPage.getByLabel('Invitation code',{exact:true}).fill(destination.invite);await targetPage.getByLabel(/^Password/).fill(destination.password);
 await targetPage.getByRole('checkbox',{name:'I am at least 18 years old.',exact:true}).check();await targetPage.getByRole('checkbox',{name:/I agree to the/}).check();
 progress('local-signup-submit');await targetPage.getByRole('button',{name:'Create my account',exact:true}).click();progress('local-signup-result');await targetPage.getByRole('heading',{name:'Check your email.',exact:true}).waitFor({timeout:60000});
 progress('local-verification');const verification=await destination.verification();await targetPage.goto(verification);check(new URL(targetPage.url()).origin===destination.origin,'LOCAL_VERIFICATION_REDIRECTED');
 await login(targetPage,destination.origin,destination.email,destination.password);targetCookie=(await target.cookies(destination.origin)).map(c=>`${c.name}=${c.value}`).join('; ');
 const me=await targetAPI('/api/v1/me');member=me.id;check(me.handle===destination.handle&&me.status==='active'&&me.connection_count===0,'FRESH_DESTINATION_REQUIRED');
 progress('local-key-setup');await targetPage.getByRole('button',{name:'Create my private keys',exact:false}).click();await targetPage.getByRole('heading',{name:'Save your recovery secret',exact:true}).waitFor();
 targetSecret=(await targetPage.locator('.secret-box code').textContent())!.trim();check(targetSecret.length>20,'DESTINATION_SECRET_REQUIRED');
 await targetPage.getByRole('checkbox',{name:/I saved my secret/}).check();await targetPage.getByRole('checkbox',{name:/Remember keys on this private device/}).check();await targetPage.getByRole('button',{name:'Continue',exact:true}).click();
 await targetPage.locator('.feed-heading').getByText('Posts',{exact:true}).waitFor({timeout:90000});await Promise.all(tasks);check(!observerFailure&&!uncertain,'LOCAL_ONBOARDING_UNCONFIRMED');
 const devices=list(await targetAPI('/api/v1/devices'));check(devices.length===1,'FRESH_DESTINATION_DEVICE_REQUIRED');device=devices[0].id;targetPublic=devices[0].public_key;
 const backup=await targetAPI('/api/v1/keys/backup');const key=(backup.envelope||backup).devices.find((d:any)=>d.id===device);targetKey=await unlockPrivateKey(key.encrypted_private_key,targetSecret,key.fingerprint);
 profilePrevious=(await targetAPI('/api/v1/me')).envelope;check(profilePrevious?.context.revision===1,'LOCAL_INITIAL_PROFILE_NOT_SAVED');mode='idle';
 await receipt('local-ready',{member,device,fingerprint:devices[0].fingerprint,database:destination.name,migrations:destination.migrations,normalSignup:true,capturedVerification:true,normalKeyEnrollment:true,at:new Date().toISOString()});
 if(!localOnly){
  state=await readPrivate<any>(root+'state.json');a=state.accounts?.[0];check(state.v===1&&state.synthetic===true&&state.origin===stagingOrigin&&a?.handle===`qa_${state.run}_0`&&!a.deleted&&a.device?.enrolled&&state.accounts[2]?.deleted===true,'SYNTHETIC_SOURCE_A_REQUIRED');
  assertDistinctDestination(a,{id:member,fingerprint:devices[0].fingerprint});
  const sourceProfile=resolve(root+'isolated-browser-profile'),st=await lstat(sourceProfile);check(st.isDirectory()&&!st.isSymbolicLink()&&(st.mode&0o077)===0,'EXISTING_SOURCE_PROFILE_REQUIRED');
  source=await chromium.launchPersistentContext(sourceProfile,{headless:true,viewport:{width:1280,height:900},acceptDownloads:true,serviceWorkers:'block'});source.setDefaultTimeout(30000);sourcePage=source.pages()[0]||await source.newPage();
  await source.route('**/api/**',async route=>{const request=route.request(),url=new URL(request.url());if(['GET','HEAD','OPTIONS'].includes(request.method()))return route.continue();
   const path=url.pathname;try{check(url.origin===stagingOrigin&&(request.method()==='POST'&&['/api/auth/sign-in/email','/api/auth/sign-out','/api/v1/exports'].includes(path)||
    request.method()==='POST'&&/^\/api\/v1\/exports\/[a-f0-9-]{36}\/validate$/.test(path)||request.method()==='DELETE'&&/^\/api\/v1\/exports\/[a-f0-9-]{36}$/.test(path)),'UNEXPECTED_SOURCE_BROWSER_MUTATION');track(sourcePage!,request);await route.continue();}catch{observerFailure=true;await route.abort('blockedbyclient').catch(()=>{});}
  });
  progress('source-unlock');await login(sourcePage,stagingOrigin,a.email,a.password);sourceCookie=(await source.cookies(stagingOrigin)).map(c=>`${c.name}=${c.value}`).join('; ');
  const sourceDevices=list(await sourceAPI('/api/v1/devices'));baselineDevices=checksum(canonicalJson(sourceDevices.map(d=>[d.id,d.fingerprint,d.revoked_at]).sort()));baselineProfile=checksum(canonicalJson((await sourceAPI('/api/v1/me')).envelope));
  await sourcePage.getByRole('heading',{name:'Unlock this device',exact:true}).waitFor();await sourcePage.getByLabel('Encryption recovery secret',{exact:true}).fill(a.device.keys.recoverySecret);await sourcePage.getByRole('checkbox',{name:/Remember this private device/}).check();await sourcePage.getByRole('button',{name:'Unlock',exact:false}).click();await sourcePage.locator('.feed-heading').getByText('Posts',{exact:true}).waitFor({timeout:90000});
  sourceKey=await unlockPrivateKey(a.device.keys.encryptedPrivateKey,a.device.keys.recoverySecret);
  const health=await fetch(stagingOrigin+'/health',{redirect:'error',signal:AbortSignal.timeout(30000)}),release=await health.json() as any;check(health.ok&&release.environment==='staging','STAGING_HEALTH_REQUIRED');
  progress('source-fixture');sourceFixture.text='Synthetic clean destination migration '+attempt;sourceFixture.createdAt=new Date().toISOString();sourceFixture.expiresAt=new Date(Date.now()+60*60000).toISOString();sourceFixture.photoExpiresAt=new Date(Date.now()+45*60000).toISOString();sourceFixture.commentExpiresAt=new Date(Date.now()+120000).toISOString();
  const jpeg=await readFile(resolve('docs/archive/sample/photos/77777777-7777-4777-8777-777777777777.jpg')),photoSHA256=checksum(jpeg);
  await receipt('source-fixture-intent',{...sourceFixture,memberId:a.id,deviceId:a.device.id,photoSHA256,release,createdAt:new Date().toISOString()});
  async function seal(payload:unknown,context:Partial<ContentContext>,postId?:string){const audience=await sourceAPI('/api/v1/audiences?'+new URLSearchParams({audience:'only_me',...postId?{post_id:postId}:{}}));check(!audience.pending_members?.length,'SOURCE_AUDIENCE_NOT_READY');return encryptObject({payload,signingKey:sourceKey,context:{id:randomUUID(),kind:'post',authorId:a.id,authorDeviceId:a.device.id,audience:'only_me',parentId:null,groupId:null,epoch:audience.epoch,revision:1,createdAt:sourceFixture.createdAt,expiresAt:sourceFixture.expiresAt,...context},recipients:audience.devices.map((d:any)=>({memberId:d.member_id,deviceId:d.id,publicKey:d.public_key}))});}
  const meta={id:sourceFixture.mediaId,mime:'image/jpeg',width:16,height:16,alt:'Synthetic clean migration sample',name:'migration.jpg'};
  const photo=await seal({...meta,bytes:jpeg.toString('base64')},{id:sourceFixture.mediaId,kind:'media',parentId:sourceFixture.postId,expiresAt:sourceFixture.photoExpiresAt}),encoded=Buffer.from(JSON.stringify(photo));sourceMutated=true;
  const reservation=await sourceAPI('/api/v1/media','POST',{id:sourceFixture.mediaId,envelope:photo,byte_size:encoded.length},[201]);check(reservation.upload_url===`/api/v1/media/${sourceFixture.mediaId}/bytes`,'SOURCE_UPLOAD_TARGET_MISMATCH');
  await call(source,stagingOrigin,reservation.upload_url,'PUT',encoded);
  const post=await seal({text:sourceFixture.text,reactionSecret:createReactionSecret(),media:[meta]},{id:sourceFixture.postId});await sourceAPI('/api/v1/posts','POST',{envelope:post,media_ids:[sourceFixture.mediaId]},[201]);
  const comment=await seal({text:'Synthetic entry that expires before import',reactionSecret:createReactionSecret()},{id:sourceFixture.commentId,kind:'comment',parentId:sourceFixture.postId,expiresAt:sourceFixture.commentExpiresAt},sourceFixture.postId);await sourceAPI(`/api/v1/posts/${sourceFixture.postId}/comments`,'POST',{envelope:comment,parent_expires_at:sourceFixture.expiresAt},[201]);
  progress('protected-export-page');await sourcePage.goto(stagingOrigin+'/app/settings/data');await sourcePage.getByRole('heading',{name:'Export your data',exact:true}).waitFor();progress('protected-export-form');check(!await sourcePage.getByRole('checkbox',{name:/Download readable, unencrypted ZIP/}).isChecked(),'PROTECTED_EXPORT_DEFAULT_REQUIRED');
  progress('protected-export-download');sourcePage.on('download',download=>tasks.push(saveDownload(download).catch(()=>{observerFailure=true;})));await sourcePage.getByRole('button',{name:'Export my data',exact:true}).click();await sourcePage.locator('.transfer-progress').filter({hasText:'Your archive is complete:'}).waitFor({timeout:120000});
  await sourcePage.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent?.trim()==='Export my data'&&!b.disabled));await Promise.all(tasks);check(downloads.length>0&&!observerFailure&&!uncertain,'PROTECTED_EXPORT_UNCONFIRMED');
  const archiveSecret=(await sourcePage.locator('code.secret-box').textContent())!.trim();check(archiveSecret&&archiveSecret!==a.device.keys.recoverySecret&&archiveSecret!==targetSecret,'SEPARATE_ARCHIVE_SECRET_REQUIRED');
  for(const download of downloads){const bytes=new Uint8Array(await readFile(download.path));check(bytes[0]!==0x50||bytes[1]!==0x4b,'PROTECTED_PART_IS_PLAINTEXT');const parsed=unpackArchive(await decryptArchive(bytes,archiveSecret));parts.push(parsed.archive);for(const[path,data]of Object.entries(parsed.files))if(path.startsWith('photos/')){check(!files.has(path),'DUPLICATE_ARCHIVE_PHOTO');files.set(path,data);}}
  validateSet(parts);check(parts.every(p=>p.member_id===a.id&&p.handle===a.handle),'SOURCE_ARCHIVE_ACCOUNT_MISMATCH');
  const allEntries=parts.flatMap(p=>[...p.posts,...p.comments,...p.reactions]),allMedia=parts.flatMap(p=>p.media),archivedProfile=parts.find(p=>p.profile)?.profile;
  check(allEntries.length<=40&&allMedia.length<=16&&archivedProfile,'BOUNDED_ARCHIVE_PROFILE_REQUIRED');check(parts.some(p=>p.comments.some(c=>c.id===sourceFixture.commentId)),'EXPIRING_COMMENT_NOT_EXPORTED');
  check(parts.some(p=>p.posts.some(p=>p.id===sourceFixture.postId&&p.payload.text===sourceFixture.text)),'SOURCE_POST_NOT_EXPORTED');
  for(const photo of allMedia)check(files.has(photo.path)&&checksum(files.get(photo.path)!)===photo.sha256,'EXPORTED_PHOTO_HASH_MISMATCH');check(allMedia.find(p=>p.id===sourceFixture.mediaId)?.sha256===photoSHA256,'SOURCE_PHOTO_NOT_EXPORTED');
  await receipt('protected-export',{parts:downloads.map(d=>({path:d.path,name:d.name})),entries:allEntries.length,photos:allMedia.length,sourceMember:a.id,destinationMember:member,profileExported:true,expiredCommentInitiallyPresent:true,photoSHA256});
  progress('waiting-for-original-comment-deadline');while(Date.now()<=Date.parse(sourceFixture.commentExpiresAt)+1000){await new Promise(r=>setTimeout(r,Math.min(20000,Date.parse(sourceFixture.commentExpiresAt)+1001-Date.now())));if(Date.now()<=Date.parse(sourceFixture.commentExpiresAt)+1000)progress('waiting-for-original-comment-deadline');}
  const entries=eligibleEntries(parts);check(!entries.some(e=>e.id===sourceFixture.commentId),'EXPIRED_COMMENT_ELIGIBLE');
  const originalEntries=new Map(entries.map(e=>[importSourceKey(a.id,e.journal_kind,e.id),e]));
  const sources=new Map<string,ArchiveSource>(entries.map(e=>[importSourceKey(a.id,e.journal_kind,e.id),{id:e.id,journal_kind:e.journal_kind,created_at:e.created_at,expires_at:e.expires_at||null}]));
  const referenced=new Set(entries.flatMap(e=>(e.payload.media||[]).map((m:any)=>m.id)));for(const slot of ['avatar','cover','background'])if(archivedProfile[slot])referenced.add(archivedProfile[slot].id);
  for(const p of allMedia)if(!referenced.has(p.id)&&(!p.expires_at||Date.parse(p.expires_at)>Date.now()))sources.set(importSourceKey(a.id,'photo',p.id),{id:p.id,journal_kind:'photo',created_at:p.created_at||parts[0].generated_at,expires_at:p.expires_at||null});
  boundary={member,device,originalIds:new Set([a.id,...allEntries.map(e=>e.id),...allMedia.map(p=>p.id)]),sources,media:new Map(),posts:new Set()};
  progress('destination-import-preview');await targetPage.goto(destination.origin+'/app/settings/data');await targetPage.getByLabel('Archive secret, for encrypted parts',{exact:true}).fill(archiveSecret);await targetPage.getByLabel('Choose archive files',{exact:false}).setInputFiles(downloads.map(d=>d.path));await targetPage.getByRole('heading',{name:'Review your import',exact:true}).waitFor({timeout:120000});
  await targetPage.getByRole('checkbox',{name:/Replace my profile with the archived profile/}).check();mode='import';await receipt('confirm-import',{source:a.id,destination:member,profileReplacement:true,eligible:entries.length,expiredCommentSkipped:true});
  progress('destination-import');await targetPage.getByRole('button',{name:'Import my data privately',exact:true}).click();await targetPage.locator('.transfer-progress').filter({hasText:/Imported \d+ new private entries/}).waitFor({timeout:180000});await Promise.all(tasks);mode='idle';check(!observerFailure&&!uncertain&&imported.size>0&&profileSubmitted,'DESTINATION_IMPORT_UNCONFIRMED');
  progress('verify-destination');
  check(imported.size===captured.size&&captured.size===sources.size&&[...sources.keys()].every(key=>[...captured.values()].some(post=>post.source===key)),'DESTINATION_IMPORT_COVERAGE_MISMATCH');
  let knownPost:string|undefined,knownMedia:string|undefined;
  for(const id of imported){const capturedPost=captured.get(id)!,row=await targetAPI('/api/v1/posts/'+id),e=(row.post?.envelope||row.envelope) as EncryptedEnvelope;const payload=await openDestination(e),entry=sources.get(capturedPost.source)!;
   check(e.context.authorId===member&&e.context.audience==='only_me'&&e.context.createdAt===capturedPost.createdAt&&e.context.expiresAt===capturedPost.expiresAt&&e.recipients.every(r=>r.memberId===member)&&payload.provenance?.source_member_id===a.id&&payload.provenance?.source_id===entry.id,'IMPORTED_FIELDS_OR_PROVENANCE_MISMATCH');
   check(payload.provenance.source_id!==sourceFixture.commentId,'EXPIRED_COMMENT_RESURRECTED');
   const original=originalEntries.get(capturedPost.source);
   if(original){for(const [field,value]of Object.entries(original.payload)){
    if(['media','reactionSecret','provenance'].includes(field)||field==='text'&&original.journal_kind==='reaction')continue;
    check(canonicalJson(payload[field])===canonicalJson(value),'IMPORTED_PAYLOAD_FIELD_MISMATCH');
   }check(canonicalJson(payload.provenance.prior_provenance)===canonicalJson(original.payload.provenance||null)&&
    payload.provenance.kind===original.journal_kind&&payload.provenance.parent_id===(original.parent_id||null)&&
    payload.provenance.original_audience===original.audience&&payload.provenance.original_group_id===original.group_id,'IMPORTED_PRIOR_PROVENANCE_MISMATCH');}
   const oldPhotos=original?.payload.media||(entry.journal_kind==='photo'?[{id:entry.id}]:[]);
   check((payload.media||[]).length===oldPhotos.length,'IMPORTED_PHOTO_COUNT_MISMATCH');
   for(let index=0;index<oldPhotos.length;index++){
    const old=allMedia.find(photo=>photo.id===oldPhotos[index].id);check(old,'IMPORTED_PHOTO_SOURCE_MISSING');
    const mediaEnvelope=await targetAPI('/api/v1/media/'+payload.media[index].id+'/bytes') as EncryptedEnvelope;
    const mediaPayload=await openDestination(mediaEnvelope),deadlines=[old.expires_at,capturedPost.expiresAt].filter(Boolean).map(value=>Date.parse(value!));
    const expectedDeadline=deadlines.length?new Date(Math.min(...deadlines)).toISOString():null;
    check(checksum(Buffer.from(mediaPayload.bytes,'base64'))===old.sha256&&mediaEnvelope.context.expiresAt===expectedDeadline,'IMPORTED_PHOTO_CHECKSUM_OR_EXPIRY_MISMATCH');
   }
   if(entry.id===sourceFixture.postId){check(payload.text===sourceFixture.text&&payload.media?.length===1,'MIGRATED_TEXT_MISMATCH');knownPost=id;knownMedia=payload.media[0].id;let sourceCouldRead=false;try{await decryptObject({envelope:e,expectedContext:e.context,privateKey:sourceKey,authorPublicKey:targetPublic});sourceCouldRead=true;}catch{}check(!sourceCouldRead,'SOURCE_KEY_DECRYPTED_DESTINATION');}
  }
  check(knownPost&&knownMedia,'KNOWN_FIXTURE_NOT_IMPORTED');const importedPhoto=await targetAPI('/api/v1/media/'+knownMedia+'/bytes') as EncryptedEnvelope,photoPayload=await openDestination(importedPhoto);check(checksum(Buffer.from(photoPayload.bytes,'base64'))===photoSHA256&&importedPhoto.context.expiresAt===sourceFixture.photoExpiresAt,'MIGRATED_PHOTO_OR_DEADLINE_MISMATCH');
  const destinationMe=await targetAPI('/api/v1/me'),destinationProfile=await openDestination(destinationMe.envelope);
  for(const[key,value]of Object.entries(archivedProfile))if(!['avatar','cover','background'].includes(key))check(canonicalJson(destinationProfile[key])===canonicalJson(value),'MIGRATED_PROFILE_FIELD_MISMATCH');
  for(const slot of ['avatar','cover','background'])if(archivedProfile[slot]){const original=allMedia.find(p=>p.id===archivedProfile[slot].id)!;const e=await targetAPI('/api/v1/media/'+destinationProfile[slot].id+'/bytes');check(checksum(Buffer.from((await openDestination(e)).bytes,'base64'))===original.sha256,'MIGRATED_PROFILE_PHOTO_MISMATCH');}
  const connections=await targetAPI('/api/v1/connections'),groups=await targetAPI('/api/v1/groups');check(connections.items.length===0&&connections.requests.length===0&&groups.items.length===0&&groups.invitations.length===0&&destinationMe.connection_count===0,'DESTINATION_RELATIONSHIPS_CREATED');
  await targetPage.goto(destination.origin+'/app/post/'+knownPost);await targetPage.getByText(sourceFixture.text,{exact:true}).waitFor();const img=targetPage.getByRole('img',{name:'Synthetic clean migration sample',exact:true});await img.waitFor({state:'attached',timeout:60000});await img.scrollIntoViewIfNeeded();check(await img.evaluate(async(img:HTMLImageElement)=>{await img.decode();return img.complete&&img.naturalWidth===16&&img.naturalHeight===16&&img.src.startsWith('blob:');}),'MIGRATED_BROWSER_PHOTO_NOT_DECODED');
  await receipt('verification',{differentAccount:true,differentKeys:true,defaultProtectedExport:true,archiveParts:parts.length,importedEntries:imported.size,profileFieldsPreserved:true,photoSHA256Verified:true,absolutePostAndPhotoDeadlinesPreserved:true,originalTimestampsAndProvenancePreserved:true,expiredCommentSkipped:true,allImportedPrivate:true,noConnectionsOrGroupsRecreated:true,sourceKeysCannotDecrypt:true,browserPhotoDecoded:true,sourceFixture:{...sourceFixture,memberId:a.id}});
  progress('source-cleanup');await cleanupSource();await endSessionOnce(sourceSession,()=>signout(source!,sourcePage!,stagingOrigin,sourceCookie));sourceCookie='';await receipt('source-session-ended',{savedSessionDenied:true,localKeysCleared:true,cookiesCleared:true,at:new Date().toISOString()});
 }else{
  progress('local-cross-document-unlock');await targetPage.goto(destination.origin+'/app/settings/data');await targetPage.getByRole('heading',{name:'Export your data',exact:true}).waitFor({timeout:60000});
 }
 progress('destination-account-deletion');await targetAPI('/api/v1/account','DELETE',{confirm:'DELETE'});check(await destination.emptyAuthIdentity(member),'LOCAL_AUTH_IDENTITY_NOT_DELETED');localAccountDeleted=true;
 check((await target.request.get(destination.origin+'/api/v1/me',{maxRedirects:0,timeout:30000})).status()===401,'LOCAL_DELETED_SESSION_NOT_DENIED');
 await receipt('destination-deleted',{member,normalAccountDeletion:true,authIdentityAbsent:true,sessionDenied:true,at:new Date().toISOString()});complete=true;
}catch(error){const code=error instanceof SmokeError&&/^[A-Z0-9_]+$/.test(error.message)?error.message:error instanceof Error&&/^LOCAL_ARCHIVE_[A-Z0-9_]+$/.test(error.message)?error.message:error instanceof Error&&error.name==='TimeoutError'?'BROWSER_TIMEOUT':'MIGRATION_OPERATION_FAILED';
 console.error(JSON.stringify({phase,stage,passed:false,code}));if(attempt)try{await receipt('failure',{stage,code,observerFailure,uncertain,sourceMutated,capturedPosts:captured.size,capturedMedia:media.size,localStatuses,localAssets,localPageErrors,at:new Date().toISOString()});}catch{}process.exitCode=1;
}finally{
 mode='idle';await Promise.all(tasks);
 if(source){try{await cleanupSource();if(sourcePage)await endSessionOnce(sourceSession,()=>signout(source!,sourcePage!,stagingOrigin,sourceCookie));}catch{cleanupGood=false;}try{await bounded(source.close());}catch{cleanupGood=false;}}
 if(target&&destination){try{if(member&&!complete){await targetAPI('/api/v1/account','DELETE',{confirm:'DELETE'});localAccountDeleted=true;}if(targetPage&&targetCookie){if(localAccountDeleted){const ended=await target.request.get(destination.origin+'/api/auth/get-session',{headers:{Cookie:targetCookie},maxRedirects:0,timeout:30000});check(ended.status()===200&&!(await ended.json())?.user,'DELETED_DESTINATION_SESSION_LIVE');await clearKeys(targetPage,destination.origin);await target.clearCookies();}else await signout(target,targetPage,destination.origin,targetCookie);}}catch{cleanupGood=false;}
  let closed=false;try{await bounded(target.close());closed=true;}catch{cleanupGood=false;}if(closed&&localProfile)try{await rm(localProfile,{recursive:true,force:false});}catch{cleanupGood=false;}
 }
 if(destination)try{await destination.cleanup();}catch{cleanupGood=false;}
 const passed=complete&&cleanupGood&&!observerFailure&&!uncertain;if(attempt)try{await receipt('result',{phase,passed,localOnly,complete,cleanupGood,observerFailure,uncertain,sourceApiCleanup:!sourceMutated,sourceSessionEnded:sourceSession.ended,physicalSourceR2Verified:false,at:new Date().toISOString()});}catch{cleanupGood=false;}
 if(passed&&cleanupGood)console.log(JSON.stringify({phase,stage:'passed',localOnly,differentAccount:!localOnly,normalDestinationSignup:true,normalDestinationDeletion:true,localResourcesRemoved:true,physicalSourceR2Verified:false}));else{console.error(JSON.stringify({phase,stage:'incomplete',cleanupGood,inspectPrivateIntentBeforeRetry:true}));process.exitCode=1;}
}
