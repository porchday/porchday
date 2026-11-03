import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {assertJournalReadable,beginPrivacyIntent,checkpointJournal,completePrivacyIntent,initializePrivacyJournal,provePrivacyReceipts,publishAuthPrivacyCommitScope,readJournalControl,sha256,type JournalDatabase,type JournalEvent,type JournalStore} from '../src/privacy-journal';

class Store implements JournalStore{
  rows=new Map<string,{text:string;etag:string}>();serial=0;reads:string[]=[];writes:string[]=[];
  async get(key:string){this.reads.push(key);const row=this.rows.get(key);return row?{etag:row.etag,text:async()=>row.text}:null;}
  async put(key:string,text:string,options?:{onlyIf?:{etagMatches?:string;etagDoesNotMatch?:string}}){
    const old=this.rows.get(key),condition=options?.onlyIf;
    if(condition?.etagDoesNotMatch==='*'&&old||condition?.etagMatches&&condition.etagMatches!==old?.etag)return null;
    this.writes.push(key);const etag=String(++this.serial);this.rows.set(key,{text,etag});return {etag};
  }
}
class Database implements JournalDatabase{
  generation=randomUUID();events:JournalEvent[]=[];quarantined=false;
  async status(){return {generation:this.generation,sequence:String(this.events.length),quarantined:this.quarantined};}
  async page(after:string){return this.events.slice(Number(after),Number(after)+3);}
  append(){this.events.push({sequence:String(this.events.length+1),id:randomUUID(),occurred_at:new Date().toISOString(),decision:{action:'delete',kind:'posts',id:randomUUID()}});}
}
const start=Date.parse('2026-10-26T06:16:49.000Z');
async function setup(){
  const store=new Store(),db=new Database();await initializePrivacyJournal(store,db);
  const current=await readJournalControl(store);await store.put('control.json',JSON.stringify({...current.value,mode:'active',reason:null}),{onlyIf:{etagMatches:current.etag}});
  return {store,db};
}
async function leaveDurableReceipt(store:Store,db:Database,events=1){
  const intent=await beginPrivacyIntent(store,db);for(let i=0;i<events;i++)db.append();
  const put=store.put.bind(store);let failed=false;
  store.put=async(key,text,options)=>{
    if(!failed&&key==='control.json'&&store.rows.has(`receipts/${intent.id}.json`)&&!JSON.parse(text).pending.some((p:{id:string})=>p.id===intent.id)){failed=true;throw Error('synthetic final control transport failure');}
    return put(key,text,options);
  };
  await expect(completePrivacyIntent(store,db,intent)).rejects.toThrow('synthetic final control');store.put=put;
  return intent;
}
describe('Active stale-intent receipt reconciliation',()=>{
  beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(start);});
  afterEach(()=>vi.useRealTimers());
  it('finishes only lost bookkeeping after durable completion without replay or immutable rewrites',async()=>{
    const {store,db}=await setup(),intent=await leaveDurableReceipt(store,db);
    const immutable=new Map([...store.rows].filter(([key])=>key!=='control.json')),events=JSON.stringify(db.events);store.writes=[];
    vi.setSystemTime(start+120001);const result=await assertJournalReadable(store,db);
    expect(result.value).toMatchObject({mode:'active',sequence:'1',pending:[]});expect(store.writes).toEqual(['control.json']);
    expect(JSON.stringify(db.events)).toBe(events);expect(new Map([...store.rows].filter(([key])=>key!=='control.json'))).toEqual(immutable);
    expect(store.rows.has(`receipts/${intent.id}.json`)).toBe(true);
  });
  it('accepts a receipt at an older actual ancestor and a canonical zero checkpoint',async()=>{
    for(const initialEvents of [0,1]){
      const {store,db}=await setup();await leaveDurableReceipt(store,db,initialEvents);
      const next=await beginPrivacyIntent(store,db);db.append();await completePrivacyIntent(store,db,next);
      vi.setSystemTime(start+120001);expect((await assertJournalReadable(store,db)).value.pending).toEqual([]);vi.setSystemTime(start);
    }
  });
  it('bounds proof to the matching current checkpoint even after a long history',async()=>{
    const {store,db}=await setup();
    for(let i=0;i<515;i++){db.append();await checkpointJournal(store,db);}
    await leaveDurableReceipt(store,db);store.reads=[];vi.setSystemTime(start+120001);
    expect((await assertJournalReadable(store,db)).value.pending).toEqual([]);
    expect(store.reads.filter(key=>key.startsWith('batches/'))).toHaveLength(1);
  });
  it('refuses an over-budget distant root proof without accepting a truncated chain',async()=>{
    const {store,db}=await setup();await leaveDurableReceipt(store,db,0);
    for(let i=0;i<513;i++){db.append();await checkpointJournal(store,db);}
    const before=store.rows.get('control.json');store.reads=[];vi.setSystemTime(start+120001);
    await expect(assertJournalReadable(store,db)).rejects.toThrow('JOURNAL_RECEIPT_PROOF_LIMIT');
    expect(store.rows.get('control.json')).toEqual(before);expect(store.reads.filter(key=>key.startsWith('batches/'))).toHaveLength(512);
  });
  it('retains unreceipted uncertainty and still quarantines it, even alongside proven completion',async()=>{
    const {store,db}=await setup();await leaveDurableReceipt(store,db);const unresolved=await beginPrivacyIntent(store,db);
    vi.setSystemTime(start+120001);await expect(assertJournalReadable(store,db)).rejects.toThrow('RESTORE_QUARANTINED');
    expect((await readJournalControl(store)).value).toMatchObject({mode:'quarantine',pending:[unresolved]});
    expect(store.rows.has(`receipts/${unresolved.id}.json`)).toBe(false);
  });
  it.each(['invalid JSON','wrong id','wrong generation','future sequence','extra field','null nonzero head','non-null zero head','changed intent'])( 'refuses %s without changing control',async kind=>{
    const {store,db}=await setup(),intent=await leaveDurableReceipt(store,db),key=`receipts/${intent.id}.json`;
    const row=store.rows.get(key)!,receipt=JSON.parse(row.text);
    if(kind==='wrong id')receipt.id=randomUUID();if(kind==='wrong generation')receipt.generation=randomUUID();
    if(kind==='future sequence')receipt.sequence='2';if(kind==='extra field')receipt.untrusted=true;
    if(kind==='null nonzero head')receipt.head=null;if(kind==='non-null zero head')receipt.sequence='0';
    store.rows.set(key,{...row,text:kind==='invalid JSON'?'invalid':JSON.stringify(receipt)});
    if(kind==='changed intent'){const original=store.rows.get(`intents/${intent.id}.json`)!;store.rows.set(`intents/${intent.id}.json`,{...original,text:JSON.stringify({...JSON.parse(original.text),started_at:new Date(start-1).toISOString()})});}
    const control=store.rows.get('control.json');vi.setSystemTime(start+120001);
    await expect(assertJournalReadable(store,db)).rejects.toThrow('INVALID_JOURNAL_RECEIPT');expect(store.rows.get('control.json')).toEqual(control);
  });
  it.each(['current','older'])('rejects a valid %s orphan/fork checkpoint that was never on the control chain',async age=>{
    const {store,db}=await setup(),intent=await leaveDurableReceipt(store,db),control=(await readJournalControl(store)).value;
    const batch=JSON.parse(store.rows.get(control.head!.key)!.text);batch.events[0].id=randomUUID();
    const text=JSON.stringify(batch),hash=await sha256(text),key=`batches/${db.generation}/1-1-${hash}.json`;
    await store.put(key,text);const receiptKey=`receipts/${intent.id}.json`,receipt=store.rows.get(receiptKey)!;
    store.rows.set(receiptKey,{...receipt,text:JSON.stringify({...JSON.parse(receipt.text),head:{key,hash}})});
    if(age==='older'){const next=await beginPrivacyIntent(store,db);db.append();await completePrivacyIntent(store,db,next);}
    const before=(await readJournalControl(store)).value;
    vi.setSystemTime(start+120001);await expect(assertJournalReadable(store,db)).rejects.toThrow('INVALID_JOURNAL_RECEIPT');
    expect((await readJournalControl(store)).value).toEqual(before);
  });
  it.each(['missing','tampered','range gap'])('refuses %s ancestry rather than trusting the receipt alone',async kind=>{
    const {store,db}=await setup();await leaveDurableReceipt(store,db);const control=(await readJournalControl(store)).value,row=store.rows.get(control.head!.key)!;
    if(kind==='missing')store.rows.delete(control.head!.key);
    if(kind==='tampered')store.rows.set(control.head!.key,{...row,text:row.text+' '});
    if(kind==='range gap'){
      const batch={...JSON.parse(row.text),previous:null,from:'0'},text=JSON.stringify(batch),hash=await sha256(text),key=`batches/${db.generation}/0-1-${hash}.json`;
      await store.put(key,text);const current=store.rows.get('control.json')!;store.rows.set('control.json',{...current,text:JSON.stringify({...control,head:{key,hash}})});
    }
    const before=store.rows.get('control.json');vi.setSystemTime(start+120001);
    await expect(assertJournalReadable(store,db)).rejects.toThrow(/JOURNAL_GAP|JOURNAL_HASH_MISMATCH/);expect(store.rows.get('control.json')).toEqual(before);
  });
  it.each(['generation','rollback','SQL quarantine','remote quarantine'])('does not perform receipt cleanup across %s',async kind=>{
    const {store,db}=await setup();await leaveDurableReceipt(store,db);
    if(kind==='generation')db.generation=randomUUID();if(kind==='rollback')db.events=[];if(kind==='SQL quarantine')db.quarantined=true;
    if(kind==='remote quarantine'){const current=store.rows.get('control.json')!;store.rows.set('control.json',{...current,text:JSON.stringify({...JSON.parse(current.text),mode:'quarantine',reason:'restore'})});}
    const before=store.rows.get('control.json');store.reads=[];vi.setSystemTime(start+120001);
    await expect(assertJournalReadable(store,db)).rejects.toThrow(/DATABASE_ROLLBACK_DETECTED|RESTORE_QUARANTINED/);
    expect(store.rows.get('control.json')).toEqual(before);expect(store.reads.some(key=>key.startsWith('receipts/'))).toBe(false);
  });
  it('re-proves a CAS conflict and retains a concurrently added live pending intent',async()=>{
    const {store,db}=await setup();await leaveDurableReceipt(store,db);vi.setSystemTime(start+120001);
    const put=store.put.bind(store),added={id:randomUUID(),started_at:new Date().toISOString()};let raced=false;
    store.put=async(key,text,options)=>{
      if(key==='control.json'&&!raced){raced=true;const current=await readJournalControl(store);await put(key,JSON.stringify({...current.value,pending:[...current.value.pending,added]}),{onlyIf:{etagMatches:current.etag}});}
      return put(key,text,options);
    };
    expect((await assertJournalReadable(store,db)).value).toMatchObject({mode:'active',pending:[added]});expect(raced).toBe(true);
  });
  it('does not undo a concurrent quarantine or quarantine a concurrently completed intent',async()=>{
    for(const mode of ['quarantine','completed']){
      vi.setSystemTime(start);const {store,db}=await setup();if(mode==='quarantine')await leaveDurableReceipt(store,db);else await beginPrivacyIntent(store,db);
      vi.setSystemTime(start+120001);const put=store.put.bind(store);let raced=false;
      store.put=async(key,text,options)=>{
        if(key==='control.json'&&!raced){raced=true;const current=await readJournalControl(store);await put(key,JSON.stringify(mode==='quarantine'?{...current.value,mode:'quarantine',reason:'operator'}:{...current.value,pending:[]}),{onlyIf:{etagMatches:current.etag}});}
        return put(key,text,options);
      };
      if(mode==='quarantine'){await expect(assertJournalReadable(store,db)).rejects.toThrow('RESTORE_QUARANTINED');expect((await readJournalControl(store)).value.reason).toBe('operator');}
      else expect((await assertJournalReadable(store,db)).value).toMatchObject({mode:'active',pending:[]});
    }
  });
  it('refuses duplicate intent identities and bounded-proof exhaustion without removing pending',async()=>{
    const {store,db}=await setup(),intent=await leaveDurableReceipt(store,db),remote=await readJournalControl(store);
    await expect(provePrivacyReceipts(store,remote.value,[intent],{remaining:1})).rejects.toThrow('JOURNAL_RECEIPT_PROOF_LIMIT');
    await store.put('control.json',JSON.stringify({...remote.value,pending:[intent,intent]}),{onlyIf:{etagMatches:remote.etag}});
    const before=store.rows.get('control.json');vi.setSystemTime(start+120001);
    await expect(assertJournalReadable(store,db)).rejects.toThrow('INVALID_JOURNAL_RECEIPT');expect(store.rows.get('control.json')).toEqual(before);
  });
  it('revalidates SQL after ancestry proof and refuses a changed database before CAS',async()=>{
    const {store,db}=await setup();await leaveDurableReceipt(store,db);const before=store.rows.get('control.json'),get=store.get.bind(store);
    store.get=async key=>{const object=await get(key);if(key.startsWith('batches/'))db.generation=randomUUID();return object;};
    vi.setSystemTime(start+120001);await expect(assertJournalReadable(store,db)).rejects.toThrow('DATABASE_ROLLBACK_DETECTED');expect(store.rows.get('control.json')).toEqual(before);
  });
  it('bounds repeated CAS conflicts and keeps the original unresolved control',async()=>{
    const {store,db}=await setup();await leaveDurableReceipt(store,db);const before=store.rows.get('control.json'),put=store.put.bind(store);let attempts=0;
    store.put=async(key,text,options)=>{if(key==='control.json'){attempts++;return null;}return put(key,text,options);};
    vi.setSystemTime(start+120001);await expect(assertJournalReadable(store,db)).rejects.toThrow('JOURNAL_BUSY');expect(attempts).toBe(8);expect(store.rows.get('control.json')).toEqual(before);
  });
  it('propagates a lost removal response as unknown, then the next read observes the completed removal',async()=>{
    const {store,db}=await setup();await leaveDurableReceipt(store,db);vi.setSystemTime(start+120001);const put=store.put.bind(store);let lost=false;
    store.put=async(key,text,options)=>{const result=await put(key,text,options);if(key==='control.json'&&result&&!lost){lost=true;throw Error('lost successful CAS response');}return result;};
    await expect(assertJournalReadable(store,db)).rejects.toThrow('lost successful CAS response');
    expect((await assertJournalReadable(store,db)).value).toMatchObject({mode:'active',pending:[]});
  });
});


