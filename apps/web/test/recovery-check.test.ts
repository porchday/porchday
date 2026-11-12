import {beforeAll, describe, expect, it} from 'vitest';
import {createRecoverySecret, generateDeviceKeys} from '@porchday/crypto';
import {verifyRecoveryBackup, type RecoveryBackup} from '../src/recovery-check';

describe('local recovery rehearsal', () => {
  const secret = createRecoverySecret();
  let backup: RecoveryBackup;
  beforeAll(async () => {
    const entries = [];
    for (const id of ['old-device', 'current-device', 'recovery']) {
      const key = await generateDeviceKeys('synthetic-member', id, secret);
      entries.push({id, public_key: key.publicKey, fingerprint: key.fingerprint, encrypted_private_key: key.encryptedPrivateKey});
    }
    backup = {v: 1, devices: entries.slice(0, 2), recovery: entries[2]};
  });
  it('actually unlocks every historical key and recovery authority without modifying the backup', async () => {
    const before = JSON.stringify(backup);
    await expect(verifyRecoveryBackup(backup, `  ${secret}\n`)).resolves.toBeUndefined();
    expect(JSON.stringify(backup)).toBe(before);
  });
  it('rejects a different secret with no disclosure of supplied input', async () => {
    const wrong = createRecoverySecret();
    await expect(verifyRecoveryBackup(backup, wrong)).rejects.toThrow('could not unlock the complete backup');
    try { await verifyRecoveryBackup(backup, wrong); } catch (error) { expect(String(error)).not.toContain(wrong); }
  });
  it('does not report success if only the current device key is recoverable', async () => {
    const other = await generateDeviceKeys('synthetic-member', 'recovery', createRecoverySecret());
    await expect(verifyRecoveryBackup({...backup, recovery: {...backup.recovery, encrypted_private_key: other.encryptedPrivateKey}}, secret)).rejects.toThrow('complete backup');
    await expect(verifyRecoveryBackup({...backup, devices: [{...backup.devices[0], fingerprint: backup.devices[1].fingerprint}, backup.devices[1]]}, secret)).rejects.toThrow('complete backup');
  });
  it('rejects empty or missing backups', async () => {
    await expect(verifyRecoveryBackup({...backup, devices: []}, secret)).rejects.toThrow('No complete recovery backup');
    await expect(verifyRecoveryBackup(null as unknown as RecoveryBackup, secret)).rejects.toThrow('No complete recovery backup');
  });
});
