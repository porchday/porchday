import {expect,it,vi} from 'vitest';
import type {Env} from '../src/types';
const mock=vi.hoisted(()=>({end:vi.fn(async()=>{})}));
vi.mock('postgres',()=>({default:()=>Object.assign(async()=>[{
 value:{version:3,cleanup_age_seconds:0,deletion_pending:0,deletion_age_seconds:0,deletion_first_pass_pending:0,deletion_first_pass_age_seconds:0,deletion_final_pass_pending:0,deletion_final_pass_overdue_seconds:0,identity_pending:0,identity_age_seconds:0,email_pending:0,email_failed:0,email_age_seconds:0,web_push_pending:0,native_push_pending:0,moderation_pending:0,moderation_age_seconds:0,recovery_pending:0,recovery_age_seconds:0},
 backup:{last_complete_age_seconds:0,unfinished_runs:0,oldest_unfinished_age_seconds:0,failed_runs:0},
}],{end:mock.end})}));
import {readOperationalHealth} from '../src/operations-health';
import {denialProgressKey} from '../src/session-denial-progress';
it('healthy ordinary cleanup cannot hide stalled denial cleanup, and fresh denial progress recovers health',async()=>{
 let age=181000;
 const store={get:async(key:string)=>{
  expect(key).toBe(denialProgressKey);const at=Date.now()-age;
  return {etag:'progress',text:async()=>JSON.stringify({v:2,cursor:null,pageCompletedAt:at,passStartedAt:null,passSeen:0,passInvalid:0,lastPass:{completedAt:at,durationMs:0,seen:0,invalid:0}})};
 }};
 const env={HYPERDRIVE_JOBS:{connectionString:'postgres://not-connected'},SESSION_DENIAL_CLEANUP_V1:'true',RECOVERY_JOURNAL:store} as unknown as Env;
 const stale=await readOperationalHealth(env);expect(stale.snapshot.cleanup_age_seconds).toBe(0);
 expect(stale.status).toBe('degraded');expect(stale.issues).toEqual(['session_denial_cleanup_stale']);
 age=0;expect((await readOperationalHealth(env)).status).toBe('ok');
 expect((await readOperationalHealth({...env,SESSION_DENIAL_CLEANUP_V1:undefined})).denial_cleanup).toBeNull();
});
it('releases the SQL connection while a bounded independent health read is still stalled',async()=>{
 mock.end.mockClear();vi.useFakeTimers();
 try{
  const env={HYPERDRIVE_JOBS:{connectionString:'postgres://not-connected'},SESSION_DENIAL_CLEANUP_V1:'true',RECOVERY_JOURNAL:{get:()=>new Promise(()=>{})}} as unknown as Env;
  const pending=readOperationalHealth(env);await vi.advanceTimersByTimeAsync(1);expect(mock.end).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1999);const result=await pending;
  expect(result.snapshot.cleanup_age_seconds).toBe(0);expect(result.status).toBe('degraded');expect(result.issues).toEqual(['session_denial_cleanup_unavailable']);
 }finally{vi.useRealTimers();}
});
