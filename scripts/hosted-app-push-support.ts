/** Fixed synthetic A/B boundary for the opt-in application Web Push check. */
export class AppPushError extends Error {}
export function ensure(value: unknown, code: string): asserts value {
  if (!value) throw new AppPushError(code);
}
/** Handle the underlying rejection immediately, including when it arrives after the deadline. */
export async function bounded<T>(work: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new AppPushError(code)),ms);})]);}
  finally {clearTimeout(timer);}
}
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function explicitAttempt(args: string[]): string {
  ensure(args.length === 2 && args[0] === '--run' && /^--attempt=[a-f0-9]{8}$/.test(args[1]), 'EXPLICIT_ATTEMPT_REQUIRED');
  return args[1].slice('--attempt='.length);
}
export function assertInitialPair(a: any, b: any, aId: string, bId: string) {
  ensure(uuid.test(aId) && uuid.test(bId) && aId !== bId, 'PAIR_IDENTITY_INVALID');
  for (const [row, own, peer, blocked] of [[a, aId, bId, true], [b, bId, aId, false]] as const) {
    ensure(row.me.id === own && row.me.status === 'active', 'PAIR_NOT_ACTIVE');
    ensure(row.me.notification_preferences?.in_app === true && row.me.notification_preferences?.push === false,
      'PREFERENCES_CHANGED');
    ensure(row.blocks.items.some((r: any) => r.target === peer) === blocked, 'BLOCK_STATE_CHANGED');
    ensure(!row.connections.items.some((r: any) => [r.member_a, r.member_b].includes(peer)) &&
      !row.connections.requests.some((r: any) => [r.sender, r.recipient].includes(peer)), 'RELATIONSHIP_CHANGED');
  }
  ensure(a.subscriptions.items.length === 0, 'EXISTING_A_SUBSCRIPTION');
}
export type Boundary = { aId: string; bId: string; aHandle: string; requestId: string; subscriptionId?: string; cleanup: boolean };
/** The only social effects allowed: one temporary block exception, one unaccepted request, one subscription. */
export function mutationKind(who: 'A' | 'B', method: string, path: string, body: any, b: Boundary): string {
  if (method === 'POST' && path === '/api/auth/sign-out' && JSON.stringify(body) === '{}') return 'signout';
  if (who === 'A' && path === `/api/v1/blocks/${b.bId}` && JSON.stringify(body) === '{}') {
    if (method === 'DELETE' && !b.cleanup) return 'unblock';
    if (method === 'PUT' && b.cleanup) return 'restore-block';
  }
  if (who === 'A' && method === 'POST' && path === '/api/v1/push/subscriptions' && !b.cleanup) return 'register-push';
  if (who === 'A' && method === 'DELETE' && path === `/api/v1/push/subscriptions/${b.subscriptionId}` &&
    b.subscriptionId && uuid.test(b.subscriptionId) && b.cleanup && JSON.stringify(body) === '{}') return 'revoke-push';
  if (who === 'A' && method === 'PATCH' && path === '/api/v1/me' && b.cleanup &&
    JSON.stringify(body) === '{"notification_preferences":{"in_app":true,"push":false}}') return 'restore-preferences';
  if (who === 'B' && method === 'POST' && path === '/api/v1/connections/requests' && !b.cleanup &&
    body?.id === b.requestId && body.kind === 'friend' && body.handle === b.aHandle &&
    Object.keys(body).sort().join(',') === 'handle,id,kind') return 'friend-request';
  if (who === 'B' && method === 'POST' && path === `/api/v1/connections/requests/${b.requestId}/decline` &&
    b.cleanup && JSON.stringify(body) === '{}') return 'cancel-request';
  throw new AppPushError('MUTATION_BOUNDARY');
}
export function isExpectedNotification(n: any, b: Boundary): boolean {
  return uuid.test(n?.id) && n.recipient === b.aId && n.actor === b.bId && n.kind === 'connection_request' &&
    n.dedupe_key === `request:${b.requestId}` && n.post_id === null && n.comment_id === null && n.group_id === null &&
    n.read_at === null;
}
export function assertOutboxEvidence(value: any, attempt: string) {
  ensure(value?.attempt === attempt && value.matched === 1 && value.outcome === 'sent' && value.completed === true &&
    Number.isInteger(value.attempts) && value.attempts >= 1, 'OUTBOX_EVIDENCE_UNCONFIRMED');
}
