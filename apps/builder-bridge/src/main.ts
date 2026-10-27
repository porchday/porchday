import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ApiError, createApi } from './api.ts';
import { createBridge } from './bridge.ts';
import { head, runCodexTurn, turnCommits } from './codex.ts';
import { ConfigError, DEFAULT_CONFIG_PATH, loadConfig, readToken, type Config } from './config.ts';
import { readLock, tryAcquire } from './lock.ts';

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function bridgeFor(config: Config) {
  const api = createApi(config.apiUrl, readToken(config.tokenFile));
  return createBridge({
    api, log, sleep,
    runTurn: options => runCodexTurn({ ...options, command: config.codexCommand, args: config.codexArgs, session: config.codexSession, cwd: config.repoDir }),
    head: () => head(config.repoDir),
    turnCommits: (before, id) => turnCommits(config.repoDir, before, id),
    tryLock: () => tryAcquire(config.lockFile, 'builder-bridge', config.lockStaleSeconds),
  });
}

async function run(config: Config, once: boolean) {
  const bridge = bridgeFor(config);
  let stopping = false, failures = 0;
  // launchd sends SIGTERM on stop. A running turn finishes first; the plist's
  // ExitTimeOut leaves room for the 10 minute turn limit.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { stopping = true; log(`received ${signal}; stopping after the current step`); });
  log(`bridge started for ${config.apiUrl}`);
  let last = '';
  while (!stopping) {
    try {
      const result = await bridge.step();
      failures = 0;
      if (result !== last && result !== 'turn') log(`state ${result}`);
      last = result;
    } catch (error) {
      failures++;
      log(`step failed: ${(error as Error).message}`);
    }
    if (once) break;
    await sleep(failures ? Math.min(60_000, 2000 * 2 ** failures) : config.pollSeconds * 1000);
  }
  log('bridge stopped');
}

function findSession(id: string) {
  const root = join(homedir(), '.codex', 'sessions');
  if (!existsSync(root)) return false;
  const walk = (dir: string): boolean => readdirSync(dir, { withFileTypes: true }).some(entry =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.includes(id));
  return walk(root);
}

/** Checks every setting the bridge needs and prints one line per check. */
async function check(config: Config) {
  let ok = true;
  const report = (passed: boolean, line: string, warning = false) => {
    if (!passed && !warning) ok = false;
    console.log(`${passed ? 'ok  ' : warning ? 'warn' : 'FAIL'}  ${line}`);
  };
  let token = '';
  try { token = readToken(config.tokenFile); report(true, `token file ${config.tokenFile}`); }
  catch (error) { report(false, (error as Error).message); }
  try { report(true, `repository ${config.repoDir} at ${head(config.repoDir).slice(0, 12)}`); }
  catch { report(false, `${config.repoDir} is not a git checkout`); }
  try { execFileSync('git', ['config', 'user.email'], { cwd: config.repoDir, stdio: 'ignore' }); report(true, 'git user.email is set, so Codex commits can be recorded'); }
  catch { report(false, 'git user.email is not set in the repository; commits cannot be attributed', true); }
  try { report(true, `Codex: ${execFileSync(config.codexCommand, ['--version'], { encoding: 'utf8' }).trim()}`); }
  catch { report(false, `could not run "${config.codexCommand} --version"`); }
  if (/^[0-9a-f-]{36}$/i.test(config.codexSession)) report(findSession(config.codexSession), `Codex session ${config.codexSession} ${findSession(config.codexSession) ? 'found' : 'not found'} in ~/.codex/sessions`, true);
  else report(true, `Codex session named "${config.codexSession}"`);
  const lock = readLock(config.lockFile);
  report(true, lock ? `lock ${config.lockFile} is held by ${lock.owner} (pid ${lock.pid || 'none'}) since ${new Date(lock.started * 1000).toISOString()}` : `lock ${config.lockFile} is free`);
  if (token) {
    try {
      const status = await createApi(config.apiUrl, token).status();
      report(true, `API ${config.apiUrl} accepted the token (${status.environment}, builder chat ${status.paused ? 'paused' : 'open'})`);
    } catch (error) { report(false, error instanceof ApiError ? error.message : `could not reach ${config.apiUrl}: ${(error as Error).message}`); }
  }
  console.log(ok ? '\nAll required checks passed.' : '\nFix the failed checks, then run this again.');
  return ok;
}

const [command = 'run', ...rest] = process.argv.slice(2);
const configIndex = rest.indexOf('--config');
const configPath = configIndex >= 0 ? rest[configIndex + 1] : process.env.PORCHDAY_BRIDGE_CONFIG ?? DEFAULT_CONFIG_PATH;
try {
  const config = loadConfig(configPath);
  if (command === 'check') process.exitCode = (await check(config)) ? 0 : 1;
  else if (command === 'run' || command === 'once') await run(config, command === 'once');
  else { console.error('Usage: node src/main.ts run|once|check [--config path]'); process.exitCode = 2; }
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
}
