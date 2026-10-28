import type { ClaimedMessage, Progress } from './turn.ts';

export type FinishBody = { status: 'answered' | 'timed_out' | 'failed'; reply: string; commits: string[]; held_back: string[]; proposal?: { title: string; plan: string } | null };
export interface BridgeApi {
  status(): Promise<{ paused: boolean; environment: string }>;
  claim(take: boolean, waitingOn?: 'request_file' | 'other_work'): Promise<{ paused: boolean; message: ClaimedMessage | null; turn_seconds: number }>;
  progress(id: string, reply: string, progress: Progress | null): Promise<{ continue: boolean }>;
  finish(id: string, body: FinishBody): Promise<{ recorded: boolean }>;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** HTTPS client for /api/builder-bridge. The bridge only makes outbound requests. */
export function createApi(baseUrl: string, token: string): BridgeApi {
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const response = await fetch(baseUrl + '/api/builder-bridge' + path, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'User-Agent': 'porchday-builder-bridge/1' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const hint = response.status === 401 ? 'the bridge token does not match BUILDER_BRIDGE_TOKEN'
        : response.status === 404 ? 'BUILDER_BRIDGE_TOKEN is not set for this environment, or the API is older than builder chat'
        : 'the API returned an error';
      throw new ApiError(response.status, `${method} ${path} failed with ${response.status}: ${hint}.`);
    }
    return response.json() as Promise<T>;
  }
  return {
    status: () => call('GET', '/status'),
    claim: (take, waitingOn = 'other_work') => call('POST', '/claim', { take, waiting_on: waitingOn, feature_protocol: 1 }),
    progress: (id, reply, progress) => call('POST', `/messages/${id}/progress`, { reply, progress }),
    finish: (id, body) => call('POST', `/messages/${id}/finish`, body),
  };
}
