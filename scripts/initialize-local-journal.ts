import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {resolve} from 'node:path';
import postgres from 'postgres';
import {initializePrivacyJournal,readJournalControl,assertJournalReadable,type JournalStore,type JournalDatabase} from '../apps/api/src/privacy-journal.js';

// This script cannot select a remote database or cloud bucket.
const url=process.env.LOCAL_JOURNAL_DATABASE_URL??'postgres://postgres:porchday-local@127.0.0.1:54329/porchday';
const parsed=new URL(url);
if(!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)||parsed.pathname!=='/porchday')throw Error('LOCAL_PORCHDAY_DATABASE_REQUIRED');
const persistence=resolve(process.env.LOCAL_RESOURCE_PERSISTENCE??'apps/api/.wrangler/state/v3');
const mf=new Miniflare(convertV4MiniflareOptions({name:'local-journal-initializer',modules:true,script:'export default {fetch(){return new Response("not exposed",{status:404})}}',compatibilityDate:'2026-10-01',resourcePersistencePath:persistence,r2Buckets:{RECOVERY_JOURNAL:'porchday-local-recovery-journal'}}));
const sql=postgres(url,{max:1,prepare:false,onnotice:()=>{}});
try {
 const store=await mf.getR2Bucket('RECOVERY_JOURNAL') as unknown as JournalStore;
 const db:JournalDatabase={async status(){const [r]=await sql`select app.safety_status() value`;return r.value;},async page(after){const [r]=await sql`select app.safety_page(${after}::bigint,200) value`;return r.value;}};
 if(!await store.get('control.json'))await initializePrivacyJournal(store,db);
 const current=await readJournalControl(store),local=await db.status();
 if(current.value.mode==='quarantine'){
  if(current.value.reason!=='initialization'||current.value.pending.length||current.value.generation!==local.generation||current.value.sequence!==local.sequence||local.quarantined)throw Error('LOCAL_MANUAL_RECONCILIATION_REQUIRED');
  if(!await store.put('control.json',JSON.stringify({...current.value,mode:'active',reason:null}),{onlyIf:{etagMatches:current.etag}}))throw Error('LOCAL_INITIALIZATION_CHANGED');
 }
 await assertJournalReadable(store,db);console.log('Local Wrangler journal initialized and matched to the local database.');
}finally{await sql.end();await mf.dispose();}
