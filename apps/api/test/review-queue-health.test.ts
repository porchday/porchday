import {expect,test} from 'vitest';
import postgres from 'postgres';
import {operationalSnapshotSchema,operationalIssues} from '../src/operations-health';

const url=process.env.TEST_DATABASE_URL;
test.skipIf(!url)('real PostgreSQL review aggregates exclude unverified/resolved/expired cases and preserve role isolation and old snapshots',async()=>{
 const target=new URL(url!);if(!['localhost','127.0.0.1'].includes(target.hostname))throw Error('Loopback test database required');
 const sql=postgres(url!,{max:1,onnotice:()=>{}});
 try{
  await sql.begin(async tx=>{
   const [before]=await tx`select app.operational_snapshot_v3() as value`;
   const report=crypto.randomUUID(),recovery=crypto.randomUUID();
   for(const [state,age,retained] of [['received',90001,true],['reviewing',80000,true],['appealed',100,true],['resolved',95000,true],['received',95000,false]] as const){
    await tx`insert into app.reports(id,reason,status,created_at,retention_until) values(${state==='received'&&retained?report:crypto.randomUUID()},'other',${state},now()-${age}*interval '1 second',now()+${retained?1:-1}*interval '1 day')`;
   }
   for(const [state,verified,age,retained] of [['submitted',true,90002,true],['reviewing',true,80000,true],['hold',true,100,true],['contact_pending',false,95000,true],['submitted',false,95000,true],['restored',true,95000,true],['denied',true,95000,true],['hold',true,95000,false]] as const){
    const id=state==='submitted'&&verified?recovery:crypto.randomUUID();
    await tx`insert into public.recovery_cases(id,account_reference,safe_email,contact_token_hash,contact_token_expires_at,state,created_at,contact_verified_at,retention_until) values(${id},'private synthetic account','synthetic@example.test',${crypto.randomUUID()},now()+interval '1 hour',${state},now()-interval '3 days',CASE WHEN ${verified} THEN now()-${age}*interval '1 second' ELSE NULL END,now()+${retained?1:-1}*interval '1 day')`;
   }
   await tx`set local role porchday_jobs`;
   const [row]=await tx`select app.operational_snapshot_v3() as value,app.operational_snapshot_v2() as v2,app.operational_snapshot() as v1`;
   const current=operationalSnapshotSchema.parse(row.value);
   expect(current.moderation_pending-before.value.moderation_pending).toBe(3);expect(current.recovery_pending-before.value.recovery_pending).toBe(3);
   expect(current.moderation_age_seconds).toBeGreaterThanOrEqual(90001);expect(current.recovery_age_seconds).toBeGreaterThanOrEqual(90002);
   expect(operationalIssues(current)).toEqual(expect.arrayContaining(['moderation_review_backlog','recovery_review_backlog']));
   expect(row.v2.version).toBe(2);expect(row.v2).not.toHaveProperty('moderation_pending');expect(row.v1).not.toHaveProperty('version');
   expect(JSON.stringify(row)).not.toMatch(/private synthetic|example\.test/);expect(JSON.stringify(row)).not.toContain(report);expect(JSON.stringify(row)).not.toContain(recovery);
   await tx`reset role`;
   // Reviewer assignment and an unrelated edit do not restart the queue clock.
   await tx`update public.recovery_cases set updated_at=now() where id=${recovery}`;
   const [edited]=await tx`select app.operational_snapshot_v3() as value`;expect(edited.value.recovery_age_seconds).toBe(current.recovery_age_seconds);
   for(const role of ['porchday_social','porchday_auth']){
    await tx.savepoint(async inner=>{await inner.unsafe('set local role '+role);await expect(inner`select app.operational_snapshot_v3()`).rejects.toMatchObject({code:'42501'});throw Error('ROLLBACK_DENIED_PROBE');}).catch(error=>{if(error.message!=='ROLLBACK_DENIED_PROBE')throw error;});
   }
   await tx.savepoint(async inner=>{await inner`set local role porchday_jobs`;await expect(inner`select safe_email from public.recovery_cases`).rejects.toMatchObject({code:'42501'});throw Error('ROLLBACK_DENIED_PROBE');}).catch(error=>{if(error.message!=='ROLLBACK_DENIED_PROBE')throw error;});
   throw Error('ROLLBACK_SYNTHETIC_FIXTURES');
  });
 }catch(error){if((error as Error).message!=='ROLLBACK_SYNTHETIC_FIXTURES')throw error;}finally{await sql.end();}
});
