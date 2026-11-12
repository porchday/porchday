import {unlockPrivateKey} from '@porchday/crypto';

export type RecoveryBackup = {
  v: 1;
  devices: {id: string; public_key: string; fingerprint: string; encrypted_private_key: string}[];
  recovery: {public_key: string; fingerprint: string; encrypted_private_key: string};
};

/** A read-only restore rehearsal. Never return, persist or enroll recovered keys. */
export async function verifyRecoveryBackup(backup: RecoveryBackup, secret: string): Promise<void> {
  if (backup?.v !== 1 || !backup.devices?.length || !backup.recovery?.fingerprint)
    throw new Error('No complete recovery backup is available. Keep this device signed in.');
  try {
    // Check every historical key, not just the current device or a string match.
    for (const entry of [...backup.devices, backup.recovery]) {
      if (!entry.fingerprint || !entry.encrypted_private_key) throw new Error('Incomplete backup');
      await unlockPrivateKey(entry.encrypted_private_key, secret.trim(), entry.fingerprint);
    }
  } catch {
    // Do not propagate library errors that might include sensitive input.
    throw new Error('That secret could not unlock the complete backup. Check the saved copy for this account. Keep this device signed in.');
  }
}
