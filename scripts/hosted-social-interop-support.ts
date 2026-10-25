import { canonicalJson, type EncryptedEnvelope } from '../packages/crypto/src/index.js';
import { check, stagingOrigin } from './hosted-smoke-support.js';
import type { HostedSocialFixture } from './hosted-ios-support.js';

export type DeviceRecord = { id: string; member_id: string; public_key: string; fingerprint: string; created_at: string; revoked_at: string | null };
export type BackupEntry = { id: string; public_key: string; fingerprint: string; encrypted_private_key: string };
export type Backup = { v: 1; devices: BackupEntry[]; recovery: Omit<BackupEntry, 'id'> };
export type Baseline = { profile: unknown; devices: DeviceRecord[]; backup: Backup };

export function socialArguments(args: string[]) {
  check(args.length === 3 && ['prepare', 'check', 'cleanup'].includes(args[0]) && args[1] === '--run' && /^--attempt=[a-f0-9]{8}$/.test(args[2]), 'EXPLICIT_SOCIAL_ATTEMPT_REQUIRED');
  return { phase: args[0] as 'prepare' | 'check' | 'cleanup', attempt: args[2].slice(10) };
}

export function requireSyntheticA(state: any) {
  const account = state?.accounts?.[0];
  check(state?.v === 1 && state.synthetic === true && state.origin === stagingOrigin && /^[a-f0-9]{10}$/.test(state.run) &&
    state.socialPassed === true && state.accounts?.length === 3 && state.accounts[2]?.deleted === true &&
    account?.signedUp && !account.deleted && account.id && account.handle === `qa_${state.run}_0` && account.device?.enrolled &&
    account.password?.length >= 32 && /^[A-Za-z0-9_-]{43}$/.test(account.device.keys?.recoverySecret), 'SYNTHETIC_A_REQUIRED');
  return account;
}

/** Full old records stay byte-for-byte equal; one observed, revoked native device may be appended. */
export function verifyBaseline(before: Baseline, after: Baseline, memberId: string, nativeDeviceId: string | null) {
  check(canonicalJson(before.profile) === canonicalJson(after.profile), 'PROFILE_CHANGED');
  check(before.devices.length > 0 && new Set(after.devices.map(d => d.id)).size === after.devices.length &&
    after.devices.every(d => d.member_id === memberId), 'DEVICE_ROSTER_INVALID');
  for (const old of before.devices)
    check(after.devices.some(d => d.id === old.id && canonicalJson(d) === canonicalJson(old)), 'PREEXISTING_DEVICE_CHANGED');
  const extra = after.devices.filter(d => !before.devices.some(old => old.id === d.id));
  check(extra.length === (nativeDeviceId ? 1 : 0) && extra.every(d => d.id === nativeDeviceId && !!d.revoked_at), 'NATIVE_DEVICE_CLEANUP_UNCONFIRMED');
  check(before.backup.v === 1 && after.backup.v === 1 &&
    canonicalJson(before.backup.recovery) === canonicalJson(after.backup.recovery) &&
    new Set(after.backup.devices.map(d => d.id)).size === after.backup.devices.length &&
    after.backup.devices.length === before.backup.devices.length + (nativeDeviceId ? 1 : 0), 'BACKUP_CHANGED');
  for (const old of before.backup.devices)
    check(after.backup.devices.some(d => d.id === old.id && canonicalJson(d) === canonicalJson(old)), 'PREEXISTING_BACKUP_CHANGED');
  if (nativeDeviceId) {
    const key = after.backup.devices.find(d => d.id === nativeDeviceId), device = extra[0];
    check(key && key.public_key === device.public_key && key.fingerprint === device.fingerprint &&
      typeof key.encrypted_private_key === 'string' && key.encrypted_private_key.startsWith('-----BEGIN PGP PRIVATE KEY BLOCK-----'), 'NATIVE_BACKUP_MISSING');
  }
}

/** Validate externally expected resource metadata before invoking cryptographic verification. */
export function expectedSocialContext(envelope: EncryptedEnvelope, fixture: HostedSocialFixture,
  expected: { id: string; kind: 'post' | 'comment' | 'reaction'; parent: string | null; authorDeviceId: string; expiry: string }) {
  const c = envelope?.context;
  check(c && c.id === expected.id && c.kind === expected.kind && c.authorId === fixture.memberId &&
    c.authorDeviceId === expected.authorDeviceId && c.audience === 'only_me' && c.parentId === expected.parent &&
    c.groupId === null && c.revision === 1 && c.expiresAt === expected.expiry &&
    Number.isSafeInteger(c.epoch) && c.epoch >= 0 && Number.isFinite(Date.parse(c.createdAt)) &&
    Date.parse(c.createdAt) >= Date.parse(fixture.expiresAt) - 7_260_000 &&
    Date.parse(c.createdAt) < Date.parse(c.expiresAt) && Array.isArray(envelope.recipients) &&
    envelope.recipients.length > 0 && envelope.recipients.length <= 8 &&
    envelope.recipients.every(r => r.memberId === fixture.memberId), 'SOCIAL_CONTEXT_MISMATCH');
  return { ...c, id: expected.id, kind: expected.kind, parentId: expected.parent, authorId: fixture.memberId,
    authorDeviceId: expected.authorDeviceId, audience: 'only_me' as const, groupId: null, expiresAt: expected.expiry, revision: 1 };
}
