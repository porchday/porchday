import type { ContentContext, Device } from './api';

type Recovered<T> = { device: Pick<Device, 'id' | 'public_key' | 'fingerprint'>; key: T };

/** Use an existing trusted author when available; retain revoked keys for history. */
export function selectRecoveredDevice<T>(recovered: readonly Recovered<T>[], roster: readonly Device[], memberId: string) {
  const matches = recovered.flatMap(entry => {
    const device = roster.find(d => d.id === entry.device.id && d.member_id === memberId &&
      d.fingerprint === entry.device.fingerprint && d.public_key === entry.device.public_key);
    return device ? [{ device, key: entry.key }] : [];
  });
  const selected = matches.find(entry => !entry.device.revoked_at) ?? matches[0];
  if (!selected) throw new Error('No saved device matches this account’s recovery keys.');
  // Return the roster entry, including its revocation state. Never synthesize
  // an apparently trusted device from a historical backup.
  return selected;
}

/** Refresh an already-unlocked account without enrollment or discarding history. */
export function refreshRecoveredAuthor<T>({ status, memberId, active, previousRoster, roster, fingerprint }: {
  status: string | undefined; memberId: string;
  active: { device: Device; key: T; history: T[] }; previousRoster: readonly Device[];
  roster: readonly Device[]; fingerprint: (key: T) => string;
}) {
  const localRestore = status === 'restricted' || status === 'suspended';
  const recovered = [{ device: active.device, key: active.key }];
  if (localRestore) for (const key of active.history) {
    const previous = previousRoster.find(d => d.fingerprint === fingerprint(key));
    if (previous) recovered.push({ device: previous, key });
  }
  const selected = selectRecoveredDevice(recovered, roster, memberId);
  if (!localRestore && selected.device.revoked_at) return null;
  // History remains useful even when an old key has no current directory row.
  return { ...selected, history: [active.key, ...active.history].filter(key => key !== selected.key) };
}

/** Evidence-free reports do not seal content and remain separately available. */
export function requireSealingAuthor(status: string | undefined, kind: ContentContext['kind'], device: Device) {
  if (status === 'suspended' || status === 'restricted' && kind !== 'report')
    throw new Error('Social changes are unavailable while this account is restricted. Your data and appeals remain available.');
  if (device.revoked_at)
    throw new Error('These saved keys can read and export your history, but cannot sign new encrypted evidence. You can submit a report without disclosing encrypted evidence.');
}
