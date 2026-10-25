import postgres from 'postgres';
import { readdir,readFile } from 'node:fs/promises';
const url=process.env.DATABASE_MIGRATION_URL;
if(!url)throw new Error('DATABASE_MIGRATION_URL is required; load it without printing it.');
const db=postgres(url,{max:1,prepare:false,ssl:process.env.PG_LOCAL==='true'?false:'verify-full',onnotice:()=>{}});
try {
 await db`CREATE TABLE IF NOT EXISTS public.schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`;
 for(const name of (await readdir('apps/api/migrations')).filter(n=>n.endsWith('.sql')).sort()){
  if((await db`SELECT 1 FROM public.schema_migrations WHERE name=${name}`).length)continue;
  const sql=await readFile('apps/api/migrations/'+name,'utf8');
  await db.begin(async tx=>{await tx.unsafe(sql);await tx`INSERT INTO public.schema_migrations(name) VALUES(${name})`;});
  console.log('Applied '+name);
 }
} catch { console.error('Migration failed; inspect schema state without logging credentials or SQL parameters.'); process.exitCode=1; }
finally{await db.end();}
