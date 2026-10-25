/** Actual staging member API fixtures; no SQL/member bypass, no source key changes. */
import {readFile} from 'node:fs/promises';
import {setTimeout as wait} from 'node:timers/promises';
import {createHash,randomUUID} from 'node:crypto';
import {encryptObject,decryptObject,unlockPrivateKey,createReactionSecret,signStatement,type ContentContext,type EncryptedEnvelope} from '../packages/crypto/src/index.js';
import {SmokeClient,SmokeError,check,readPrivate,stagingOrigin} from './hosted-smoke-support.js';
import {readRestorePrivate,writeRestorePrivate} from './restore-private-files.js';
import {backupReaderFromEnvironment} from './r2-backup-reader.js';
import {verifyMediaBackup} from '../apps/api/src/media-backup.js';
import {R2JournalStore} from './r2-journal-store.js';
import {readJournalControl} from '../apps/api/src/privacy-journal.js';

const phase=process.argv[2],attempt=process.argv.find(arg=>arg.startsWith('--attempt='))?.slice(10);
const path=attempt?'artifacts/private/restore-ops/fixtures/'+attempt+'.json':'artifacts/private/restore-ops/fixtures.json';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Account={id:string;email:string;password:string;handle:string;deleted?:boolean;device:{id:string;enrolled:boolean;keys:{publicKey:string;encryptedPrivateKey:string;recoverySecret:string}}};
type Post={id:string;mediaId?:string;text:string;envelope?:EncryptedEnvelope};
export type RestoreFixtures={v:1;synthetic:true;origin:string;run:string;attempt?:string;memberId:string;strangerId:string;createdAt:string;expiresAt:string;prepared:boolean;afterStarted?:boolean;afterComplete?:boolean;survivor:Post;deleted:Post;timed:Post;commentId:string;timedPayload?:Record<string,unknown>;photoSHA256:string;sessionId?:string;cookie?:string;snapshotId?:string;pairedAt?:string;shortenedAt?:string;shortenedEnvelope?:EncryptedEnvelope;deletedAcknowledged?:boolean;expiryAcknowledged?:boolean};
const progress=(step:string)=>console.log(JSON.stringify({phase,step}));
try {
 check(['prepare','after-snapshot'].includes(phase)&&process.argv.includes('--run'),'RESTORE_FIXTURE_EXPLICIT_RUN_REQUIRED');
 check((attempt===undefined||/^[a-f0-9]{8}$/.test(attempt))&&process.argv.filter(arg=>arg.startsWith('--attempt=')).length<=1&&process.argv.slice(3).every(arg=>arg==='--run'||arg.startsWith('--attempt=')||phase==='after-snapshot'&&(arg.startsWith('--snapshot=')||arg==='--resume')),'RESTORE_FIXTURE_ARGUMENTS_INVALID');
 const state=await readPrivate<{v:number;synthetic:boolean;origin:string;run:string;socialPassed:boolean;accounts:Account[]}>('artifacts/private/hosted-smoke/state.json');
 check(state.v===1&&state.synthetic&&state.origin===stagingOrigin&&state.socialPassed&&/^[a-f0-9]{10}$/.test(state.run)&&state.accounts.length===3,'FINISHED_SYNTHETIC_SOCIAL_FIXTURE_REQUIRED');
 const a=state.accounts[0],stranger=state.accounts[2];
 check(!a.deleted&&uuid.test(a.id)&&uuid.test(stranger.id)&&a.device?.enrolled&&uuid.test(a.device.id)&&a.handle.startsWith('qa_'+state.run+'_')&&a.password.length>=32,'RESTORE_FIXTURE_IDENTITY_INVALID');
 const snapshot=process.argv.find(value=>value.startsWith('--snapshot='))?.slice(11);
 if(phase==='after-snapshot')check(!!snapshot&&uuid.test(snapshot),'RESTORE_FIXTURE_SNAPSHOT_ID_REQUIRED');
 if(phase==='prepare'){
  let exists=false;try{await readRestorePrivate(path);exists=true;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  check(!exists,'RESTORE_FIXTURE_ALREADY_EXISTS');
 }
 const api=new SmokeClient();await api.json('/api/auth/sign-in/email','POST',{email:a.email,password:a.password});
 const session=await api.json('/api/auth/get-session'),me=await api.json('/api/v1/me');
 check(session.user?.id===a.id&&session.user.emailVerified===true&&me.id===a.id&&me.handle===a.handle&&me.status==='active'&&typeof session.session?.id==='string','RESTORE_FIXTURE_LOGIN_MISMATCH');
 const key=await unlockPrivateKey(a.device.keys.encryptedPrivateKey,a.device.keys.recoverySecret);
 async function seal(payload:unknown,context:Partial<ContentContext>,postId?:string){
  const query=new URLSearchParams({audience:'only_me'});if(postId)query.set('post_id',postId);
  const audience=await api.json('/api/v1/audiences?'+query);
  check(!audience.pending_members?.length&&audience.devices.every((d:any)=>d.member_id===a.id)&&audience.devices.some((d:any)=>d.id===a.device.id&&d.public_key===a.device.keys.publicKey),'RESTORE_FIXTURE_AUDIENCE_INVALID');
  return encryptObject({payload,signingKey:key,context:{id:randomUUID(),kind:'post',authorId:a.id,authorDeviceId:a.device.id,audience:'only_me',parentId:null,groupId:null,createdAt:new Date().toISOString(),expiresAt:null,revision:1,...context,epoch:audience.epoch},recipients:audience.devices.map((d:any)=>({memberId:d.member_id,deviceId:d.id,publicKey:d.public_key}))});
 }
 if(phase==='prepare'){
  const bytes=await readFile(new URL('../docs/archive/sample/photos/77777777-7777-4777-8777-777777777777.jpg',import.meta.url));
  const fixture:RestoreFixtures={v:1,synthetic:true,origin:stagingOrigin,run:state.run,...(attempt?{attempt}:{}),memberId:a.id,strangerId:stranger.id,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+2*3600000).toISOString(),prepared:false,
   survivor:{id:randomUUID(),mediaId:randomUUID(),text:'Synthetic hosted restore survivor'},deleted:{id:randomUUID(),mediaId:randomUUID(),text:'Synthetic hosted restore deletion'},timed:{id:randomUUID(),text:'Synthetic hosted restore shortened deadline'},commentId:randomUUID(),photoSHA256:createHash('sha256').update(bytes).digest('hex'),sessionId:session.session.id,cookie:api.cookieHeader()};
  await writeRestorePrivate(path,fixture,true); // No fixture mutation before recoverable IDs exist.
  for(const post of [fixture.survivor,fixture.deleted,fixture.timed]){
   if(post.mediaId){
    const photo=await seal({mime:'image/jpeg',bytes:bytes.toString('base64'),width:16,height:16,alt:'Synthetic restore test'}, {id:post.mediaId,kind:'media',parentId:post.id,expiresAt:fixture.expiresAt});
    const encoded=new TextEncoder().encode(JSON.stringify(photo)),reservation=await api.json('/api/v1/media','POST',{id:post.mediaId,envelope:photo,byte_size:encoded.length},201);
    check((await api.request(reservation.upload_url,'PUT',encoded)).status===200,'RESTORE_FIXTURE_UPLOAD_FAILED');
   }
   const payload={text:post.text,reactionSecret:createReactionSecret(),...(post.mediaId?{media:[{id:post.mediaId,mime:'image/jpeg',width:16,height:16,alt:'Synthetic restore test'}]}:{})};
   post.envelope=await seal(payload,{id:post.id,expiresAt:fixture.expiresAt});if(post===fixture.timed)fixture.timedPayload=payload;
   await writeRestorePrivate(path,fixture);
   await api.json('/api/v1/posts','POST',{envelope:post.envelope,media_ids:post.mediaId?[post.mediaId]:[]},201);
   const actual=(await api.json('/api/v1/posts/'+post.id)).post.envelope;
   const plain=await decryptObject<{text:string}>({envelope:actual,expectedContext:actual.context,privateKey:key,authorPublicKey:a.device.keys.publicKey});check(plain.text===post.text,'RESTORE_FIXTURE_POST_ROUNDTRIP_FAILED');
  }
  const comment=await seal({text:'Synthetic child inherits the restored parent deadline',reactionSecret:createReactionSecret()},{id:fixture.commentId,kind:'comment',parentId:fixture.timed.id,expiresAt:fixture.expiresAt},fixture.timed.id);
  await api.json('/api/v1/posts/'+fixture.timed.id+'/comments','POST',{envelope:comment,parent_expires_at:fixture.expiresAt},201);
  const actualPhoto=await api.json<EncryptedEnvelope>('/api/v1/media/'+fixture.survivor.mediaId+'/bytes');
  const photo=await decryptObject<{bytes:string}>({envelope:actualPhoto,expectedContext:actualPhoto.context,privateKey:key,authorPublicKey:a.device.keys.publicKey});
  check(createHash('sha256').update(Buffer.from(photo.bytes,'base64')).digest('hex')===fixture.photoSHA256,'RESTORE_FIXTURE_PHOTO_ROUNDTRIP_FAILED');
  fixture.prepared=true;await writeRestorePrivate(path,fixture);progress('prepared-three-posts-two-photos-child-comment-and-live-session');
 }else{
  const fixture=await readRestorePrivate<RestoreFixtures>(path);
  check(fixture.v===1&&fixture.synthetic&&fixture.origin===stagingOrigin&&fixture.run===state.run&&fixture.attempt===attempt&&fixture.memberId===a.id&&fixture.prepared&&!fixture.afterComplete&&(!fixture.afterStarted||process.argv.includes('--resume')&&fixture.deletedAcknowledged&&!fixture.shortenedEnvelope)&&!!snapshot&&uuid.test(snapshot),'RESTORE_FIXTURE_PHASE_INVALID');
  check(Date.parse(fixture.expiresAt)>Date.now()+10*60000,'RESTORE_FIXTURE_TOO_CLOSE_TO_EXPIRY');
  const ticket=await readRestorePrivate<{id:string;environment:string;pairedAt:string;generation:string;captureVerified:boolean}>('artifacts/private/restore-ops/manual-media-backups/staging-'+snapshot+'.json');
  check(ticket.id===snapshot&&ticket.environment==='staging'&&ticket.captureVerified&&Date.parse(ticket.pairedAt)>Date.parse(fixture.createdAt),'RESTORE_FIXTURE_SNAPSHOT_INVALID');
  const journal=await readJournalControl(R2JournalStore.fromEnvironment('porchday-staging-recovery-journal'));
  check(journal.value.mode==='active'&&!journal.value.pending.length&&journal.value.generation===ticket.generation,'RESTORE_FIXTURE_JOURNAL_NOT_STABLE');
  const expected=new Set([fixture.survivor.mediaId,fixture.deleted.mediaId].map(id=>'media/'+a.id+'/'+id));
  const manifest=await verifyMediaBackup(backupReaderFromEnvironment('porchday-staging-media-backup') as never,snapshot,ticket.pairedAt,async(item,bytes)=>{if(expected.has(item.object_key)){check(!item.omitted&&bytes!==null,'RESTORE_FIXTURE_SNAPSHOT_PHOTO_MISSING');expected.delete(item.object_key);}},{generation:ticket.generation,maxJournalSequence:journal.value.sequence});
  check(!expected.size&&manifest.objects>=2,'RESTORE_FIXTURE_SNAPSHOT_PHOTO_MISSING');
  fixture.snapshotId=snapshot;fixture.pairedAt=ticket.pairedAt;fixture.afterStarted=true;await writeRestorePrivate(path,fixture);
  if(!fixture.deletedAcknowledged){await api.json('/api/v1/posts/'+fixture.deleted.id,'DELETE');fixture.deletedAcknowledged=true;await writeRestorePrivate(path,fixture);}
  check((await api.request('/api/v1/posts/'+fixture.deleted.id)).status===404&&(await api.request('/api/v1/media/'+fixture.deleted.mediaId+'/bytes')).status===404,'RESTORE_FIXTURE_DELETION_VISIBLE');
  const expiresAt=new Date(Date.now()+20000).toISOString(),old=fixture.timed.envelope!.context;
  const envelope=await seal(fixture.timedPayload,{...old,expiresAt,revision:old.revision+1},fixture.timed.id);
  const lifecycle=await signStatement({purpose:'porchday-lifecycle',id:old.id,revision:envelope.context.revision,expiresAt},key);
  fixture.shortenedAt=expiresAt;fixture.shortenedEnvelope=envelope;await writeRestorePrivate(path,fixture);
  await api.json('/api/v1/posts/'+fixture.timed.id,'PUT',{envelope,lifecycle});fixture.expiryAcknowledged=true;await writeRestorePrivate(path,fixture);
  await wait(Math.max(0,Date.parse(expiresAt)-Date.now())+500);
  check((await api.request('/api/v1/posts/'+fixture.timed.id)).status===404,'RESTORE_FIXTURE_EXPIRY_VISIBLE');
  check((await api.request('/api/v1/posts/'+fixture.survivor.id)).status===200,'RESTORE_FIXTURE_SURVIVOR_LOST');
  fixture.afterComplete=true;await writeRestorePrivate(path,fixture);progress('verified-snapshot-then-acknowledged-deletion-and-shortened-deadline');
 }
 // Deliberately retain this synthetic session through the paired snapshot so
 // the isolated replay can prove session invalidation. Account cleanup revokes it.
} catch(error){
 const code=(error as Error).message;console.error(JSON.stringify({phase,error:/^[A-Z][A-Z0-9_]{2,100}$/.test(code)?code:'RESTORE_FIXTURE_FAILED',...(error instanceof SmokeError&&error.diagnostic?{diagnostic:error.diagnostic}:{})}));process.exitCode=1;
}
