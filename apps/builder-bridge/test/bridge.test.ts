import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filterText, HELD_BACK } from '../src/filter.ts';
import { classify, frame, TurnState, type ClaimedMessage } from '../src/turn.ts';
import { isStale, readLock, tryAcquire } from '../src/lock.ts';
import { runCodexTurn, turnCommits } from '../src/codex.ts';
import { createBridge } from '../src/bridge.ts';
import type { BridgeApi, FinishBody } from '../src/api.ts';
import { loadConfig, readToken } from '../src/config.ts';

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'porchday-bridge-')); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const message: ClaimedMessage = { id: '8c21a0e4-1b2c-4d5e-8f90-123456789abc', member_id: '0b6f0000-0000-4000-8000-000000000001', handle: 'avery', body: 'Please add a footer link.' };
const fakeSecrets = {
  github_token: 'ghp_' + 'a'.repeat(36),
  cloudflare_token: 'cfut_' + 'b'.repeat(30),
  // Split so the repository's own secret scan doesn't flag the fixture.
  postgres_credential: 'postgres://admin:hunter2hunter2' + '@db.example.com:5432/porchday',
  assigned_secret: 'BETTER_AUTH_SECRET=' + 'c'.repeat(40),
  openai_key: 'sk-' + 'd'.repeat(40),
};

describe('output filter', () => {
  it('holds back paragraphs that match a secret pattern and names the pattern', () => {
    for (const [name, secret] of Object.entries(fakeSecrets)) {
      const result = filterText(`Here is what I found.\n\nThe value is ${secret} today.\n\nAll done.`);
      expect(result.text).not.toContain(secret);
      expect(result.text).toBe(`Here is what I found.\n\n${HELD_BACK}\n\nAll done.`);
      expect(result.matched).toEqual([name]);
    }
  });
  it('passes ordinary replies and local database URLs through unchanged', () => {
    const text = 'I added the link in apps/web/src/Public.tsx and committed 4c7ef31.\n\nTests use postgres://postgres:pw@localhost:5432/porchday.';
    expect(filterText(text)).toEqual({ text, matched: [] });
  });
});

describe('Codex event handling', () => {
  it('forwards only Codex messages and fixed progress labels, never command output or reasoning', () => {
    const state = new TurnState();
    state.apply({ type: 'item.completed', item: { type: 'agent_message', text: 'Looking at the footer.' } });
    state.apply({ type: 'item.completed', item: { type: 'reasoning', text: 'secret plan ' + fakeSecrets.github_token } });
    state.apply({ type: 'item.started', item: { type: 'command_execution', command: '/bin/bash -lc "env"' } });
    state.apply({ type: 'item.completed', item: { type: 'command_execution', command: '/bin/bash -lc "env"', aggregated_output: 'HOME=/Users/bobby\nTOKEN=' + fakeSecrets.cloudflare_token } as never });
    state.apply({ type: 'item.completed', item: { type: 'agent_message', text: 'Done. I changed one file.' } });
    state.apply({ type: 'turn.completed' });
    const reply = state.reply();
    expect(reply.text).toBe('Looking at the footer.\n\nDone. I changed one file.');
    expect(reply.text).not.toContain('HOME=');
    expect(state.completed).toBe(true);
  });
  it('labels commands without exposing them', () => {
    expect(classify('/opt/homebrew/bin/bash -lc "npm test"')).toBe('testing');
    expect(classify("bash -lc 'npx vitest run apps/web'")).toBe('testing');
    expect(classify('/bin/zsh -lc "git commit -m \\"Add link\\""')).toBe('committing');
    expect(classify('bash -lc "sed -n 1,40p apps/web/src/main.tsx"')).toBe('reading');
    expect(classify('bash -lc "python3 scripts/configure-worker.py staging"')).toBe('working');
    const state = new TurnState();
    state.apply({ type: 'item.started', item: { type: 'file_change' } });
    expect(state.progress).toBe('editing');
  });
  it('frames the message with the sender, the message ID and the rollback trailer', () => {
    const prompt = frame(message);
    expect(prompt).toContain('Builder chat message from @avery (member ID 0b6f0000-0000-4000-8000-000000000001), builder chat message ID 8c21a0e4');
    expect(prompt).toContain('Builder-Chat-Message: 8c21a0e4-1b2c-4d5e-8f90-123456789abc');
    expect(prompt.endsWith('--- message ---\nPlease add a footer link.\n--- end message ---')).toBe(true);
    expect(frame(message, true)).toContain('stopped at its time limit');
  });
});

