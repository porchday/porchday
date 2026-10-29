import {test,expect} from 'vitest';
import postgres from 'postgres';
import {mkdtemp, mkdir, readdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
const connection=process.env.MIGRATION_BOUND_TEST_DATABASE_URL;
test.skipIf(!connection)('migration 052 times out behind a writer, rolls back completely, then applies only after verified rollback',async()=>{
 const url=new URL(connection!);
 if(!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/porchday_migration_bounds_test')throw Error('DEDICATED_LOCAL_MIGRATION_DATABASE_REQUIRED');
 const db=postgres(url.href,{max:1,prepare:false,onnotice:()=>{}}),blocker=postgres(url.href,{max:1,prepare:false,onnotice:()=>{}});
 const root=await mkdtemp(join(tmpdir(),'porchday-migration-bounds-')),directory=join(root,'apps/api/migrations');
 const source=resolve('apps/api/migrations'),script=resolve('scripts/migrate.ts');
 const run=()=>new Promise<{code:number|null;stderr:string}>((done,reject)=>{
  const child=spawn(process.execPath,[script],{cwd:root,env:{...process.env,DATABASE_MIGRATION_URL:url.href,PG_LOCAL:'true'},stdio:['ignore','ignore','pipe']});let stderr='';
  child.stderr.on('data',chunk=>{stderr+=chunk.toString();});child.on('error',reject);child.on('close',code=>done({code,stderr}));
 });
 let release:(()=>void)|undefined,held:Promise<unknown>|undefined,pending:Promise<unknown>|undefined;
 try{
  // Refuse an existing populated database. The harness creates/drops this unique
  // local database; this test must never erase somebody else's schema.
  expect((await db`select to_regclass('public.schema_migrations') as value`)[0].value).toBeNull();
  await mkdir(directory,{recursive:true});
  for(const name of await readdir(source))if(name.endsWith('.sql')&&name!=='052_group_invitation_roster.sql')await writeFile(join(directory,name),await readFile(join(source,name)));
  expect((await run()).code).toBe(0);
  await writeFile(join(directory,'052_group_invitation_roster.sql'),await readFile(join(source,'052_group_invitation_roster.sql')));
  const before=(await db`select has_column_privilege('porchday_social','app.group_invitations','inviter','UPDATE') as allowed`)[0].allowed;
  let ready!:()=>void;const acquired=new Promise<void>(r=>{ready=r;});const hold=new Promise<void>(r=>{release=r;});
  held=blocker.begin(async tx=>{await tx`LOCK TABLE app.group_invitations IN ROW EXCLUSIVE MODE`;ready();await hold;});await acquired;
  const started=performance.now(),attempt=run();pending=attempt;
  const deadline=performance.now()+2500;let waiting=false;
  while(performance.now()<deadline){
   waiting=(await db`select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name='porchday-schema-migration' and l.relation='app.group_invitations'::regclass and not l.granted`).length>0;
   if(waiting)break;await new Promise(r=>setTimeout(r,10));
  }
  expect(waiting).toBe(true);
  // AccessShare reads remain available while the observed stronger lock waits.
  const readStart=performance.now();await db`select count(*) from app.group_invitations`;const readMs=performance.now()-readStart;expect(readMs).toBeLessThan(1000);
  const result=await attempt,elapsed=performance.now()-started;
  expect(result.code).toBe(1);expect(result.stderr).toContain('reconcile schema');if(url.password)expect(result.stderr).not.toContain(url.password);
  expect(elapsed).toBeGreaterThan(700);expect(elapsed).toBeLessThan(5000);
  expect(await db`select name from public.schema_migrations where name='052_group_invitation_roster.sql'`).toHaveLength(0);
  expect((await db`select to_regprocedure('app.owner_group_invitations(uuid,timestamp with time zone,uuid)') as value`)[0].value).toBeNull();
  expect((await db`select to_regprocedure('app.check_group_invitation_inviter()') as value`)[0].value).toBeNull();
  expect(await db`select 1 from pg_trigger where tgname='group_invitation_inviter'`).toHaveLength(0);
  expect((await db`select has_column_privilege('porchday_social','app.group_invitations','inviter','UPDATE') as allowed`)[0].allowed).toBe(before);
  release!();await held;held=undefined;
  // A distinct local test invocation follows read-only proof of full rollback.
  expect((await run()).code).toBe(0);
  expect(await db`select name from public.schema_migrations where name='052_group_invitation_roster.sql'`).toHaveLength(1);
  expect(await db`select 1 from pg_trigger where tgname='group_invitation_inviter'`).toHaveLength(1);
  console.info('migration-bound-evidence',JSON.stringify({blockedAttemptMs:elapsed,readWhileWaitingMs:readMs,rollbackVerified:true,subsequentLocalApplyVerified:true}));
 }finally{release?.();await held;await pending;await blocker.end({timeout:5});await db.end({timeout:5});await rm(root,{recursive:true,force:true});}
},60000);
