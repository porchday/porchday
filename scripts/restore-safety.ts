import postgres from 'postgres';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {restoreMediaSnapshot} from './restore-media.js';
import {readRestorePrivate,writeRestorePrivate} from './restore-private-files.js';
import {validateOriginalPrimaryConfiguration} from './original-primary-recovery-config.js';
import {backupReaderFromEnvironment} from './r2-backup-reader.js';
import {withOperatorR2} from './r2-operator-bridge.js';
import {initializePrivacyJournal,checkpointJournal,quarantineJournal,readJournalControl,verifyJournalChain,type JournalDatabase,JournalError} from '../apps/api/src/privacy-journal.js';
import {replayPrivacyJournal,releasePrivacyQuarantine,reconcileDurableReceipts,recoverOriginalPrimary,type OriginalPrimaryRecoveryTicket} from '../apps/api/src/restore-journal.js';

const command=process.argv[2];
const commands=['initialize','quarantine','verify','checkpoint-original','reconcile-receipts','replay','restore-media','release','recover-original'];
if(!command||!commands.includes(command))throw new Error('Use restore-safety.ts '+commands.join('|'));
const bucket=process.env.RECOVERY_JOURNAL_BUCKET;
if(!bucket)throw new Error('RECOVERY_JOURNAL_BUCKET is required.');
let sql:ReturnType<typeof postgres>|undefined;
function database(original=false) {
  const url=original?process.env.ORIGINAL_DATABASE_MIGRATION_URL:process.env.DATABASE_MIGRATION_URL;
  if(!url)throw new Error(original?'ORIGINAL_DATABASE_MIGRATION_URL_REQUIRED':'DATABASE_MIGRATION_URL_REQUIRED');
  sql=postgres(url,{max:1,prepare:false,fetch_types:false,idle_timeout:0,ssl:process.env.PG_LOCAL==='true'?false:'verify-full',onnotice:()=>{}});
  const db:JournalDatabase={async status(){const[r]=await sql!`select app.safety_status() as value`;return r.value;},async page(after){const[r]=await sql!`select app.safety_page(${after}::bigint,200) as value`;return r.value;}};
  return db;
}
try {
  const mediaBucket=['replay','restore-media','release','recover-original'].includes(command)?process.env.MEDIA_BUCKET:undefined;
  let recoveryTicket:OriginalPrimaryRecoveryTicket|undefined,recoveryTicketPath:string|undefined,recoveryResult:Awaited<ReturnType<typeof recoverOriginalPrimary>>|undefined;
  if(command==='recover-original'){
    const args=process.argv.slice(3),tickets=args.filter(a=>a.startsWith('--ticket=')),evidence=args.filter(a=>a.startsWith('--evidence='));
    if(args.length!==3||!args.includes('--run')||tickets.length!==1||evidence.length!==1)throw Error('ORIGINAL_PRIMARY_EXPLICIT_ARGUMENTS_REQUIRED');
    recoveryTicketPath=tickets[0].slice(9);
    const external=await readRestorePrivate(evidence[0].slice(11));
    recoveryTicket=await validateOriginalPrimaryConfiguration({ticket:await readRestorePrivate(recoveryTicketPath),evidence:external,
      resources:JSON.parse(await readFile(new URL('../infra/resources.json',import.meta.url),'utf8')),account:process.env.CLOUDFLARE_ACCOUNT_ID,
      bucket,mediaBucket,databaseUrl:process.env.ORIGINAL_DATABASE_MIGRATION_URL,pgLocal:process.env.PG_LOCAL,
      head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),trackedChanges:execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'})});
    try{await readRestorePrivate(recoveryTicketPath+'.result.json');throw Error('ORIGINAL_PRIMARY_ALREADY_EXECUTED');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  const backupBucket=command==='restore-media'?process.env.MEDIA_BACKUP_BUCKET:undefined;
  if(command==='restore-media'&&(!backupBucket||[bucket,mediaBucket].includes(backupBucket)))throw Error('SEPARATE_BACKUP_BUCKET_REQUIRED');
  if(['replay','restore-media'].includes(command)&&(!mediaBucket||mediaBucket===bucket))throw new Error('SEPARATE_MEDIA_BUCKET_REQUIRED');
  // The native binding transport probes authentication and atomic conditional
  // writes before entering this callback, and tears down its temporary endpoint.
  await withOperatorR2({journalBucket:bucket,mediaBucket,backupBucket,journalAccess:command==='verify'?'read-only':'read-write'},async({journal:store,deleteMediaObject,restoreMediaObject,verifyMediaObject})=>{
  if(command==='initialize') {
    await initializePrivacyJournal(store,database());
    console.log('Independent checkpoint initialized in quarantine. Review and release explicitly.');
  } else if(command==='quarantine') {
    await quarantineJournal(store,'operator_restore');console.log('Restore quarantine is active. Stop in-flight traffic before touching database snapshots.');
  } else if(command==='verify') {
    const checked=await verifyJournalChain(store);
    console.log(JSON.stringify({verified:true,sequence:checked.control.sequence,batches:checked.batches.length,events:checked.batches.reduce((n,b)=>n+b.length,0)}));
  } else if(command==='reconcile-receipts') {
    console.log(JSON.stringify(await reconcileDurableReceipts(store)));
  } else if(command==='checkpoint-original') {
    if(process.env.ORIGINAL_DATABASE_CONFIRMATION!=='I_VERIFIED_THIS_IS_THE_UNRESTORED_PRIMARY')throw new Error('UNRESTORED_PRIMARY_ATTESTATION_REQUIRED');
    const current=await readJournalControl(store);
    if(current.value.mode!=='quarantine')throw new JournalError('RESTORE_QUARANTINE_REQUIRED');
    const db=database(true);
    // This command is intentionally unavailable against DATABASE_MIGRATION_URL:
    // a restored snapshot cannot prove that an ambiguous tail was recovered.
    const checkpoint=await checkpointJournal(store,db,true);
    for(const intent of checkpoint.pending) {
      const receipt={v:1,id:intent.id,generation:checkpoint.generation,sequence:checkpoint.sequence,head:checkpoint.head,operator_verified_original:true};
      const existing=await store.get(`receipts/${intent.id}.json`);
      if(!existing&&!await store.put(`receipts/${intent.id}.json`,JSON.stringify(receipt),{onlyIf:{etagDoesNotMatch:'*'}}))throw new JournalError('RESTORE_CHECKPOINT_CHANGED');
    }
    console.log(JSON.stringify(await reconcileDurableReceipts(store)));
    console.log('Original primary checkpointed. Quarantine remains active; no automatic release.');
  } else if(command==='replay') {
    database();
    console.log(JSON.stringify(await replayPrivacyJournal(store,sql!,deleteMediaObject)));
    console.log('Reconciliation complete; quarantine remains active. Revalidate staff Access roles before restoring staff access.');
  } else if(command==='restore-media') {
    const id=process.env.MEDIA_RESTORE_SNAPSHOT_ID,paired=process.env.MEDIA_RESTORE_PITR_AT;
    if(!id||!paired)throw Error('MEDIA_SNAPSHOT_AND_PITR_TIME_REQUIRED');
    database();console.log(JSON.stringify(await restoreMediaSnapshot({journal:store,sql:sql!,backup:backupReaderFromEnvironment(backupBucket!) as never,snapshotId:id,pairedTime:paired,restoreObject:restoreMediaObject})));
  } else if(command==='release') {
    database();const current=await readJournalControl(store);
    if(process.env.RESTORE_REVIEWED_SEQUENCE!==current.value.sequence)throw new Error('REVIEWED_CHECKPOINT_SEQUENCE_REQUIRED');
    await releasePrivacyQuarantine(store,sql!,async item=>{if(!mediaBucket)throw Error('MEDIA_BUCKET_REQUIRED');await verifyMediaObject(item);});console.log('Reviewed checkpoint released. Reopen traffic only after application checks pass.');
  } else if(command==='recover-original') {
    database(true);
    recoveryResult=await recoverOriginalPrimary(store,sql!,recoveryTicket,verifyMediaObject);
  }
  });
  if(recoveryResult){
    // A success receipt is published only after native transport teardown has
    // confirmed the temporary Worker and custom domain are both absent.
    await writeRestorePrivate(recoveryTicketPath!+'.result.json',{...recoveryResult,operatorTransportRemoved:true,completedAt:new Date().toISOString()},true);
    console.log(JSON.stringify({recovered:recoveryResult.recovered,sequence:recoveryResult.sequence,resolvedIntents:recoveryResult.resolvedIntents,verifiedMedia:recoveryResult.verifiedMedia}));
  }
} catch(error) {
  const code=error instanceof JournalError?error.code:(error as Error).message;
  // Only our fixed codes are printed; provider/SQL messages can contain secrets.
  console.error(/^[A-Z][A-Z0-9_]{2,100}$/.test(code)?code:'RESTORE_SAFETY_OPERATION_FAILED');
  process.exitCode=1;
} finally {await sql?.end({timeout:1});}
