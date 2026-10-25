import postgres from 'postgres';
const base=process.env.TEST_DATABASE_URL;
if(!base)throw new Error('TEST_DATABASE_URL required');
const url=new URL(base);
if(!['localhost','127.0.0.1'].includes(url.hostname))throw new Error('Disposable test databases must use a local PostgreSQL instance');
const sql=postgres(base,{max:1,prepare:false});
try{
 for(const name of ['porchday_social_test','porchday_http_test','porchday_moderation_test','porchday_push_test']){
  const found=await sql`select 1 from pg_database where datname=${name}`;
  if(!found.length)await sql.unsafe('CREATE DATABASE '+name);
 }
}finally{await sql.end();}
