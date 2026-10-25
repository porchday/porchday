import type { EncryptedEnvelope } from '@porchday/crypto';
import { check } from './hosted-smoke-support.js';

export const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export type ExpectedWrite = { kind: 'post' | 'comment'; parentId: string | null; expiresAt: string;
  acknowledged: string | null; text: string; expectedStatus: 201 | 409; capturedId?: string };
export type CapturedWrite = { id: string; kind: 'post' | 'comment'; parentId: string | null;
  expiresAt: string; acknowledged: string | null; expectedStatus: 201 | 409; accepted: boolean };
export type TimedBoundary = { member: string; device: string; postId?: string;
  captured: Map<string, CapturedWrite>; expected?: ExpectedWrite };

export function explicitAttempt(args: string[]) {
  check(args.length === 2 && args[0] === '--run' && /^--attempt=[a-f0-9]{8}$/.test(args[1]), 'EXPLICIT_TIMED_COMMENT_ATTEMPT_REQUIRED');
  return args[1].slice(10);
}

/** Inspect the unmodified UI envelope. The caller also verifies its signature and exact synthetic plaintext. */
export function captureTimedWrite(path: string, body: any, boundary: TimedBoundary, now = Date.now()): CapturedWrite {
  const planned = boundary.expected, envelope = body?.envelope as EncryptedEnvelope, c = envelope?.context;
  check(planned && !planned.capturedId && envelope?.v === 1 && envelope.protocol === 'porchday-openpgp-v1' &&
    typeof envelope.ciphertext === 'string' && envelope.ciphertext.length <= 32000 && c && uuid.test(c.id) &&
    !boundary.captured.has(c.id) && c.authorId === boundary.member && c.authorDeviceId === boundary.device &&
    c.kind === planned.kind && c.parentId === planned.parentId && c.audience === 'only_me' && c.groupId === null &&
    c.revision === 1 && Number.isSafeInteger(c.epoch) && c.epoch >= 0 && c.expiresAt === planned.expiresAt &&
    Number.isFinite(Date.parse(c.createdAt)) && Math.abs(Date.parse(c.createdAt) - now) <= 300000 &&
    Date.parse(c.expiresAt) > now + 10 * 60000 && Date.parse(c.expiresAt) <= now + 3 * 3600000 &&
    Array.isArray(envelope.recipients) && envelope.recipients.length > 0 && envelope.recipients.length <= 8 &&
    envelope.recipients.every(r => r.memberId === boundary.member && uuid.test(r.deviceId)), 'TIMED_WRITE_BOUNDARY');
  if (planned.kind === 'post') {
    check(path === '/api/v1/posts' && !boundary.postId && boundary.captured.size === 0 &&
      c.parentId === null && planned.acknowledged === null && planned.expectedStatus === 201 &&
      Object.keys(body).sort().join(',') === 'envelope,media_ids' && Array.isArray(body.media_ids) && body.media_ids.length === 0,
    'TIMED_POST_BOUNDARY');
  } else {
    const parent = boundary.captured.get(c.parentId || '');
    check(boundary.postId && path === '/api/v1/posts/' + boundary.postId + '/comments' && parent?.accepted &&
      boundary.captured.size < 7 && Object.keys(body).sort().join(',') === 'envelope,parent_expires_at' &&
      body.parent_expires_at === planned.acknowledged && planned.acknowledged &&
      Date.parse(c.expiresAt) <= Date.parse(planned.acknowledged), 'TIMED_COMMENT_BOUNDARY');
  }
  return { id: c.id, kind: planned.kind, parentId: c.parentId, expiresAt: planned.expiresAt,
    acknowledged: planned.acknowledged, expectedStatus: planned.expectedStatus, accepted: false };
}

export function assertTimedPayload(payload: any, expected: ExpectedWrite) {
  check(payload?.text === expected.text && typeof payload.reactionSecret === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(payload.reactionSecret), 'TIMED_PLAINTEXT_MISMATCH');
  check(Object.keys(payload).sort().join(',') === (expected.kind === 'post' ? 'media,reactionSecret,text' : 'reactionSecret,text') &&
    (expected.kind !== 'post' || Array.isArray(payload.media) && payload.media.length === 0), 'TIMED_PAYLOAD_BOUNDARY');
}

/** Observe both promises immediately so early UI failure cannot leak an unhandled browser error. */
export async function responseAfterAction<T>(response: Promise<T>, action: () => Promise<unknown>): Promise<T> {
  const observed = response.then(value => ({ ok: true as const, value }), () => ({ ok: false as const }));
  const acted = Promise.resolve().then(action).then(() => true, () => false);
  const [result, done] = await Promise.all([observed, acted]);
  check(done, 'TIMED_UI_ACTION_FAILED'); check(result.ok, 'TIMED_UI_RESPONSE_FAILED');
  return result.value;
}
