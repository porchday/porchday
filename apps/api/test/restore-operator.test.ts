import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import postgres,{type Sql} from 'postgres';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {initializePrivacyJournal,readJournalControl,checkpointJournal,quarantineJournal,type JournalStore,type JournalDatabase} from '../src/privacy-journal';
import {replayPrivacyJournal,releasePrivacyQuarantine} from '../src/restore-journal';
import {beginMediaBackup,copyMediaBackupPage,type BackupDatabase} from '../src/media-backup';
import {restoreMediaSnapshot} from '../../../scripts/restore-media';

const source=process.env.JOURNAL_TEST_DATABASE_URL,suite=source?describe:describe.skip;
const suffix=randomUUID().replaceAll('-',''),database='porchday_restore_operator_'+suffix+'_test';
const ownerName='restore_owner_'+suffix,operatorName='restore_admin_'+suffix;
let admin:Sql,owner:Sql,operator:Sql,created=false,mf:Miniflare;
const roles:string[]=[];const clients:Sql[]=[];
const required=['app.safety_status()','app.safety_page(bigint,integer)','app.replay_safety_batch(jsonb)','app.set_security_hold(uuid)','app.expire_batch(integer)','app.comment_deadline(uuid)','app.media_deadline(uuid)'];
let ownedBefore:unknown;
function connect(url:URL,role:string){const value=new URL(url);value.username=role;value.password='synthetic-restore-role-test';const sql=postgres(value.href,{max:1,prepare:false,onnotice:()=>{}});clients.push(sql);return sql;}

