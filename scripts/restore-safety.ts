import postgres from 'postgres';
import {R2JournalStore} from './r2-journal-store.js';
import {initializePrivacyJournal,checkpointJournal,quarantineJournal,readJournalControl,verifyJournalChain,type JournalDatabase,JournalError} from '../apps/api/src/privacy-journal.js';
import {replayPrivacyJournal,releasePrivacyQuarantine,reconcileDurableReceipts} from '../apps/api/src/restore-journal.js';

const command=process.argv[2];
const commands=['initialize','quarantine','verify','checkpoint-original','reconcile-receipts','replay','release'];
if(!command||!commands.includes(command))throw new Error('Use restore-safety.ts '+commands.join('|'));
const bucket=process.env.RECOVERY_JOURNAL_BUCKET;
if(!bucket)throw new Error('RECOVERY_JOURNAL_BUCKET is required.');
const store=R2JournalStore.fromEnvironment(bucket);
let sql:ReturnType<typeof postgres>|undefined;
function database(original=false) {
  const url=original?process.env.ORIGINAL_DATABASE_MIGRATION_URL:process.env.DATABASE_MIGRATION_URL;
  if(!url)throw new Error(original?'ORIGINAL_DATABASE_MIGRATION_URL_REQUIRED':'DATABASE_MIGRATION_URL_REQUIRED');
  sql=postgres(url,{max:1,prepare:false,fetch_types:false,ssl:process.env.PG_LOCAL==='true'?false:'verify-full',onnotice:()=>{}});
  const db:JournalDatabase={async status(){const[r]=await sql!`select app.safety_status() as value`;return r.value;},async page(after){const[r]=await sql!`select app.safety_page(${after}::bigint,200) as value`;return r.value;}};
  return db;
}
try {
  // Never assume the API-token REST path implements conditional semantics.
  await store.verifyConditionalWrites();
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
    database();const mediaBucket=process.env.MEDIA_BUCKET;
    if(!mediaBucket||mediaBucket===bucket)throw new Error('SEPARATE_MEDIA_BUCKET_REQUIRED');
    const media=R2JournalStore.fromEnvironment(mediaBucket);
    console.log(JSON.stringify(await replayPrivacyJournal(store,sql!,key=>media.deleteMediaObject(key))));
    console.log('Reconciliation complete; quarantine remains active. Revalidate staff Access roles before restoring staff access.');
  } else if(command==='release') {
    database();const current=await readJournalControl(store);
    if(process.env.RESTORE_REVIEWED_SEQUENCE!==current.value.sequence)throw new Error('REVIEWED_CHECKPOINT_SEQUENCE_REQUIRED');
    await releasePrivacyQuarantine(store,sql!);console.log('Reviewed checkpoint released. Reopen traffic only after application checks pass.');
  }
} catch(error) {
  const code=error instanceof JournalError?error.code:(error as Error).message;
  // Only our fixed codes are printed; provider/SQL messages can contain secrets.
  console.error(/^[A-Z][A-Z0-9_]{2,100}$/.test(code)?code:'RESTORE_SAFETY_OPERATION_FAILED');
  process.exitCode=1;
} finally {await sql?.end({timeout:1});}
