import {test,expect,describe,beforeAll,beforeEach,afterAll} from 'vitest';
import postgres from 'postgres';
import {mkdir,writeFile,chmod,rm,symlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {argumentsFor,expectedEmail,validateReference,readReference,verifyDirectory,verifyAccessInventory,stagingConnection,provisionRole,type Reference} from './provision-staff-role-support.js';
const reference:Reference={v:1,environment:'staging',subject:'678432db-b480-4e94-a566-e1d9c6715bb2',email:'reviewer@example.test',confirmedAt:new Date().toISOString(),source:'human-confirmed-signed-staff-identity'};
const env={cloudflare_username:'owner@example.test',STAFF_STAGING_RECOVERY_REVIEWER_EMAIL:'reviewer@example.test',CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_API_TOKEN:'synthetic-token'};

test('CLI defaults to read-only and permits only explicit staging recovery identity choices',()=>{
 const base=['staging','--identity','reviewer','--reference-file','artifacts/private/staff-access/reference.json'];
 expect(argumentsFor(base).apply).toBe(false);expect(argumentsFor([...base,'--apply']).apply).toBe(true);
 for(const args of [[...base,'--role','moderation'],['production',...base.slice(1)],[...base.slice(0,2),'arbitrary',...base.slice(3)],[...base,'--apply','extra']])expect(()=>argumentsFor(args)).toThrow('STAFF_ROLE_ARGUMENTS');
 expect(expectedEmail('reviewer',env)).toBe(reference.email);
 expect(()=>expectedEmail('reviewer',{...env,STAFF_STAGING_RECOVERY_REVIEWER_EMAIL:env.cloudflare_username})).toThrow('DISTINCT_REVIEWER');
 expect(()=>expectedEmail('owner',{...env,STAFF_PRODUCTION_RECOVERY_REVIEWER_EMAIL:'other@example.test'})).toThrow('PRODUCTION_ROSTER');
});
test('private reference requires exact confirmed identity, provenance and bounded freshness without token fields',()=>{
 expect(validateReference(reference,reference.email)).toEqual(reference);
 for(const patch of [{subject:'not-a-subject'},{email:'other@example.test'},{environment:'production'},{source:'directory-only'},{jwt:'fake'},{confirmedAt:new Date(Date.now()-25*60*60_000).toISOString()},{confirmedAt:new Date(Date.now()+120_000).toISOString()}])expect(()=>validateReference({...reference,...patch},reference.email)).toThrow('STAFF_ROLE_REFERENCE');
});
test('reference reader accepts private0600 JSON but rejects public permissions, symlinks and paths outside boundary',async()=>{
 const dir='artifacts/private/staff-access/test-'+randomUUID(),path=dir+'/reference.json';await mkdir(dir,{recursive:true,mode:0o700});
 try{
  await writeFile(path,JSON.stringify(reference),{mode:0o600});expect(await readReference(path,reference.email)).toEqual(reference);
  await chmod(path,0o644);await expect(readReference(path,reference.email)).rejects.toThrow('PRIVATE_PERMISSIONS');await chmod(path,0o600);
  await symlink('reference.json',dir+'/link.json');await expect(readReference(dir+'/link.json',reference.email)).rejects.toThrow();
  await expect(readReference('/tmp/reference.json',reference.email)).rejects.toThrow('PRIVATE_PATH');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('authenticated Cloudflare directory requires same UUID and configured email; no directory claim is MFA proof',async()=>{
 const request=async(input:any,options:any)=>{
  expect(String(input)).toBe('https://api.cloudflare.com/client/v4/accounts/'+env.CLOUDFLARE_ACCOUNT_ID+'/access/users/'+reference.subject);
  expect(options.headers.Authorization).toBe('Bearer synthetic-token');expect(options.redirect).toBe('error');
  return Response.json({success:true,result:{id:reference.subject,email:'Reviewer@example.test',access_seat:true}});
 };
 await verifyDirectory(reference,env,request as typeof fetch);
 for(const result of [{id:randomUUID(),email:reference.email,access_seat:true},{id:reference.subject,email:'other@example.test',access_seat:true},{id:reference.subject,email:reference.email,access_seat:false}])await expect(verifyDirectory(reference,env,(async()=>Response.json({success:true,result}))as typeof fetch)).rejects.toThrow('DIRECTORY_MISMATCH');
 await expect(verifyDirectory(reference,env,(async()=>new Response('private provider email', {status:403}))as typeof fetch)).rejects.toThrow('STAFF_ROLE_DIRECTORY_UNAVAILABLE');
});
test('database target uses staging branch only and verified-TLS provider hostname',()=>{
 const resources={account_id:env.CLOUDFLARE_ACCOUNT_ID,environments:{staging:{database:{provider:'planetscale',name:'porchday-staging',branch:'main',engine:'postgresql',branch_id:'stage-branch'}}}};
 // URL validation only: this fixture never opens a connection or needs a password.
 const value='postgresql://operator.stage-branch@sample.pg.psdb.cloud:5432/postgres';
 expect(stagingConnection({...env,PORCHDAY_STAGING_DATABASE_MIGRATION_URL:value},resources)).toBe(value);
 expect(()=>stagingConnection({...env,CLOUDFLARE_ACCOUNT_ID:'b'.repeat(32),PORCHDAY_STAGING_DATABASE_MIGRATION_URL:value},resources)).toThrow('ACCOUNT_TARGET');
 expect(()=>stagingConnection({...env,PORCHDAY_STAGING_DATABASE_MIGRATION_URL:value},{...resources,environments:{staging:{database:{...resources.environments.staging.database,name:'porchday-production'}}}})).toThrow('DATABASE_TARGET');
 for(const url of [value.replace('stage-branch','production-branch'),value.replace('.pg.psdb.cloud','.example.test'),value.replace(':5432',':6432'),value.replace('postgresql:','https:')])expect(()=>stagingConnection({...env,PORCHDAY_STAGING_DATABASE_MIGRATION_URL:url},resources)).toThrow('DATABASE_TARGET');
});

test('Access readback must match saved provider, launcher and both application identities',()=>{
 const staging={staff_access_issuer:'https://porchday-staff.cloudflareaccess.com',staff_access_audience:'a'.repeat(64),staff_access_application_id:'stage-app',staff_access_policy_id:'stage-policy'};
 const production={...staging,staff_access_audience:'b'.repeat(64),staff_access_application_id:'prod-app',staff_access_policy_id:'prod-policy'};
 const resources={staff_access_identity_provider_id:'otp',staff_access_launcher_application_id:'launcher',staff_access_launcher_policy_id:'launcher-policy',environments:{staging,production}};
 const output={staff_access_identity_provider_id:'otp',launcher:{application_id:'launcher',policy_id:'launcher-policy'},environments:{staging,production}};
 expect(()=>verifyAccessInventory(output,resources)).not.toThrow();
 for(const key of ['staff_access_identity_provider_id','staff_access_launcher_application_id','staff_access_launcher_policy_id']){
  const missing=structuredClone(resources),actual=structuredClone(output);delete (missing as any)[key];
  if(key==='staff_access_identity_provider_id')delete (actual as any).staff_access_identity_provider_id;
  else delete (actual.launcher as any)[key==='staff_access_launcher_application_id'?'application_id':'policy_id'];
  expect(()=>verifyAccessInventory(actual,missing)).toThrow('ACCESS_INVENTORY');
 }
 expect(()=>verifyAccessInventory({...output,staff_access_identity_provider_id:'another'},resources)).toThrow('ACCESS_INVENTORY');
 expect(()=>verifyAccessInventory({...output,environments:{staging,production:{...production,staff_access_audience:'c'.repeat(64)}}},resources)).toThrow('ACCESS_INVENTORY');
});

const databaseUrl=process.env.STAFF_ROLE_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('real local database role transaction',()=>{
 let db:ReturnType<typeof postgres>;
 beforeAll(async()=>{
  const target=new URL(databaseUrl!);if(!['localhost','127.0.0.1'].includes(target.hostname)||target.pathname!=='/porchday_staff_role_test')throw Error('LOCAL_STAFF_ROLE_TEST_DATABASE_REQUIRED');
  db=postgres(databaseUrl!,{max:4,prepare:false,onnotice:()=>{}});
  await db`create table if not exists public.staff_users(subject text primary key,email text not null,active boolean not null,roles text[] not null)`;
  await db`create table if not exists public.security_audit(id bigint generated always as identity,staff_subject text,action text not null)`;
 });
 beforeEach(async()=>{await db`truncate public.staff_users,public.security_audit`;});
 afterAll(async()=>{await db?.end();});
 test('default only reports prospective grant and writes neither row nor audit',async()=>{
  expect(await provisionRole(db,reference)).toBe('would_create');expect((await db`select count(*)::int n from public.staff_users`)[0].n).toBe(0);expect((await db`select count(*)::int n from public.security_audit`)[0].n).toBe(0);
 });
 test('one explicit grant is audited and exact repeated grant is idempotent',async()=>{
  expect(await provisionRole(db,reference,true)).toBe('created');expect(await provisionRole(db,reference,true)).toBe('already_present');expect(await provisionRole(db,reference)).toBe('already_present');
  expect((await db`select action,staff_subject from public.security_audit`)).toEqual([{action:'staff_recovery_role_provisioned',staff_subject:reference.subject}]);
 });
 test('same email/different subject and same subject/different email are not overwritten',async()=>{
  await provisionRole(db,reference,true);
  await expect(provisionRole(db,{...reference,subject:randomUUID()},true)).rejects.toThrow('IDENTITY_CONFLICT');
  await expect(provisionRole(db,{...reference,email:'different@example.test'},true)).rejects.toThrow('IDENTITY_CONFLICT');
  expect((await db`select email from public.staff_users`)).toEqual([{email:reference.email}]);expect((await db`select count(*)::int n from public.security_audit`)[0].n).toBe(1);
 });
 test('inactive or non-exact roles are never silently reactivated or expanded',async()=>{
  for(const row of [{active:false,roles:['recovery']},{active:true,roles:[]},{active:true,roles:['moderation']},{active:true,roles:['recovery','moderation']}]){
   await db`truncate public.staff_users`;await db`insert into public.staff_users values(${reference.subject},${reference.email},${row.active},${db.array(row.roles)})`;
   await expect(provisionRole(db,reference,true)).rejects.toThrow('EXISTING_CONFIGURATION');
   expect((await db`select active,roles from public.staff_users`)[0]).toEqual(row);
  }
 });
 test('audit failure rolls back the role grant',async()=>{
  await db`alter table public.security_audit add constraint reject_bootstrap check(action<>'staff_recovery_role_provisioned')`;
  try{await expect(provisionRole(db,reference,true)).rejects.toThrow();expect((await db`select count(*)::int n from public.staff_users`)[0].n).toBe(0);}finally{await db`alter table public.security_audit drop constraint reject_bootstrap`;}
 });
 test('concurrent duplicate submissions serialize to one grant and one audit',async()=>{
  expect((await Promise.all([provisionRole(db,reference,true),provisionRole(db,reference,true)])).sort()).toEqual(['already_present','created']);expect((await db`select count(*)::int n from public.staff_users`)[0].n).toBe(1);expect((await db`select count(*)::int n from public.security_audit`)[0].n).toBe(1);
 });
});