describe('shared lock', () => {
  it('lets only one holder in and releases only its own lock', () => {
    const path = join(dir, 'exclusive.lock');
    const release = tryAcquire(path, 'builder-bridge')!;
    expect(release).toBeTypeOf('function');
    expect(tryAcquire(path, 'builder-bridge')).toBeNull();
    expect(readLock(path)).toMatchObject({ owner: 'builder-bridge', pid: process.pid });
    release();
    expect(existsSync(path)).toBe(false);
  });
  it('replaces a lock whose process is gone, or a shell lock older than the stale limit', async () => {
    const path = join(dir, 'stale.lock');
    const child = spawn(process.execPath, ['-e', '']);
    const pid = child.pid!;
    await new Promise(resolve => child.on('close', resolve));
    writeFileSync(path, `owner=builder-bridge\npid=${pid}\nstarted=${Math.floor(Date.now() / 1000)}\n`);
    expect(isStale(readLock(path)!, 3600)).toBe(true);
    const release = tryAcquire(path, 'builder-bridge');
    expect(release).not.toBeNull();
    release!();
    writeFileSync(path, `owner=request-file\npid=0\nstarted=${Math.floor(Date.now() / 1000) - 7200}\n`);
    expect(tryAcquire(path, 'builder-bridge', 3600)).not.toBeNull();
    writeFileSync(path, `owner=request-file\npid=0\nstarted=${Math.floor(Date.now() / 1000)}\n`);
    expect(tryAcquire(path, 'builder-bridge', 3600)).toBeNull();
    rmSync(path);
  });
  it('works with builder-lock.sh used by the request-file loop', () => {
    const path = join(dir, 'shell.lock');
    const script = new URL('../builder-lock.sh', import.meta.url).pathname;
    const sh = (...args: string[]) => {
      try { return { code: 0, out: execFileSync(script, args, { env: { ...process.env, PORCHDAY_BUILDER_LOCK: path }, encoding: 'utf8' }) }; }
      catch (error) { return { code: (error as { status: number }).status, out: String((error as { stdout: string }).stdout) }; }
    };
    expect(sh('acquire').code).toBe(0);
    expect(tryAcquire(path, 'builder-bridge')).toBeNull();
    expect(sh('acquire').code).toBe(1);
    expect(sh('release').out).toContain('released');
    const release = tryAcquire(path, 'builder-bridge')!;
    expect(sh('acquire')).toMatchObject({ code: 1 });
    expect(sh('status').out).toContain('held by builder-bridge');
    expect(sh('release').out).toContain('not held');
    release();
    expect(sh('status').out).toContain('free');
  });
});

function fakeCodex(mode: string) {
  const path = join(dir, `codex-${mode}`);
  writeFileSync(path, `#!${process.execPath}
const fs=require('node:fs');
let input='';process.stdin.on('data',d=>input+=d).on('end',()=>{
 fs.writeFileSync(${JSON.stringify(join(dir, `codex-${mode}.call`))},JSON.stringify({argv:process.argv.slice(2),input}));
 const out=e=>process.stdout.write(JSON.stringify(e)+'\\n');
 out({type:'thread.started',thread_id:'t'});out({type:'turn.started'});
 out({type:'item.completed',item:{type:'agent_message',text:'On it.'}});
 out({type:'item.completed',item:{type:'command_execution',command:'bash -lc "cat .env"',aggregated_output:${JSON.stringify(fakeSecrets.github_token)}}});
 process.stdout.write('not json\\n');
 if(${JSON.stringify(mode)}==='hang'){process.on('SIGINT',()=>process.exit(130));setInterval(()=>{},1000);return;}
 out({type:'item.completed',item:{type:'agent_message',text:'Finished.'}});out({type:'turn.completed',usage:{}});
});
`);
  chmodSync(path, 0o755);
  return path;
}

