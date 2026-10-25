import postgres,{type Sql} from 'postgres';
import {z} from 'zod';
import {createHash} from 'node:crypto';
import {assertJournalReadable,checkpointJournal,sha256,type JournalDatabase,type JournalStore} from './privacy-journal.js';
import type {Env} from './types.js';

const seq=z.string().regex(/^(0|[1-9][0-9]*)$/),hash=z.string().regex(/^[a-f0-9]{64}$/),sourceKey=z.string().regex(/^media\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/);
const runSchema=z.object({id:z.uuid(),restore_at:z.string(),generation:z.uuid(),base_sequence:seq,expires_at:z.string()});
const itemSchema=z.object({object_key:sourceKey,canonical_sha256:hash,sha256:hash,byte_size:z.number().int().min(1).max(22020096)});
const pointerSchema=z.object({key:z.string(),hash});
const stateSchema=z.object({v:z.literal(1),run:runSchema,cursor:z.string().nullable(),head:pointerSchema.nullable(),pages:z.number().int().nonnegative(),objects:z.number().int().nonnegative(),bytes:z.number().int().nonnegative(),omitted:z.number().int().nonnegative(),proofSequence:seq,lease:z.object({id:z.uuid(),until:z.number()}).nullable()});
const recordSchema=itemSchema.extend({omitted:z.boolean(),proofSequence:seq.optional()});
const pageSchema=z.object({v:z.literal(1),id:z.uuid(),index:z.number().int().positive(),previous:pointerSchema.nullable(),items:z.array(recordSchema).min(1).max(8)});
const manifestSchema=stateSchema.omit({cursor:true,lease:true}).extend({completedAt:z.string(),journalSequence:seq});
type Run=z.infer<typeof runSchema>;type Item=z.infer<typeof itemSchema>;type SnapshotItem=z.infer<typeof recordSchema>;type State=z.infer<typeof stateSchema>;
export interface BackupDatabase {journal:JournalDatabase;start():Promise<Run>;info(id:string):Promise<Run>;page(id:string,cursor:string|null):Promise<Item[]>;missing(id:string,key:string):Promise<string|null>;complete(id:string):Promise<void>;failed(id:string):Promise<void>}
export interface BackupStorage {source:R2Bucket;backup:R2Bucket;journal:JournalStore;db:BackupDatabase}
const fail=(code:string):never=>{throw Error(code);};
function run(value:unknown):Run{const r=runSchema.parse(value);r.restore_at=new Date(r.restore_at).toISOString();r.expires_at=new Date(r.expires_at).toISOString();if(Date.parse(r.expires_at)!==Date.parse(r.restore_at)+7*86400000)fail('BACKUP_RETENTION_INVALID');return r;}
function prefix(id:string){if(!z.uuid().safeParse(id).success)fail('BACKUP_ID_INVALID');return 'snapshots/'+id+'/';}
function live(r:Run){if(Date.parse(r.expires_at)<=Date.now())fail('BACKUP_EXPIRED');}
const checksum=async(bytes:ArrayBuffer)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
async function streamChecksum(stream:ReadableStream<Uint8Array>){const hash=createHash('sha256'),reader=stream.getReader();try{for(;;){const{done,value}=await reader.read();if(done)break;hash.update(value);}return hash.digest('hex');}finally{reader.releaseLock();}}
async function immutable(bucket:R2Bucket,key:string,text:string){if(await bucket.put(key,text,{onlyIf:{etagDoesNotMatch:'*'}}))return;const old=await bucket.get(key);if(!old||await old.text()!==text)fail('BACKUP_IMMUTABILITY_FAILED');}
export function backupDatabase(sql:Sql):BackupDatabase{return{
 journal:{async status(){const[r]=await sql`select app.safety_status() value`;return r.value;},async page(after){const[r]=await sql`select app.safety_page(${after}::bigint,200) value`;return r.value;}},
 async start(){// Separate SQL statement chooses PITR time BEFORE inventory MVCC snapshot.
  const[clock]=await sql`select clock_timestamp() paired_at`;const[r]=await sql`select app.media_backup_start(${crypto.randomUUID()}::uuid,${clock.paired_at}::timestamptz) value`;return run(r.value);
 },async info(id){const[r]=await sql`select app.media_backup_info(${id}::uuid) value`;if(!r.value)fail('BACKUP_INVENTORY_MISSING');return run(r.value);},
 async page(id,cursor){const[r]=await sql`select app.media_backup_page(${id}::uuid,${cursor}) value`;return z.array(itemSchema).max(8).parse(r.value.map((i:any)=>({...i,byte_size:Number(i.byte_size)})));},
 async missing(id,key){const[r]=await sql`select app.media_backup_missing(${id}::uuid,${key}) value`;return r.value===null?null:seq.parse(r.value);},
 async complete(id){await sql`select app.media_backup_complete(${id}::uuid)`;},async failed(id){await sql`select app.media_backup_failed(${id}::uuid)`;}
};}
async function initializeRunState(storage:BackupStorage,r:Run){
 const state:State={v:1,run:r,cursor:null,head:null,pages:0,objects:0,bytes:0,omitted:0,proofSequence:r.base_sequence,lease:null};
 await storage.backup.put(prefix(r.id)+'state.json',JSON.stringify(state),{onlyIf:{etagDoesNotMatch:'*'}});
}
export async function beginMediaBackup(storage:BackupStorage){const current=await assertJournalReadable(storage.journal,storage.db.journal);const r=await storage.db.start();live(r);if(current.value.generation!==r.generation)fail('BACKUP_SOURCE_MISMATCH');await initializeRunState(storage,r);return r.id;}
/** One message copies at most eight objects, sequentially; no SQL lock spans R2 I/O. */
export async function copyMediaBackupPage(storage:BackupStorage,id:string):Promise<'more'|'complete'|'busy'> {
 const {source,backup,db,journal}=storage;const currentJournal=await assertJournalReadable(journal,db.journal);const r=await db.info(id);live(r);if(currentJournal.value.generation!==r.generation)fail('BACKUP_SOURCE_MISMATCH');
 // An owner-created manual run, or a crash after SQL inventory capture, may
 // reach the normal queue before its R2 state exists. Never replace a state;
 // initialize only from this generation-checked, frozen database inventory.
 const base=prefix(id);let old=await backup.get(base+'state.json');if(!old){await initializeRunState(storage,r);old=await backup.get(base+'state.json');}if(!old)fail('BACKUP_STATE_MISSING');const state=stateSchema.parse(JSON.parse(await old!.text()));
 if(JSON.stringify(state.run)!==JSON.stringify(r))fail('BACKUP_SOURCE_MISMATCH');
 const completed=await backup.get(base+'complete.json');if(completed){const manifest=manifestSchema.parse(JSON.parse(await completed.text()));if(JSON.stringify(manifest.run)!==JSON.stringify(r))fail('BACKUP_SOURCE_MISMATCH');await db.complete(id);return 'complete';}
 if(state.lease&&state.lease.until>Date.now())return 'busy';
 const claim={...state,lease:{id:crypto.randomUUID(),until:Date.now()+120000}},leased=await backup.put(base+'state.json',JSON.stringify(claim),{onlyIf:{etagMatches:old!.etag}});if(!leased)return 'busy';
 try{
  const items=await db.page(id,state.cursor);
  if(!items.length){const control=await checkpointJournal(journal,db.journal);if(control.generation!==r.generation||BigInt(control.sequence)<BigInt(state.proofSequence))fail('BACKUP_JOURNAL_COVERAGE_MISSING');live(r);
   const {cursor,lease,...summary}=state;await immutable(backup,base+'complete.json',JSON.stringify({...summary,completedAt:new Date().toISOString(),journalSequence:control.sequence}));await db.complete(id);return 'complete';
  }
  const records:z.infer<typeof recordSchema>[]=[];let omitted=0,bytes=0,proof=BigInt(state.proofSequence);
  for(const item of items){const targetKey=base+'objects/'+item.object_key.slice(6);let object=await backup.get(targetKey);
   if(!object){const original=await source.get(item.object_key);if(!original){const covered=await db.missing(id,item.object_key)??fail('BACKUP_SOURCE_OBJECT_MISSING');proof=proof>BigInt(covered)?proof:BigInt(covered);records.push({...item,omitted:true,proofSequence:covered});omitted++;continue;}
    if(original.size!==item.byte_size)fail('BACKUP_SOURCE_SIZE_MISMATCH');
    // Native R2 streams and validates the trusted raw upload checksum before commit.
    await backup.put(targetKey,original.body,{onlyIf:{etagDoesNotMatch:'*'},sha256:item.sha256});object=await backup.get(targetKey);
   }
   if(!object||object.size!==item.byte_size||await streamChecksum(object!.body)!==item.sha256)fail('BACKUP_COPY_VERIFY_FAILED');
   bytes+=item.byte_size;records.push({...item,omitted:false});
  }
  const page={v:1,id,index:state.pages+1,previous:state.head,items:records},text=JSON.stringify(page),digest=await sha256(text),key=base+'pages/'+String(page.index).padStart(8,'0')+'-'+digest+'.json';await immutable(backup,key,text);
  const next:State={...state,cursor:items.at(-1)!.object_key,head:{key,hash:digest},pages:page.index,objects:state.objects+items.length-omitted,bytes:state.bytes+bytes,omitted:state.omitted+omitted,proofSequence:String(proof),lease:null};
  if(!await backup.put(base+'state.json',JSON.stringify(next),{onlyIf:{etagMatches:leased.etag}}))return 'busy';return 'more';
 }finally{const current=await backup.get(base+'state.json');if(current?.etag===leased.etag)await backup.put(base+'state.json',JSON.stringify(state),{onlyIf:{etagMatches:leased.etag}});}
}
/** Privileged restore verifier; no route exposes backups to members or staff. */
export async function verifyMediaBackup(backup:Pick<R2Bucket,'get'>,id:string,pairedTime:string,onObject?:(item:SnapshotItem,bytes:ArrayBuffer|null)=>Promise<void>,expected?:{generation:string;maxJournalSequence:string}){
 const base=prefix(id),object=await backup.get(base+'complete.json');if(!object)fail('BACKUP_INCOMPLETE');const manifest=manifestSchema.parse(JSON.parse(await object!.text()));live(run(manifest.run));
 if(manifest.run.id!==id||pairedTime!==manifest.run.restore_at)fail('BACKUP_PITR_MISMATCH');
 if(expected&&(manifest.run.generation!==expected.generation||BigInt(manifest.journalSequence)>BigInt(expected.maxJournalSequence)))fail('BACKUP_JOURNAL_MISMATCH');
 let head=manifest.head,index=manifest.pages,objects=0,bytes=0,omitted=0,lastKey:string|null=null;
 while(head){if(index<1||head.key!==base+'pages/'+String(index).padStart(8,'0')+'-'+head.hash+'.json')fail('BACKUP_MANIFEST_CHAIN_INVALID');
  const raw=await backup.get(head.key);if(!raw)fail('BACKUP_MANIFEST_MISSING');const text=await raw!.text();if(await sha256(text)!==head.hash)fail('BACKUP_MANIFEST_HASH_MISMATCH');const page=pageSchema.parse(JSON.parse(text));if(page.id!==id||page.index!==index)fail('BACKUP_MANIFEST_CHAIN_INVALID');
  // Reverse chain traversal still checks globally monotonic source keys.
  for(const item of [...page.items].reverse()){if(lastKey!==null&&item.object_key>=lastKey)fail('BACKUP_MANIFEST_DUPLICATE');lastKey=item.object_key;
   if(item.omitted){if(!item.proofSequence||BigInt(item.proofSequence)>BigInt(manifest.journalSequence))fail('BACKUP_OMISSION_UNPROVEN');omitted++;await onObject?.(item,null);continue;}
   const copy=await backup.get(base+'objects/'+item.object_key.slice(6));if(!copy||copy.size!==item.byte_size)fail('BACKUP_OBJECT_MISSING');
   // Operator Node callbacks may request bytes; Worker verification never buffers objects.
   const data=onObject?await copy!.arrayBuffer():null;if((data?await checksum(data):await streamChecksum(copy!.body))!==item.sha256)fail('BACKUP_OBJECT_HASH_MISMATCH');objects++;bytes+=item.byte_size;await onObject?.(item,data);
  }head=page.previous;index--;
 }
 if(index!==0||objects!==manifest.objects||bytes!==manifest.bytes||omitted!==manifest.omitted)fail('BACKUP_MANIFEST_TOTAL_MISMATCH');return manifest;
}
async function configured<T>(env:Env,fn:(storage:BackupStorage)=>Promise<T>):Promise<T>{if(env.MEDIA_BACKUP_ENABLED!=='true'||!env.MEDIA_BACKUP||!env.RECOVERY_JOURNAL)fail('MEDIA_BACKUP_NOT_CONFIGURED');const sql=postgres(env.HYPERDRIVE_JOBS.connectionString,{max:1,prepare:false,fetch_types:false});try{return await fn({source:env.MEDIA,backup:env.MEDIA_BACKUP!,journal:env.RECOVERY_JOURNAL!,db:backupDatabase(sql)});}finally{await sql.end({timeout:1});}}
export async function scheduleMediaBackup(env:Env){return configured(env,async storage=>{const id=await beginMediaBackup(storage);await env.JOBS.send({kind:'media_backup',id});return id;});}
export async function processMediaBackup(env:Env,id:string){return configured(env,async storage=>{try{const result=await copyMediaBackupPage(storage,id);if(result==='more')await env.JOBS.send({kind:'media_backup',id});return result;}catch(error){await storage.db.failed(id).catch(()=>{});throw error;}});}
