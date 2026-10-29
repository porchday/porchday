import postgres from 'postgres';
import {measureOperationsPhase, type RequestTiming} from './request-timing';
import {z} from 'zod';
import {createMiddleware} from 'hono/factory';
import type {Env,Variables} from './types';
import {trackPostgres} from './connection-metrics';
import {readCandidateCleanupHealth as readDenialCleanupHealth} from './session-denial-candidates';

const count=z.number().int().nonnegative();
export const operationalSnapshotSchema=z.object({
 version:z.literal(3),
 cleanup_age_seconds:count.nullable(),deletion_pending:count,deletion_age_seconds:count,
 deletion_first_pass_pending:count,deletion_first_pass_age_seconds:count,
 deletion_final_pass_pending:count,deletion_final_pass_overdue_seconds:count,
 identity_pending:count,identity_age_seconds:count,email_pending:count,email_failed:count,email_age_seconds:count,
 web_push_pending:count,native_push_pending:count,
 moderation_pending:count,moderation_age_seconds:count,recovery_pending:count,recovery_age_seconds:count,
}).strict();
export function operationalIssues(snapshot:z.infer<typeof operationalSnapshotSchema>){
 const issues:string[]=[];
 if(snapshot.cleanup_age_seconds===null||snapshot.cleanup_age_seconds>180)issues.push('cleanup_stale');
 // Retry leases never move these obligations. Final eligibility starts at ten
 // minutes; allow it to run within the design's fifteen-minute total target.
 if(snapshot.deletion_first_pass_age_seconds>600||snapshot.deletion_final_pass_overdue_seconds>300)issues.push('media_deletion_backlog');
 if(snapshot.identity_age_seconds>300)issues.push('identity_deletion_backlog');
 if(snapshot.email_age_seconds>300||snapshot.email_failed>0)issues.push('account_email_backlog');
 // Provisional review escalation, not a staffed response-time guarantee.
 // Original enqueue/verification times survive assignment and retries.
 if(snapshot.moderation_age_seconds>24*60*60)issues.push('moderation_review_backlog');
 if(snapshot.recovery_age_seconds>24*60*60)issues.push('recovery_review_backlog');
 return issues;
}
export const mediaBackupSnapshotSchema=z.object({
 last_complete_age_seconds:count.nullable(),unfinished_runs:count,oldest_unfinished_age_seconds:count,failed_runs:count,
}).strict();
export function mediaBackupIssues(snapshot:z.infer<typeof mediaBackupSnapshotSchema>,configured:boolean){
 if(!configured)return ['media_backup_not_configured'];
 const issues:string[]=[];
 if(snapshot.last_complete_age_seconds===null)issues.push('media_backup_missing');
 else if(snapshot.last_complete_age_seconds>26*60*60)issues.push('media_backup_stale');
 if(snapshot.oldest_unfinished_age_seconds>2*60*60)issues.push('media_backup_stuck');
 if(snapshot.failed_runs>0)issues.push('media_backup_retrying');
 return issues;
}
async function operationsDb<T>(env:Pick<Env,'HYPERDRIVE_JOBS'>,work:(sql:ReturnType<typeof postgres>)=>Promise<T>,timing?:RequestTiming){
 const sql=trackPostgres(env,'jobs',postgres(env.HYPERDRIVE_JOBS.connectionString,{max:1,prepare:true,fetch_types:false,connect_timeout:5,idle_timeout:1}));
 try{return await measureOperationsPhase(timing,'operations_snapshot',()=>work(sql));}finally{await measureOperationsPhase(timing,'operations_close',()=>sql.end({timeout:1}));}
}
export const recordCleanupSuccess=(env:Pick<Env,'HYPERDRIVE_JOBS'>)=>operationsDb(env,async sql=>{await sql`select app.record_cleanup_success()`;});
type HealthEnvironment=Pick<Env,'HYPERDRIVE_JOBS'>&Partial<Pick<Env,'ENVIRONMENT'|'MEDIA_BACKUP_ENABLED'|'MEDIA_BACKUP'|'RECOVERY_JOURNAL'|'SESSION_DENIAL_CLEANUP_V1'>>;
export const readOperationalHealth=async(env:HealthEnvironment,timing?:RequestTiming)=>{
 const [database,denialCleanup]=await Promise.all([operationsDb(env,async sql=>{
 const [row]=await sql`select app.operational_snapshot_v3() as value,app.media_backup_health() as backup`;
 const snapshot=operationalSnapshotSchema.parse(row.value),issues=operationalIssues(snapshot);
 const backup=mediaBackupSnapshotSchema.parse(row.backup);
 if(env.ENVIRONMENT==='staging'||env.ENVIRONMENT==='production'){
  issues.push(...mediaBackupIssues(backup,env.MEDIA_BACKUP_ENABLED==='true'&&!!env.MEDIA_BACKUP&&!!env.RECOVERY_JOURNAL));
 }
 return {issues,snapshot,backup};
 },timing),readDenialCleanupHealth(env)]);
 const issues=[...database.issues,...denialCleanup.issues];
 return {...database,status:issues.length?'degraded':'ok',issues,denial_cleanup:denialCleanup.snapshot};
};

/** Dedicated monitoring capability; cannot authenticate a member or read content. */
export const requireOperations=createMiddleware<{Bindings:Env;Variables:Variables}>(async(c,next)=>{
 const expected=c.env.OPERATIONS_HEALTH_TOKEN;
 if(!expected||expected.length<32)return c.json({error:{code:'NOT_CONFIGURED'}},404);
 const provided=c.req.header('Authorization')?.replace(/^Bearer /,'');
 if(!provided||provided.length>256)return c.json({error:{code:'UNAUTHORIZED'}},401);
 const digest=async(value:string)=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
 const [left,right]=await Promise.all([digest(expected),digest(provided)]);
 let difference=0;for(let i=0;i<left.length;i++)difference|=left[i]^right[i];
 if(difference)return c.json({error:{code:'UNAUTHORIZED'}},401);
 c.set('operationsAuthorized',true);
 await next();
});
