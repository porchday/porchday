import {describe,it,expect} from 'vitest';
import {cloneStableJournalCut} from './clone-journal-cut.js';
import {initializePrivacyJournal,checkpointJournal,readJournalControl,verifyJournalChain,type JournalStore,type JournalDatabase,type JournalEvent} from '../apps/api/src/privacy-journal.js';
class Memory implements JournalStore {
 data=new Map<string,{etag:string,value:string}>(); writes=0; hook?:(key:string)=>Promise<void>;
 async get(key:string){const item=this.data.get(key);return item?{etag:item.etag,text:async()=>item.value}:null;}
 async put(key:string,value:string,condition?:{onlyIf?:{etagMatches?:string;etagDoesNotMatch?:string}}){
  const previous=this.data.get(key),c=condition?.onlyIf;if(c?.etagDoesNotMatch==='*'&&previous||c?.etagMatches&&previous?.etag!==c.etagMatches)return null;
  const etag=String(++this.writes);this.data.set(key,{etag,value});await this.hook?.(key);return {etag};
 }
}
async function setup(){
 const source=new Memory(),target=new Memory(),generation=crypto.randomUUID();let sequence='1';
 const events:JournalEvent[]=[{sequence:'1',id:crypto.randomUUID(),occurred_at:new Date().toISOString(),decision:{kind:'delete',table:'posts',id:crypto.randomUUID()}}];
 const db:JournalDatabase={async status(){return {generation,sequence,quarantined:false};},async page(after){return events.filter(e=>BigInt(e.sequence)>BigInt(after));}};
 await initializePrivacyJournal(source,db);const c=await readJournalControl(source);await source.put('control.json',JSON.stringify({...c.value,mode:'active',reason:null}));
 return {source,target,db,events,setSequence:(value:string)=>{sequence=value;}};
}
describe('Isolated stable journal cut',()=>{
 it('copies and verifies a quarantined chain without mutating the active source',async()=>{
  const {source,target,db}=await setup(),before=new Map(source.data),writes=source.writes;
  const result=await cloneStableJournalCut(source,target,db);expect(result).toMatchObject({sequence:'1',batches:1,events:1});
  expect(source.data).toEqual(before);expect(source.writes).toBe(writes);
  expect((await verifyJournalChain(target)).control).toMatchObject({mode:'quarantine',reason:'isolated_restore_drill',pending:[],sequence:'1'});
  await expect(cloneStableJournalCut(source,target,db)).rejects.toThrow('RESTORE_TARGET_ALREADY_INITIALIZED');
 });
 it('refuses pending intents and a database tail not yet independently checkpointed',async()=>{
  const x=await setup(),c=await readJournalControl(x.source);await x.source.put('control.json',JSON.stringify({...c.value,pending:[{id:crypto.randomUUID(),started_at:new Date().toISOString()}]}));
  await expect(cloneStableJournalCut(x.source,x.target,x.db)).rejects.toThrow('RESTORE_SOURCE_NOT_QUIET');expect(x.target.writes).toBe(0);
  await x.source.put('control.json',JSON.stringify(c.value));x.setSequence('2');
  await expect(cloneStableJournalCut(x.source,x.target,x.db)).rejects.toThrow('RESTORE_SOURCE_CHANGED');expect(x.target.writes).toBe(0);
 });
 it('does not publish control when the source advances during immutable copy',async()=>{
  const x=await setup();x.target.hook=async key=>{if(key.startsWith('batches/')){x.target.hook=undefined;x.events.push({...x.events[0],sequence:'2',id:crypto.randomUUID()});x.setSequence('2');await checkpointJournal(x.source,x.db);}};
  await expect(cloneStableJournalCut(x.source,x.target,x.db)).rejects.toThrow('RESTORE_SOURCE_CHANGED');expect(await x.target.get('control.json')).toBeNull();
 });
 it('leaves a quarantined unused target if the source changes just after publication',async()=>{
  const x=await setup();x.target.hook=async key=>{if(key==='control.json')x.setSequence('2');};
  await expect(cloneStableJournalCut(x.source,x.target,x.db)).rejects.toThrow('RESTORE_SOURCE_CHANGED');expect((await readJournalControl(x.target)).value.mode).toBe('quarantine');
 });
 it('rejects corrupted source bytes before publishing target control',async()=>{
  const x=await setup(),c=await readJournalControl(x.source);await x.source.put(c.value.head!.key,'{}');
  await expect(cloneStableJournalCut(x.source,x.target,x.db)).rejects.toThrow('JOURNAL_HASH_MISMATCH');expect(await x.target.get('control.json')).toBeNull();
 });
});
