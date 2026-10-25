import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expectedSocialContext, requireSyntheticA, socialArguments, verifyBaseline, type Baseline } from './hosted-social-interop-support.js';
import type { HostedSocialFixture } from './hosted-ios-support.js';
import type { EncryptedEnvelope } from '../packages/crypto/src/index.js';

const ids = Array.from({ length: 8 }, (_, i) => `${i + 1}`.repeat(8) + '-1111-4111-8111-' + `${i + 1}`.repeat(12));
const fixture: HostedSocialFixture = { v: 2, synthetic: true, scenario: 'comments-reactions', origin: 'https://staging.porchday.com',
  run: 'aabbcc0011', attempt: 'aabb0011', expiresAt: '2026-01-01T12:00:00.000Z', email: 'fixture@example.invalid', password: 'synthetic'.repeat(4),
  memberId: ids[0], recoverySecret: 'A'.repeat(43), webPostId: ids[1], webCommentId: ids[2], webReplyId: ids[3], nativeCommentId: ids[4], nativeReplyId: ids[5],
  webCommentExpiresAt: '2026-01-01T11:50:00.000Z', webReplyExpiresAt: '2026-01-01T11:40:00.000Z' };
const old = { id: ids[6], member_id: ids[0], public_key: 'old-public', fingerprint: 'a'.repeat(64), created_at: '2026-01-01T09:00:00.000Z', revoked_at: null };
const entry = { id: old.id, public_key: old.public_key, fingerprint: old.fingerprint, encrypted_private_key: 'old-encrypted' };
const base: Baseline = { profile: { envelope: { ciphertext: 'sealed-profile' } }, devices: [old],
  backup: { v: 1, devices: [entry], recovery: { public_key: 'recovery-public', fingerprint: 'c'.repeat(64), encrypted_private_key: 'recovery-encrypted' } } };
const fresh = { ...old, id: ids[7], public_key: 'new-public', fingerprint: 'b'.repeat(64), revoked_at: '2026-01-01T11:00:00.000Z' };
const after: Baseline = { ...structuredClone(base), devices: [old, fresh], backup: { ...structuredClone(base.backup), devices: [entry,
  { id: fresh.id, public_key: fresh.public_key, fingerprint: fresh.fingerprint, encrypted_private_key: '-----BEGIN PGP PRIVATE KEY BLOCK-----protected' }] } };

describe('bounded native social interoperability', () => {
  it('requires an explicit attempt and the original surviving synthetic A', () => {
    expect(socialArguments(['prepare', '--run', '--attempt=aabb0011'])).toEqual({ phase: 'prepare', attempt: 'aabb0011' });
    for (const args of [[], ['prepare'], ['prepare', '--run', '--attempt=private-value'], ['delete', '--run', '--attempt=aabb0011']])
      expect(() => socialArguments(args)).toThrow('EXPLICIT_SOCIAL_ATTEMPT_REQUIRED');
    const a = { id: ids[0], signedUp: true, handle: 'qa_aabbcc0011_0', password: 'A'.repeat(32), device: { enrolled: true, keys: { recoverySecret: 'A'.repeat(43) } } };
    const state = { v: 1, synthetic: true, origin: fixture.origin, run: fixture.run, socialPassed: true, accounts: [a, {}, { deleted: true }] };
    expect(requireSyntheticA(state)).toBe(a);
    for (const altered of [{ ...state, origin: 'https://porchday.com' }, { ...state, socialPassed: false },
      { ...state, accounts: [{ ...a, handle: 'qa_aabbcc0011_1' }, {}, { deleted: true }] },
      { ...state, accounts: [{ ...a, deleted: true }, {}, { deleted: true }] }]) expect(() => requireSyntheticA(altered)).toThrow('SYNTHETIC_A_REQUIRED');
  });
  it('accepts only the exact old profile/keys plus one captured revoked device and protected backup', () => {
    expect(() => verifyBaseline(base, structuredClone(base), ids[0], null)).not.toThrow();
    expect(() => verifyBaseline(base, after, ids[0], fresh.id)).not.toThrow();
    for (const mutate of [
      (b: Baseline) => { b.profile = {}; },
      (b: Baseline) => { b.devices[0].revoked_at = '2026-01-01T11:00:00.000Z'; },
      (b: Baseline) => { b.devices[1].revoked_at = null; },
      (b: Baseline) => { b.backup.devices[0].encrypted_private_key = 'changed'; },
      (b: Baseline) => { b.backup.recovery.public_key = 'changed'; },
      (b: Baseline) => { b.backup.devices[1].fingerprint = 'changed'; },
      (b: Baseline) => { b.backup.devices.push(b.backup.devices[1]); },
    ]) { const changed = structuredClone(after); mutate(changed); expect(() => verifyBaseline(base, changed, ids[0], fresh.id)).toThrow(); }
    expect(() => verifyBaseline(base, after, ids[0], null)).toThrow('NATIVE_DEVICE_CLEANUP_UNCONFIRMED');
    expect(() => verifyBaseline(base, after, ids[0], ids[5])).toThrow('NATIVE_DEVICE_CLEANUP_UNCONFIRMED');
  });
  it('derives verified context from the intended object, parent, author and deadline', () => {
    const envelope: EncryptedEnvelope = { v: 1, protocol: 'porchday-openpgp-v1', ciphertext: 'test-only',
      context: { id: fixture.nativeCommentId, kind: 'comment', authorId: fixture.memberId, authorDeviceId: fresh.id,
        parentId: fixture.webPostId, audience: 'only_me', groupId: null, epoch: 1, revision: 1,
        createdAt: '2026-01-01T11:00:00.000Z', expiresAt: fixture.expiresAt },
      recipients: [{ memberId: fixture.memberId, deviceId: fresh.id, fingerprint: fresh.fingerprint }] };
    const expected = { id: fixture.nativeCommentId, kind: 'comment' as const, parent: fixture.webPostId, authorDeviceId: fresh.id, expiry: fixture.expiresAt };
    expect(expectedSocialContext(envelope, fixture, expected)).toEqual(envelope.context);
    for (const changed of [{ ...envelope, context: { ...envelope.context, audience: 'connections' } },
      { ...envelope, context: { ...envelope.context, parentId: fixture.webCommentId } },
      { ...envelope, context: { ...envelope.context, expiresAt: fixture.webCommentExpiresAt } },
      { ...envelope, context: { ...envelope.context, authorDeviceId: old.id } },
      { ...envelope, recipients: [] }, { ...envelope, recipients: [{ ...envelope.recipients[0], memberId: ids[1] }] }])
      expect(() => expectedSocialContext(changed as EncryptedEnvelope, fixture, expected)).toThrow('SOCIAL_CONTEXT_MISMATCH');
  });
  it('refuses unapproved invocation before reading private state and prints only a fixed code', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('hosted-social-interop.ts', import.meta.url)), 'private-marker'],
      { encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(1); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ step: 'native-social-preflight', complete: false, code: 'EXPLICIT_SOCIAL_ATTEMPT_REQUIRED', logout: true, mutationUnconfirmed: false });
    expect(result.stdout).not.toContain('private-marker');
  });
});
