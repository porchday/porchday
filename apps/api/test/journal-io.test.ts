import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {resilientJournalIO} from '../src/journal-io';
import {initializePrivacyJournal,beginPrivacyIntent,completePrivacyIntent,readJournalControl,assertJournalReadable,type JournalStore,type JournalDatabase} from '../src/privacy-journal';

class Store implements JournalStore{
 rows=new Map<string,{etag:string;text:string}>();serial=0;
 async get(key:string){const row=this.rows.get(key);return row?{etag:row.etag,text:async()=>row.text}:null;}
 async put(key:string,text:string,condition?:{onlyIf?:{etagMatches?:string;etagDoesNotMatch?:string}}){
  const old=this.rows.get(key);if(condition?.onlyIf?.etagDoesNotMatch==='*'&&old||condition?.onlyIf?.etagMatches&&old?.etag!==condition.onlyIf.etagMatches)return null;
  const etag=String(++this.serial);this.rows.set(key,{etag,text});return{etag};
 }
}
async function setup(){
 const store=new Store(),generation=randomUUID(),db:JournalDatabase={status:async()=>({generation,sequence:'0',quarantined:false}),page:async()=>[]};
 await initializePrivacyJournal(store,db);const control=await readJournalControl(store);await store.put('control.json',JSON.stringify({...control.value,mode:'active',reason:null}),{onlyIf:{etagMatches:control.etag}});
 const codes:string[]=[],delays:number[]=[];let clock=0;
 const io=resilientJournalIO(store,db,{report:c=>codes.push(c),random:()=>0,now:()=>clock,sleep:async ms=>{delays.push(ms);clock+=ms;}});
 return{store,db,io,codes,delays,advance:(ms:number)=>{clock+=ms;}};
}
describe('bounded journal transport recovery',()=>{
 it('does not register a duplicate intent after losing the successful registration reply',async()=>{
  const {store,io}=await setup(),put=store.put.bind(store);let failed=false;
  store.put=async(k,v,c)=>{const result=await put(k,v,c);if(k==='control.json'&&!failed&&result){failed=true;throw Error('registration reply lost');}return result;};
  const intent=await beginPrivacyIntent(io.store,io.db);
  expect((await readJournalControl(store)).value.pending).toEqual([intent]);
  await completePrivacyIntent(io.store,io.db,intent);
  expect((await readJournalControl(store)).value.pending).toEqual([]);
 });
 it.each(['before receipt write','lost receipt response','before pending removal','lost pending removal response'])('finishes %s without replaying work or weakening CAS',async point=>{
  const {store,db,io,codes,delays}=await setup();const intent=await beginPrivacyIntent(store,db),put=store.put.bind(store);let failed=false;
  store.put=async(key,text,condition)=>{
   const target=point.includes('receipt')?key.startsWith('receipts/'):key==='control.json'&&!JSON.parse(text).pending.length;
   if(target&&!failed){failed=true;if(point.startsWith('lost'))await put(key,text,condition);throw Error('private provider failure 429 token=not-logged');}
   return put(key,text,condition);
  };
  const work=vi.fn(async()=>42);expect(await work()).toBe(42);
  await completePrivacyIntent(io.store,io.db,intent);
  expect(work).toHaveBeenCalledTimes(1);expect((await readJournalControl(store)).value).toMatchObject({mode:'active',pending:[]});
  expect([...store.rows.keys()].filter(k=>k.startsWith('receipts/'))).toHaveLength(1);
  expect(codes).toEqual(['journal_r2_write_retry']);expect(delays).toEqual([1000]);
 });
 it('retains unknown operations when storage stays unavailable',async()=>{
  const {store,db,io,codes,delays}=await setup(),intent=await beginPrivacyIntent(store,db),put=store.put.bind(store);let attempts=0;
  store.put=async(k,v,c)=>{if(k.startsWith('receipts/')){attempts++;throw Error('private outage');}return put(k,v,c);};
  await expect(completePrivacyIntent(io.store,io.db,intent)).rejects.toThrow('private outage');
  expect(attempts).toBe(4);expect(delays).toEqual([1000,2000,4000]);expect(codes.at(-1)).toBe('journal_io_exhausted');
  expect((await readJournalControl(store)).value.pending).toEqual([intent]);expect(store.rows.has('receipts/'+intent.id+'.json')).toBe(false);
 });
 it('retries a transient connection-capacity rejection with a fresh SQL status read',async()=>{
  const {db,io,codes}=await setup(),status=db.status;let attempts=0;
  db.status=async()=>{if(++attempts===1)throw Object.assign(Error('private connection parameters'),{code:'53300'});return status();};
  await expect(assertJournalReadable(io.store,io.db)).resolves.toBeDefined();expect(attempts).toBe(2);expect(codes).toEqual(['journal_db_capacity_retry']);
 });
 it('never retries SQL work errors or a valid quarantine/rollback decision',async()=>{
  const {store,db,io,codes}=await setup();let attempts=0;
  db.status=async()=>{attempts++;throw Object.assign(Error('bad query'),{code:'42501'});};
  await expect(assertJournalReadable(io.store,io.db)).rejects.toThrow('JOURNAL_DATABASE_READ_FAILED');expect(attempts).toBe(1);expect(codes).toEqual([]);
  const current=(await readJournalControl(store)).value;db.status=async()=>({generation:current.generation,sequence:current.sequence,quarantined:true});
  await expect(assertJournalReadable(io.store,io.db)).rejects.toThrow('RESTORE_QUARANTINED');expect(codes).toEqual([]);
 });
 it('shares its retry budget across reads and writes and does not repeat unconditional writes',async()=>{
  const {store,io,codes}=await setup(),get=store.get.bind(store);let reads=0,writes=0;
  store.get=async k=>{if(reads++<2)throw Error('private read error');return get(k);};await io.store.get('control.json');
  store.put=async()=>{writes++;throw Error('private write error');};
  await expect(io.store.put('control.json','value',{onlyIf:{etagMatches:'old'}})).rejects.toThrow();expect(writes).toBe(2);
  await expect(io.store.put('unconditional','value')).rejects.toThrow();expect(writes).toBe(3);expect(codes.at(-1)).toBe('journal_io_exhausted');
 });
 it('cannot overwrite a concurrent control change after a lost successful write',async()=>{
  const {store,io}=await setup(),old=(await readJournalControl(store)),put=store.put.bind(store);let failed=false;
  store.put=async(k,v,c)=>{const result=await put(k,v,c);if(!failed){failed=true;const newer=await readJournalControl(store);await put(k,JSON.stringify({...newer.value,mode:'quarantine',reason:'operator'}),{onlyIf:{etagMatches:newer.etag}});throw Error('lost response');}return result;};
  expect(await io.store.put('control.json',JSON.stringify({...old.value,reason:'first'}),{onlyIf:{etagMatches:old.etag}})).toBeNull();
  expect((await readJournalControl(store)).value).toMatchObject({mode:'quarantine',reason:'operator'});
 });
 it('retries a failed object body read and contains telemetry failures',async()=>{
  const {store,db}=await setup(),get=store.get.bind(store);let calls=0;
  store.get=async key=>{const value=await get(key);return calls++===0?{etag:'old',text:async()=>{throw Error('body failed');}}:value;};
  const io=resilientJournalIO(store,db,{report:()=>{throw Error('metrics failed');},sleep:async()=>{},random:()=>0});
  expect(await io.store.get('control.json')).not.toBeNull();expect(calls).toBe(2);
 });
 it('stops starting retries after the elapsed budget without turning a failure into success',async()=>{
  const {store,io,advance,delays}=await setup();let calls=0;
  store.get=async()=>{calls++;advance(10001);throw Error('slow failed read');};
  await expect(io.store.get('control.json')).rejects.toThrow();expect(calls).toBe(2);expect(delays).toEqual([1000]);
 });
});
