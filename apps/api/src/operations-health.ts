import postgres from 'postgres';
import {z} from 'zod';
import {createMiddleware} from 'hono/factory';
import type {Env,Variables} from './types';

const count=z.number().int().nonnegative();
export const operationalSnapshotSchema=z.object({
 cleanup_age_seconds:count.nullable(),deletion_pending:count,deletion_age_seconds:count,
 identity_pending:count,identity_age_seconds:count,email_pending:count,email_failed:count,email_age_seconds:count,
 web_push_pending:count,native_push_pending:count,
}).strict();
export function operationalIssues(snapshot:z.infer<typeof operationalSnapshotSchema>){
 const issues:string[]=[];
 if(snapshot.cleanup_age_seconds===null||snapshot.cleanup_age_seconds>180)issues.push('cleanup_stale');
 if(snapshot.deletion_age_seconds>600)issues.push('media_deletion_backlog');
 if(snapshot.identity_age_seconds>300)issues.push('identity_deletion_backlog');
 if(snapshot.email_age_seconds>300||snapshot.email_failed>0)issues.push('account_email_backlog');
 return issues;
}
async function operationsDb<T>(env:Pick<Env,'HYPERDRIVE_JOBS'>,work:(sql:ReturnType<typeof postgres>)=>Promise<T>){
 const sql=postgres(env.HYPERDRIVE_JOBS.connectionString,{max:1,prepare:false,fetch_types:false,connect_timeout:5,idle_timeout:1});
 try{return await work(sql);}finally{await sql.end({timeout:1});}
}
export const recordCleanupSuccess=(env:Pick<Env,'HYPERDRIVE_JOBS'>)=>operationsDb(env,async sql=>{await sql`select app.record_cleanup_success()`;});
export const readOperationalHealth=(env:Pick<Env,'HYPERDRIVE_JOBS'>)=>operationsDb(env,async sql=>{
 const [row]=await sql`select app.operational_snapshot() as value`;
 const snapshot=operationalSnapshotSchema.parse(row.value),issues=operationalIssues(snapshot);
 return {status:issues.length?'degraded':'ok',issues,snapshot};
});

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
 await next();
});