describe('Codex runner', () => {
  it('resumes the session with the prompt on standard input', async () => {
    const events: Record<string, unknown>[] = [];
    const result = await runCodexTurn({ command: fakeCodex('ok'), args: ['-c', 'model="x"'], session: 'session-1', cwd: dir, prompt: 'hello prompt', timeoutSeconds: 30, onEvent: e => events.push(e) });
    expect(result).toEqual({ exitCode: 0, timedOut: false });
    const call = JSON.parse(readFileSync(join(dir, 'codex-ok.call'), 'utf8'));
    expect(call).toEqual({ argv: ['exec', 'resume', '-c', 'model="x"', '--json', 'session-1', '-'], input: 'hello prompt' });
    expect(events.map(e => e.type)).toEqual(['thread.started', 'turn.started', 'item.completed', 'item.completed', 'item.completed', 'turn.completed']);
  });
  it('interrupts a turn that runs past its limit', async () => {
    const result = await runCodexTurn({ command: fakeCodex('hang'), args: [], session: 's', cwd: dir, prompt: 'p', timeoutSeconds: 0.5, onEvent: () => {} });
    expect(result.timedOut).toBe(true);
  });
});

describe('commit recording', () => {
  it('records commits with the message trailer or this checkout’s identity, not commits pulled from others', () => {
    const repo = join(dir, 'repo');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['init', '-q', repo]);
    git('config', 'user.email', 'builder@example.test'); git('config', 'user.name', 'Builder');
    git('commit', '-q', '--allow-empty', '-m', 'base');
    const before = git('rev-parse', 'HEAD');
    git('commit', '-q', '--allow-empty', '-m', `Add link\n\nBuilder-Chat-Message: ${message.id}`);
    const own = git('rev-parse', 'HEAD');
    git('-c', 'user.email=other@example.test', 'commit', '-q', '--allow-empty', '-m', 'Someone else');
    git('-c', 'user.email=other@example.test', 'commit', '-q', '--allow-empty', '-m', `Tagged by Codex\n\nBuilder-Chat-Message: ${message.id}`);
    const tagged = git('rev-parse', 'HEAD');
    git('commit', '-q', '--allow-empty', '-m', 'Builder follow-up');
    const followUp = git('rev-parse', 'HEAD');
    expect(turnCommits(repo, before, message.id)).toEqual([own, tagged, followUp].map(h => h.slice(0, 12)));
  });
});

function fakeApi(overrides: Partial<BridgeApi> = {}) {
  const calls: { claim: boolean[]; progress: { reply: string; progress: string | null }[]; finish: FinishBody[] } = { claim: [], progress: [], finish: [] };
  const api: BridgeApi = {
    status: async () => ({ paused: false, environment: 'development' }),
    claim: async take => { calls.claim.push(take); return { paused: false, message: take ? message : null, turn_seconds: 600 }; },
    progress: async (_id, reply, progress) => { calls.progress.push({ reply, progress }); return { continue: true }; },
    finish: async (_id, body) => { calls.finish.push(body); return { recorded: true }; },
    ...overrides,
  };
  return { api, calls };
}
const quiet = { log: () => {}, sleep: async () => {}, head: () => 'abc', turnCommits: () => ['abc1234def56'], progressIntervalMs: 5 };

