import {readJournalControl,verifyJournalChain,type JournalStore,type JournalControl,type JournalDatabase} from '../apps/api/src/privacy-journal.js';

/** Copy a verified point-in-time cut for an isolated, unbound restore drill.
 * The source has NO mutation capability. The target must be a different private
 * bucket; the caller verifies bucket identities and native conditional writes.
 * This does not freeze future source decisions or replace a disaster quarantine.
 */
export async function cloneStableJournalCut(source:Pick<JournalStore,'get'>,target:JournalStore,database:Pick<JournalDatabase,'status'>){
 if(await target.get('control.json'))throw Error('RESTORE_TARGET_ALREADY_INITIALIZED');
 const frozen=(await readJournalControl(source as JournalStore)).value;
 async function stable(){
  const remote=(await readJournalControl(source as JournalStore)).value,local=await database.status();
  if(remote.mode!=='active'||remote.pending.length||local.quarantined)throw Error('RESTORE_SOURCE_NOT_QUIET');
  if(JSON.stringify(remote)!==JSON.stringify(frozen)||local.generation!==frozen.generation||local.sequence!==frozen.sequence)throw Error('RESTORE_SOURCE_CHANGED');
 }
 await stable();
 const quarantined:JournalControl={...frozen,mode:'quarantine',reason:'isolated_restore_drill'};
 let objects=0;
 const view:JournalStore={
  async get(key){
   if(key==='control.json')return {etag:'frozen-read-only-view',text:async()=>JSON.stringify(quarantined)};
   if(!key.startsWith('batches/'+frozen.generation+'/'))throw Error('RESTORE_JOURNAL_KEY_INVALID');
   const item=await source.get(key);if(!item)return null;
   const text=await item.text();
   if(!await target.put(key,text,{onlyIf:{etagDoesNotMatch:'*'}})){
    const prior=await target.get(key);if(!prior||await prior.text()!==text)throw Error('RESTORE_TARGET_CONFLICT');
   }
   objects++;return {etag:item.etag,text:async()=>text};
  },async put(){throw Error('RESTORE_SOURCE_READ_ONLY');},
 };
 const verified=await verifyJournalChain(view);
 // No target control is published until the complete immutable chain passes.
 await stable();
 if(!await target.put('control.json',JSON.stringify(quarantined),{onlyIf:{etagDoesNotMatch:'*'}}))throw Error('RESTORE_TARGET_ALREADY_INITIALIZED');
 await verifyJournalChain(target);
 await stable(); // Any late uncertainty leaves a quarantined, unused target.
 return {generation:frozen.generation,sequence:frozen.sequence,head:frozen.head,batches:objects,events:verified.batches.reduce((n,b)=>n+b.length,0)};
}
