/** Exact-ID read-only observation after the normal source deletion outbox has run. */
import postgres from 'postgres';
import {readFile,readdir} from 'node:fs/promises';
import {check,readPrivate,writePrivate,SmokeError} from './hosted-smoke-support.js';
const root='artifacts/private/hosted-smoke/';let sql:ReturnType<typeof postgres>|undefined;
try{
 check(process.argv.length===4&&process.argv[2]==='--run'&&/^--attempt=[a-f0-9]{8}$/.test(process.argv[3]),'EXPLICIT_CLEANUP_OBSERVATION_REQUIRED');
 const attempt=process.argv[3].slice(10),names=await readdir(root),matching=(ending:string)=>names.filter(n=>n.startsWith('archive-migration-'+attempt+'-')&&n.endsWith(ending));
 const intents=matching('-source-fixture-intent.json'),cleanups=matching('-source-cleanup.json');check(intents.length===1&&cleanups.length===1,'EXACT_SOURCE_INTENT_AND_CLEANUP_REQUIRED');
 const intent=await readPrivate<any>(root+intents[0]),cleanup=await readPrivate<any>(root+cleanups[0]),state=await readPrivate<any>(root+'state.json');
 check(state.synthetic===true&&intent.memberId===state.accounts[0].id&&cleanup.memberId===intent.memberId&&cleanup.mediaId===intent.mediaId&&cleanup.postId===intent.postId&&cleanup.apiAbsent===true&&/^[a-f0-9-]{36}$/.test(intent.mediaId),'SOURCE_CLEANUP_TICKET_MISMATCH');
 const manifest=JSON.parse(await readFile('infra/resources.json','utf8')),resources=manifest.environments.staging;
 const connection=process.env.PORCHDAY_STAGING_DATABASE_MIGRATION_URL;check(connection,'STAGING_READ_ONLY_URL_REQUIRED');const url=new URL(connection);
 check(url.hostname.endsWith('.pg.psdb.cloud')&&decodeURIComponent(url.username).endsWith('.'+resources.database.branch_id)&&url.port==='5432'&&resources.bucket==='porchday-staging-media','STAGING_RESOURCE_MISMATCH');
 sql=postgres(connection,{max:1,prepare:false,fetch_types:false,connect_timeout:10,ssl:'verify-full',connection:{default_transaction_read_only:true,statement_timeout:15000},onnotice:()=>{}});
 check((await sql`show transaction_read_only`)[0].transaction_read_only==='on','READ_ONLY_CONNECTION_REQUIRED');
 const key=`media/${intent.memberId}/${intent.mediaId}`;
 const [row]=await sql`select attempts,created_at,first_deleted_at,completed_at from app.deletion_outbox where object_key=${key}`;
 const [live]=await sql`select count(*)::int n from app.media_assets where id=${intent.mediaId} and owner_id=${intent.memberId}`;
 const token=process.env.CLOUDFLARE_API_TOKEN??process.env.CF_API_TOKEN,account=process.env.CLOUDFLARE_ACCOUNT_ID;check(token&&/^[a-f0-9]{32}$/.test(account||'')&&account===manifest.account_id,'CLOUDFLARE_READ_CONFIGURATION_REQUIRED');
 const base=`https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${resources.bucket}`;
 const metadata=await fetch(base,{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(30000)});const bucket=await metadata.json() as any;
 check(metadata.ok&&bucket.success===true&&bucket.result?.name===resources.bucket,'SOURCE_BUCKET_UNVERIFIED');
 const response=await fetch(base+'/objects/'+key,{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(30000)});check([200,404].includes(response.status),'SOURCE_R2_READ_FAILED');await response.body?.cancel();
 const elapsed=row?.completed_at?(+new Date(row.completed_at)-+new Date(row.created_at))/1000:null;
 const passed=live.n===0&&response.status===404&&!!row?.first_deleted_at&&!!row?.completed_at&&Number(row.attempts)>=2&&elapsed!==null&&elapsed>=600;
 const result={v:1,attempt,checkedAt:new Date().toISOString(),passed,mediaRecordAbsent:live.n===0,r2Absent:response.status===404,firstPassAcknowledged:!!row?.first_deleted_at,finalPassCompleted:!!row?.completed_at,attempts:row?.attempts??0,completedAfterSeconds:elapsed,existingBackupRetentionDays:7};
 await writePrivate(root+`archive-migration-${attempt}-cleanup-status-${Date.now()}.json`,result,true);console.log(JSON.stringify({phase:'archive-migration-cleanup',...result}));
}catch(error){console.error(JSON.stringify({phase:'archive-migration-cleanup',passed:false,code:error instanceof SmokeError?error.message:'CLEANUP_OBSERVATION_FAILED'}));process.exitCode=1;}
finally{await sql?.end({timeout:10});}
