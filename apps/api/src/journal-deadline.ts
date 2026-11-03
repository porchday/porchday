/** A caller deadline is not cancellation of an R2 operation. In particular a
 * timed-out PUT may still commit. Close this request's entire I/O scope on any
 * deadline, retain its intent, and let a fresh recovery attempt reconcile it.
 */
export class JournalDeadlineError extends Error {
  constructor() { super('JOURNAL_IO_DEADLINE'); }
}
export type JournalDeadlineScope = { assertOpen(): void };
export function journalDeadline(options: {
  attemptMs: number;
  totalMs: number;
  now?: () => number;
}) {
  if (![options.attemptMs, options.totalMs].every(x => Number.isSafeInteger(x) && x > 0)
    || options.attemptMs > options.totalMs) throw Error('JOURNAL_DEADLINE_INVALID');
  const now = options.now ?? (() => performance.now());
  const attemptMs = options.attemptMs, totalMs = options.totalMs;
  let deadline: number | undefined, closed = false;
  const assertOpen = () => {
    if (closed || deadline !== undefined && now() >= deadline) {
      closed = true;
      throw new JournalDeadlineError();
    }
  };
  async function run<T>(work: (scope: JournalDeadlineScope) => Promise<T>,maximumMs:number): Promise<T> {
      assertOpen();
      deadline ??= now() + totalMs;
      const wait = Math.min(maximumMs, deadline - now());
      const attemptDeadline = now() + wait;
      const assertAttempt = () => {
        assertOpen();
        if (now() >= attemptDeadline) { closed = true; throw new JournalDeadlineError(); }
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Promise.race observes late rejection too. Its loser is never allowed
        // to initiate another journal step: multi-step adapters must check the
        // scope between lookup/body reads and before returning a result.
        const result = await Promise.race([
          Promise.resolve().then(() => { assertAttempt(); return work({assertOpen:assertAttempt}); }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => { closed = true; reject(new JournalDeadlineError()); }, wait);
          }),
        ]);
        assertAttempt();
        return result;
      } catch (error) {
        assertAttempt();
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
  }
  return {assertOpen,
    run:<T>(work:(scope:JournalDeadlineScope)=>Promise<T>)=>run(work,attemptMs),
    runLifecycle:<T>(work:(scope:JournalDeadlineScope)=>Promise<T>)=>run(work,totalMs),
  };
}
