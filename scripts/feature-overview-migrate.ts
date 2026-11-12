/** Reviewed presentation-only data change. Receipt and input must remain private. */
import {readFile,writeFile} from 'node:fs/promises';
import postgres from 'postgres';
import {prepareOverviewChanges,type ReviewedOverview} from './feature-overview-data.ts';

const [environment,mode,input,receipt]=process.argv.slice(2);
let db:ReturnType<typeof postgres>|undefined;
try {
  if (!['staging','production'].includes(environment) || !['check','apply','rollback'].includes(mode) || !input || !receipt)
    throw Error('USAGE_ENV_CHECK_APPLY_ROLLBACK_INPUT_PRIVATE_RECEIPT');
  const changes=prepareOverviewChanges(JSON.parse(await readFile(input,'utf8')) as ReviewedOverview[]);
  const resources=JSON.parse(await readFile(new URL('../infra/resources.json',import.meta.url),'utf8'));
  const connection=new URL(process.env[`PORCHDAY_${environment.toUpperCase()}_DATABASE_MIGRATION_URL`]??'');
  if (!connection.hostname.endsWith('.pg.psdb.cloud') || connection.port!=='5432' || !decodeURIComponent(connection.username).endsWith('.'+resources.environments[environment].database.branch_id)) throw Error('DATABASE_TARGET_MISMATCH');
  // Durable pre-transaction intent is also the exact inverse. Never overwrite it or auto-retry.
  await writeFile(receipt,JSON.stringify({environment,mode,at:new Date().toISOString(),changes},null,2)+'\n',{flag:'wx',mode:0o600});
  db=postgres(connection.href,{max:1,prepare:false,fetch_types:false,ssl:'verify-full',connect_timeout:10,onnotice:()=>{}});
  await db.begin(async tx=>{
    await tx`set local lock_timeout='5s'`;
    await tx`set local statement_timeout='10s'`;
    await tx`select pg_advisory_xact_lock(hashtextextended('porchday-builder-chat-queue',0))`;
    for(const change of changes) {
      const expected=mode==='rollback'?change.after:change.before;
      const replacement=mode==='rollback'?change.before:change.after;
      const rows=await tx`select plan, to_jsonb(f)-'plan' as state from app.feature_additions f where id=${change.id}::uuid for update`;
      if(rows.length!==1 || rows[0].plan!==expected) throw Error('PLAN_CHANGED_REVIEW_REQUIRED');
      if(mode!=='check') {
        const after=await tx`update app.feature_additions f set plan=${replacement} where id=${change.id}::uuid and plan=${expected} returning to_jsonb(f)-'plan' as state`;
        if(after.length!==1 || JSON.stringify(after[0].state)!==JSON.stringify(rows[0].state)) throw Error('NON_PRESENTATION_STATE_CHANGED');
      }
    }
  });
  await writeFile(receipt+'.complete',JSON.stringify({environment,mode,count:changes.length,at:new Date().toISOString()})+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({passed:true,mode,count:changes.length}));
} catch {
  // Database error strings can contain connection or member data.
  console.error('OVERVIEW_OPERATION_INCOMPLETE: inspect private intent and current plans before retrying; no automatic retry.');
  process.exitCode=1;
} finally {await db?.end({timeout:1});}
