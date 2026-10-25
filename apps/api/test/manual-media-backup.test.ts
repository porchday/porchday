import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import postgres,{type Sql} from 'postgres';
import {randomUUID} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';

const source=process.env.JOURNAL_TEST_DATABASE_URL;
const suite=source?describe:describe.skip;
let admin:Sql,db:Sql,created=false;
const suffix=randomUUID().replaceAll('-',''),name='porchday_manual_backup_'+suffix+'_test';
const runtime=new Map<string,Sql>(),roles:string[]=[];

suite('Owner-only manual snapshot inventory on real PostgreSQL',()=>{
 beforeAll(async()=>{
  const url=new URL(source!);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!url.pathname.includes('test'))throw Error('DISPOSABLE_LOOPBACK_DATABASE_REQUIRED');
  url.pathname='/postgres';admin=postgres(url.href,{max:1,onnotice:()=>{}});await admin.unsafe('CREATE DATABASE '+name);created=true;
  url.pathname='/'+name;db=postgres(url.href,{max:1,onnotice:()=>{}});
  for(const filename of(await readdir(new URL('../migrations/',import.meta.url))).filter(f=>f.endsWith('.sql')).sort())await db.unsafe(await readFile(new URL('../migrations/'+filename,import.meta.url),'utf8'));
  for(const kind of ['auth','social','jobs']){
   const role='manual_'+kind+'_'+suffix;roles.push(role);
   await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'synthetic-manual-backup-test' IN ROLE porchday_${kind}`);
   const connection=new URL(url);connection.username=role;connection.password='synthetic-manual-backup-test';runtime.set(kind,postgres(connection.href,{max:1,onnotice:()=>{}}));
  }
 },30000);
 afterAll(async()=>{for(const sql of runtime.values())await sql.end();await db?.end();if(created)await admin.unsafe('DROP DATABASE '+name+' WITH (FORCE)');for(const role of roles)await admin.unsafe('DROP ROLE '+role);await admin?.end();});
 it('denies all runtime identities while keeping the daily jobs operation idempotent',async()=>{
  const [definition]=await db`select prosecdef from pg_proc where oid='app.media_backup_start_manual(uuid,timestamptz)'::regprocedure`;expect(definition.prosecdef).toBe(false);
  for(const sql of runtime.values())await expect(sql`select app.media_backup_start_manual(${randomUUID()}::uuid,clock_timestamp())`).rejects.toMatchObject({code:'42501'});
  const jobs=runtime.get('jobs')!;
  const [first]=await jobs`select app.media_backup_start(${randomUUID()}::uuid,clock_timestamp()) value`;
  const [again]=await jobs`select app.media_backup_start(${randomUUID()}::uuid,clock_timestamp()) value`;
  expect(again.value.id).toBe(first.value.id);
  expect((await db`select count(*)::int n from app.media_backup_runs where day is not null`)[0].n).toBe(1);
 });
 it('preserves daily inventory and manual retries, freezes new media only in a fresh run, and retains seven days',async()=>{
  const member=randomUUID(),asset=randomUUID();await db`insert into app.members(id,adult_attested_at,rules_accepted_at) values(${member},now(),now())`;
  const key='media/'+member+'/'+asset;
  await db`insert into app.media_assets(id,owner_id,object_key,envelope,byte_size,state,envelope_sha256,raw_sha256) values(${asset},${member},${key},'{}',100,'ready',${'a'.repeat(64)},${'b'.repeat(64)})`;
  const id=randomUUID(),[clock]=await db`select clock_timestamp() at`;
  const [first]=await db`select app.media_backup_start_manual(${id}::uuid,${clock.at}::timestamptz) value`;
  expect(first.value.day).toBeNull();expect(new Date(first.value.expires_at).getTime()-new Date(first.value.restore_at).getTime()).toBe(7*86400000);
  expect((await db`select count(*)::int n from app.media_backup_items where run_id=${id}`)[0].n).toBe(1);
  const secondAsset=randomUUID();await db`insert into app.media_assets(id,owner_id,object_key,envelope,byte_size,state,envelope_sha256,raw_sha256) values(${secondAsset},${member},${'media/'+member+'/'+secondAsset},'{}',101,'ready',${'c'.repeat(64)},${'d'.repeat(64)})`;
  const [retry]=await db`select app.media_backup_start_manual(${id}::uuid,${clock.at}::timestamptz) value`;expect(retry.value).toEqual(first.value);
  expect((await db`select count(*)::int n from app.media_backup_items where run_id=${id}`)[0].n).toBe(1);
  const next=randomUUID();await db`select app.media_backup_start_manual(${next}::uuid,clock_timestamp())`;
  expect((await db`select count(*)::int n from app.media_backup_items where run_id=${next}`)[0].n).toBe(2);
  const daily=(await db`select id from app.media_backup_runs where day is not null`)[0].id;
  expect((await db`select count(*)::int n from app.media_backup_items where run_id=${daily}`)[0].n).toBe(0);
  await expect(db`select app.media_backup_start_manual(${daily}::uuid,clock_timestamp())`).rejects.toMatchObject({message:'BACKUP_ID_CONFLICT'});
  await expect(db`select app.media_backup_start_manual(${id}::uuid,clock_timestamp()+interval '1 second')`).rejects.toMatchObject({message:'BACKUP_ID_CONFLICT'});
  await expect(db`select app.media_backup_start_manual(${randomUUID()}::uuid,clock_timestamp()-interval '2 minutes')`).rejects.toMatchObject({message:'BACKUP_CLOCK_INVALID'});
  await db`update app.safety_journal_state set restore_quarantined=true`;
  await expect(db`select app.media_backup_start_manual(${randomUUID()}::uuid,clock_timestamp())`).rejects.toMatchObject({message:'RESTORE_QUARANTINED'});
 });
});