suite('Restored provider administrator with original object owners unavailable',()=>{
 beforeAll(async()=>{
  const url=new URL(source!);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!url.pathname.includes('test'))throw Error('DISPOSABLE_LOOPBACK_DATABASE_REQUIRED');
  url.pathname='/postgres';admin=postgres(url.href,{max:1,onnotice:()=>{}});await admin.unsafe('CREATE DATABASE '+database);created=true;
  for(const role of [ownerName,operatorName]){await admin.unsafe(`CREATE ROLE ${role} LOGIN CREATEROLE BYPASSRLS PASSWORD 'synthetic-restore-role-test'`);roles.push(role);}
  await admin.unsafe(`GRANT pg_read_all_data,pg_write_all_data TO ${operatorName}`);
  for(const kind of ['auth','social','jobs']){
   await admin.unsafe(`DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='porchday_${kind}') THEN CREATE ROLE porchday_${kind} NOLOGIN; END IF; END $$`);
   await admin.unsafe(`GRANT porchday_${kind} TO ${ownerName} WITH ADMIN TRUE,INHERIT FALSE,SET FALSE`);
  }
  await admin.unsafe(`GRANT CONNECT,CREATE,TEMPORARY ON DATABASE ${database} TO ${ownerName},${operatorName}`);
  url.pathname='/'+database;const bootstrap=postgres(url.href,{max:1,onnotice:()=>{}});await bootstrap.unsafe(`GRANT CREATE,USAGE ON SCHEMA public TO ${ownerName}`);await bootstrap.end();
  owner=connect(url,ownerName);operator=connect(url,operatorName);
  for(const name of(await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')&&n<'040_').sort())await owner.unsafe(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  ownedBefore=await owner`select p.oid,p.proowner,p.prosecdef,p.proconfig from pg_proc p where p.pronamespace='app'::regnamespace order by p.oid`;
  await expect(operator`select app.safety_status()`).rejects.toMatchObject({code:'42501'});
  // The real provider identity is named postgres. Local PostgreSQL reserves that
  // name for its superuser, so substitute only the constant grantee in the exact
  // production migration; the test connects as a separate NOSUPERUSER login.
  const migration=await readFile(new URL('../migrations/040_restore_operator.sql',import.meta.url),'utf8');
  await owner.unsafe(migration.replace(/TO postgres\b/g,'TO '+operatorName));
  mf=new Miniflare(convertV4MiniflareOptions({name:'restore-operator-acl',modules:true,script:'export default{fetch(){return new Response("test")}}',compatibilityDate:'2026-10-01',r2Buckets:['SOURCE','BACKUP','JOURNAL']}));
 },30000);
 afterAll(async()=>{await mf?.dispose();await Promise.all(clients.map(sql=>sql.end()));if(created)await admin.unsafe('DROP DATABASE '+database+' WITH (FORCE)');for(const role of roles.reverse())await admin.unsafe('DROP ROLE '+role);await admin?.end();});
 it('preserves ownership and creates separately restricted replacement runtime logins',async()=>{
  expect(await owner`select p.oid,p.proowner,p.prosecdef,p.proconfig from pg_proc p where p.pronamespace='app'::regnamespace order by p.oid`).toEqual(ownedBefore);
  const[r]=await operator`select rolsuper,rolbypassrls,pg_has_role(current_user,${ownerName},'SET') owner_set,has_schema_privilege(current_user,'app','CREATE') app_create from pg_roles where rolname=current_user`;
  expect(r).toMatchObject({rolsuper:false,rolbypassrls:true,owner_set:false,app_create:true});
  for(const signature of required)expect((await operator`select has_function_privilege(current_user,${signature},'EXECUTE') allowed`)[0].allowed).toBe(true);
  expect((await operator`select has_function_privilege(current_user,'app.media_backup_start_manual(uuid,timestamptz)','EXECUTE') allowed`)[0].allowed).toBe(false);
  const url=new URL(source!);url.pathname='/'+database;
  for(const kind of ['auth','social','jobs']){
   const role='restore_'+kind+'_'+suffix;roles.push(role);
   await operator.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'synthetic-restore-role-test'`);
   await operator.unsafe(`GRANT porchday_${kind} TO ${role} WITH ADMIN FALSE,INHERIT TRUE,SET TRUE`);
   const runtime=connect(url,role);const[permissions]=await runtime`select rolsuper,rolcreaterole,rolbypassrls,has_schema_privilege(current_user,'app','CREATE') app_create,has_function_privilege(current_user,'app.replay_safety_batch(jsonb)','EXECUTE') replay,pg_has_role(current_user,${operatorName},'SET') operator_set,pg_has_role(current_user,${ownerName},'SET') owner_set,has_table_privilege(current_user,'app.posts','SELECT') posts,has_table_privilege(current_user,'public.auth_session','SELECT') sessions from pg_roles where rolname=current_user`;
   expect(permissions).toEqual({rolsuper:false,rolcreaterole:false,rolbypassrls:false,app_create:false,replay:false,operator_set:false,owner_set:false,posts:kind==='social',sessions:kind==='auth'});
   const memberOf=await runtime`select r.rolname from pg_auth_members m join pg_roles r on r.oid=m.roleid where m.member=(select oid from pg_roles where rolname=current_user) and(m.inherit_option or m.set_option)`;
   expect(memberOf.map(r=>r.rolname)).toEqual(['porchday_'+kind]);
   await expect(runtime`select app.replay_safety_batch('[]')`).rejects.toMatchObject({code:'42501'});
   const[membership]=await operator`select pg_has_role(current_user,${'porchday_'+kind},'MEMBER WITH ADMIN OPTION') admin,pg_has_role(current_user,${'porchday_'+kind},'USAGE') inherited,pg_has_role(current_user,${'porchday_'+kind},'SET') may_set`;
   expect(membership).toEqual({admin:true,inherited:false,may_set:false});
  }
 });
 it('runs the production restore path without the owner, holding surviving accounts while honoring later member deletion',async()=>{
  const member=randomUUID(),removedMember=randomUUID(),deleted=randomUUID(),survivor=randomUUID(),timed=randomUUID(),child=randomUUID(),media=randomUUID();
  await owner`insert into app.members(id,adult_attested_at,rules_accepted_at) values(${member},now(),now())`;
  await owner`insert into public.auth_user(id,name,email,"emailVerified") values(${member},'Synthetic restore',${member+'@example.test'},true)`;
  await owner`insert into app.members(id,adult_attested_at,rules_accepted_at) values(${removedMember},now(),now())`;
  await owner`insert into public.auth_user(id,name,email,"emailVerified") values(${removedMember},'Synthetic deleted restore',${removedMember+'@example.test'},true)`;
  await owner`insert into public.auth_session(id,"userId",token,"expiresAt") values(${randomUUID()},${member},${randomUUID()},now()+interval '1 hour')`;
  await owner`insert into public.auth_verification(id,identifier,value,"expiresAt") values(${randomUUID()},'synthetic','synthetic',now()+interval '1 hour')`;
  for(const id of [deleted,survivor,timed])await owner`insert into app.posts(id,author_id,audience,envelope,epoch,created_at) values(${id},${member},'only_me','{}',1,now()-interval '1 day')`;
  await owner`insert into app.comments(id,post_id,author_id,envelope,created_at) values(${child},${timed},${member},'{}',now()-interval '23 hours')`;
  const key='media/'+member+'/'+media,bytes='{"ciphertext":"synthetic encrypted photo"}',digest=createHash('sha256').update(bytes).digest('hex');
  await owner`insert into app.media_assets(id,owner_id,post_id,object_key,envelope,byte_size,state,envelope_sha256,raw_sha256) values(${media},${member},${survivor},${key},'{}',${Buffer.byteLength(bytes)},'attached',${digest},${digest})`;
  const journal=await mf.getR2Bucket('JOURNAL') as unknown as JournalStore,sourceBucket=await mf.getR2Bucket('SOURCE') as unknown as R2Bucket,backup=await mf.getR2Bucket('BACKUP') as unknown as R2Bucket;
  const db:JournalDatabase={async status(){return(await operator`select app.safety_status() value`)[0].value;},async page(after){return(await operator`select app.safety_page(${after}::bigint,200) value`)[0].value;}};
  await initializePrivacyJournal(journal,db);const current=await readJournalControl(journal);await journal.put('control.json',JSON.stringify({...current.value,mode:'active',reason:null}),{onlyIf:{etagMatches:current.etag}});
  const initial=await db.status(),at=new Date(),run={id:randomUUID(),restore_at:at.toISOString(),generation:initial.generation,base_sequence:initial.sequence,expires_at:new Date(+at+7*86400000).toISOString()};
  await sourceBucket.put(key,bytes);const item={object_key:key,canonical_sha256:digest,sha256:digest,byte_size:Buffer.byteLength(bytes)};
  const backupDb:BackupDatabase={journal:db,async start(){return run;},async info(){return run;},async page(_,after){return after?[]:[item];},async missing(){return null;},async complete(){},async failed(){}};
  const storage={source:sourceBucket,backup,journal,db:backupDb};await beginMediaBackup(storage);while(await copyMediaBackupPage(storage,run.id)!=='complete'){}
  // Independent decisions describe later actions; the SQL rows intentionally
  // retain the older snapshot until the real restore functions replay them.
  const events=[{action:'delete',kind:'posts',id:deleted},{action:'deadline',kind:'posts',id:timed,expires_at:new Date(Date.now()-3600000).toISOString()},{action:'security_hold',id:member},{action:'status',id:member,status:'active'},{action:'security_hold',id:removedMember},{action:'delete',kind:'members',id:removedMember}];
  await owner.begin(async tx=>{for(const decision of events)await tx`select app.append_safety_decision(${tx.json(decision)})`;});await checkpointJournal(journal,db);await quarantineJournal(journal,'operator_acl_test');
  await owner`update app.safety_journal_state set sequence=${initial.sequence}::bigint`;await owner`delete from app.safety_journal where sequence>${initial.sequence}::bigint`;
  // From this point the original managed owner is deliberately unavailable.
  await owner.end();
  const removed:string[]=[];const replay=await replayPrivacyJournal(journal,operator,async k=>{removed.push(k);});expect(replay.replayed).toBe(events.length);expect(replay.heldAccounts).toBe(1);
  expect(await operator`select id from app.members where id=${removedMember}`).toHaveLength(0);expect(await operator`select id from public.auth_user where id=${removedMember}`).toHaveLength(0);
  expect(await operator`select id from app.posts where id in(${deleted},${timed})`).toHaveLength(0);expect(await operator`select id from app.comments where id=${child}`).toHaveLength(0);
  expect(await operator`select id from public.auth_session`).toHaveLength(0);expect(await operator`select id from public.auth_verification`).toHaveLength(0);expect((await operator`select status from app.members where id=${member}`)[0].status).toBe('hold');
  const copied=new Map<string,string>();const verify=async(item:{key:string;sha256:string;byteSize:number})=>{if(copied.get(item.key)!==bytes||item.sha256!==digest||item.byteSize!==Buffer.byteLength(bytes))throw Error('MISSING_VERIFIED_MEDIA');};
  await expect(releasePrivacyQuarantine(journal,operator,verify)).rejects.toThrow('MISSING_VERIFIED_MEDIA');expect((await readJournalControl(journal)).value.mode).toBe('quarantine');
  const restored=await restoreMediaSnapshot({journal,sql:operator,backup,snapshotId:run.id,pairedTime:run.restore_at,restoreObject:async value=>{const object=await backup.get('snapshots/'+run.id+'/objects/'+value.key.slice(6));expect(object).not.toBeNull();copied.set(value.key,await object!.text());}});expect(restored.copied).toBe(1);
  await releasePrivacyQuarantine(journal,operator,verify);expect((await readJournalControl(journal)).value.mode).toBe('active');expect((await db.status()).quarantined).toBe(false);
 });
});
