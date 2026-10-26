import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {startInitialProfileSetup,type InitialProfileState} from '../src/initial-profile-lifecycle';
import {ApiError,type EncryptedEnvelope} from '../src/api';

function deferred<T>(){
 let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
 const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};
}
const envelope=()=>({ciphertext:crypto.randomUUID()}) as EncryptedEnvelope;
const flush=async()=>{for(let i=0;i<25;i++)await Promise.resolve();};
describe('nonblocking starter-profile lifecycle',()=>{
 const tasks:ReturnType<typeof startInitialProfileSetup>[]=[];
 beforeEach(()=>vi.useFakeTimers());
 afterEach(()=>{for(const task of tasks)task.dispose();tasks.length=0;vi.useRealTimers();});
 function setup(overrides:Partial<Parameters<typeof startInitialProfileSetup>[0]>={}){
  const states:InitialProfileState[]=[],read=vi.fn(async()=>({envelope:null as EncryptedEnvelope|null})),seal=vi.fn(async()=>envelope()),save=vi.fn(async(_value:EncryptedEnvelope)=>{}),confirmed=vi.fn();
  const io={read,seal,save,confirmed,state:(state:InitialProfileState)=>states.push(state),...overrides};
  const task=startInitialProfileSetup(io);tasks.push(task);return {task,states,read,seal,save,confirmed,io};
 }
 it('returns immediately, accepts existing profile, and never seals or saves over it',async()=>{
  const gate=deferred<{envelope:EncryptedEnvelope}>(),fixture=setup({read:()=>gate.promise});
  expect(fixture.states).toEqual(['working']);expect(fixture.task.retry).toBeTypeOf('function');
  gate.resolve({envelope:envelope()});await flush();
  expect(fixture.states).toEqual(['working','confirmed']);expect(fixture.seal).not.toHaveBeenCalled();expect(fixture.save).not.toHaveBeenCalled();
 });
 it('keeps a submitted save alive after the notice deadline and does not submit parallel retries',async()=>{
  const gate=deferred<void>(),save=vi.fn(()=>gate.promise),fixture=setup({save});await flush();
  expect(save).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(15000);expect(fixture.states.at(-1)).toBe('unconfirmed');
  await Promise.all([fixture.task.retry(),fixture.task.retry()]);
  expect(save).toHaveBeenCalledTimes(1);expect(fixture.confirmed).not.toHaveBeenCalled();
  gate.resolve();await flush();expect(fixture.states.at(-1)).toBe('confirmed');expect(fixture.confirmed).toHaveBeenCalledTimes(1);
 });
 it('reconciles a committed save whose response failed without another write or random choice',async()=>{
  let stored:EncryptedEnvelope|null=null;
  const save=vi.fn(async(value:EncryptedEnvelope)=>{stored=value;throw Error('response lost');});
  const fixture=setup({read:async()=>({envelope:stored}),save});await flush();
  expect(fixture.states.at(-1)).toBe('unconfirmed');
  await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.states.at(-1)).toBe('confirmed');expect(fixture.seal).toHaveBeenCalledTimes(1);expect(save).toHaveBeenCalledTimes(1);
 });
 it('bounds automatic reconnect/focus/backoff reads and never automatically retries a missing save',async()=>{
  const fixture=setup({save:async()=>{throw Error('response lost');}});await flush();
  await Promise.all(Array.from({length:8},()=>fixture.task.recheck()));
  await fixture.task.recheck();await fixture.task.recheck();await fixture.task.recheck();
  await vi.advanceTimersByTimeAsync(90000);
  expect(fixture.read).toHaveBeenCalledTimes(4); // Initial read + three automatic recovery reads.
  expect(fixture.seal).toHaveBeenCalledTimes(1);expect(fixture.states.at(-1)).toBe('unconfirmed');
 });
 it('an explicit retry reads first and reuses identical candidate bytes after an ambiguous save',async()=>{
  const save=vi.fn().mockRejectedValueOnce(Error('response lost')).mockResolvedValue(undefined),fixture=setup({save});await flush();
  await fixture.task.retry();await flush();
  expect(fixture.read).toHaveBeenCalledTimes(2);expect(save).toHaveBeenCalledTimes(2);
  expect(save.mock.calls[1][0]).toBe(save.mock.calls[0][0]);expect(fixture.seal).toHaveBeenCalledTimes(1);
 });
 it('accepts a concurrent profile before an explicit retry without overwriting it',async()=>{
  let stored:EncryptedEnvelope|null=null;const save=vi.fn(async()=>{throw Error('response lost');});
  const fixture=setup({read:async()=>({envelope:stored}),save});await flush();stored=envelope();
  await fixture.task.retry();expect(save).toHaveBeenCalledTimes(1);expect(fixture.confirmed).toHaveBeenCalledTimes(1);
 });
 it('can prepare a fresh candidate after a definitive audience rejection',async()=>{
  const save=vi.fn().mockRejectedValueOnce(new ApiError(409,{error:{code:'AUDIENCE_CHANGED'}})).mockResolvedValue(undefined),fixture=setup({save});await flush();
  await fixture.task.retry();expect(fixture.seal).toHaveBeenCalledTimes(2);expect(fixture.states.at(-1)).toBe('confirmed');
 });
 it('does not publish a candidate after unmount/account change during encryption',async()=>{
  const sealed=deferred<EncryptedEnvelope>(),fixture=setup({seal:()=>sealed.promise});await flush();
  fixture.task.dispose();sealed.resolve(envelope());await flush();await vi.advanceTimersByTimeAsync(60000);
  expect(fixture.save).not.toHaveBeenCalled();expect(fixture.confirmed).not.toHaveBeenCalled();expect(fixture.states).toEqual(['working']);
 });
 it('stops not-yet-started preparation if reconciliation discovers a saved profile',async()=>{
  const sealed=deferred<EncryptedEnvelope>();let stored:EncryptedEnvelope|null=null;
  const fixture=setup({read:async()=>({envelope:stored}),seal:()=>sealed.promise});await flush();
  await vi.advanceTimersByTimeAsync(15000);stored=envelope();await fixture.task.recheck();
  sealed.resolve(envelope());await flush();
  expect(fixture.save).not.toHaveBeenCalled();expect(fixture.confirmed).toHaveBeenCalledTimes(1);
 });
 it('leaves an already-started save alive after disposal but suppresses old-context callbacks',async()=>{
  const gate=deferred<void>(),save=vi.fn(()=>gate.promise),fixture=setup({save});await flush();
  fixture.task.dispose();gate.resolve();await flush();await vi.advanceTimersByTimeAsync(60000);
  expect(save).toHaveBeenCalledTimes(1);expect(save.mock.calls[0]).toHaveLength(1);
  expect(fixture.states).toEqual(['working']);expect(fixture.confirmed).not.toHaveBeenCalled();
 });
 it('expires read-only requests and suppresses late read results after disposal',async()=>{
  const gate=deferred<{envelope:EncryptedEnvelope|null}>(),signals:AbortSignal[]=[];
  const fixture=setup({read:signal=>{signals.push(signal);return gate.promise;}});await flush();
  await vi.advanceTimersByTimeAsync(10000);expect(signals[0].aborted).toBe(true);expect(fixture.states.at(-1)).toBe('unconfirmed');
  fixture.task.dispose();const states=[...fixture.states];gate.resolve({envelope:envelope()});await flush();
  expect(fixture.states).toEqual(states);expect(fixture.seal).not.toHaveBeenCalled();expect(fixture.confirmed).not.toHaveBeenCalled();
 });
 it('does not allow encryption that outlives its preparation deadline to publish later',async()=>{
  const sealed=deferred<EncryptedEnvelope>(),fixture=setup({seal:()=>sealed.promise});await flush();
  await vi.advanceTimersByTimeAsync(30000);sealed.resolve(envelope());await flush();
  expect(fixture.save).not.toHaveBeenCalled();expect(fixture.states.at(-1)).toBe('unconfirmed');
 });
});
