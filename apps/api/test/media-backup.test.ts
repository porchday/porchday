import {describe,it,expect} from 'vitest';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {randomUUID,createHash} from 'node:crypto';
import {canonicalJson} from '@porchday/crypto';
import {beginMediaBackup,copyMediaBackupPage,verifyMediaBackup,type BackupDatabase,type BackupStorage} from '../src/media-backup';
import {initializePrivacyJournal,readJournalControl,type JournalEvent,type JournalStore} from '../src/privacy-journal';

async function fixture(count=17){
 const mf=new Miniflare(convertV4MiniflareOptions({name:'backup-test',modules:true,script:'export default{fetch(){return new Response("test")}}',compatibilityDate:'2026-10-01',r2Buckets:['SOURCE','BACKUP','JOURNAL']}));
 const source=await mf.getR2Bucket('SOURCE') as unknown as R2Bucket,backup=await mf.getR2Bucket('BACKUP') as unknown as R2Bucket,journal=await mf.getR2Bucket('JOURNAL') as unknown as JournalStore;
 const owner=randomUUID(),events:JournalEvent[]=[],generation=randomUUID(),started=new Date(),run={id:randomUUID(),restore_at:started.toISOString(),generation,base_sequence:'0',expires_at:new Date(+started+7*86400000).toISOString()};
 const items=[];for(let i=0;i<count;i++){const object_key='media/'+owner+'/'+randomUUID(),data=JSON.stringify({ciphertext:'synthetic encrypted bytes '+i});await source.put(object_key,data);items.push({object_key,canonical_sha256:createHash('sha256').update(canonicalJson(JSON.parse(data))).digest('hex'),sha256:createHash('sha256').update(data).digest('hex'),byte_size:Buffer.byteLength(data)});}items.sort((a,b)=>a.object_key.localeCompare(b.object_key));
 await source.put('unreferenced-object','must never be copied');const deleted=new Set<string>();let completed=0;
 const db:BackupDatabase={journal:{async status(){return {generation,sequence:String(events.length),quarantined:false};},async page(after){return events.slice(Number(after));}},async start(){return run;},async info(){return run;},async page(_,cursor){return items.filter(i=>i.object_key>(cursor??'')).slice(0,8);},async missing(_,key){return deleted.has(key)?String(events.length):null;},async complete(){completed++;},async failed(){}};
 await initializePrivacyJournal(journal,db.journal);const control=await readJournalControl(journal);await journal.put('control.json',JSON.stringify({...control.value,mode:'active',reason:null}),{onlyIf:{etagMatches:control.etag}});
 const storage:BackupStorage={source,backup,journal,db};
 return{mf,storage,run,items,events,deleted,completed:()=>completed};
}
describe('Private media snapshot pipeline through native R2',()=>{
 it('copies only database inventory in bounded pages, resumes retries, and verifies complete manifests',async()=>{
  const f=await fixture();try{
   const id=await beginMediaBackup(f.storage);await expect(verifyMediaBackup(f.storage.backup,id,f.run.restore_at)).rejects.toThrow('BACKUP_INCOMPLETE');
   const first=await Promise.all([copyMediaBackupPage(f.storage,id),copyMediaBackupPage(f.storage,id)]);expect(first.sort()).toEqual(['busy','more']);
   expect((await f.storage.backup.list({prefix:'snapshots/'+id+'/objects/'})).objects).toHaveLength(8);
   expect(await copyMediaBackupPage(f.storage,id)).toBe('more');expect(await copyMediaBackupPage(f.storage,id)).toBe('more');expect(await copyMediaBackupPage(f.storage,id)).toBe('complete');
   const verified=await verifyMediaBackup(f.storage.backup,id,f.run.restore_at);expect(verified.objects).toBe(17);expect(verified.pages).toBe(3);expect(verified.omitted).toBe(0);expect(f.completed()).toBe(1);
   await expect(verifyMediaBackup(f.storage.backup,id,new Date(Date.now()+1).toISOString())).rejects.toThrow('BACKUP_PITR_MISMATCH');
   const key='snapshots/'+id+'/objects/'+f.items[0].object_key.slice(6);await f.storage.backup.put(key,'tampered');await expect(verifyMediaBackup(f.storage.backup,id,f.run.restore_at)).rejects.toThrow(/BACKUP_OBJECT_(MISSING|HASH_MISMATCH)/);
  }finally{await f.mf.dispose();}
 });
 it('fails on unexplained missing data and permits only journal-covered deletion omissions',async()=>{
  const f=await fixture(1);try{
   const id=await beginMediaBackup(f.storage);await f.storage.source.delete(f.items[0].object_key);
   await expect(copyMediaBackupPage(f.storage,id)).rejects.toThrow('BACKUP_SOURCE_OBJECT_MISSING');expect(await f.storage.backup.head('snapshots/'+id+'/complete.json')).toBeNull();
   f.events.push({sequence:'1',id:randomUUID(),occurred_at:new Date().toISOString(),decision:{action:'media_object',key:f.items[0].object_key}});f.deleted.add(f.items[0].object_key);
   expect(await copyMediaBackupPage(f.storage,id)).toBe('more');expect(await copyMediaBackupPage(f.storage,id)).toBe('complete');
   const verified=await verifyMediaBackup(f.storage.backup,id,f.run.restore_at);expect(verified.omitted).toBe(1);expect(verified.journalSequence).toBe('1');
  }finally{await f.mf.dispose();}
 });
 it('recovers an interrupted manifest write without duplicating objects or trusting damaged bytes',async()=>{
  const f=await fixture(2);try{
   const id=await beginMediaBackup(f.storage),original=f.storage.backup,proxy=new Proxy(original,{get(target,property){if(property==='put')return async(key:string,...args:any[])=>{if(key.includes('/pages/'))throw Error('simulated outage');return (target.put as any)(key,...args);};const value=(target as any)[property];return typeof value==='function'?value.bind(target):value;}});
   await expect(copyMediaBackupPage({...f.storage,backup:proxy},id)).rejects.toThrow('simulated outage');expect((await original.list({prefix:'snapshots/'+id+'/objects/'})).objects).toHaveLength(2);
   expect(await copyMediaBackupPage(f.storage,id)).toBe('more');expect(await copyMediaBackupPage(f.storage,id)).toBe('complete');expect((await verifyMediaBackup(original,id,f.run.restore_at)).objects).toBe(2);
   const state=JSON.parse(await(await original.get('snapshots/'+id+'/complete.json'))!.text());state.run.restore_at=new Date(Date.now()-8*86400000).toISOString();state.run.expires_at=new Date(Date.now()-86400000).toISOString();await original.put('snapshots/'+id+'/complete.json',JSON.stringify(state));
   await expect(verifyMediaBackup(original,id,state.run.restore_at)).rejects.toThrow(/BACKUP_(EXPIRED|RETENTION_INVALID)/);
  }finally{await f.mf.dispose();}
 });
 it('rejects changed raw upload bytes through native checksum validation before committing a copy',async()=>{
  const f=await fixture(1);try{
   const id=await beginMediaBackup(f.storage),key=f.items[0].object_key,raw=await(await f.storage.source.get(key))!.text();
   const corrupted=raw.replace('synthetic','corrupted');expect(corrupted.length).toBe(raw.length);await f.storage.source.put(key,corrupted);
   await expect(copyMediaBackupPage(f.storage,id)).rejects.toThrow();expect(await f.storage.backup.get('snapshots/'+id+'/objects/'+key.slice(6))).toBeNull();expect(await f.storage.backup.get('snapshots/'+id+'/complete.json')).toBeNull();
   await f.storage.source.put(key,raw);expect(await copyMediaBackupPage(f.storage,id)).toBe('more');expect(await copyMediaBackupPage(f.storage,id)).toBe('complete');
  }finally{await f.mf.dispose();}
 });
});
