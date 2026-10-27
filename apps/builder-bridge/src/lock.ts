import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';

/** The shared builder lock, also used by builder-lock.sh for the request-file
 * loop. The file holds `owner=`, `pid=` and `started=` (Unix seconds) lines and
 * is created with O_EXCL, so only one job can hold it. A lock is stale when its
 * process is gone or, for shell holders that record pid=0, when it is older
 * than staleSeconds. */
export type LockInfo = { owner: string; pid: number; started: number };

export function readLock(path: string): LockInfo | null {
  let text: string, modified: number;
  try { text = readFileSync(path, 'utf8'); modified = Math.floor(statSync(path).mtimeMs / 1000); } catch { return null; }
  const field = (name: string) => text.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim() ?? '';
  // A lock another job is still writing has no fields yet; its file time stands in.
  return { owner: field('owner') || 'unknown', pid: Number(field('pid')) || 0, started: Number(field('started')) || modified };
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export function isStale(lock: LockInfo, staleSeconds: number, now = Date.now() / 1000) {
  if (lock.pid > 0) return !alive(lock.pid);
  return !lock.started || now - lock.started > staleSeconds;
}

/** Returns a release function, or null when another job holds the lock. */
export function tryAcquire(path: string, owner: string, staleSeconds = 3600): (() => void) | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeSync(fd, `owner=${owner}\npid=${process.pid}\nstarted=${Math.floor(Date.now() / 1000)}\n`); } finally { closeSync(fd); }
      return () => {
        const current = readLock(path);
        if (current?.pid === process.pid && current.owner === owner) rmSync(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = readLock(path);
      if (!current || !isStale(current, staleSeconds)) return null;
      rmSync(path, { force: true });
    }
  }
  return null;
}
