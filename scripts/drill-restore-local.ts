import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile,rm,chmod,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import postgres,{type Sql} from 'postgres';
import {Hono} from 'hono';
import {createSocialRoutes} from '../apps/api/src/social.js';
import type {Env,Variables} from '../apps/api/src/types.js';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {canonicalJson,generateDeviceKeys,unlockPrivateKey,encryptObject,decryptObject,type ContentContext,type EncryptedEnvelope} from '../packages/crypto/src/index.js';
import {initializePrivacyJournal,readJournalControl,assertJournalReadable,beginPrivacyIntent,publishAuthPrivacyCommitScope,completePrivacyIntent,quarantineJournal,verifyJournalChain,type JournalDatabase,type JournalStore} from '../apps/api/src/privacy-journal.js';
import {restoreMediaSnapshot} from './restore-media.js';
import {beginMediaBackup,copyMediaBackupPage,verifyMediaBackup,backupDatabase} from '../apps/api/src/media-backup.js';
import {replayPrivacyJournal,releasePrivacyQuarantine} from '../apps/api/src/restore-journal.js';

// Creates two NEW databases only. Never selects the main application database,
// a provider URL, real R2 or secrets.env. The Docker container must be the local
// development PostgreSQL container, or a labeled disposable container for the
// opt-in commit-protocol drill. Both use local socket identity for dump/restore.
if(process.argv[2]!=='--run'||process.argv.slice(3).some(arg=>arg!=='--commit-protocol'))throw Error('USE_NPX_TSX_SCRIPTS_DRILL_RESTORE_LOCAL_TS_RUN');
const commitProtocol=process.argv.includes('--commit-protocol');
const legacyCommit='3810d1d6383415eb2559c54829b68dee6113618c';
const adminUrl=process.env.LOCAL_DRILL_ADMIN_URL??'postgres://postgres:porchday-local@127.0.0.1:54329/postgres';
const parsed=new URL(adminUrl);
if(!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)||parsed.pathname!=='/postgres'||(!commitProtocol&&parsed.port!=='54329'))throw Error('LOCAL_DRILL_DATABASE_REQUIRED');
const container=commitProtocol?process.env.LOCAL_DRILL_CONTAINER??'':'porchday-postgres';
if(commitProtocol&&!/^porchday-commit-restore-[a-f0-9]{12}$/.test(container))throw Error('OWNED_COMMIT_RESTORE_CONTAINER_REQUIRED');
const suffix=randomUUID().replaceAll('-','').slice(0,12);
const sourceName='porchday_drill_'+suffix+'_source',targetName='porchday_drill_'+suffix+'_target';
const directory=await mkdtemp(join(tmpdir(),'porchday-restore-drill-'));await chmod(directory,0o700);
const admin=postgres(adminUrl,{max:1,prepare:false,onnotice:()=>{}});
let source:Sql|undefined,target:Sql|undefined,mf:Miniflare|undefined,phase='START';
let sourceCreated=false,targetCreated=false;
const started=performance.now();
function database(name:string){const url=new URL(adminUrl);url.pathname='/'+name;return postgres(url.toString(),{max:2,prepare:false,onnotice:()=>{}});}
function journalDb(sql:Sql):JournalDatabase{return{async status(){const[r]=await sql`select app.safety_status() value`;return r.value;},async page(after){const[r]=await sql`select app.safety_page(${after}::bigint,200) value`;return r.value;}};}
function r2(){return new Miniflare(convertV4MiniflareOptions({name:'restore-drill',modules:true,script:'export default {fetch(){return new Response("not exposed",{status:404})}}',compatibilityDate:'2026-10-01',resourcePersistencePath:join(directory,'r2'),r2Buckets:{JOURNAL:'drill-independent-journal',SOURCE_MEDIA:'drill-source-media',TARGET_MEDIA:'drill-target-media',BACKUP:'drill-ciphertext-backup',RECONCILED_MEDIA:'drill-reconciled-media'}}));}
async function docker(args:string[],input?:Uint8Array):Promise<Buffer>{return new Promise((resolve,reject)=>{
 const child=spawn('docker',['exec',...(input?['-i']:[]),container,...args],{stdio:['pipe','pipe','pipe']});const out:Buffer[]=[];let size=0;
 const timer=setTimeout(()=>{child.kill();reject(Error('LOCAL_DRILL_PROCESS_TIMEOUT'));},60_000);
 child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>64*1024*1024){child.kill();reject(Error('LOCAL_DRILL_OUTPUT_TOO_LARGE'));}else out.push(chunk);});
 child.stderr.resume();child.on('error',()=>{clearTimeout(timer);reject(Error('LOCAL_DRILL_DOCKER_FAILED'));});
 child.on('close',code=>{clearTimeout(timer);code===0?resolve(Buffer.concat(out)):reject(Error('LOCAL_DRILL_POSTGRES_TOOL_FAILED'));});
 child.stdin.on('error',()=>{});child.stdin.end(input);
 });}
