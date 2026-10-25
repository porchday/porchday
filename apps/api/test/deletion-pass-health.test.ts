import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import postgres,{type Sql} from 'postgres';
import {cleanupExpired} from '../src/db';
import {readOperationalHealth,recordCleanupSuccess} from '../src/operations-health';
import type {Env} from '../src/types';

const base=process.env.TEST_DATABASE_URL;
const suite=base?describe:describe.skip;
let admin:Sql,owner:Sql,env:Env;
const suffix=randomUUID().replaceAll('-','');
const database='porchday_delete_pass_'+suffix,role='porchday_delete_jobs_'+suffix;
const objects=new Set<string>();let deletes=0,failDelete=false;
suite('real PostgreSQL deletion pass acknowledgements and operational deadlines',()=>{
 beforeAll(async()=>{
  const url=new URL(base!);
  if(!['127.0.0.1','localhost'].includes(url.hostname))throw Error('Disposable loopback database required');
  url.pathname='/postgres';admin=postgres(url.href,{max:1,onnotice:()=>{}});
  await admin.unsafe('CREATE DATABASE '+database);url.pathname='/'+database;
  owner=postgres(url.href,{max:1,onnotice:()=>{}});
  for(const name of(await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await owner.unsafe(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  await owner.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'synthetic-local-deletion-test' IN ROLE porchday_jobs`);
  url.username=role;url.password='synthetic-local-deletion-test';
  env={HYPERDRIVE_JOBS:{connectionString:url.href},MEDIA:{delete:async(key:string)=>{deletes++;if(failDelete)throw Error('synthetic storage failure');objects.delete(key);}}} as unknown as Env;
 },30000);
 beforeEach(async()=>{objects.clear();deletes=0;failDelete=false;await owner`delete from app.deletion_outbox`;await recordCleanupSuccess(env);});
 afterAll(async()=>{
  if(owner)await owner.end();
  if(admin){await admin.unsafe('DROP DATABASE IF EXISTS '+database+' WITH(FORCE)');await admin.unsafe('DROP ROLE IF EXISTS '+role);await admin.end();}
 });
 async function insert(age:number,reason='synthetic-deletion'){
  const key='synthetic/'+randomUUID();objects.add(key);
  await owner`insert into app.deletion_outbox(object_key,reason,created_at) values(${key},${reason},now()-${age}*interval '1 second')`;
  return key;
 }
 it('records first success, waits for the fixed final floor, and excludes completed work',async()=>{
  const key=await insert(10);
  await cleanupExpired(env);
  const [first]=await owner`select created_at,first_deleted_at,completed_at,attempts,next_retry from app.deletion_outbox where object_key=${key}`;
  expect(first.first_deleted_at).toBeInstanceOf(Date);expect(first.completed_at).toBeNull();expect(first.attempts).toBe(1);expect(objects.has(key)).toBe(false);
  expect(first.next_retry.getTime()-first.created_at.getTime()).toBe(600000);
  const health=await readOperationalHealth(env);
  expect(health.snapshot).toMatchObject({version:2,deletion_pending:1,deletion_first_pass_pending:0,deletion_first_pass_age_seconds:0,deletion_final_pass_pending:1,deletion_final_pass_overdue_seconds:0});
  expect(health.issues).toEqual([]);
  await cleanupExpired(env);expect(deletes).toBe(1); // The not-yet-due final pass is not claimed.
  // Advance this disposable fixture's creation point; no live clock/queue is changed.
  await owner`update app.deletion_outbox set created_at=now()-interval '11 minutes',next_retry=now() where object_key=${key}`;
  objects.add(key); // A bounded late writer after the initial delete.
  await cleanupExpired(env);
  const [final]=await owner`select first_deleted_at,completed_at,attempts from app.deletion_outbox where object_key=${key}`;
  expect(final.first_deleted_at).toEqual(first.first_deleted_at);expect(final.completed_at).toBeInstanceOf(Date);expect(final.attempts).toBe(2);expect(objects.has(key)).toBe(false);
  expect((await readOperationalHealth(env)).snapshot).toMatchObject({deletion_pending:0,deletion_first_pass_pending:0,deletion_final_pass_pending:0,deletion_final_pass_overdue_seconds:0});
 });
 it('warns about failed first deletion even when backoff or a crashed claim has a future lease',async()=>{
  const key=await insert(610);failDelete=true;await cleanupExpired(env);
  const [row]=await owner`select first_deleted_at,completed_at,attempts,next_retry>now() as deferred from app.deletion_outbox where object_key=${key}`;
  expect(row).toMatchObject({first_deleted_at:null,completed_at:null,attempts:1,deferred:true});expect(objects.has(key)).toBe(true);
  const first=await readOperationalHealth(env);expect(first.issues).toContain('media_deletion_backlog');expect(first.snapshot.deletion_first_pass_age_seconds).toBeGreaterThanOrEqual(610);
  // Claim count and an in-flight/crashed lease are never evidence of success.
  await owner`update app.deletion_outbox set attempts=4,next_retry=now()+interval '5 minutes' where object_key=${key}`;
  const claimed=await readOperationalHealth(env);expect(claimed.issues).toContain('media_deletion_backlog');expect(claimed.snapshot.deletion_first_pass_pending).toBe(1);expect(claimed.snapshot.deletion_final_pass_pending).toBe(0);
 });
 it('does not fabricate success after R2 deletion when the SQL acknowledgement fails',async()=>{
  const key=await insert(610,'reject-ack');
  await owner.unsafe("CREATE FUNCTION app.reject_test_delete_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.reason='reject-ack' AND NEW.first_deleted_at IS DISTINCT FROM OLD.first_deleted_at THEN RAISE EXCEPTION 'synthetic acknowledgement failure'; END IF; RETURN NEW; END $$");
  await owner.unsafe('CREATE TRIGGER reject_test_delete_ack BEFORE UPDATE ON app.deletion_outbox FOR EACH ROW EXECUTE FUNCTION app.reject_test_delete_ack()');
  try{
   await cleanupExpired(env);expect(objects.has(key)).toBe(false);
   const [row]=await owner`select first_deleted_at,completed_at,attempts from app.deletion_outbox where object_key=${key}`;
   expect(row).toMatchObject({first_deleted_at:null,completed_at:null,attempts:1});
   expect((await readOperationalHealth(env)).issues).toContain('media_deletion_backlog');
  }finally{await owner.unsafe('DROP TRIGGER reject_test_delete_ack ON app.deletion_outbox');await owner.unsafe('DROP FUNCTION app.reject_test_delete_ack()');}
  await owner`update app.deletion_outbox set next_retry=now() where object_key=${key}`;
  await cleanupExpired(env);expect(deletes).toBe(2); // Idempotently confirms already-absent bytes.
  const [confirmed]=await owner`select first_deleted_at,completed_at from app.deletion_outbox where object_key=${key}`;
  expect(confirmed.first_deleted_at).toBeInstanceOf(Date);expect(confirmed.completed_at).toBeInstanceOf(Date);
 });
 it('measures final delay from creation, unaffected by failure/backoff, and preserves v1 rollout compatibility',async()=>{
  const key=await insert(712);
  await owner`update app.deletion_outbox set first_deleted_at=created_at+interval '20 seconds',attempts=1,next_retry=now()+interval '30 minutes' where object_key=${key}`;
  const [old]=await owner`select app.operational_snapshot() as value`;
  expect(old.value).not.toHaveProperty('version');expect(old.value).not.toHaveProperty('deletion_first_pass_pending');expect(old.value.deletion_age_seconds).toBeGreaterThanOrEqual(712);
  const waiting=await readOperationalHealth(env);expect(waiting.issues).toEqual([]);expect(waiting.snapshot.deletion_final_pass_overdue_seconds).toBeGreaterThanOrEqual(112);
  await owner`update app.deletion_outbox set created_at=now()-interval '901 seconds',next_retry=now() where object_key=${key}`;
  const [before]=await owner`select first_deleted_at from app.deletion_outbox where object_key=${key}`;
  failDelete=true;await cleanupExpired(env);
  const overdue=await readOperationalHealth(env);expect(overdue.issues).toContain('media_deletion_backlog');expect(overdue.snapshot.deletion_final_pass_overdue_seconds).toBeGreaterThanOrEqual(301);
  const [after]=await owner`select first_deleted_at,completed_at,next_retry>now() as deferred from app.deletion_outbox where object_key=${key}`;
  expect(after).toMatchObject({first_deleted_at:before.first_deleted_at,completed_at:null,deferred:true});
  await expect(owner.begin(async tx=>{await tx`set local role porchday_social`;await tx`select app.operational_snapshot_v2()`;})).rejects.toMatchObject({code:'42501'});
  expect(JSON.stringify(overdue)).not.toContain(key);
 });
});
