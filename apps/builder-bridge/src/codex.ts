import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';

export type RunOptions = {
  command: string;
  /** Extra options placed before the session ID, e.g. ["-c", "model=..."]. */
  args: string[];
  session: string;
  cwd: string;
  prompt: string;
  timeoutSeconds: number;
  onEvent: (event: Record<string, unknown>) => void;
};
export type RunResult = { exitCode: number | null; timedOut: boolean };

/** Runs one turn in the existing session with `codex exec resume --json`. The
 * prompt goes on standard input so it never appears in the process list.
 * Standard error is discarded because it can contain command output. */
export function runCodexTurn(options: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, ['exec', 'resume', ...options.args, '--json', options.session, '-'], {
      cwd: options.cwd, stdio: ['pipe', 'pipe', 'ignore'],
    });
    let timedOut = false;
    const timers: NodeJS.Timeout[] = [];
    timers.push(setTimeout(() => {
      timedOut = true;
      child.kill('SIGINT');
      timers.push(setTimeout(() => child.kill('SIGTERM'), 10_000), setTimeout(() => child.kill('SIGKILL'), 20_000));
    }, options.timeoutSeconds * 1000));
    createInterface({ input: child.stdout! }).on('line', line => {
      let event: unknown;
      try { event = JSON.parse(line); } catch { return; }
      if (event && typeof event === 'object') options.onEvent(event as Record<string, unknown>);
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(options.prompt);
    child.on('error', error => { timers.forEach(clearTimeout); reject(error); });
    child.on('close', exitCode => { timers.forEach(clearTimeout); resolve({ exitCode, timedOut }); });
  });
}

const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

export function head(repo: string) { return git(repo, ['rev-parse', 'HEAD']); }

/** Commits made during a turn: those carrying the message trailer, plus those
 * committed by this checkout's own git identity, so commits pulled from other
 * people during the turn are not attributed to builder chat. */
export function turnCommits(repo: string, before: string, messageId: string): string[] {
  let email = '';
  try { email = git(repo, ['config', 'user.email']); } catch { /* no identity configured */ }
  const lines = git(repo, ['log', '--no-merges', '--reverse', '--format=%H%x00%ce%x00%B%x1e', `${before}..HEAD`]);
  const trailer = `Builder-Chat-Message: ${messageId}`;
  return lines.split('\x1e').map(entry => entry.trim()).filter(Boolean).filter(entry => {
    const [, committer, body] = entry.split('\0');
    return body?.split('\n').some(line => line.trim() === trailer) || (email !== '' && committer === email);
  }).map(entry => entry.split('\0')[0].slice(0, 12)).slice(0, 50);
}
