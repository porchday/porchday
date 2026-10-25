import {expect,test} from 'vitest';
import {Pool} from 'pg';
import {app} from '../src/index';
import {operationalIssues,recordCleanupSuccess,readOperationalHealth} from '../src/operations-health';
import type {Env} from '../src/types';

const healthy={cleanup_age_seconds:0,deletion_pending:0,deletion_age_seconds:0,identity_pending:0,identity_age_seconds:0,email_pending:0,email_failed:0,email_age_seconds:0,web_push_pending:0,native_push_pending:0};
test('alerts distinguish absent cleanup, old deletion queues, and undelivered account email',()=>{
 expect(operationalIssues(healthy)).toEqual([]);
 expect(operationalIssues({...healthy,cleanup_age_seconds:null})).toEqual(['cleanup_stale']);
 expect(operationalIssues({...healthy,deletion_age_seconds:601,identity_age_seconds:301,email_age_seconds:301})).toEqual(['media_deletion_backlog','identity_deletion_backlog','account_email_backlog']);
 expect(operationalIssues({...healthy,email_failed:1})).toEqual(['account_email_backlog']);
});
test('missing or incorrect monitoring capability cannot reach any database or R2 binding',async()=>{
 const url='https://porchday.test/api/operations/health';
 const env={ENVIRONMENT:'production',APP_URL:'https://porchday.test',OPERATIONS_HEALTH_TOKEN:'synthetic-monitoring-capability-for-tests'} as Env;
 for(const headers of [{},{Authorization:'Bearer incorrect'}]){
  const response=await app.request(url,{headers},env);
  expect(response.status).toBe(401);expect(response.headers.get('cache-control')).toBe('private, no-store');
 }
});
const base=process.env.TEST_DATABASE_URL;
test.skipIf(!base)('real restricted jobs role reports aggregate backlog and a successful heartbeat; member role cannot inspect operations',async()=>{
 const owner=new Pool({connectionString:base});
 await owner.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='porchday_health_test') THEN CREATE ROLE porchday_health_test LOGIN PASSWORD 'local-health-test' INHERIT; END IF; END $$");
 await owner.query('GRANT porchday_jobs TO porchday_health_test');
 const runtime=new URL(base!);runtime.username='porchday_health_test';runtime.password='local-health-test';
 const env={HYPERDRIVE_JOBS:{connectionString:runtime.href}} as Env;
 const fixture='operations-health-test/'+crypto.randomUUID();
 try{
  await recordCleanupSuccess(env);
  const before=await readOperationalHealth(env);
  expect(before.snapshot.cleanup_age_seconds).toBeLessThan(3);
  await owner.query("INSERT INTO app.deletion_outbox(object_key,reason,created_at) VALUES($1,'synthetic-health-test',now()-interval '11 minutes')",[fixture]);
  const after=await readOperationalHealth(env);
  expect(after.issues).toContain('media_deletion_backlog');
  expect(after.snapshot.deletion_pending).toBeGreaterThan(before.snapshot.deletion_pending);
  expect(JSON.stringify(after)).not.toContain(fixture);
  const client=await owner.connect();
  try{
   await client.query('BEGIN');await client.query('SET LOCAL ROLE porchday_social');
   await expect(client.query('SELECT app.operational_snapshot()')).rejects.toMatchObject({code:'42501'});
  }finally{await client.query('ROLLBACK');client.release();}
 }finally{await owner.query('DELETE FROM app.deletion_outbox WHERE object_key=$1',[fixture]);await owner.end();}
});
