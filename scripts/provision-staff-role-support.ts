/** Staging recovery-role bootstrap. Reference provenance is operator confirmation,
 * not a signed token; authenticated directory lookup adds a separate cross-check. */
import type postgres from 'postgres';
import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {dirname,resolve,sep} from 'node:path';

export class StaffRoleError extends Error {}
export function requireValue(value:unknown,code:string):asserts value {if(!value)throw new StaffRoleError(code);}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export type Identity='owner'|'reviewer';
export type Reference={v:1;environment:'staging';subject:string;email:string;confirmedAt:string;source:'human-confirmed-signed-staff-identity'};
export function argumentsFor(args:string[]){
 requireValue((args.length===5||args.length===6)&&args[0]==='staging'&&args[1]==='--identity'&&['owner','reviewer'].includes(args[2])&&args[3]==='--reference-file'&&args[4]&&(args.length===5||args[5]==='--apply'),'STAFF_ROLE_ARGUMENTS');
 return {identity:args[2] as Identity,referencePath:args[4],apply:args.length===6};
}
export function expectedEmail(identity:Identity,env:NodeJS.ProcessEnv){
 const value=env[identity==='owner'?'cloudflare_username':'STAFF_STAGING_RECOVERY_REVIEWER_EMAIL']?.trim().toLowerCase();
 requireValue(value&&value.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),'STAFF_ROLE_EMAIL_CONFIGURATION');
 requireValue(!env.STAFF_PRODUCTION_RECOVERY_REVIEWER_EMAIL,'STAFF_ROLE_PRODUCTION_ROSTER');
 if(identity==='reviewer')requireValue(value!==env.cloudflare_username?.trim().toLowerCase(),'STAFF_ROLE_DISTINCT_REVIEWER');
 return value;
}
export function validateReference(value:unknown,email:string,now=Date.now()):Reference{
 requireValue(value&&typeof value==='object'&&!Array.isArray(value),'STAFF_ROLE_REFERENCE_INVALID');const r=value as Reference;
 requireValue(Object.keys(r).sort().join(',')==='confirmedAt,email,environment,source,subject,v'&&r.v===1&&r.environment==='staging'&&r.source==='human-confirmed-signed-staff-identity'&&typeof r.subject==='string'&&uuid.test(r.subject)&&typeof r.email==='string'&&r.email.toLowerCase()===email&&typeof r.confirmedAt==='string','STAFF_ROLE_REFERENCE_INVALID');
 const time=Date.parse(r.confirmedAt);requireValue(Number.isFinite(time)&&time<=now+60_000&&time>=now-24*60*60_000,'STAFF_ROLE_REFERENCE_EXPIRED');
 return {...r,email};
}
export async function readReference(path:string,email:string):Promise<Reference>{
 const boundary=resolve('artifacts/private/staff-access'),absolute=resolve(path);
 requireValue(absolute.startsWith(boundary+sep)&&absolute.endsWith('.json'),'STAFF_ROLE_PRIVATE_PATH');
 requireValue(await realpath(dirname(absolute))===dirname(absolute),'STAFF_ROLE_PRIVATE_PATH');
 let directory=dirname(absolute);
 while(directory===boundary||directory.startsWith(boundary+sep)){
  const stat=await lstat(directory);requireValue(stat.isDirectory()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0,'STAFF_ROLE_PRIVATE_PERMISSIONS');directory=dirname(directory);
 }
 const file=await open(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const stat=await file.stat();requireValue(stat.isFile()&&(stat.mode&0o777)===0o600&&stat.size<=4096,'STAFF_ROLE_PRIVATE_PERMISSIONS');return validateReference(JSON.parse(await file.readFile('utf8')),email);}finally{await file.close();}
}
export async function verifyDirectory(reference:Reference,env:NodeJS.ProcessEnv,fetcher:typeof fetch=fetch){
 const account=env.CLOUDFLARE_ACCOUNT_ID,token=env.CLOUDFLARE_API_TOKEN;
 requireValue(account&&/^[a-f0-9]{32}$/.test(account)&&token,'STAFF_ROLE_DIRECTORY_CONFIGURATION');
 let response:Response;try{response=await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}/access/users/${reference.subject}`,{headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(15_000)});}catch{throw new StaffRoleError('STAFF_ROLE_DIRECTORY_UNAVAILABLE');}
 requireValue(response.ok,'STAFF_ROLE_DIRECTORY_UNAVAILABLE');const body=await response.text();requireValue(body.length<=64*1024,'STAFF_ROLE_DIRECTORY_INVALID');
 let value:any;try{value=JSON.parse(body);}catch{throw new StaffRoleError('STAFF_ROLE_DIRECTORY_INVALID');}
 requireValue(value.success===true&&value.result?.id===reference.subject&&typeof value.result?.email==='string'&&value.result.email.toLowerCase()===reference.email&&value.result.access_seat===true,'STAFF_ROLE_DIRECTORY_MISMATCH');
 // Access-seat membership proves neither this application's admission nor MFA.
}
export function verifyAccessInventory(value:any,resources:any){
 for(const [expected,actual] of [[resources?.staff_access_identity_provider_id,value?.staff_access_identity_provider_id],[resources?.staff_access_launcher_application_id,value?.launcher?.application_id],[resources?.staff_access_launcher_policy_id,value?.launcher?.policy_id]])
  requireValue(typeof expected==='string'&&!!expected&&actual===expected,'STAFF_ROLE_ACCESS_INVENTORY');
 for(const environment of ['staging','production'])for(const field of ['staff_access_issuer','staff_access_audience','staff_access_application_id','staff_access_policy_id']){
  const expected=resources?.environments?.[environment]?.[field];
  requireValue(typeof expected==='string'&&!!expected&&value?.environments?.[environment]?.[field]===expected,'STAFF_ROLE_ACCESS_INVENTORY');
 }
}
export function stagingConnection(env:NodeJS.ProcessEnv,resources:any){
 requireValue(typeof resources?.account_id==='string'&&/^[a-f0-9]{32}$/.test(resources.account_id)&&env.CLOUDFLARE_ACCOUNT_ID===resources.account_id,'STAFF_ROLE_ACCOUNT_TARGET');
 const metadata=resources?.environments?.staging?.database;
 requireValue(metadata?.provider==='planetscale'&&metadata.name==='porchday-staging'&&metadata.branch==='main'&&metadata.engine==='postgresql','STAFF_ROLE_DATABASE_TARGET');
 const value=env.PORCHDAY_STAGING_DATABASE_MIGRATION_URL;requireValue(value,'STAFF_ROLE_DATABASE_REQUIRED');
 let url:URL;try{url=new URL(value);}catch{throw new StaffRoleError('STAFF_ROLE_DATABASE_TARGET');}
 const branch=resources?.environments?.staging?.database?.branch_id;
 requireValue(typeof branch==='string'&&!!branch&&['postgresql:','postgres:'].includes(url.protocol),'STAFF_ROLE_DATABASE_TARGET');
 requireValue(url.hostname.endsWith('.pg.psdb.cloud')&&decodeURIComponent(url.username).endsWith('.'+branch)&&url.port==='5432','STAFF_ROLE_DATABASE_TARGET');return value;
}
type Row={subject:string;email:string;active:boolean;roles:string[]};
export function classifyRows(rows:Row[],reference:Reference){
 requireValue(rows.length<=1,'STAFF_ROLE_IDENTITY_CONFLICT');if(!rows.length)return 'missing' as const;
 const row=rows[0];requireValue(row.subject===reference.subject&&row.email.toLowerCase()===reference.email,'STAFF_ROLE_IDENTITY_CONFLICT');
 requireValue(row.active===true&&Array.isArray(row.roles)&&row.roles.length===1&&row.roles[0]==='recovery','STAFF_ROLE_EXISTING_CONFIGURATION');return 'present' as const;
}
export async function provisionRole(db:ReturnType<typeof postgres>,reference:Reference,apply=false){
 const work=async(tx:postgres.TransactionSql)=>{
  await tx`set local statement_timeout='5s'`;await tx`set local lock_timeout='2s'`;
  if(apply)await tx`lock table public.staff_users in share row exclusive mode`;
  const rows=await tx<Row[]>`select subject,email,active,roles from public.staff_users where subject=${reference.subject} or lower(email)=${reference.email}`;
  if(classifyRows(rows,reference)==='present')return 'already_present' as const;
  if(!apply)return 'would_create' as const;
  await tx`insert into public.staff_users(subject,email,active,roles) values(${reference.subject},${reference.email},true,ARRAY['recovery']::text[])`;
  // staff_subject identifies the affected staff identity; approval provenance is
  // retained in the protected operator receipt, never invented as a JWT actor.
  await tx`insert into public.security_audit(staff_subject,action) values(${reference.subject},'staff_recovery_role_provisioned')`;
  const saved=await tx<Row[]>`select subject,email,active,roles from public.staff_users where subject=${reference.subject} or lower(email)=${reference.email}`;
  requireValue(classifyRows(saved,reference)==='present','STAFF_ROLE_READBACK_FAILED');return 'created' as const;
 };
 const status=apply?await db.begin(work):await db.begin('read only',work);
 if(apply){const saved=await db<Row[]>`select subject,email,active,roles from public.staff_users where subject=${reference.subject} or lower(email)=${reference.email}`;requireValue(classifyRows(saved,reference)==='present','STAFF_ROLE_READBACK_FAILED');}
 return status;
}