describe('bridge step', () => {
  it('only sends a heartbeat while another job holds the lock', async () => {
    const { api, calls } = fakeApi();
    let ran = false;
    const bridge = createBridge({ ...quiet, api, tryLock: () => null, runTurn: async () => { ran = true; return { exitCode: 0, timedOut: false }; } });
    expect(await bridge.step()).toBe('locked');
    expect(calls.claim).toEqual([false]);
    expect(ran).toBe(false);
  });
  it('runs a claimed message, streams filtered progress and records commits and held back patterns', async () => {
    const { api, calls } = fakeApi();
    let released = 0;
    const bridge = createBridge({
      ...quiet, api, tryLock: () => () => { released++; },
      runTurn: async ({ prompt, onEvent }) => {
        expect(prompt).toContain('Builder-Chat-Message: ' + message.id);
        onEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'Your key is ' + fakeSecrets.github_token } });
        onEvent({ type: 'item.started', item: { type: 'command_execution', command: 'bash -lc "npm test"' } });
        await new Promise(resolve => setTimeout(resolve, 30));
        onEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'Committed the change.' } });
        onEvent({ type: 'turn.completed' });
        return { exitCode: 0, timedOut: false };
      },
    });
    expect(await bridge.step()).toBe('turn');
    expect(released).toBe(1);
    expect(calls.progress.length).toBeGreaterThan(0);
    expect(calls.progress.some(p => p.progress === 'testing')).toBe(true);
    expect(JSON.stringify(calls)).not.toContain(fakeSecrets.github_token);
    expect(calls.finish).toEqual([{ status: 'answered', reply: `${HELD_BACK}\n\nCommitted the change.`, commits: ['abc1234def56'], held_back: ['github_token'] }]);
  });
  it('reports a timeout, tells the next turn, and retries recording the result', async () => {
    let failures = 2;
    const { api, calls } = fakeApi({
      finish: async (_id, body) => { if (failures-- > 0) throw new Error('offline'); calls.finish.push(body); return { recorded: true }; },
    });
    const prompts: string[] = [];
    const bridge = createBridge({ ...quiet, api, tryLock: () => () => {}, runTurn: async ({ prompt, onEvent }) => {
      prompts.push(prompt);
      onEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'Starting.' } });
      return { exitCode: null, timedOut: true };
    } });
    await bridge.step();
    expect(calls.finish).toEqual([{ status: 'timed_out', reply: 'Starting.\n\nCodex ran out of time on this request.', commits: ['abc1234def56'], held_back: [] }]);
    await bridge.step();
    expect(prompts[1]).toContain('stopped at its time limit');
  });
  it('keeps Codex running but stops streaming when the server ends the turn', async () => {
    const { api, calls } = fakeApi({ progress: async (_id, reply, progress) => { calls.progress.push({ reply, progress }); return { continue: false }; } });
    let finishedTurn = false;
    const bridge = createBridge({ ...quiet, api, tryLock: () => () => {}, runTurn: async ({ onEvent }) => {
      for (let i = 0; i < 3; i++) { onEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'step ' + i } }); await new Promise(r => setTimeout(r, 20)); }
      onEvent({ type: 'turn.completed' });
      finishedTurn = true;
      return { exitCode: 0, timedOut: false };
    } });
    await bridge.step();
    expect(finishedTurn).toBe(true);
    expect(calls.progress).toHaveLength(1);
    expect(calls.finish[0].commits).toEqual(['abc1234def56']);
  });
  it('marks the message failed when Codex cannot start, and releases the lock', async () => {
    const { api, calls } = fakeApi();
    let released = false;
    const bridge = createBridge({ ...quiet, api, tryLock: () => () => { released = true; }, runTurn: async () => { throw new Error('spawn codex ENOENT'); } });
    await bridge.step();
    expect(released).toBe(true);
    expect(calls.finish[0]).toMatchObject({ status: 'failed', commits: [] });
  });
});

describe('configuration', () => {
  it('requires https and a private token file', () => {
    const config = join(dir, 'config.json'), token = join(dir, 'token');
    writeFileSync(config, JSON.stringify({ api_url: 'http://porchday.org', token_file: token, codex_session: 's', repo_dir: dir }));
    expect(() => loadConfig(config)).toThrow(/https/);
    writeFileSync(config, JSON.stringify({ api_url: 'https://porchday.org/', token_file: token, codex_session: 's', repo_dir: dir }));
    expect(loadConfig(config)).toMatchObject({ apiUrl: 'https://porchday.org', pollSeconds: 3, codexCommand: 'codex', codexArgs: [] });
    writeFileSync(token, 'x'.repeat(40));
    chmodSync(token, 0o644);
    expect(() => readToken(token)).toThrow(/chmod 600/);
    chmodSync(token, 0o600);
    expect(readToken(token)).toBe('x'.repeat(40));
  });
});
