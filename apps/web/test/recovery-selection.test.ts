import { describe, expect, it } from 'vitest';
import { decryptObject, encryptObject, generateDeviceKeys, unlockPrivateKey } from '@porchday/crypto';
import { refreshRecoveredAuthor, requireSealingAuthor, selectRecoveredDevice } from '../src/recovery-selection';
import type { Device } from '../src/api';

describe('restricted account recovery author selection', () => {
  it('prefers the matching nonrevoked key without dropping historical keys', async () => {
    const member = crypto.randomUUID(), oldId = crypto.randomUUID(), currentId = crypto.randomUUID(), moderator = crypto.randomUUID(), staffId = crypto.randomUUID();
    const old = await generateDeviceKeys(member, oldId), current = await generateDeviceKeys(member, currentId), staff = await generateDeviceKeys(moderator, staffId);
    const oldKey = await unlockPrivateKey(old.encryptedPrivateKey, old.recoverySecret), key = await unlockPrivateKey(current.encryptedPrivateKey, current.recoverySecret);
    const row = (id: string, keys: typeof old, revoked_at: string | null): Device => ({ id, member_id: member, public_key: keys.publicKey, fingerprint: keys.fingerprint, revoked_at });
    const roster = [row(oldId, old, new Date().toISOString()), row(currentId, current, null)];
    const recovered = [{ device: roster[0], key: oldKey }, { device: roster[1], key }];
    const selected = selectRecoveredDevice(recovered, roster, member);
    expect(selected.device.id).toBe(currentId); expect(selected.key === key).toBe(true);
    expect(recovered.length).toBe(2); expect(recovered[0].key === oldKey).toBe(true);
    requireSealingAuthor('restricted', 'report', selected.device);
    const context = { id: crypto.randomUUID(), kind: 'report' as const, authorId: member, authorDeviceId: selected.device.id,
      audience: 'moderators' as const, parentId: null, groupId: null, epoch: 1, createdAt: new Date().toISOString(), expiresAt: null, revision: 1 };
    // Match the real report audience: the current own device and a moderator;
    // the revoked key is deliberately absent and cannot sign this envelope.
    const envelope = await encryptObject({ context, payload: { selectedText: 'Synthetic disclosed evidence' }, signingKey: selected.key,
      recipients: [{ memberId: member, deviceId: currentId, publicKey: current.publicKey }, { memberId: moderator, deviceId: staffId, publicKey: staff.publicKey }] });
    const opened = await decryptObject<{ selectedText: string }>({ envelope, expectedContext: context,
      privateKey: await unlockPrivateKey(staff.encryptedPrivateKey, staff.recoverySecret), authorPublicKey: selected.device.public_key });
    expect(opened.selectedText).toBe('Synthetic disclosed evidence');
    expect(() => requireSealingAuthor('restricted', 'post', selected.device)).toThrow('Social changes are unavailable');
  });
  it('preserves a revoked-only key for reading but refuses signing evidence', () => {
    const revoked: Device = { id: 'old', member_id: 'member', public_key: 'public', fingerprint: 'fingerprint', revoked_at: '2026-01-01T00:00:00.000Z' };
    const selected = selectRecoveredDevice([{ device: revoked, key: 'retained-decryption-key' }], [revoked], 'member');
    expect(selected.key).toBe('retained-decryption-key'); expect(selected.device.revoked_at).toBe(revoked.revoked_at);
    expect(() => requireSealingAuthor('restricted', 'report', selected.device)).toThrow('report without disclosing encrypted evidence');
    expect(() => requireSealingAuthor('suspended', 'report', { ...revoked, revoked_at: null })).toThrow('Social changes are unavailable');
  });
  it('replaces stale cached trust with the latest roster while retaining old decryption keys', () => {
    const cached: Device = { id: 'one', member_id: 'member', public_key: 'first', fingerprint: 'first-fingerprint', revoked_at: null };
    const second: Device = { ...cached, id: 'two', public_key: 'second', fingerprint: 'second-fingerprint' };
    const revoked = { ...cached, revoked_at: '2026-01-01T00:00:00.000Z' };
    const recovered = [{ device: cached, key: 'old-decryption-key' }, { device: second, key: 'second-key' }];
    expect(selectRecoveredDevice(recovered, [revoked, second], 'member').device.id).toBe('two');
    const onlyOld = selectRecoveredDevice(recovered.slice(0, 1), [revoked, second], 'member');
    expect(onlyOld.device.revoked_at).toBe(revoked.revoked_at);
    expect(onlyOld.key).toBe('old-decryption-key');
    expect(() => requireSealingAuthor('restricted', 'report', onlyOld.device)).toThrow('cannot sign new encrypted evidence');
    expect(recovered[0].device.revoked_at).toBeNull(); // The helper does not mutate retained history.
  });
  it('refreshes status for the same member without enrolling or discarding unlisted historical keys', () => {
    const one: Device = { id: 'one', member_id: 'member', public_key: 'first', fingerprint: 'first', revoked_at: null };
    const two: Device = { ...one, id: 'two', public_key: 'second', fingerprint: 'second' };
    const prior = { device: one, key: 'first', history: ['second', 'unlisted-history'] };
    const input = { memberId: 'member', active: prior, previousRoster: [one, two], roster: [one, two], fingerprint: (key: string) => key };
    expect(refreshRecoveredAuthor({ ...input, status: 'active' })?.device.id).toBe('one');
    const revoked = { ...one, revoked_at: '2026-01-01T00:00:00.000Z' };
    const restricted = refreshRecoveredAuthor({ ...input, status: 'restricted', roster: [revoked, two] });
    expect(restricted?.device.id).toBe('two'); expect(restricted?.history).toEqual(['first', 'unlisted-history']);
    const suspended = refreshRecoveredAuthor({ ...input, status: 'suspended', roster: [revoked, { ...two, revoked_at: revoked.revoked_at }] });
    expect(suspended?.device.revoked_at).toBe(revoked.revoked_at); expect(suspended?.history).toEqual(prior.history);
    expect(refreshRecoveredAuthor({ ...input, status: 'active', roster: [revoked, two] })).toBeNull();
    expect(prior.history).toEqual(['second', 'unlisted-history']);
  });
  it('rejects missing, cross-account and mismatched directory identities', () => {
    const device: Device = { id: 'one', member_id: 'member', public_key: 'public', fingerprint: 'fingerprint' };
    const recovered = [{ device, key: 'local-key' }];
    for (const roster of [[], [{ ...device, member_id: 'another' }], [{ ...device, fingerprint: 'different' }], [{ ...device, public_key: 'different' }]])
      expect(() => selectRecoveredDevice(recovered, roster, 'member')).toThrow('No saved device matches');
  });
});
