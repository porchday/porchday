import { ApiError, type Content, type EncryptedEnvelope } from "./api";
import { initializeEmptyProfile } from "./initial-profile";

export type InitialProfileState = "working" | "unconfirmed" | "confirmed";
type IO = {
  read: (signal: AbortSignal) => Promise<{ envelope?: EncryptedEnvelope | null }>;
  seal: (profile: Content, signal: AbortSignal) => Promise<EncryptedEnvelope>;
  // A submitted write must not share an abort signal with cosmetic UI work.
  save: (envelope: EncryptedEnvelope) => Promise<unknown>;
  state: (state: InitialProfileState) => void;
  confirmed: () => void;
};
const recoveryDelays = [1000, 5000, 15000];

/** Optional setup never gates the app. Only an explicit retry may write again;
 * automatic recovery reads the current profile and accepts any saved revision.
 */
export function startInitialProfileSetup(io: IO) {
  let disposed = false, confirmed = false;
  let state: InitialProfileState = "working";
  let operation: Promise<void> | null = null, reading: Promise<void> | null = null;
  let candidate: EncryptedEnvelope | undefined, automaticReads = 0;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelable = new Set<AbortController>();
  const current = () => !disposed && !confirmed;

  function publish(next: InitialProfileState) {
    if (disposed) return;
    state = next;
    io.state(next);
  }
  function clearTimers() {
    clearTimeout(recoveryTimer);
    clearTimeout(noticeTimer);
    recoveryTimer = noticeTimer = undefined;
  }
  function finish() {
    if (!current()) return;
    confirmed = true;
    clearTimers();
    // Stop preparation if a reconciliation read found another saved profile.
    // Already submitted saves have no controller and remain alive.
    for (const controller of cancelable) controller.abort();
    publish("confirmed");
    io.confirmed();
  }
  function bounded<T>(
    run: (signal: AbortSignal) => Promise<T>,
    milliseconds: number,
  ): Promise<T> {
    const controller = new AbortController();
    cancelable.add(controller);
    return new Promise<T>((resolve, reject) => {
      const aborted = () => reject(new Error("INITIAL_PROFILE_PREPARATION_CANCELED"));
      controller.signal.addEventListener("abort", aborted, { once: true });
      const timer = setTimeout(() => controller.abort(), milliseconds);
      Promise.resolve().then(() => {
        if (!current() || controller.signal.aborted)
          throw new Error("INITIAL_PROFILE_PREPARATION_CANCELED");
        return run(controller.signal);
      }).then(resolve, reject).finally(() => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", aborted);
        cancelable.delete(controller);
      });
    });
  }
  function scheduleRead() {
    if (!current() || state !== "unconfirmed" || recoveryTimer || reading ||
        automaticReads >= recoveryDelays.length) return;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = undefined;
      void recheck();
    }, recoveryDelays[automaticReads]);
  }
  function unconfirmed() {
    if (!current()) return;
    publish("unconfirmed");
    scheduleRead();
  }
  function recheck(manual = false): Promise<void> {
    if (!current() || (!manual && state !== "unconfirmed")) return Promise.resolve();
    if (reading) return reading;
    if (!manual && automaticReads >= recoveryDelays.length) return Promise.resolve();
    clearTimeout(recoveryTimer);
    recoveryTimer = undefined;
    if (!manual) automaticReads++;
    const pending = (async () => {
      try {
        if ((await bounded(io.read, 10000)).envelope) finish();
      } catch {
        // Leave the status unconfirmed; no error or private data is logged.
      }
    })();
    reading = pending;
    void pending.finally(() => {
      if (reading === pending) reading = null;
      scheduleRead();
    });
    return pending;
  }
  function launch(): Promise<void> {
    if (!current()) return Promise.resolve();
    if (operation) return operation;
    automaticReads = 0;
    clearTimers();
    publish("working");
    // A slow save may still be succeeding. Release no network work at this
    // deadline; only reveal the optional status and start read-only checks.
    noticeTimer = setTimeout(unconfirmed, 15000);
    const pending = (async () => {
      try {
        await initializeEmptyProfile({
          read: () => bounded(io.read, 10000),
          seal: async profile => {
            if (!current()) throw new Error("INITIAL_PROFILE_PREPARATION_CANCELED");
            if (!candidate)
              candidate = await bounded(signal => io.seal(profile, signal), 30000);
            return candidate;
          },
          save: async envelope => {
            // Check again after asynchronous key work, before sending bytes.
            if (!current()) throw new Error("INITIAL_PROFILE_PREPARATION_CANCELED");
            try {
              return await io.save(envelope);
            } catch (error) {
              // An explicit rejected request can be prepared afresh. An
              // ambiguous transport/server outcome retains identical bytes.
              if (error instanceof ApiError && error.status >= 400 && error.status < 500)
                candidate = undefined;
              throw error;
            }
          },
        });
        finish();
      } catch {
        unconfirmed();
      } finally {
        clearTimeout(noticeTimer);
        noticeTimer = undefined;
      }
    })();
    operation = pending;
    void pending.finally(() => {
      if (operation === pending) operation = null;
    });
    return pending;
  }
  void launch();
  return {
    recheck: () => recheck(),
    async retry() {
      if (!current()) return;
      // A stalled original save must never acquire a parallel mutating retry.
      if (operation) {
        await recheck(true);
        return;
      }
      if (reading) await reading;
      await launch();
    },
    dispose() {
      disposed = true;
      clearTimers();
      for (const controller of cancelable) controller.abort();
    },
  };
}
