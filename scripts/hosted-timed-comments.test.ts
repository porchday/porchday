import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { assertTimedPayload, captureTimedWrite, responseAfterAction, type TimedBoundary, type ExpectedWrite } from './hosted-timed-comments-support.js';

function fixture() {
  const member = randomUUID(), device = randomUUID(), now = Date.now(), expiry = new Date(now + 7200000).toISOString();
  const expected: ExpectedWrite = { kind: 'post', parentId: null, expiresAt: expiry, acknowledged: null, text: 'Synthetic post', expectedStatus: 201 };
  const boundary: TimedBoundary = { member, device, captured: new Map(), expected };
  const body: any = { envelope: { v: 1, protocol: 'porchday-openpgp-v1', ciphertext: 'encrypted synthetic fixture',
    context: { id: randomUUID(), kind: 'post', authorId: member, authorDeviceId: device, audience: 'only_me', groupId: null,
      parentId: null, revision: 1, epoch: 2, createdAt: new Date(now).toISOString(), expiresAt: expiry },
    recipients: [{ memberId: member, deviceId: device, fingerprint: 'synthetic' }] }, media_ids: [] };
  return { boundary, expected, body, now };
}
function commentFixture() {
  const f = fixture(), captured = captureTimedWrite('/api/v1/posts', f.body, f.boundary, f.now);
  captured.accepted = true; f.boundary.captured.set(captured.id, captured); f.boundary.postId = captured.id;
  f.boundary.expected = { kind: 'comment', parentId: captured.id, expiresAt: captured.expiresAt, acknowledged: captured.expiresAt,
    text: 'Synthetic comment', expectedStatus: 201 };
  const body = structuredClone(f.body); delete body.media_ids;
  body.parent_expires_at = captured.expiresAt; body.envelope.context.kind = 'comment';
  body.envelope.context.id = randomUUID(); body.envelope.context.parentId = captured.id;
  return { ...f, body, path: '/api/v1/posts/' + captured.id + '/comments' };
}

describe('Hosted timed comment boundaries', () => {
  it('refuses ambiguous invocation before fixture, browser or network access', () => {
    for (const args of [[], ['--run'], ['--run', '--attempt=12345678', '--account=B'], ['--run', '--attempt=../private']]) {
      const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/hosted-timed-comments.ts', ...args], {
        encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH },
      });
      expect(run.status).toBe(1); expect(run.stdout).toBe('');
      expect(run.stderr).toContain('EXPLICIT_TIMED_COMMENT_ATTEMPT_REQUIRED');
      expect(run.stderr).not.toMatch(/password|recoverySecret|https:| at /);
    }
  });
  it('captures only the one new own-private post and stores no ciphertext/plaintext', () => {
    const f = fixture(), captured = captureTimedWrite('/api/v1/posts', f.body, f.boundary, f.now);
    expect(captured.id).toBe(f.body.envelope.context.id); expect(captured.accepted).toBe(false);
    expect(JSON.stringify(captured)).not.toMatch(/ciphertext|Synthetic post|encrypted synthetic/);
    f.boundary.postId = captured.id;
    expect(() => captureTimedWrite('/api/v1/posts', f.body, f.boundary, f.now)).toThrow('TIMED_POST_BOUNDARY');
  });
  it('refuses unplanned parents, recipients, author/device, deadline, media and replayed IDs', () => {
    const f = commentFixture();
    const attempt = (change: (b: any) => void) => { const copy = structuredClone(f.body); change(copy); return () => captureTimedWrite(f.path, copy, f.boundary, f.now); };
    for (const change of [(b: any) => b.envelope.context.audience = 'connections',
      (b: any) => b.envelope.context.authorId = randomUUID(), (b: any) => b.envelope.context.authorDeviceId = randomUUID(),
      (b: any) => b.envelope.recipients[0].memberId = randomUUID(), (b: any) => b.envelope.context.parentId = randomUUID(),
      (b: any) => b.envelope.context.expiresAt = null, (b: any) => b.envelope.context.id = f.boundary.postId])
      expect(attempt(change)).toThrow('TIMED_WRITE_BOUNDARY');
    expect(attempt(b => b.parent_expires_at = null)).toThrow('TIMED_COMMENT_BOUNDARY');
    expect(attempt(b => b.media_ids = [randomUUID()])).toThrow('TIMED_COMMENT_BOUNDARY');
    const original = f.boundary.captured.get(f.boundary.postId!)!; original.accepted = false;
    expect(() => captureTimedWrite(f.path, f.body, f.boundary, f.now)).toThrow('TIMED_COMMENT_BOUNDARY');
  });
  it('permits shorter inheritance and one explicitly planned stale attempt without broadening the wire boundary', () => {
    const f = commentFixture(), shorter = new Date(f.now + 3600000).toISOString();
    f.boundary.expected!.expiresAt = shorter; f.body.envelope.context.expiresAt = shorter;
    const captured = captureTimedWrite(f.path, f.body, f.boundary, f.now);
    expect(captured.expiresAt).toBe(shorter); expect(captured.acknowledged).not.toBe(shorter);
    f.boundary.expected!.expectedStatus = 409;
    expect(captureTimedWrite(f.path, f.body, f.boundary, f.now).expectedStatus).toBe(409);
    f.boundary.expected!.capturedId = captured.id;
    expect(() => captureTimedWrite(f.path, f.body, f.boundary, f.now)).toThrow('TIMED_WRITE_BOUNDARY');
  });
  it('caps comment attempts, validates decrypted synthetic text and forbids hidden attachments', () => {
    const f = commentFixture();
    while (f.boundary.captured.size < 7) { const id = randomUUID(); f.boundary.captured.set(id, { id, kind: 'comment',
      parentId: f.boundary.postId!, expiresAt: f.boundary.expected!.expiresAt, acknowledged: f.boundary.expected!.acknowledged,
      accepted: true, expectedStatus: 201 }); }
    expect(() => captureTimedWrite(f.path, f.body, f.boundary, f.now)).toThrow('TIMED_COMMENT_BOUNDARY');
    const payload = { text: f.boundary.expected!.text, reactionSecret: 'a'.repeat(43) };
    expect(() => assertTimedPayload(payload, f.boundary.expected!)).not.toThrow();
    expect(() => assertTimedPayload({ ...payload, text: 'other' }, f.boundary.expected!)).toThrow('TIMED_PLAINTEXT_MISMATCH');
    expect(() => assertTimedPayload({ ...payload, media: [] }, f.boundary.expected!)).toThrow('TIMED_PAYLOAD_BOUNDARY');
  });
  it('handles a late sensitive response rejection even when the initiating click fails', async () => {
    let settled = false;
    const response = new Promise<never>((_, reject) => setTimeout(() => { settled = true; reject(Error('private response')); }, 10));
    await expect(responseAfterAction(response, async () => { throw Error('private browser error'); })).rejects.toThrow('TIMED_UI_ACTION_FAILED');
    expect(settled).toBe(true);
    await expect(responseAfterAction(Promise.reject(Error('private')), async () => {})).rejects.toThrow('TIMED_UI_RESPONSE_FAILED');
  });
});
