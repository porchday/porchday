import {beforeEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Hono} from 'hono';
import type {Env,Variables} from '../src/types';
const database=vi.hoisted(()=>({query:Object.assign(vi.fn(),{end:vi.fn()})}));
vi.mock('postgres',()=>({default:()=>database.query}));
import {logoutJournalTiming} from '../src/journal-timing';
import {withHttpPrivacyJournal,privacyReadGuard,privacyMutationMiddleware,readJournalControl,type JournalStore} from '../src/privacy-journal';

function deferred<T=void>(){
 let resolve!:(value:T|PromiseLike<T>)=>void,reject!:(error:unknown)=>void;
 const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});
 return {promise,resolve,reject};
}
class Store implements JournalStore{
 rows=new Map<string,{etag:string;text:string}>();serial=0;
 beforeReceipt:()=>Promise<void>=async()=>{};
 async get(key:string){const row=this.rows.get(key);return row?{etag:row.etag,text:async()=>row.text}:null;}
 async put(key:string,text:string,options?:{onlyIf?:{etagMatches?:string;etagDoesNotMatch?:string}}){
  if(key.startsWith('receipts/'))await this.beforeReceipt();
  const row=this.rows.get(key),condition=options?.onlyIf;
  if(condition?.etagDoesNotMatch==='*'&&row||condition?.etagMatches&&condition.etagMatches!==row?.etag)return null;
  const etag=String(++this.serial);this.rows.set(key,{etag,text});return {etag};
 }
}
describe('HTTP privacy operations retain one awaited durability lifecycle',()=>{
 let store:Store,env:Env;
 beforeEach(async()=>{
  store=new Store();const generation=randomUUID();
  await store.put('control.json',JSON.stringify({v:1,generation,mode:'active',sequence:'0',head:null,pending:[],reason:null}));
  database.query.mockReset();database.query.end.mockReset().mockResolvedValue(undefined);
  database.query.mockImplementation(async(parts:TemplateStringsArray)=>{
   if(parts[0].includes('app.safety_status()'))return [{value:{generation,sequence:'0',quarantined:false}}];
   throw Error('Unexpected test query');
  });
  env={ENVIRONMENT:'production',RECOVERY_JOURNAL:store,HYPERDRIVE_JOBS:{connectionString:'synthetic-not-connected'}} as unknown as Env;
 });
 it.each([false,true])('times the outer logout guard and close without bypassing failed checks (%s)',async(fail)=>{
  const writeDataPoint=vi.fn(),handler=vi.fn(c=>c.json({ok:true}));
  env.LOGOUT_PHASE_TIMING='true';env.METRICS={writeDataPoint} as never;
  if(fail)database.query.mockRejectedValue(Error('private database failure'));
  const app=new Hono<{Bindings:Env;Variables:Variables}>();
  app.use('*',privacyReadGuard);app.post('/api/auth/sign-out',handler);
  const response=await app.request('/api/auth/sign-out',{method:'POST'},env);
  expect(response.status).toBe(fail?503:200);
  expect(handler).toHaveBeenCalledTimes(fail?0:1);
  expect(database.query.end).toHaveBeenCalledTimes(1);
  const points=writeDataPoint.mock.calls.map(([point])=>point).filter(point=>point.blobs[2]==='journal_phase');
  expect(points.map(point=>point.blobs[5])).toEqual(['read_guard','read_guard_close']);
  expect(JSON.stringify(points)).not.toContain('private database failure');
 });
 function execution(){
  return {pending:[] as Promise<unknown>[],waitUntil(p:Promise<unknown>){this.pending.push(p);},passThroughOnException(){},props:{}};
 }
 it('registers immediately and retains work, receipt, and connection close without acknowledging early',async()=>{
  const ctx=execution(),workGate=deferred<number>(),workStarted=deferred(),receiptGate=deferred(),receiptStarted=deferred(),closeGate=deferred(),closeStarted=deferred();
  const work=vi.fn(()=>{workStarted.resolve();return workGate.promise;});
  store.beforeReceipt=()=>{receiptStarted.resolve();return receiptGate.promise;};
  database.query.end.mockImplementation(()=>{closeStarted.resolve();return closeGate.promise;});
  const original=withHttpPrivacyJournal({env,executionCtx:ctx},work);
  expect(ctx.pending).toHaveLength(1);expect(work).not.toHaveBeenCalled();
  let originalSettled=false,observerSettled=false;
  void original.then(()=>{originalSettled=true;});
  void ctx.pending[0].then(()=>{observerSettled=true;});
  await workStarted.promise;
  expect(work).toHaveBeenCalledTimes(1);expect(originalSettled).toBe(false);expect(observerSettled).toBe(false);
  workGate.resolve(42);await receiptStarted.promise;
  expect((await readJournalControl(store)).value.pending).toHaveLength(1);
  expect(originalSettled).toBe(false);expect(observerSettled).toBe(false);
  receiptGate.resolve();await closeStarted.promise;
  expect((await readJournalControl(store)).value.pending).toHaveLength(0);
  expect(originalSettled).toBe(false);expect(observerSettled).toBe(false);
  closeGate.resolve();await expect(original).resolves.toBe(42);await expect(ctx.pending[0]).resolves.toBeUndefined();
  expect(work).toHaveBeenCalledTimes(1);expect([...store.rows.keys()].filter(k=>k.startsWith('intents/'))).toHaveLength(1);
 });
 it('shares caller phase timing through journal completion in one summary',async()=>{
  const writeDataPoint=vi.fn();env.LOGOUT_PHASE_TIMING='true';env.METRICS={writeDataPoint} as never;
  const req={method:'POST',path:'/api/auth/sign-out'},timing=logoutJournalTiming(env,req)!;
  timing.record('initial_authorization',321);
  await expect(withHttpPrivacyJournal({env,req,executionCtx:execution()},async()=>42,timing)).resolves.toBe(42);
  timing.finish(true);
  const summaries=writeDataPoint.mock.calls.map(([p])=>p).filter(p=>p.blobs[2]==='logout_summary');expect(summaries).toHaveLength(1);
  expect(summaries[0].doubles[1]).toBe(1);expect(summaries[0].doubles[3]).toBe(321);
  for(const n of summaries[0].doubles.slice(4,11))expect(n).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(summaries)).not.toMatch(/synthetic|generation|sequence/);
 });
 it('propagates an unknown work error unchanged while the retained observer fulfills',async()=>{
  const ctx=execution(),failure=Error('synthetic private SQL details');
  const original=withHttpPrivacyJournal({env,executionCtx:ctx},async()=>{throw failure;});
  await expect(original).rejects.toBe(failure);await expect(ctx.pending[0]).resolves.toBeUndefined();
  expect((await readJournalControl(store)).value.pending).toHaveLength(1);
  expect([...store.rows.keys()].filter(k=>k.startsWith('receipts/'))).toHaveLength(0);
 });
 it('still propagates connection-close failure after durable receipt and keeps it out of the observer',async()=>{
  const ctx=execution(),failure=Error('synthetic private provider details');database.query.end.mockRejectedValueOnce(failure);
  await expect(withHttpPrivacyJournal({env,executionCtx:ctx},async()=>42)).rejects.toBe(failure);
  await expect(ctx.pending[0]).resolves.toBeUndefined();
  expect((await readJournalControl(store)).value.pending).toHaveLength(0);
 });
 it('permits a local development request without an execution context',async()=>{
  const work=vi.fn(async()=>42),context={env:{ENVIRONMENT:'development'} as Env,get executionCtx():ExecutionContext{throw Error('This context has no ExecutionContext');}};
  await expect(withHttpPrivacyJournal(context,work)).resolves.toBe(42);expect(work).toHaveBeenCalledTimes(1);
 });
 it('refuses missing hosted context before recording an intent or doing work',async()=>{
  const work=vi.fn(),context={env,get executionCtx():ExecutionContext{throw Error('This context has no ExecutionContext');}};
  await expect(withHttpPrivacyJournal(context,work)).rejects.toThrow('JOURNAL_EXECUTION_CONTEXT_REQUIRED');
  expect(work).not.toHaveBeenCalled();expect(database.query).not.toHaveBeenCalled();expect(store.rows.size).toBe(1);
 });
 it('replaces the handler success with 503 if durability fails, while the observer fulfills',async()=>{
  const ctx=execution();store.beforeReceipt=async()=>{throw Error('synthetic private R2 failure');};
  const app=new Hono<{Bindings:Env;Variables:Variables}>();
  app.use('*',async(c,next)=>{c.set('memberId',randomUUID());await next();});
  app.use('*',privacyMutationMiddleware);
  const handler=vi.fn(c=>c.json({ok:true}));app.put('/api/v1/profiles/me',handler);
  const response=await app.request('https://porchday.test/api/v1/profiles/me',{method:'PUT'},env,ctx as ExecutionContext);
  expect(handler).toHaveBeenCalledTimes(1);expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({error:{code:'PRIVACY_CHECKPOINT_REQUIRED'}});
  expect(ctx.pending).toHaveLength(1);await expect(ctx.pending[0]).resolves.toBeUndefined();
  expect((await readJournalControl(store)).value.pending).toHaveLength(1);
 });
});