describe('Independent auth commit recovery',()=>{
  beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(start);});
  afterEach(()=>vi.useRealTimers());
  async function committed(){
    const {store,db}=await setup(),intent=await beginPrivacyIntent(store,db),scope=await publishAuthPrivacyCommitScope(store,db,intent);
    db.events.push({sequence:'1',id:randomUUID(),occurred_at:new Date().toISOString(),decision:{kind:'privacy_operation_committed',operation_id:intent.id,scope_sha256:scope.scopeSha256}});
    return {store,db,intent};
  }
  it('exports committed history and recovers without replaying SQL work',async()=>{
    const {store,db,intent}=await committed(),events=JSON.stringify(db.events);vi.setSystemTime(start+120001);
    expect((await assertJournalReadable(store,db,undefined,true)).value).toMatchObject({mode:'active',sequence:'1',pending:[]});
    expect(store.rows.has(`receipts/${intent.id}.json`)).toBe(true);expect(JSON.stringify(db.events)).toBe(events);
  });
  it('keeps recovery disabled unless explicitly enabled',async()=>{
    const {store,db,intent}=await committed();vi.setSystemTime(start+120001);
    await expect(assertJournalReadable(store,db)).rejects.toThrow('RESTORE_QUARANTINED');
    expect(store.rows.has(`receipts/${intent.id}.json`)).toBe(false);
  });
  it('retires proven commits but quarantines remaining uncertainty',async()=>{
    const {store,db,intent}=await committed(),unknown=await beginPrivacyIntent(store,db);vi.setSystemTime(start+120001);
    await expect(assertJournalReadable(store,db,undefined,true)).rejects.toThrow('RESTORE_QUARANTINED');
    expect((await readJournalControl(store)).value).toMatchObject({mode:'quarantine',pending:[unknown]});
    expect(store.rows.has(`receipts/${intent.id}.json`)).toBe(true);expect(store.rows.has(`receipts/${unknown.id}.json`)).toBe(false);
  });
  it.each(['generation','rollback','quarantine'])('refuses SQL %s during independent proof before writing a receipt',async fault=>{
    const {store,db,intent}=await committed();await checkpointJournal(store,db);const get=store.get.bind(store);
    store.get=async key=>{const result=await get(key);if(key.startsWith('batches/')){if(fault==='generation')db.generation=randomUUID();if(fault==='rollback')db.events=[];if(fault==='quarantine')db.quarantined=true;}return result;};
    vi.setSystemTime(start+120001);await expect(assertJournalReadable(store,db,undefined,true)).rejects.toThrow(/DATABASE_ROLLBACK_DETECTED|RESTORE_QUARANTINED/);
    expect(store.rows.has(`receipts/${intent.id}.json`)).toBe(false);expect((await readJournalControl(store)).value.pending).toEqual([intent]);
  });
  it.each(['registration','quarantine'])('preserves concurrent %s during receipt publication',async race=>{
    const {store,db,intent}=await committed(),put=store.put.bind(store);vi.setSystemTime(start+120001);
    const added={id:randomUUID(),started_at:new Date().toISOString()};let raced=false;
    store.put=async(key,text,options)=>{
      if(key.startsWith('receipts/')&&!raced){raced=true;const current=await readJournalControl(store);await put('control.json',JSON.stringify(race==='registration'?{...current.value,pending:[...current.value.pending,added]}:{...current.value,mode:'quarantine',reason:'operator'}),{onlyIf:{etagMatches:current.etag}});}
      return put(key,text,options);
    };
    if(race==='registration')expect((await assertJournalReadable(store,db,undefined,true)).value).toMatchObject({mode:'active',pending:[added]});
    else {await expect(assertJournalReadable(store,db,undefined,true)).rejects.toThrow('RESTORE_QUARANTINED');expect((await readJournalControl(store)).value).toMatchObject({mode:'quarantine',reason:'operator',pending:[intent]});}
    expect(raced).toBe(true);
  });
  it('reconciles a lost successful receipt response on the next read',async()=>{
    const {store,db,intent}=await committed(),put=store.put.bind(store),events=JSON.stringify(db.events);let lost=false;
    store.put=async(key,text,options)=>{const result=await put(key,text,options);if(key.startsWith('receipts/')&&result&&!lost){lost=true;throw Error('lost receipt response');}return result;};
    vi.setSystemTime(start+120001);await expect(assertJournalReadable(store,db,undefined,true)).rejects.toThrow('lost receipt response');
    expect((await readJournalControl(store)).value.pending).toEqual([intent]);
    expect((await assertJournalReadable(store,db,undefined,true)).value).toMatchObject({mode:'active',pending:[]});expect(JSON.stringify(db.events)).toBe(events);
  });
  it('bounds repeated retirement conflicts',async()=>{
    const {store,db}=await committed();await checkpointJournal(store,db);const put=store.put.bind(store);let attempts=0;
    store.put=async(key,text,options)=>{if(key==='control.json'){attempts++;return null;}return put(key,text,options);};
    vi.setSystemTime(start+120001);await expect(assertJournalReadable(store,db,undefined,true)).rejects.toThrow('JOURNAL_BUSY');expect(attempts).toBe(8);
  });
});
