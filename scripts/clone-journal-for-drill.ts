import postgres from 'postgres';
import {readFile} from 'node:fs/promises';
import {writeRestorePrivate} from './restore-private-files.js';
import {resolve} from 'node:path';
import {R2JournalStore} from './r2-journal-store.js';
import {withOperatorR2} from './r2-operator-bridge.js';
import {cloneStableJournalCut} from './clone-journal-cut.js';

const environment=process.argv[2],target=process.env.RESTORE_DRILL_JOURNAL_BUCKET;
let sql:ReturnType<typeof postgres>|undefined;
try {
 if(!['staging','production'].includes(environment)||process.argv.length!==4||process.argv[3]!=='--run')throw Error('RESTORE_DRILL_ARGUMENTS_INVALID');
 const nonce=/^porchday-restore-([a-f0-9]{8})-journal$/.exec(target??'')?.[1];if(!nonce)throw Error('ISOLATED_RESTORE_JOURNAL_REQUIRED');
 const resources=JSON.parse(await readFile(new URL('../infra/resources.json',import.meta.url),'utf8')),configured=resources.environments[environment];
 if(process.env.CLOUDFLARE_ACCOUNT_ID!==resources.account_id)throw Error('RESTORE_DRILL_ACCOUNT_MISMATCH');
 for(const e of Object.values(resources.environments) as Record<string,unknown>[])if(Object.values(e).includes(target))throw Error('RESTORE_TARGET_MUST_BE_ISOLATED');
 const value=process.env['PORCHDAY_'+environment.toUpperCase()+'_DATABASE_MIGRATION_URL'];if(!value)throw Error('RESTORE_DRILL_SOURCE_DATABASE_REQUIRED');
 const url=new URL(value);if(!url.hostname.endsWith('.pg.psdb.cloud')||!decodeURIComponent(url.username).endsWith('.'+configured.database.branch_id)||url.port!=='5432')throw Error('RESTORE_DRILL_SOURCE_DATABASE_MISMATCH');
 sql=postgres(value,{max:1,prepare:false,fetch_types:false,connect_timeout:10,ssl:'verify-full',onnotice:()=>{}});
 const source=R2JournalStore.fromEnvironment(configured.recovery_journal_bucket),started=Date.now();
 const result=await withOperatorR2({journalBucket:target!,hostname:'ops-'+nonce+'.porchday.com'},async({journal})=>cloneStableJournalCut(source,journal,{
  async status(){const[r]=await sql!`select app.safety_status() value`;return r.value;},
 }));
 const directory=resolve('artifacts/private/restore-ops/drills');
 await writeRestorePrivate(resolve(directory,nonce+'-journal-cut.json'),{v:1,environment,target,captured_at:new Date().toISOString(),...result},true);
 console.log(JSON.stringify({copied:true,quarantined:true,sequence:result.sequence,batches:result.batches,events:result.events,elapsed_ms:Date.now()-started}));
} catch(error){const code=(error as Error).message;console.error(/^[A-Z][A-Z0-9_]{2,100}$/.test(code)?code:'RESTORE_DRILL_JOURNAL_COPY_FAILED');process.exitCode=1;}
finally{await sql?.end({timeout:1});}
