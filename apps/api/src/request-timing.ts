import type {Context, MiddlewareHandler} from 'hono';
import {feedTiming, type FeedTiming} from './feed-timing';
import {FEED_PHASES, type FeedPhase} from './telemetry';
import type {Env, Variables} from './types';
import {activeTrace,recordTraceSpan} from './tracing';

type Phase = FeedPhase | 'journal_r2' | 'journal_db' | 'worker' | 'auth_schema' | 'auth_schema_wait' | 'operations_snapshot' | 'operations_close';
const phases: readonly Phase[] = [...FEED_PHASES, 'journal_r2', 'journal_db', 'auth_schema', 'auth_schema_wait', 'operations_snapshot', 'operations_close', 'worker'];
const allowed = new Set<string>(phases);

/** Request-local numeric durations only. Never retained or sent to telemetry;
 * an opted-in traced request also receives each phase as a span. */
export class RequestTiming implements FeedTiming {
  private durations = new Map<Phase, number>();
  record(phase: Phase, durationMs: number): void {
    if (!allowed.has(phase) || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 3_600_000) return;
    this.durations.set(phase, Math.min(3_600_000, (this.durations.get(phase) ?? 0) + durationMs));
    recordTraceSpan(phase, durationMs);
  }
  header(): string {
    return phases.filter(phase => this.durations.has(phase))
      .map(phase => `${phase};dur=${Math.round(this.durations.get(phase)!)}`).join(', ');
  }
}

export const requestTimingMiddleware: MiddlewareHandler<{Bindings: Env; Variables: Variables}> = async (c, next) => {
  const summarized = c.req.method === 'GET' && ['/health', '/api/v1/me', '/api/operations/health'].includes(c.req.path);
  if (!summarized && !activeTrace()) return next();
  const timing = new RequestTiming(), start = performance.now();
  c.set('requestTiming', timing);
  await next();
  // Traced requests on other routes report spans through the tracing middleware.
  if (!summarized) return;
  // Do not expose authentication/denial phase differences to anonymous callers.
  if (c.res.status !== 200 || (c.req.path === '/api/v1/me' && !c.get('memberId')) || (c.req.path === '/api/operations/health' && !c.get('operationsAuthorized'))) return;
  timing.record('worker', performance.now() - start);
  c.header('Server-Timing', timing.header());
  c.header('Cache-Control', c.req.path === '/health' ? 'no-store' : 'private, no-store');
};

export function phaseTiming(c: Context<{Bindings: Env; Variables: Variables}>): FeedTiming | undefined {
  const local = c.get('requestTiming'), aggregate = feedTiming(c.env, c.req.method, c.req.path);
  if (!local) return aggregate;
  return {record(phase, durationMs) {local.record(phase, durationMs); aggregate?.record(phase, durationMs);}};
}

export async function measureJournalRead<T>(timing: RequestTiming | undefined, phase: 'journal_r2' | 'journal_db', work: () => Promise<T>): Promise<T> {
  if (!timing) return work();
  const start = performance.now();
  try {return await work();}
  finally {timing.record(phase, performance.now() - start);}
}

export async function measureOperationsPhase<T>(timing: RequestTiming | undefined, phase: 'operations_snapshot' | 'operations_close', work: () => Promise<T>): Promise<T> {
  if (!timing) return work();
  const start = performance.now();
  try {return await work();}
  finally {timing.record(phase, performance.now() - start);}
}
