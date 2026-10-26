import type {EncryptedEnvelope} from './api';

/** Read completion may refresh a pristine editor, never replace a draft or
 * silently advance its revision after another writer saved a profile. */
export function profileRefreshState() {
  let generation = 0, dirty = false;
  return {
    begin: () => ++generation,
    invalidate: () => { generation++; },
    edit: () => { dirty = true; },
    saved: () => { generation++; dirty = false; },
    decide(token: number, baseline: EncryptedEnvelope | null, observed: EncryptedEnvelope | null) {
      if (token !== generation) return 'stale' as const;
      if (!dirty) return 'replace' as const;
      return JSON.stringify(baseline) === JSON.stringify(observed) ? 'preserve' as const : 'conflict' as const;
    },
  };
}
