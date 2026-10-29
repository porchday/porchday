import postgres from 'postgres';
import { readdir,readFile } from 'node:fs/promises';
const url=process.env.DATABASE_MIGRATION_URL;
if(!url)throw new Error('DATABASE_MIGRATION_URL is required; load it without printing it.');
// Bound schema-ledger operations as well as DDL. A queued schema lock must not
// wait indefinitely behind live traffic. Timeouts stop this run, never retry it.
const db=postgres(url,{max:1,prepare:false,connect_timeout:5,ssl:process.env.PG_LOCAL==='true'?false:'verify-full',connection:{application_name:'porchday-schema-migration',lock_timeout:1000,statement_timeout:15000,idle_in_transaction_session_timeout:10000},onnotice:()=>{}});
try {
 await db`CREATE TABLE IF NOT EXISTS public.schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`;
 for(const name of (await readdir('apps/api/migrations')).filter(n=>n.endsWith('.sql')).sort()){
  if((await db`SELECT 1 FROM public.schema_migrations WHERE name=${name}`).length)continue;
  const sql=await readFile('apps/api/migrations/'+name,'utf8');
  await db.begin(async tx=>{await tx`SET LOCAL transaction_timeout='30s'`;await tx.unsafe(sql);await tx`INSERT INTO public.schema_migrations(name) VALUES(${name})`;});
  console.log('Applied '+name);
 }
} catch { console.error('Migration stopped; reconcile schema and migration ledger before another invocation. Do not blindly retry an unknown commit outcome or log credentials/SQL parameters.'); process.exitCode=1; }
finally{await db.end({timeout:5});}
