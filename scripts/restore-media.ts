import {restorableMediaPage} from '../apps/api/src/restorable-media.js';
import type {Sql} from 'postgres';
import {verifyMediaBackup} from '../apps/api/src/media-backup.js';
import {readJournalControl,type JournalStore} from '../apps/api/src/privacy-journal.js';

/** Operator-only: replay latest privacy decisions before restoring surviving bytes. */
export async function restoreMediaSnapshot(options:{journal:JournalStore;sql:Sql;backup:Parameters<typeof verifyMediaBackup>[0];snapshotId:string;pairedTime:string;restoreObject:(value:{snapshotId:string;key:string;sha256:string;byteSize:number})=>Promise<void>}){
 const {journal,sql:pool,backup,snapshotId,pairedTime,restoreObject}=options;
 const sql=await pool.reserve();
 try{
 const current=await readJournalControl(journal),[state]=await sql`select app.safety_status() value`;
 if(current.value.mode!=='quarantine'||current.value.pending.length||!state.value.quarantined||state.value.generation!==current.value.generation||state.value.sequence!==current.value.sequence)throw Error('MEDIA_RESTORE_REPLAY_REQUIRED');
 await sql`create temporary table porchday_verified_media(object_key text primary key) on commit preserve rows`;let copied=0,discarded=0;
 try{
 await verifyMediaBackup(backup,snapshotId,pairedTime,async(item,bytes)=>{
  const[asset]=await restorableMediaPage(sql,'',item.object_key);
  if(!asset){discarded++;return;}
  if(!bytes||!item.sha256||asset.envelope_sha256!==item.canonical_sha256||asset.raw_sha256!==item.sha256||Number(asset.byte_size)!==item.byte_size)throw Error('MEDIA_RESTORE_INVENTORY_MISMATCH');
  await restoreObject({snapshotId,key:item.object_key,sha256:item.sha256,byteSize:item.byte_size});await sql`insert into porchday_verified_media(object_key) values(${item.object_key}) on conflict do nothing`;copied++;
 },{generation:state.value.generation,maxJournalSequence:current.value.sequence});
 let cursor='';
 for(;;){const required=await restorableMediaPage(sql,cursor);if(!required.length)break;
  for(const item of required){const[found]=await sql`select object_key from porchday_verified_media where object_key=${item.object_key}`;if(!found)throw Error('MEDIA_RESTORE_MISSING_REQUIRED_OBJECTS');cursor=item.object_key;}
 }
 if(JSON.stringify((await readJournalControl(journal)).value)!==JSON.stringify(current.value))throw Error('RESTORE_CHECKPOINT_CHANGED');
 return{verified:true,copied,discarded,quarantine:true};
 }finally{await sql`drop table if exists porchday_verified_media`;}
 }finally{sql.release();}
}
