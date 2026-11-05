import postgres from 'postgres';
import {createHash} from 'node:crypto';

export type ReleaseSchemaFingerprint={version:1;migrations:string[];functionsSha256:string;columnsSha256:string};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest=/^[a-f0-9]{64}$/;
function migrations(value:unknown):string[]{
 if(!Array.isArray(value)||!value.length||value.some(name=>typeof name!=='string'||!/^\d{3}_[a-z0-9_]+\.sql$/.test(name))||new Set(value).size!==value.length)throw Error('RELEASE_SCHEMA_MIGRATIONS_INVALID');
 return [...value].sort();
}
export function validateSchemaFingerprint(value:ReleaseSchemaFingerprint):void{
 if(value?.version!==1||!digest.test(value.functionsSha256)||!digest.test(value.columnsSha256)||JSON.stringify(migrations(value.migrations))!==JSON.stringify(value.migrations))throw Error('RELEASE_SCHEMA_FINGERPRINT_INVALID');
}
/** Equality is a drift gate, not proof that an application or migration is compatible. */
export function assertReleaseSchema(actual:ReleaseSchemaFingerprint,expected:ReleaseSchemaFingerprint):void{
 validateSchemaFingerprint(actual);validateSchemaFingerprint(expected);
 if(JSON.stringify(actual.migrations)!==JSON.stringify(expected.migrations)||actual.functionsSha256!==expected.functionsSha256||actual.columnsSha256!==expected.columnsSha256)throw Error('RELEASE_SCHEMA_CHANGED');
}
export function validateReleaseDatabaseTarget(connection:string,branchId:string):void{
 try{
  const url=new URL(connection);
  if(!/^[a-z0-9]+$/.test(branchId)||!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname.endsWith('.pg.psdb.cloud')||url.port!=='5432'||!decodeURIComponent(url.username).endsWith('.'+branchId)||[...url.searchParams].some(([key,value])=>key!=='sslmode'||value!=='verify-full')||url.searchParams.getAll('sslmode').length>1||url.hash)throw Error();
 }catch{throw Error('RELEASE_SCHEMA_TARGET_INVALID');}
}
/** Read only, direct connection, one repeatable snapshot; never reads member rows. */
export async function captureReleaseSchema(options:{connection:string;branchId:string;expectedMigrations:string[];signal:AbortSignal}):Promise<ReleaseSchemaFingerprint>{
 validateReleaseDatabaseTarget(options.connection,options.branchId);
 const expected=migrations(options.expectedMigrations);options.signal.throwIfAborted();
 const db=postgres(options.connection,{max:1,prepare:false,fetch_types:false,ssl:'verify-full',connect_timeout:5,onnotice:()=>{}});
 const cancel=()=>{void db.end({timeout:0}).catch(()=>{});};options.signal.addEventListener('abort',cancel,{once:true});
 try{
  const result=await db.begin('isolation level repeatable read read only',async tx=>{
   await tx`set local statement_timeout='5s'`;
   await tx`set local lock_timeout='1s'`;
   await tx`set local transaction_timeout='15s'`;
   const applied=await tx`select name from public.schema_migrations order by name`;
   const functions=await tx`select n.nspname as schema,p.proname as name,pg_get_function_identity_arguments(p.oid) as arguments,pg_get_functiondef(p.oid) as definition,p.prosecdef as security_definer,p.proconfig as config,p.proacl::text as acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('app','public') and p.prokind='f' order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)`;
   const columns=await tx`select table_schema,table_name,column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema in ('app','public') order by table_schema,table_name,ordinal_position`;
   return{version:1 as const,migrations:applied.map(row=>String(row.name)),functionsSha256:hash(functions),columnsSha256:hash(columns)};
  });
  if(options.signal.aborted)throw Error();
  validateSchemaFingerprint(result);
  if(JSON.stringify(result.migrations)!==JSON.stringify(expected))throw Error('RELEASE_SCHEMA_MIGRATIONS_CHANGED');
  return result;
 }catch(error){
  if(options.signal.aborted)throw Error('RELEASE_SCHEMA_CANCELLED');
  if(error instanceof Error&&error.message==='RELEASE_SCHEMA_MIGRATIONS_CHANGED')throw error;
  throw Error('RELEASE_SCHEMA_READ_FAILED');
 }finally{options.signal.removeEventListener('abort',cancel);await db.end({timeout:1}).catch(()=>{});}
}