async function command(file:string,args:string[],input?:Buffer):Promise<Buffer>{return new Promise((resolve,reject)=>{
 const child=spawn(file,args,{stdio:['pipe','pipe','pipe']}),chunks:Buffer[]=[];let size=0;
 const timer=setTimeout(()=>{child.kill();reject(Error('COMPATIBILITY_PROCESS_TIMEOUT'));},60000);
 child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>32*1024*1024){child.kill();reject(Error('COMPATIBILITY_OUTPUT_LIMIT'));}else chunks.push(chunk);});
 child.stderr.resume();child.on('error',()=>{clearTimeout(timer);reject(Error('COMPATIBILITY_PROCESS_FAILED'));});
 child.on('close',code=>{clearTimeout(timer);code===0?resolve(Buffer.concat(chunks)):reject(Error('COMPATIBILITY_PROCESS_FAILED'));});child.stdin.on('error',()=>{});child.stdin.end(input);
});}
const digest=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
try {
 phase='VERIFY_LOCAL_CONTAINER';
 if(commitProtocol){
  const inspect=JSON.parse((await command('docker',['inspect',container])).toString())[0];
  assert.equal(inspect.Config.Labels?.['porchday.commit-restore-drill'],'true');
  const binding=inspect.NetworkSettings.Ports['5432/tcp'];assert.equal(binding.length,1);
  assert.equal(binding[0].HostIp,'127.0.0.1');assert.equal(binding[0].HostPort,parsed.port);
 }
 phase='CREATE_DATABASES';await admin.unsafe('CREATE DATABASE '+sourceName);sourceCreated=true;await admin.unsafe('CREATE DATABASE '+targetName);targetCreated=true;
 source=database(sourceName);target=database(targetName);
 phase='MIGRATE_SOURCE';for(const name of(await readdir(new URL('../apps/api/migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')&&(!commitProtocol||n<'057')).sort())await source.unsafe(await readFile(new URL('../apps/api/migrations/'+name,import.meta.url),'utf8'));
 mf=r2();let journal=await mf.getR2Bucket('JOURNAL') as unknown as JournalStore;let sourceMedia=await mf.getR2Bucket('SOURCE_MEDIA');
 phase='SEED_ENCRYPTED_FIXTURES';
 const alice=randomUUID(),bob=randomUUID(),outsider=randomUUID(),aliceDevice=randomUUID(),bobDevice=randomUUID();
 const ids={deleted:randomUUID(),timed:randomUUID(),edited:randomUUID(),surviving:randomUUID(),shared:randomUUID(),deletedComment:randomUUID(),timedComment:randomUUID(),deletedMedia:randomUUID(),survivingMedia:randomUUID()};
 const keys=await generateDeviceKeys(alice,aliceDevice),bobKeys=await generateDeviceKeys(bob,bobDevice);
 const privateKey=await unlockPrivateKey(keys.encryptedPrivateKey,keys.recoverySecret,keys.fingerprint);
 const recipients=[{memberId:alice,deviceId:aliceDevice,publicKey:keys.publicKey}];
 const created=new Date(Date.now()-86400000).toISOString();
 async function envelope(id:string,kind:ContentContext['kind']='post',revision=1,parentId:string|null=null,audience:ContentContext['audience']='only_me',payload:unknown={text:'Synthetic private restore fixture'}){
  const context:ContentContext={id,kind,authorId:alice,authorDeviceId:aliceDevice,audience,parentId,groupId:null,epoch:1,createdAt:created,expiresAt:null,revision};
  return encryptObject({context,payload,signingKey:privateKey,recipients:audience==='connections'?[...recipients,{memberId:bob,deviceId:bobDevice,publicKey:bobKeys.publicKey}]:recipients});
 }
 for(const member of[alice,bob,outsider]){
  await source`insert into public.auth_user(id,name,email,"emailVerified",credentials_changed_at) values(${member},'Synthetic restore person',${member+'@example.test'},true,${created})`;
  await source`insert into app.members(id,adult_attested_at,rules_accepted_at) values(${member},now(),now())`;
 }
 for(const [id,member,key] of[[aliceDevice,alice,keys],[bobDevice,bob,bobKeys]] as const)await source`insert into app.device_keys(id,member_id,public_key,fingerprint,authorization_proof) values(${id},${member},${key.publicKey},${key.fingerprint},'{}')`;
 await source`insert into app.connections(member_a,member_b,kind) values(${[alice,bob].sort()[0]},${[alice,bob].sort()[1]},'friend')`;
 const profile=await envelope(alice,'profile');await source`insert into app.profiles(member_id,handle,envelope) values(${alice},'drill_alice',${source.json(profile)})`;
 const postEnvelopes=new Map<string,EncryptedEnvelope>();
 for(const name of['deleted','timed','edited','surviving','shared'] as const){const id=ids[name],body=await envelope(id,'post',1,null,name==='shared'?'connections':'only_me');postEnvelopes.set(id,body);await source`insert into app.posts(id,author_id,audience,envelope,epoch,created_at) values(${id},${alice},${body.context.audience},${source.json(body)},1,${created})`;for(const recipient of body.recipients)await source`insert into app.post_recipients(post_id,device_id,member_id) values(${id},${recipient.deviceId},${recipient.memberId})`;}
 for(const [id,parent] of[[ids.deletedComment,ids.deleted],[ids.timedComment,ids.timed]]){const body=await envelope(id,'comment',1,parent);await source`insert into app.comments(id,post_id,author_id,envelope,created_at) values(${id},${parent},${alice},${source.json(body)},${created})`;}
 const mediaRecords: {key:string;file:string;sha256:string}[]=[];
 const uploadApp=new Hono<{Bindings:Env;Variables:Variables}>();uploadApp.use('*',async(c,next)=>{c.set('memberId',alice);c.set('authTime',Date.now());await next();});uploadApp.route('/',createSocialRoutes());
 // This drill invokes HTTP handlers in Node, which has no FixedLengthStream.
 // Cross the Node -> native-R2 RPC boundary with a known-length fixture buffer.
 // Maximum-size native streaming is covered separately inside actual workerd.
 const uploadStorage={
  async put(key:string,value:any,options:any){if(value instanceof ReadableStream){const bytes=await new Response(value).arrayBuffer();assert(bytes.byteLength<=65536,'LOCAL_DRILL_FIXTURE_TOO_LARGE');return sourceMedia.put(key,bytes,options);}return sourceMedia.put(key,value,options);},
  get:(key:string)=>sourceMedia.get(key),head:(key:string)=>sourceMedia.head(key),delete:(key:string)=>sourceMedia.delete(key),
 };
 const uploadURL=new URL(adminUrl);uploadURL.pathname='/'+sourceName;const uploadEnv={HYPERDRIVE_SOCIAL:{connectionString:uploadURL.toString()},MEDIA:uploadStorage} as unknown as Env;
 for(const [id,parent] of[[ids.deletedMedia,ids.deleted],[ids.survivingMedia,ids.surviving]]){
  const body=await envelope(id,'media',1,parent,'only_me',{mime:'image/jpeg',data:'synthetic-photo-bytes',alt:'Synthetic photo'}),bytes=Buffer.from(JSON.stringify(body));const key='media/'+alice+'/'+id;
  assert.notEqual(digest(bytes),digest(canonicalJson(body)),'Real upload encoding must differ from canonical digest to cover backup regression');
  const reserved=await uploadApp.request('https://porchday.test/media',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,envelope:body,byte_size:bytes.length})},uploadEnv);phase='HTTP_MEDIA_RESERVATION_'+reserved.status;assert.equal(reserved.status,201);
  const uploaded=await uploadApp.request('https://porchday.test/media/'+id+'/bytes',{method:'PUT',headers:{'content-type':'application/octet-stream'},body:bytes},uploadEnv);phase='HTTP_MEDIA_UPLOAD_'+uploaded.status;assert.equal(uploaded.status,200);
  assert.equal((await source`select envelope_sha256 from app.media_assets where id=${id}`)[0].envelope_sha256,digest(canonicalJson(body)));
  await source`update app.media_assets set post_id=${parent},state='attached' where id=${id}`;
  const file='media-'+id+'.json';await writeFile(join(directory,file),bytes,{mode:0o600});mediaRecords.push({key,file,sha256:digest(bytes)});
 }
 for(const member of[alice,bob])await source`insert into public.auth_session(id,"userId",token,"expiresAt") values(${randomUUID()},${member},${randomUUID()},now()+interval '1 day')`;
 await source`insert into public.auth_verification(id,identifier,value,"expiresAt") values(${randomUUID()},'synthetic-reset','synthetic-token',now()+interval '1 day')`;
 const integration=randomUUID();await source`insert into app.integration_clients(id,member_id,name,redirect_uri) values(${integration},${alice},'Synthetic integration','https://example.test/callback')`;
 await source`insert into app.integration_grants(id,member_id,client_id,scopes,code_challenge,code_expires_at,access_hash,access_expires_at,expires_at) values(${randomUUID()},${alice},${integration},ARRAY['content:read'],'synthetic-challenge',now()+interval '1 hour','synthetic-hash',now()+interval '1 hour',now()+interval '1 day')`;
 const sourceDb=journalDb(source);await initializePrivacyJournal(journal,sourceDb);const initial=await readJournalControl(journal);
 // Synthetic baseline activation keeps deliberately seeded old sessions for the
 // restore test; real initialization follows reviewed replay/release instead.
 assert(await journal.put('control.json',JSON.stringify({...initial.value,mode:'active',reason:null}),{onlyIf:{etagMatches:initial.etag}}));
 await assertJournalReadable(journal,sourceDb);
 phase='BACKUP_DATABASE_AND_MEDIA';
 const backup=await mf.getR2Bucket('BACKUP') as unknown as R2Bucket;const backupStorage={source:sourceMedia as unknown as R2Bucket,backup,journal,db:backupDatabase(source)};const backupID=await beginMediaBackup(backupStorage);
 while(await copyMediaBackupPage(backupStorage,backupID)!=='complete'){}
 const backupInfo=await backupStorage.db.info(backupID);assert.equal((await verifyMediaBackup(backup,backupID,backupInfo.restore_at)).objects,2);
 const dump=await docker(['pg_dump','--format=custom','--username=postgres','--dbname='+sourceName]);assert(dump.byteLength>1000);
 await writeFile(join(directory,'database.dump'),dump,{mode:0o600});await writeFile(join(directory,'media-manifest.json'),JSON.stringify({version:1,objects:mediaRecords}),{mode:0o600});
 const snapshotStatus=await sourceDb.status();
 let markerOperation:string|undefined,legacy:any;
 if(commitProtocol){
  phase='LOAD_PREVIOUS_JOURNAL_EXECUTABLE';
  const archive=await command('git',['archive',legacyCommit,'apps/api/src']);
  const legacyRoot=join(directory,'legacy');await mkdir(legacyRoot,{mode:0o700});
  await command('tar',['-x','-C',legacyRoot],archive);
  await writeFile(join(legacyRoot,'package.json'),JSON.stringify({type:'module'}),{mode:0o600});
  await symlink(resolve('node_modules'),join(legacyRoot,'node_modules'));
  legacy=await import(pathToFileURL(join(legacyRoot,'apps/api/src/privacy-journal.ts')).href);
  await legacy.assertJournalReadable(journal,sourceDb);
  assert.equal((await source`select to_regclass('app.privacy_operation_commits') as name`)[0].name,null);
  phase='UPGRADE_SOURCE_AND_CHECK_PREVIOUS_EXECUTABLE';
  await source.unsafe(await readFile(new URL('../apps/api/migrations/057_privacy_transaction_commits.sql',import.meta.url),'utf8'));
  const runtimeUrl=new URL(adminUrl);runtimeUrl.pathname='/'+sourceName;
  await legacy.withPrivacyJournal({ENVIRONMENT:'development',RECOVERY_JOURNAL:journal,HYPERDRIVE_JOBS:{connectionString:runtimeUrl.href}},async()=>{});
  phase='COMMIT_AUTH_WITHOUT_RECEIPT';
  const authIntent=await beginPrivacyIntent(journal,sourceDb),scope=await publishAuthPrivacyCommitScope(journal,sourceDb,authIntent);markerOperation=authIntent.id;
  await source.begin(async tx=>{
   await tx`update public.auth_user set credentials_changed_at=now() where id=${bob}`;
   await tx`select app.set_security_hold(${bob})`;await tx`update app.members set status='active' where id=${bob}`;
   await tx`select app.complete_privacy_transaction(${scope.operationId}::uuid,${scope.scopeSha256},${scope.generation}::uuid)`;
  });
  assert.equal(await journal.get('receipts/'+markerOperation+'.json'),null);
  const realNow=Date.now,stale=realNow()+120001;Date.now=()=>stale;
  try{await assertJournalReadable(journal,sourceDb,undefined,true);}finally{Date.now=realNow;}
  assert.equal((await readJournalControl(journal)).value.pending.length,0);
  assert(await journal.get('receipts/'+markerOperation+'.json'));
  await legacy.assertJournalReadable(journal,sourceDb);
 }

 phase='CAPTURE_POST_BACKUP_PRIVACY_CHANGES';const intent=await beginPrivacyIntent(journal,sourceDb);
 await source`delete from app.posts where id=${ids.deleted}`;
 await source`update app.posts set expires_at=now()-interval '1 hour' where id=${ids.timed}`;
 await source`update app.posts set envelope=${source.json(await envelope(ids.edited,'post',2))} where id=${ids.edited}`;
 await source`update app.profiles set envelope=${source.json(await envelope(alice,'profile',2))} where member_id=${alice}`;
 await source`delete from app.connections where member_a=${[alice,bob].sort()[0]} and member_b=${[alice,bob].sort()[1]}`;
 await source`update app.device_keys set revoked_at=now() where id=${bobDevice}`;
 await source`update public.auth_user set credentials_changed_at=now() where id=${bob}`;
 await source`select app.set_security_hold(${bob})`;await source`update app.members set status='active' where id=${bob}`;
 await completePrivacyIntent(journal,sourceDb,intent);
 await sourceMedia.delete('media/'+alice+'/'+ids.deletedMedia);
 const latest=await sourceDb.status();assert(BigInt(latest.sequence)>BigInt(snapshotStatus.sequence));
 phase='REOPEN_PERSISTED_INDEPENDENT_JOURNAL';await mf.dispose();mf=r2();journal=await mf.getR2Bucket('JOURNAL') as unknown as JournalStore;
 assert.equal((await readJournalControl(journal)).value.sequence,latest.sequence);
 phase='RESTORE_ISOLATED_DATABASE_AND_MEDIA';
 await docker(['pg_restore','--exit-on-error','--username=postgres','--dbname='+targetName],await readFile(join(directory,'database.dump')));
 if(commitProtocol){
  phase='UPGRADE_PRE_057_BACKUP';
  const [marker]=await source`select sequence::text,id,occurred_at,decision from app.safety_journal where decision->>'operation_id'=${markerOperation!}`;
  assert(marker);
  await assert.rejects(target.begin(async tx=>{
   await tx`update app.safety_journal_state set restore_quarantined=true where id`;
   await tx`select app.replay_safety_batch(${tx.json([marker])})`;
  }),/INVALID_JOURNAL_ACTION/);
  assert.equal((await target`select to_regclass('app.privacy_operation_commits') as name`)[0].name,null);
  await target.unsafe(await readFile(new URL('../apps/api/migrations/057_privacy_transaction_commits.sql',import.meta.url),'utf8'));
  assert.equal((await target`select count(*)::int n from app.privacy_operation_commits`)[0].n,0);
 }
 const targetMedia=await mf.getR2Bucket('TARGET_MEDIA');
 await verifyMediaBackup(await mf.getR2Bucket('BACKUP') as unknown as R2Bucket,backupID,backupInfo.restore_at,async(item,bytes)=>{assert(bytes);await targetMedia.put(item.object_key,bytes);});
 const targetDb=journalDb(target);assert.equal((await targetDb.status()).sequence,snapshotStatus.sequence);
 assert.equal((await target`select count(*)::int n from app.posts`)[0].n,5);assert(await targetMedia.get('media/'+alice+'/'+ids.deletedMedia));
 const beforeReplay=await target.begin(async tx=>{await tx`set local role porchday_social`;await tx`select set_config('app.member_id',${alice},true)`;return tx`select id from app.posts`;});assert.equal(beforeReplay.length,5,'Restored RLS grants must be real, not absent');
 phase='PROVE_ROLLBACK_GUARD_AND_QUARANTINE';await assert.rejects(assertJournalReadable(journal,targetDb),/DATABASE_ROLLBACK_DETECTED/);
 await quarantineJournal(journal,'synthetic_restore_drill');await assert.rejects(assertJournalReadable(journal,targetDb),/RESTORE_QUARANTINED/);
 await assert.rejects(releasePrivacyQuarantine(journal,target),/RESTORE_CHECKPOINT_MISMATCH/);
 const chain=await verifyJournalChain(journal);assert(BigInt(chain.control.sequence)>BigInt(snapshotStatus.sequence));
 phase='REPLAY_AND_DELETE_RESTORED_MEDIA';
 await assert.rejects(replayPrivacyJournal(journal,target,async()=>{throw Error('SYNTHETIC_MEDIA_DELETE_FAILED');}),/SYNTHETIC_MEDIA_DELETE_FAILED/);
 await assert.rejects(assertJournalReadable(journal,targetDb),/RESTORE_QUARANTINED/);
 assert(await targetMedia.get('media/'+alice+'/'+ids.deletedMedia));
 const result=await replayPrivacyJournal(journal,target,async key=>{await targetMedia.delete(key);});
 if(commitProtocol){
  assert.equal((await target`select 1 from app.privacy_operation_commits where operation_id=${markerOperation!}`).length,1);
  assert.equal((await target`select 1 from app.safety_journal where decision->>'operation_id'=${markerOperation!}`).length,1);
 }
 assert.equal(result.heldAccounts,1);assert(result.deletedObjects>=1);assert(result.replayed>5);
 for(const id of[ids.deleted,ids.timed,ids.edited])assert.equal((await target`select id from app.posts where id=${id}`).length,0);
 assert.equal((await target`select id from app.comments`).length,0);assert.equal((await target`select envelope from app.profiles where member_id=${alice}`)[0].envelope,null);
 assert.equal((await target`select status from app.members where id=${bob}`)[0].status,'hold');assert((await target`select revoked_at from app.device_keys where id=${bobDevice}`)[0].revoked_at);
 assert.equal((await target`select id from app.connections`).length,0);
 for(const table of['public.auth_session','public.auth_verification','app.integration_grants'])assert.equal((await target.unsafe('select count(*)::int n from '+table))[0].n,0);
 assert.equal(await targetMedia.get('media/'+alice+'/'+ids.deletedMedia),null);
 assert.equal((await target`select id from app.deletion_outbox where completed_at is null`).length,0);
 await assert.rejects(assertJournalReadable(journal,targetDb),/RESTORE_QUARANTINED/);
 phase='RESTORE_ONLY_STILL_LIVE_BACKUP_OBJECTS';
 const reconciled=await mf.getR2Bucket('RECONCILED_MEDIA'),persistedBackup=await mf.getR2Bucket('BACKUP');
 const restoredMedia=await restoreMediaSnapshot({journal,sql:target,backup:persistedBackup as unknown as R2Bucket,snapshotId:backupID,pairedTime:backupInfo.restore_at,restoreObject:async item=>{
  const sourceObject=await persistedBackup.get('snapshots/'+item.snapshotId+'/objects/'+item.key.slice(6));assert(sourceObject);const bytes=await sourceObject.arrayBuffer();assert.equal(digest(new Uint8Array(bytes)),item.sha256);assert.equal(bytes.byteLength,item.byteSize);await reconciled.put(item.key,bytes,{onlyIf:{etagDoesNotMatch:'*'}});
 }});assert.equal(restoredMedia.copied,1);assert.equal(restoredMedia.discarded,1);assert.equal(await reconciled.get('media/'+alice+'/'+ids.deletedMedia),null);
 phase='EXPLICIT_RELEASE_AND_MEMBER_CHECKS';
 await assert.rejects(releasePrivacyQuarantine(journal,target),/RESTORE_MEDIA_VERIFICATION_REQUIRED/);
 await assert.rejects(releasePrivacyQuarantine(journal,target,async()=>{throw Error('SYNTHETIC_MEDIA_VERIFY_FAILED');}),/SYNTHETIC_MEDIA_VERIFY_FAILED/);
 await assert.rejects(assertJournalReadable(journal,targetDb),/RESTORE_QUARANTINED/);
 await releasePrivacyQuarantine(journal,target,async item=>{const object=await reconciled.get(item.key);assert(object);const bytes=await object.arrayBuffer();assert.equal(bytes.byteLength,item.byteSize);assert.equal(digest(new Uint8Array(bytes)),item.sha256);});await assertJournalReadable(journal,targetDb);
 if(commitProtocol){
  phase='PREVIOUS_EXECUTABLE_AFTER_RESTORE';
  await legacy.assertJournalReadable(journal,targetDb);
  const runtimeUrl=new URL(adminUrl);runtimeUrl.pathname='/'+targetName;
  await legacy.withPrivacyJournal({ENVIRONMENT:'development',RECOVERY_JOURNAL:journal,HYPERDRIVE_JOBS:{connectionString:runtimeUrl.href}},async()=>{});
  await assertJournalReadable(journal,targetDb,undefined,true);
 }
 const own=await target.begin(async tx=>{await tx`set local role porchday_social`;await tx`select set_config('app.member_id',${alice},true)`;return tx`select id,envelope from app.posts order by id`;});assert.equal(own.length,2);
 for(const actor of[bob,outsider]){const rows=await target.begin(async tx=>{await tx`set local role porchday_social`;await tx`select set_config('app.member_id',${actor},true)`;return tx`select id from app.posts`;});assert.equal(rows.length,0);}
 await assert.rejects(target.begin(async tx=>{await tx`set local role porchday_social`;return tx`select * from public.auth_session`;}),{code:'42501'});
 const restored=own.find(row=>row.id===ids.surviving)!.envelope as EncryptedEnvelope;
 assert.deepEqual(await decryptObject({envelope:restored,expectedContext:postEnvelopes.get(ids.surviving)!.context,privateKey,authorPublicKey:keys.publicKey}),{text:'Synthetic private restore fixture'});
 const photoObject=await targetMedia.get('media/'+alice+'/'+ids.survivingMedia);assert(photoObject);const photo=JSON.parse(await photoObject.text()) as EncryptedEnvelope;
 assert.deepEqual(await decryptObject({envelope:photo,expectedContext:photo.context,privateKey,authorPublicKey:keys.publicKey}),{mime:'image/jpeg',data:'synthetic-photo-bytes',alt:'Synthetic photo'});
 console.log(JSON.stringify({passed:true,commitProtocol,legacyJournalCommit:commitProtocol?legacyCommit:undefined,pre057BackupUpgradeVerified:commitProtocol,oldRestoreRejectsMarkerVerified:commitProtocol,atomicMarkerRecoveredAndRestored:commitProtocol,scope:'synthetic local PostgreSQL dump/restore and native R2',snapshotSequence:snapshotStatus.sequence,replayed:result.replayed,deletedObjects:result.deletedObjects,heldAccounts:result.heldAccounts,survivingPosts:own.length,encryptedMediaVerified:true,rlsAndAuthRevocationVerified:true,persistedIndependentJournalVerified:true,failedCleanupRetryVerified:true,scheduledBackupManifestVerified:true,actualHttpUploadDigestRegressionVerified:true,privacyFilteredMediaRestoreVerified:true,releaseRequiresLiveMediaVerification:true,elapsedMs:Math.round(performance.now()-started)}));
} catch(error) {
 const code=(error as {code?:string}).code;console.error(JSON.stringify({passed:false,phase,code:typeof code==='string'&&/^[A-Z0-9_]+$/.test(code)?code:'LOCAL_DRILL_FAILED'}));process.exitCode=1;
} finally {
 await source?.end({timeout:1});await target?.end({timeout:1});await mf?.dispose();
 if(sourceCreated)await admin.unsafe('DROP DATABASE '+sourceName+' WITH (FORCE)');if(targetCreated)await admin.unsafe('DROP DATABASE '+targetName+' WITH (FORCE)');await admin.end({timeout:1});await rm(directory,{recursive:true,force:true});
}
