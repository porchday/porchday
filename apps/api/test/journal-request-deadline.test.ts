import {afterEach,expect,it,vi} from 'vitest';
import {withJournalRequestDeadline,currentJournalDeadline} from '../src/journal-request-deadline';
import {resilientJournalIO} from '../src/journal-io';
import type {JournalStore,JournalDatabase} from '../src/privacy-journal';
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
afterEach(()=>vi.useRealTimers());
it('bounds the whole lifecycle even while work is not awaiting journal I/O',async()=>{
 vi.useFakeTimers();const result=expect(withJournalRequestDeadline(true,async()=>{await sleep(120000);return 42;})).rejects.toThrow('JOURNAL_IO_DEADLINE');
 await vi.advanceTimersByTimeAsync(30000);await result;
});
it('does not reset the request deadline when later resources or nested wrappers are created',async()=>{
 vi.useFakeTimers();let calls=0;
 const store:JournalStore={get:async()=>{calls++;await sleep(4000);return null;},put:async()=>null};
 const db:JournalDatabase={status:async()=>({generation:'unused',sequence:'0',quarantined:false}),page:async()=>[]};
 const result=expect(withJournalRequestDeadline(true,async()=>{
  for(let i=0;i<8;i++)await withJournalRequestDeadline(true,()=>resilientJournalIO(store,db,{report:()=>{}}).store.get('control.json'));
 })).rejects.toThrow('JOURNAL_IO_DEADLINE');
 await vi.advanceTimersByTimeAsync(30000);await result;expect(calls).toBe(8);
 await vi.advanceTimersByTimeAsync(10000);expect(calls).toBe(8);
});
it('isolates concurrent request deadlines and does not poison a fresh recovery attempt',async()=>{
 vi.useFakeTimers();
 const first=expect(withJournalRequestDeadline(true,()=>currentJournalDeadline()!.run(()=>new Promise(()=>{})))).rejects.toThrow('JOURNAL_IO_DEADLINE');
 const second=withJournalRequestDeadline(true,async()=>{await sleep(6000);currentJournalDeadline()!.assertOpen();return 42;});
 await vi.advanceTimersByTimeAsync(6000);await first;expect(await second).toBe(42);
 await expect(withJournalRequestDeadline(true,async()=>{currentJournalDeadline()!.assertOpen();return 99;})).resolves.toBe(99);
 expect(currentJournalDeadline()).toBeUndefined();
});
it('does not start SQL work after a nested I/O timeout',async()=>{
 vi.useFakeTimers();const work=vi.fn();
 const result=expect(withJournalRequestDeadline(true,async()=>{await currentJournalDeadline()!.run(()=>new Promise(()=>{}));work();})).rejects.toThrow('JOURNAL_IO_DEADLINE');
 await vi.advanceTimersByTimeAsync(5000);await result;expect(work).not.toHaveBeenCalled();
});
