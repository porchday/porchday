/** Operator-only fixed aggregate snapshot. Never query SQL text or member rows. */
import postgres from 'postgres';
import {readFile} from 'node:fs/promises';

const environment=process.argv[2];
let sql:ReturnType<typeof postgres>|undefined;
try{
 if(process.argv.length!==3||!['staging','production'].includes(environment))throw Error('USE_DATABASE_CAPACITY_STAGING_OR_PRODUCTION');
 const resources=JSON.parse(await readFile(new URL('../infra/resources.json',import.meta.url),'utf8'));
 const configured=resources.environments[environment],value=process.env['PORCHDAY_'+environment.toUpperCase()+'_DATABASE_MIGRATION_URL'];
 if(!value)throw Error('DATABASE_CAPACITY_CREDENTIAL_REQUIRED');
 const url=new URL(value);
 if(!url.hostname.endsWith('.pg.psdb.cloud')||!decodeURIComponent(url.username).endsWith('.'+configured.database.branch_id)||url.port!=='5432')throw Error('DATABASE_CAPACITY_TARGET_MISMATCH');
 sql=postgres(value,{max:1,prepare:false,fetch_types:false,connect_timeout:5,ssl:'verify-full',onnotice:()=>{}});
 const row=await sql.begin('read only',async tx=>{
  await tx`set local statement_timeout='5s'`;
  const [result]=await tx`with activity as (
   select a.*,case
    when exists(select 1 from pg_roles r where r.oid=a.usesysid and r.rolsuper) then 'superuser'
    when pg_has_role(a.usesysid,'porchday_auth','USAGE') then 'auth'
    when pg_has_role(a.usesysid,'porchday_social','USAGE') then 'social'
    when pg_has_role(a.usesysid,'porchday_jobs','USAGE') then 'jobs'
    else 'other' end as category
   from pg_stat_activity a where backend_type='client backend'
  ) select clock_timestamp() as checked_at,
   pg_database_size(current_database())::text as database_bytes,
   current_setting('max_connections')::int as server_connection_limit,
   current_setting('superuser_reserved_connections')::int as reserved_connections,
   count(*)::int as server_connections,
   count(*) filter(where datname=current_database())::int as database_connections,
   count(*) filter(where datname=current_database() and state='active')::int as active_connections,
   count(*) filter(where datname=current_database() and state='idle in transaction')::int as idle_transaction_connections,
   count(*) filter(where category='superuser')::int as superuser_connections,
   count(*) filter(where category='auth')::int as auth_connections,
   count(*) filter(where category='social')::int as social_connections,
   count(*) filter(where category='jobs')::int as jobs_connections,
   count(*) filter(where category='other')::int as other_connections
   from activity`;
  return result;
 });
 const data:Record<string,string|number>={environment,checked_at:new Date(row.checked_at).toISOString()};
 for(const key of ['database_bytes','server_connection_limit','reserved_connections','server_connections','database_connections',
  'active_connections','idle_transaction_connections','superuser_connections','auth_connections','social_connections','jobs_connections','other_connections']){
  const number=Number(row[key]);if(!Number.isSafeInteger(number)||number<0)throw Error('DATABASE_CAPACITY_RESPONSE_INVALID');data[key]=number;
 }
 console.log(JSON.stringify(data));
}catch(error){const code=(error as Error).message;console.error(/^[A-Z_]{3,80}$/.test(code)?code:'DATABASE_CAPACITY_UNAVAILABLE');process.exitCode=1;}
finally{await sql?.end({timeout:1});}
