import type { BridgeApi, FinishBody } from './api.ts';
import type { RunOptions, RunResult } from './codex.ts';
import { frame, TurnState, type ClaimedMessage } from './turn.ts';

export type Dependencies = {
  api: BridgeApi;
  runTurn: (options: Pick<RunOptions, 'prompt' | 'timeoutSeconds' | 'onEvent'>) => Promise<RunResult>;
  head: () => string;
  turnCommits: (before: string, messageId: string) => string[];
  tryLock: () => (() => void) | null;
  waitingOn?: () => 'request_file' | 'other_work';
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  progressIntervalMs?: number;
};
export type StepResult = 'locked' | 'paused' | 'idle' | 'turn';

/** One poll: take the shared lock, claim a message, run it, release. Logs
 * carry message IDs and statuses only, never message or reply text. */
export function createBridge(deps: Dependencies) {
  let previousInterrupted = false;
  const interval = deps.progressIntervalMs ?? 1500;

  async function finish(id: string, body: FinishBody) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try { await deps.api.finish(id, body); return; } catch (error) {
        deps.log(`finish ${id} attempt ${attempt} failed: ${(error as Error).message}`);
        if (attempt < 5) await deps.sleep(2000 * attempt);
      }
    }
    // The commits stay findable for rollback through this log line and the
    // Builder-Chat-Message commit trailer.
    deps.log(`finish ${id} not recorded; status=${body.status} commits=${body.commits.join(',') || 'none'}`);
  }

  async function run(message: ClaimedMessage, turnSeconds: number) {
    deps.log(`turn ${message.id} started`);
    let before: string | null = null;
    try { before = deps.head(); } catch { deps.log(`turn ${message.id}: could not read HEAD; commits will not be recorded`); }
    const state = new TurnState();
    let streaming = true, sending = false, pendingSend: Promise<void> = Promise.resolve();
    const send = () => {
      if (sending) return;
      sending = true;
      pendingSend = (async () => {
        try {
          if (!streaming) { await deps.api.claim(false); return; }
          const result = await deps.api.progress(message.id, state.reply().text, state.progress);
          // The member lost access. Stop streaming but let Codex finish, so the
          // checkout is never left half edited.
          if (!result.continue) { streaming = false; deps.log(`turn ${message.id}: streaming stopped by the server`); }
        } catch (error) { deps.log(`progress ${message.id} failed: ${(error as Error).message}`); }
        finally { sending = false; }
      })();
    };
    // Send the latest state at most once per interval, including during a long
    // command that produces no events. Skip ticks while a request is pending;
    // never queue a backlog behind a slow API.
    const timer = setInterval(send, interval);
    let result: RunResult;
    try {
      result = await deps.runTurn({
        prompt: frame(message, previousInterrupted), timeoutSeconds: turnSeconds,
        onEvent: event => state.apply(event),
      });
    } catch (error) {
      clearInterval(timer);
      deps.log(`turn ${message.id}: Codex could not start: ${(error as Error).message}`);
      await pendingSend;
      await finish(message.id, { status: 'failed', reply: 'Codex could not start on the builder machine. The Porchday team has been told.', commits: [], held_back: [] });
      return;
    }
    clearInterval(timer);
    await pendingSend;
    previousInterrupted = result.timedOut;
    let commits: string[] = [];
    if (before) try { commits = deps.turnCommits(before, message.id); } catch { deps.log(`turn ${message.id}: could not list commits`); }
    const status: FinishBody['status'] = result.timedOut ? 'timed_out' : state.completed && !state.failed ? 'answered' : 'failed';
    const suffix = status === 'timed_out' ? 'Codex ran out of time on this request.'
      : status === 'failed' ? 'Codex stopped before finishing this request.'
      : state.messages.length ? '' : 'Codex finished without a written reply.';
    const reply = state.reply(suffix);
    await finish(message.id, { status, reply: reply.text, commits, held_back: reply.matched });
    deps.log(`turn ${message.id} ${status} commits=${commits.join(',') || 'none'}${reply.matched.length ? ' held_back=' + reply.matched.join(',') : ''}`);
  }

  async function step(): Promise<StepResult> {
    const release = deps.tryLock();
    if (!release) { await deps.api.claim(false, deps.waitingOn?.() ?? 'other_work'); return 'locked'; }
    try {
      const claimed = await deps.api.claim(true);
      if (claimed.paused) return 'paused';
      if (!claimed.message) return 'idle';
      await run(claimed.message, claimed.turn_seconds);
      return 'turn';
    } finally { release(); }
  }
  return { step };
}
