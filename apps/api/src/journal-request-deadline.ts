import {AsyncLocalStorage} from 'node:async_hooks';
import {journalDeadline} from './journal-deadline';
const deadlines=new AsyncLocalStorage<ReturnType<typeof journalDeadline>>();
export function currentJournalDeadline(){return deadlines.getStore();}
/** Guard, registration, SQL work and completion share one caller waiting bound.
 * The losing operation remains observed; this does not claim cancellation. */
export function withJournalRequestDeadline<T>(enabled:boolean,work:()=>Promise<T>):Promise<T>{
  if(!enabled||deadlines.getStore())return work();
  const deadline=journalDeadline({attemptMs:5000,totalMs:30000});
  return deadlines.run(deadline,()=>deadline.runLifecycle(work));
}
