/** Bounded A-only browser archive acceptance. No user browser, staff identity, or SQL bypass. */
import {chromium,type BrowserContext,type Page,type Download,type Request as BrowserRequest} from 'playwright';
import {chmod,lstat,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {decryptArchive,decryptObject,unlockPrivateKey,type EncryptedEnvelope} from '@porchday/crypto';
import {unpackArchive,validateSet,eligibleEntries,type PortableArchive} from '../apps/web/src/archive.js';
import {check,readPrivate,writePrivate,stagingOrigin,SmokeError} from './hosted-smoke-support.js';
import {captureArchiveMedia,captureArchiveImport,type ArchiveBoundary,type ArchiveSource,type CapturedPost} from './hosted-browser-archive-support.js';

const directory='artifacts/private/hosted-smoke/',phase='browser-archive';
let stage='preflight',context:BrowserContext|undefined,page:Page|undefined,cookie='',complete=false,armed=false;
let observerFailure=false,sequence=0,attempt='',a:any,state:any,photoOnly=false;
const photoStatuses:number[]=[];
let baselineProfile='',baselineDevices='',activeDevice='';
const posts=new Map<string,CapturedPost>(),media=new Map<string,{id:string;parentId:string}>();
const imported=new Set<string>(),downloadTasks:Promise<void>[]=[];const downloads:{path:string;name:string}[]=[];
const mutations:Promise<void>[]=[];
let boundary:ArchiveBoundary|undefined,sourceParts:PortableArchive[]=[];
const progress=(next:string)=>{stage=next;console.log(JSON.stringify({phase,stage}));};
const digest=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const list=(value:any):any[]=>Array.isArray(value)?value:value?.items||value?.devices||[];
async function api(path:string,method='GET',body?:unknown,statuses=[200]){
 check(context&&path.startsWith('/api/')&&!path.includes('://'),'BROWSER_API_BOUNDARY');
 const response=await context.request.fetch(stagingOrigin+path,{method,data:body,headers:{Origin:stagingOrigin},maxRedirects:0,timeout:30000});
 check(statuses.includes(response.status()),'BROWSER_API_STATUS');
 return response.status()===204?null:await response.json();
}
async function receipt(kind:string,value:unknown){await writePrivate(directory+`browser-archive-${attempt}-${String(++sequence).padStart(3,'0')}-${kind}.json`,value,true);}
function observeCompletion(request:BrowserRequest){
 mutations.push(new Promise<void>(resolve=>{
  const finish=(failed=false)=>{if(failed)observerFailure=true;clearTimeout(timer);page!.off('requestfinished',done);page!.off('requestfailed',bad);resolve();};
  const done=(r:BrowserRequest)=>{if(r===request)finish();},bad=(r:BrowserRequest)=>{if(r===request)finish(true);};
  const timer=setTimeout(()=>finish(true),180000);page!.on('requestfinished',done);page!.on('requestfailed',bad);
 }));
}
async function opened(envelope:EncryptedEnvelope){
 check(envelope.context.authorId===a.id,'ARCHIVE_AUTHOR_REQUIRED');
 const keys=await unlockPrivateKey(a.device.keys.encryptedPrivateKey,a.device.keys.recoverySecret,a.device.keys.fingerprint);
 const result=await api('/api/v1/devices/'+envelope.context.authorDeviceId),author=result.device||result;
 check(author.member_id===a.id,'ARCHIVE_AUTHOR_DEVICE_REQUIRED');
 return decryptObject<any>({envelope,expectedContext:envelope.context,privateKey:keys,authorPublicKey:author.public_key});
}
async function knownPhoto(){
 const originalStage=stage;
 progress(originalStage+'-image');
 const image=page!.getByRole('img',{name:'Synthetic interoperability gradient',exact:true});
 await image.waitFor({state:'visible',timeout:60000});await image.scrollIntoViewIfNeeded();
 progress(originalStage+'-decode');
 const reference=await readFile(new URL('../docs/archive/sample/photos/77777777-7777-4777-8777-777777777777.jpg',import.meta.url));
 check(digest(reference)===state.interop.expectedMediaSHA256,'REFERENCE_JPEG_HASH_MISMATCH');
 const actual=await image.evaluate(async(node:HTMLImageElement,reference:number[])=>{
  try{await node.decode();}catch{return {failure:'IMAGE_DECODE_FAILED'};}
  const dimensions={width:node.naturalWidth,height:node.naturalHeight,complete:node.complete};
  if(!node.src.startsWith('blob:'))return {...dimensions,failure:'IMAGE_NOT_LOCAL_BLOB'};
  // connect-src intentionally excludes blob fetches. Compare rendered pixels
  // without weakening CSP, then verify original JPEG bytes in the export.
  let bitmap:ImageBitmap|undefined;
  try{
   bitmap=await createImageBitmap(new Blob([new Uint8Array(reference)],{type:'image/jpeg'}));
   const actualCanvas=document.createElement('canvas'),referenceCanvas=document.createElement('canvas');
   actualCanvas.width=referenceCanvas.width=16;actualCanvas.height=referenceCanvas.height=16;
   const actualContext=actualCanvas.getContext('2d')!,referenceContext=referenceCanvas.getContext('2d')!;
   actualContext.drawImage(node,0,0);referenceContext.drawImage(bitmap,0,0);
   const actualPixels=actualContext.getImageData(0,0,16,16).data,referencePixels=referenceContext.getImageData(0,0,16,16).data;
   const equal=actualPixels.length===referencePixels.length&&actualPixels.every((v,i)=>v===referencePixels[i]);
   return {...dimensions,referenceWidth:bitmap.width,referenceHeight:bitmap.height,pixelsEqual:equal,failure:null};
  }catch{return {...dimensions,failure:'PIXEL_COMPARISON_FAILED'};}
  finally{bitmap?.close();}
 },Array.from(reference));
 if(actual.failure){await receipt('photo-operation',{...actual,photoStatuses});check(false,actual.failure);}
 progress(originalStage+'-pixels');
 check('pixelsEqual'in actual&&actual.width===16&&actual.height===16&&actual.referenceWidth===16&&actual.referenceHeight===16&&actual.pixelsEqual,'BROWSER_PHOTO_PIXELS_MISMATCH');
}
async function saveDownload(download:Download){
 check(downloads.length<4,'ARCHIVE_DOWNLOAD_CAP');
 const name=download.suggestedFilename();check(/^porchday-[a-f0-9]{8}-part-\d{3}\.zip\.pgp$/.test(name),'PROTECTED_ARCHIVE_FILENAME_REQUIRED');
 const path=directory+`browser-archive-${attempt}-${name}`;downloads.push({path,name});
 await download.saveAs(path);await chmod(path,0o600);
 const stat=await lstat(path);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=31*1024*1024,'ARCHIVE_DOWNLOAD_SIZE');
 check(await download.failure()===null,'ARCHIVE_DOWNLOAD_FAILED');
}
async function cleanNewContent(){
 if(!context||!boundary)return;
 armed=false;
 for(const captured of posts.values()){
  const response=await context.request.get(stagingOrigin+'/api/v1/posts/'+captured.id,{maxRedirects:0,timeout:30000});
  if(response.status()===404)continue;
  check(response.status()===200,'ARCHIVE_CLEANUP_READ_FAILED');
  const row=await response.json(),envelope=row.post?.envelope||row.envelope;
  check(envelope?.context?.id===captured.id&&envelope.context.authorId===a.id&&envelope.context.audience==='only_me'&&
   envelope.context.authorDeviceId===activeDevice&&!boundary.originalIds.has(captured.id),'ARCHIVE_CLEANUP_OWNERSHIP');
  const payload=await opened(envelope),source=boundary.sources.get(captured.source)!;
  check(payload.provenance?.source_id===source.id&&payload.provenance?.source_member_id===a.id,'ARCHIVE_CLEANUP_PROVENANCE');
  await api('/api/v1/posts/'+captured.id,'DELETE');
 }
 for(const captured of media.values()){
  const response=await context.request.get(stagingOrigin+'/api/v1/media/'+captured.id+'/bytes',{maxRedirects:0,timeout:30000});
  check([200,404].includes(response.status()),'ARCHIVE_MEDIA_CLEANUP_READ_FAILED');
  if(response.status()===200){const e=await response.json() as EncryptedEnvelope;
   check(e.context.id===captured.id&&e.context.authorId===a.id&&e.context.authorDeviceId===activeDevice&&e.context.audience==='only_me'&&e.context.parentId===captured.parentId&&!boundary.originalIds.has(captured.id),'ARCHIVE_MEDIA_CLEANUP_OWNERSHIP');
  }
  // A pending reservation has no readable bytes. Its captured fresh ID is still
  // owned by this attempt; the ordinary endpoint enforces member ownership.
  await api('/api/v1/media/'+captured.id,'DELETE');
 }
 for(const id of posts.keys())check((await context.request.get(stagingOrigin+'/api/v1/posts/'+id,{maxRedirects:0,timeout:30000})).status()===404,'ARCHIVE_CLEANUP_POST_REMAINS');
 for(const id of media.keys())check((await context.request.get(stagingOrigin+'/api/v1/media/'+id+'/bytes',{maxRedirects:0,timeout:30000})).status()===404,'ARCHIVE_CLEANUP_MEDIA_REMAINS');
}
try{
 check((process.argv.length===4||(process.argv.length===5&&process.argv[4]==='--photo-only'))&&process.argv[2]==='--run'&&/^--attempt=[a-f0-9]{8}$/.test(process.argv[3]),'EXPLICIT_ARCHIVE_ATTEMPT_REQUIRED');
 photoOnly=process.argv[4]==='--photo-only';
 attempt=process.argv[3].slice(10);
 state=await readPrivate<any>(directory+'state.json');a=state.accounts?.[0];
 check(state.v===1&&state.synthetic===true&&state.origin===stagingOrigin&&/^[a-f0-9]{10}$/.test(state.run)&&
  a?.handle===`qa_${state.run}_0`&&!a.deleted&&a.device?.enrolled&&a.password?.length>=32&&a.device.keys.recoverySecret&&
  state.accounts[2]?.deleted===true,'SYNTHETIC_A_ONLY_REQUIRED');
 check(state.interop&&Date.parse(state.interop.expiresAt)>Date.now()+10*60000,'LIVE_ARCHIVE_PHOTO_FIXTURE_REQUIRED');
 const health=await fetch(stagingOrigin+'/health',{redirect:'error',signal:AbortSignal.timeout(30000)}),release=await health.json() as any;
 check(health.ok&&release.status==='ok'&&release.environment==='staging','STAGING_HEALTH_REQUIRED');
 await writePrivate(directory+`browser-archive-${attempt}.intent.json`,{v:1,synthetic:true,origin:stagingOrigin,member:a.id,startedAt:new Date().toISOString(),release,
  effects:photoOnly?['existing-device login and unlock','read original photo','logout']:['existing-device login and unlock','protected export download','same-account private import without profile replacement','captured-new-content deletion','logout']},true);
 const profile=resolve(directory+'isolated-browser-profile'),stat=await lstat(profile);
 check(stat.isDirectory()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0,'EXISTING_ISOLATED_PROFILE_REQUIRED');
 context=await chromium.launchPersistentContext(profile,{headless:true,viewport:{width:1280,height:900},acceptDownloads:true,serviceWorkers:'allow'});context.setDefaultTimeout(30000);
 page=context.pages()[0]||await context.newPage();
 page.on('response',response=>{const url=new URL(response.url());if(url.origin===stagingOrigin&&url.pathname==='/api/v1/media/'+state.interop.webMediaId+'/bytes'&&photoStatuses.length<8)photoStatuses.push(response.status());});
 progress('login');await page.goto(stagingOrigin+'/login');check(new URL(page.url()).origin===stagingOrigin,'LOGIN_ORIGIN_CHANGED');
 await page.getByLabel('Email address',{exact:true}).fill(a.email);await page.getByLabel('Password',{exact:true}).fill(a.password);
 await page.getByRole('button',{name:'Log in',exact:true}).click();await page.waitForURL(stagingOrigin+'/app');
 cookie=(await context.cookies(stagingOrigin)).map(c=>`${c.name}=${c.value}`).join('; ');check(cookie,'BROWSER_SESSION_REQUIRED');
 const devices=list(await api('/api/v1/devices'));baselineDevices=digest(JSON.stringify(devices.map(d=>[d.id,d.fingerprint,d.revoked_at]).sort()));
 activeDevice=await page.evaluate(id=>localStorage.getItem(`porchday-device:${id}`),a.id) as string;
 check(devices.some(d=>d.id===activeDevice&&!d.revoked_at),'EXISTING_DEVICE_REQUIRED');
 baselineProfile=digest(JSON.stringify((await api('/api/v1/me')).envelope));
 await page.getByRole('heading',{name:'Unlock this device',exact:true}).waitFor();
 await page.getByLabel('Encryption recovery secret',{exact:true}).fill(a.device.keys.recoverySecret);
 await page.getByRole('checkbox',{name:/Remember this private device/}).check();await page.getByRole('button',{name:'Unlock'}).click();
 await page.getByText('FROM YOUR PEOPLE',{exact:true}).waitFor({timeout:90000});
 check(baselineDevices===digest(JSON.stringify(list(await api('/api/v1/devices')).map(d=>[d.id,d.fingerprint,d.revoked_at]).sort())),'ARCHIVE_ENROLLED_EXTRA_DEVICE');
 progress('original-photo');await page.goto(stagingOrigin+'/app/post/'+state.interop.webPostId);
 progress('original-photo-text');await page.getByText(state.interop.expectedPostText,{exact:true}).waitFor({timeout:60000});await knownPhoto();
 if(photoOnly){complete=true;await receipt('photo-result',{v:1,checkedAt:new Date().toISOString(),originalPhotoDecoded:true,referenceJPEGHashVerified:true,pixelsVerified:true,photoStatuses});progress('photo-only-passed');}
 else{
 progress('protected-export');await page.goto(stagingOrigin+'/app/settings/data');
 await page.getByRole('heading',{name:'Export your data',exact:true}).waitFor();
 check(!await page.getByRole('checkbox',{name:/Download readable, unencrypted ZIP/}).isChecked(),'DEFAULT_EXPORT_NOT_PROTECTED');
 page.on('download',d=>{const task=saveDownload(d).catch(()=>{observerFailure=true;});downloadTasks.push(task);});
 const firstDownload=page.waitForEvent('download',{timeout:120000}).catch(()=>null);
 await page.getByRole('button',{name:'Export my data',exact:true}).click();
 await page.locator('.transfer-progress').filter({hasText:'Your archive is complete:'}).waitFor({timeout:120000});
 check(await firstDownload,'ARCHIVE_DOWNLOAD_EVENT_MISSING');
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(b=>b.textContent?.trim()==='Export my data'&&!b.disabled));
 await Promise.all(downloadTasks);check(!observerFailure&&downloads.length>0,'ARCHIVE_DOWNLOAD_NOT_CONFIRMED');
 const secret=(await page.locator('code.secret-box').textContent())?.trim();check(secret&&secret!==a.device.keys.recoverySecret,'SEPARATE_ARCHIVE_SECRET_REQUIRED');
 const allFiles=new Map<string,Uint8Array>();
 for(const download of downloads){const encrypted=new Uint8Array(await readFile(download.path));
  check(encrypted[0]!==0x50||encrypted[1]!==0x4b,'ARCHIVE_WAS_PLAINTEXT_ZIP');
  const parsed=unpackArchive(await decryptArchive(encrypted,secret));sourceParts.push(parsed.archive);
  for(const [path,bytes]of Object.entries(parsed.files))if(path.startsWith('photos/')){check(!allFiles.has(path),'ARCHIVE_DUPLICATE_PHOTO');allFiles.set(path,bytes);}
 }
 validateSet(sourceParts);check(sourceParts.every(p=>p.member_id===a.id&&p.handle===a.handle),'ARCHIVE_SOURCE_ACCOUNT_MISMATCH');
 const entries=eligibleEntries(sourceParts),photos=sourceParts.flatMap(p=>p.media);
 check(entries.length>0&&entries.length<=80&&photos.length<=32,'SYNTHETIC_ARCHIVE_BOUND');
 for(const photo of photos)check(digest(allFiles.get(photo.path)!)===photo.sha256,'EXPORTED_PHOTO_HASH_MISMATCH');
 const original=entries.find(e=>e.id===state.interop.webPostId&&e.journal_kind==='post');
 check(original?.payload.text===state.interop.expectedPostText,'EXPORTED_HISTORY_MISSING');
 const originalPhoto=photos.find(p=>p.id===state.interop.webMediaId);
 check(originalPhoto&&originalPhoto.sha256===state.interop.expectedMediaSHA256,'EXPORTED_KNOWN_PHOTO_MISSING');
 const originalIds=new Set<string>([...entries.map(e=>e.id),...photos.map(p=>p.id),a.id]);
 const sources=new Map<string,ArchiveSource>(entries.map(e=>[`${a.id}:${e.journal_kind}:${e.id}`,{id:e.id,journal_kind:e.journal_kind,created_at:e.created_at,expires_at:e.expires_at||null}]));
 const referenced=new Set(entries.flatMap(e=>(e.payload.media||[]).map((m:any)=>m.id)));
 for(const part of sourceParts)for(const slot of ['avatar','cover','background'])if(part.profile?.[slot])referenced.add(part.profile[slot].id);
 for(const photo of photos)if(!referenced.has(photo.id)&&(!photo.expires_at||Date.parse(photo.expires_at)>Date.now()))
  sources.set(`${a.id}:photo:${photo.id}`,{id:photo.id,journal_kind:'photo',created_at:photo.created_at||sourceParts[0].generated_at,expires_at:photo.expires_at||null});
 boundary={member:a.id,device:activeDevice,originalIds,sources,media:new Map(),posts:new Set()};
 await receipt('export',{v:1,archiveParts:downloads.map(d=>({name:d.name,path:d.path})),entries:entries.length,photos:photos.length,protected:true,knownTextVerified:true,knownPhotoHashVerified:true,originalIds:[...originalIds],profileSHA256:baselineProfile,deviceSHA256:baselineDevices});
 await context.route('**/api/v1/**',async route=>{
  const req=route.request(),url=new URL(req.url());if(!['POST','PUT','PATCH','DELETE'].includes(req.method())){await route.continue();return;}
  try{
   check(armed&&url.origin===stagingOrigin,'ARCHIVE_WRITE_NOT_ARMED');
   if(req.method()==='POST'&&url.pathname==='/api/v1/media'){
    const captured=captureArchiveMedia(req.postDataJSON(),boundary!);
    await receipt('media-intent',captured);media.set(captured.id,captured);boundary!.media.set(captured.id,captured);
   }else if(req.method()==='PUT'&&/^\/api\/v1\/media\/[a-f0-9-]{36}\/bytes$/.test(url.pathname)){
    check(media.has(url.pathname.split('/')[4]),'ARCHIVE_UPLOAD_NOT_CAPTURED');
   }else if(req.method()==='POST'&&url.pathname==='/api/v1/imports'){
    const captured=captureArchiveImport(req.postDataJSON(),boundary!);
    await receipt('import-intent',captured);for(const p of captured.posts){posts.set(p.id,p);boundary!.posts.add(p.id);}
   }else check(false,'UNEXPECTED_ARCHIVE_MUTATION');
   observeCompletion(req);await route.continue();
  }catch{observerFailure=true;await route.abort('blockedbyclient').catch(()=>{});}
 });
 page.on('response',response=>{
  if(response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/v1/imports'){
   const task=(async()=>{check(response.status()===201,'ARCHIVE_IMPORT_REJECTED');const result=await response.json();
    check(Array.isArray(result.imported)&&result.imported.every((id:string)=>posts.has(id)),'ARCHIVE_IMPORT_RECEIPT_INVALID');
    for(const id of result.imported)imported.add(id);await receipt('import-receipt',{id:result.id,imported:result.imported});
   })().catch(()=>{observerFailure=true;});downloadTasks.push(task);
  }
 });
 progress('import-preview');await page.getByLabel('Archive secret, for encrypted parts',{exact:true}).fill(secret);
 await page.getByLabel('Choose archive files',{exact:false}).setInputFiles(downloads.map(d=>d.path));
 await page.getByRole('heading',{name:'Review your import',exact:true}).waitFor({timeout:120000});
 const replace=page.getByRole('checkbox',{name:/Replace my profile with the archived profile/});if(await replace.count())await replace.uncheck();
 check(await replace.count()===0||!await replace.isChecked(),'ARCHIVE_PROFILE_REPLACEMENT_NOT_DISABLED');
 armed=true;await receipt('confirm-import',{member:a.id,replaceProfile:false,sameAccount:true,sourceCount:entries.length});
 progress('private-import');await page.getByRole('button',{name:'Import my data privately',exact:true}).click();
 await page.locator('.transfer-progress').filter({hasText:/Imported \d+ new private entries/}).waitFor({timeout:180000});
 await Promise.all([...downloadTasks,...mutations]);check(!observerFailure&&imported.size>0,'ARCHIVE_IMPORT_NOT_CONFIRMED');armed=false;
 let importedKnown:string|undefined;
 for(const id of imported){const captured=posts.get(id)!,row=await api('/api/v1/posts/'+id),e=row.post?.envelope||row.envelope;
  check(e.context.id===id&&e.context.audience==='only_me'&&e.context.authorId===a.id&&e.context.expiresAt===captured.expiresAt,'IMPORTED_ENVELOPE_MISMATCH');
  const payload=await opened(e),source=boundary.sources.get(captured.source)!;
  check(payload.provenance?.source_id===source.id&&payload.provenance?.source_member_id===a.id,'IMPORTED_PROVENANCE_MISMATCH');
  if(source.id===state.interop.webPostId){check(payload.text===state.interop.expectedPostText,'IMPORTED_TEXT_MISMATCH');importedKnown=id;}
 }
 check(importedKnown,'KNOWN_POST_NOT_IMPORTED');await page.goto(stagingOrigin+'/app/post/'+importedKnown);
 await page.getByText(state.interop.expectedPostText,{exact:true}).waitFor({timeout:60000});await knownPhoto();
 progress('scoped-cleanup');await cleanNewContent();
 check(digest(JSON.stringify((await api('/api/v1/me')).envelope))===baselineProfile,'ARCHIVE_PROFILE_CHANGED');
 check(digest(JSON.stringify(list(await api('/api/v1/devices')).map(d=>[d.id,d.fingerprint,d.revoked_at]).sort()))===baselineDevices,'ARCHIVE_DEVICE_SET_CHANGED');
 const kept=await api('/api/v1/posts/'+state.interop.webPostId);check((kept.post?.envelope||kept.envelope).context.id===state.interop.webPostId,'ORIGINAL_POST_REMOVED');
 await api('/api/v1/media/'+state.interop.webMediaId+'/bytes');
 progress('signout');await page.getByRole('button',{name:'Sign out',exact:true}).filter({visible:true}).click();await page.waitForURL(stagingOrigin+'/login');
 const revoked=await context.request.get(stagingOrigin+'/api/v1/me',{headers:{Cookie:cookie},maxRedirects:0,timeout:30000});check([401,403].includes(revoked.status()),'ARCHIVE_SESSION_STILL_LIVE');
 const session=await context.request.get(stagingOrigin+'/api/auth/get-session',{headers:{Cookie:cookie},maxRedirects:0,timeout:30000});check(session.status()===200&&!(await session.json())?.user,'ARCHIVE_AUTH_SESSION_STILL_LIVE');
 complete=true;await receipt('result',{v:1,completedAt:new Date().toISOString(),release,complete:true,sameAccount:true,originalBrowserPhotoDecoded:true,defaultProtectedExport:true,archiveParts:downloads.length,exportedEntries:entries.length,exportedPhotos:photos.length,importedEntries:imported.size,importedBrowserPhotoDecoded:true,profileUnchanged:true,devicesUnchanged:true,originalsPreserved:true,scopedApiCleanup:true,physicalObjectDeletionVerified:false,savedSessionRevoked:true});
 console.log(JSON.stringify({phase,stage:'passed',sameAccount:true,archiveParts:downloads.length,importedEntries:imported.size,photoHashesVerified:true,scopedApiCleanup:true,physicalObjectDeletionVerified:false}));
 }
}catch(error){
 const code=error instanceof SmokeError&&/^[A-Z][A-Z0-9_]{2,100}$/.test(error.message)?error.message:
  error instanceof Error&&error.name==='TimeoutError'?'BROWSER_TIMEOUT':'BROWSER_OPERATION_FAILED';
 let photoDiagnostic:unknown;
 if(page&&stage.startsWith('original-photo'))try{
  const knownErrors=[['media-unavailable','This photo is no longer available.'],['unsupported','Unsupported photo format.'],['invalid-jpeg','This photo is not a supported JPEG image.'],['dimensions','This photo has inconsistent dimensions.'],['expired','This photo expired.'],['history-key','This was shared before your device joined. Restore your recovery keys or ask the author to share it explicitly.']];
  const errors:string[]=[];for(const [label,message]of knownErrors)if(await page.getByText(message,{exact:true}).count())errors.push(label);
  photoDiagnostic={knownMediaStatuses:photoStatuses,expectedTextMatches:await page.getByText(state.interop.expectedPostText,{exact:true}).count(),photoMatches:await page.getByRole('img',{name:'Synthetic interoperability gradient',exact:true}).count(),loadingPlaceholders:await page.getByText('Opening encrypted photo…',{exact:true}).count(),knownErrors:errors};
 }catch{}
 const failure={phase,stage,error:'HOSTED_BROWSER_ARCHIVE_FAILED',code,...(photoDiagnostic?{photoDiagnostic}:{})};console.error(JSON.stringify(failure));
 if(attempt)try{await receipt('failure',{...failure,checkedAt:new Date().toISOString(),capturedPosts:posts.size,capturedMedia:media.size,imported:imported.size});}catch{}
 process.exitCode=1;
}
finally{
 armed=false;
 if(context){
  await Promise.all(mutations);
  if(!complete&&posts.size+media.size)try{await cleanNewContent();await receipt('failure-cleanup',{posts:posts.size,media:media.size,apiAbsent:true});}catch{console.error(JSON.stringify({phase,warning:'SCOPED_ARCHIVE_CLEANUP_UNCONFIRMED'}));}
  try{await context.setOffline(false);const saved=cookie||(await context.cookies(stagingOrigin)).map(c=>`${c.name}=${c.value}`).join('; ');
   await context.request.post(stagingOrigin+'/api/auth/sign-out',{headers:{Origin:stagingOrigin,Cookie:saved},data:{},maxRedirects:0,timeout:30000});
   const ended=await context.request.get(stagingOrigin+'/api/auth/get-session',{headers:{Cookie:saved},maxRedirects:0,timeout:30000});
   check(ended.status()===200&&!(await ended.json())?.user,'ARCHIVE_CLEANUP_SESSION_LIVE');
  }catch{console.error(JSON.stringify({phase,warning:'ARCHIVE_SIGNOUT_UNCONFIRMED'}));}
  try{if(page&&new URL(page.url()).origin===stagingOrigin)await page.evaluate(async()=>{
   if(!(await indexedDB.databases()).some(d=>d.name==='porchday-device-v1'))return;
   const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('porchday-device-v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(Error('Storage unavailable'));});
   try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('devices','readwrite');tx.objectStore('devices').clear();tx.oncomplete=()=>resolve();tx.onerror=()=>reject(Error('Storage cleanup failed'));});}finally{db.close();}
  });await context.clearCookies();}catch{console.error(JSON.stringify({phase,warning:'ARCHIVE_LOCAL_CLEANUP_UNCONFIRMED'}));}
  try{await context.close();}catch{console.error(JSON.stringify({phase,warning:'ARCHIVE_BROWSER_CLOSE_UNCONFIRMED'}));}
 }
 if(!complete)console.error(JSON.stringify({phase,warning:'INSPECT_PRIVATE_INTENT_BEFORE_RETRY'}));
}
