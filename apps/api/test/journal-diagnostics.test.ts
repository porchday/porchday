import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {Env} from '../src/types';
import {logoutJournalTiming} from '../src/journal-timing';
const database=vi.hoisted(()=>({query:Object.assign(vi.fn(),{end:vi.fn()})}));
vi.mock('postgres',()=>({default:()=>database.query}));
import {withHttpPrivacyJournal,withPrivacyJournal,readJournalControl,detectStalePrivacyIntents,type JournalStore} from '../src/privacy-journal';

class Store implements JournalStore{
 rows=new Map<string,{etag:string;text:string}>();serial=0;failReceipt=false;
 async get(key:string){const row=this.rows.get(key);return row?{etag:row.etag,text:async()=>row.text}:null;}
 async put(key:string,text:string,options?:{onlyIf?:{etagMatches?:string;etagDoesNotMatch?:string}}){
  if(this.failReceipt&&key.startsWith('receipts/'))throw Error('private provider error with token=secret');
  const row=this.rows.get(key),condition=options?.onlyIf;
  if(condition?.etagDoesNotMatch==='*'&&row||condition?.etagMatches&&condition.etagMatches!==row?.etag)return null;
  const etag=String(++this.serial);this.rows.set(key,{etag,text});return {etag};
 }
}
describe('Privacy-journal failure phase diagnostics preserve durability decisions',()=>{
 let store:Store,env:Env,points:AnalyticsEngineDataPoint[];
 const rawError=()=>Error('private SQL password and member@example.test link=secret');
 beforeEach(async()=>{
  store=new Store();points=[];const generation=randomUUID();
  await store.put('control.json',JSON.stringify({v:1,generation,mode:'active',sequence:'0',head:null,pending:[],reason:null}));
  database.query.mockReset();database.query.end.mockReset().mockResolvedValue(undefined);
  database.query.mockImplementation(async(parts:TemplateStringsArray)=>{
   if(parts[0].includes('app.safety_status()'))return [{value:{generation,sequence:'0',quarantined:false}}];
   throw Error('Unexpected test query');
  });
  env={ENVIRONMENT:'staging',RECOVERY_JOURNAL:store,HYPERDRIVE_JOBS:{connectionString:'synthetic-not-connected'},METRICS:{writeDataPoint:(point:AnalyticsEngineDataPoint)=>{points.push(point);}}} as unknown as Env;
 });
 const codes=()=>points.filter(point=>point.blobs?.[2]!=='journal_phase').map(point=>point.blobs?.[5]);
 afterEach(()=>vi.useRealTimers());
 const receiptCount=()=>[...store.rows.keys()].filter(key=>key.startsWith('receipts/')).length;
 it('attributes setup failure before work without fabricating an intent receipt',async()=>{
  store.rows.delete('control.json');const work=vi.fn();
  await expect(withPrivacyJournal(env,work)).rejects.toThrow('JOURNAL_NOT_INITIALIZED');
  expect(work).not.toHaveBeenCalled();expect(codes()).toEqual(['journal_begin_failed']);expect(receiptCount()).toBe(0);
 });
 it('leaves an unknown work failure pending and later quarantines it exactly as before',async()=>{
  const failure=rawError();await expect(withPrivacyJournal(env,async()=>{throw failure;})).rejects.toBe(failure);
  const current=(await readJournalControl(store)).value;expect(current.pending).toHaveLength(1);expect(receiptCount()).toBe(0);expect(codes()).toEqual(['journal_work_failed']);
  await detectStalePrivacyIntents(store,Date.parse(current.pending[0].started_at)+120001);
  expect((await readJournalControl(store)).value.mode).toBe('quarantine');expect(JSON.stringify(points)).not.toMatch(/private|password|member@example|secret/);
 });
 it('preserves existing proven-rejection reconciliation and propagates the same error',async()=>{
  const failure=Object.assign(rawError(),{code:'23505'});await expect(withPrivacyJournal(env,async()=>{throw failure;})).rejects.toBe(failure);
  expect((await readJournalControl(store)).value.pending).toHaveLength(0);expect(receiptCount()).toBe(1);expect(codes()).toEqual(['journal_work_failed']);
 });
 it('identifies durability completion failure and does not acknowledge or clear the intent',async()=>{
  vi.useFakeTimers();store.failReceipt=true;env.LOGOUT_PHASE_TIMING='true';const timing=logoutJournalTiming(env,{method:'POST',path:'/api/auth/sign-out'});const result=expect(withPrivacyJournal(env,async()=>42,timing)).rejects.toThrow('PRIVACY_CHECKPOINT_REQUIRED');
  await vi.runAllTimersAsync();await result;
  expect((await readJournalControl(store)).value.pending).toHaveLength(1);expect(receiptCount()).toBe(0);expect(codes()).toEqual(['journal_r2_write_retry','journal_r2_write_retry','journal_r2_write_retry','journal_io_exhausted','journal_completion_failed']);
  expect(JSON.stringify(points)).not.toMatch(/private|token|secret/);
  const phases=points.filter(p=>p.blobs?.[2]==='journal_phase');
  expect(phases.find(p=>p.blobs?.[5]==='receipt')?.doubles?.[1]).toBeGreaterThanOrEqual(7000);
  expect(phases.some(p=>p.blobs?.[5]==='retirement')).toBe(false);
 });
 it('distinguishes a close failure after a durable completion from an unresolved mutation',async()=>{
  const failure=rawError();database.query.end.mockRejectedValueOnce(failure);
  await expect(withPrivacyJournal(env,async()=>42)).rejects.toBe(failure);
  expect((await readJournalControl(store)).value.pending).toHaveLength(0);expect(receiptCount()).toBe(1);expect(codes()).toEqual(['journal_close_failed']);
 });
 it('does not let failed telemetry replace the original error or resolve an uncertain intent',async()=>{
  env.METRICS={writeDataPoint(){throw Error('private telemetry unavailable');}} as never;
  const failure=rawError();await expect(withPrivacyJournal(env,async()=>{throw failure;})).rejects.toBe(failure);
  expect((await readJournalControl(store)).value.pending).toHaveLength(1);expect(receiptCount()).toBe(0);
 });
 it('does not add failure events to the normal success path',async()=>{
  await expect(withPrivacyJournal(env,async()=>42)).resolves.toBe(42);expect(codes()).toEqual([]);
  expect((await readJournalControl(store)).value.pending).toHaveLength(0);expect(receiptCount()).toBe(1);
 });
 it('measures an opted-in logout without exposing identity or changing completion',async()=>{
  env.LOGOUT_PHASE_TIMING='true';const work=vi.fn(async()=>42);
  const context={env,req:{method:'POST',path:'/api/auth/sign-out'},executionCtx:{waitUntil:vi.fn()}};
  await expect(withHttpPrivacyJournal(context,work)).resolves.toBe(42);
  expect(work).toHaveBeenCalledTimes(1);expect(context.executionCtx.waitUntil).toHaveBeenCalledTimes(1);
  const timing=points.filter(p=>p.blobs?.[2]==='journal_phase');
  expect(timing.filter(p=>!['r2_read','r2_write','database_status','database_page'].includes(String(p.blobs?.[5]))).map(p=>p.blobs?.[5])).toEqual(['guard','registration','work','checkpoint','receipt','retirement','close']);
  expect(timing.some(p=>p.blobs?.[5]==='r2_read')).toBe(true);
  expect(timing.some(p=>p.blobs?.[5]==='r2_write')).toBe(true);
  expect(timing.some(p=>p.blobs?.[5]==='database_status')).toBe(true);
  expect(timing.every(p=>p.blobs?.[3]==='/api/auth/sign-out'&&Number(p.doubles?.[1])>=0)).toBe(true);
  expect((await readJournalControl(store)).value.pending).toHaveLength(0);expect(receiptCount()).toBe(1);
  for(const key of store.rows.keys())if(key!=='control.json')expect(JSON.stringify(timing)).not.toContain(key);
 });
 it('enabled measurements cannot turn an ambiguous logout into a receipt or retry it',async()=>{
  env.LOGOUT_PHASE_TIMING='true';const failure=rawError(),work=vi.fn(async()=>{throw failure;});
  await expect(withHttpPrivacyJournal({env,req:{method:'POST',path:'/api/auth/sign-out'},executionCtx:{waitUntil:vi.fn()}},work)).rejects.toBe(failure);
  expect(work).toHaveBeenCalledTimes(1);expect(receiptCount()).toBe(0);
  expect((await readJournalControl(store)).value.pending).toHaveLength(1);
  const timing=points.filter(p=>p.blobs?.[2]==='journal_phase');
  expect(timing.some(p=>p.blobs?.[5]==='work')).toBe(true);
  expect(timing.some(p=>p.blobs?.[5]==='receipt'||p.blobs?.[5]==='retirement')).toBe(false);
  expect(JSON.stringify(points)).not.toMatch(/private|password|member@example|secret/);
 });

});
