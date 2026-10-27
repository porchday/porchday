import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export type Config = {
  apiUrl: string;
  tokenFile: string;
  codexSession: string;
  repoDir: string;
  lockFile: string;
  codexCommand: string;
  codexArgs: string[];
  pollSeconds: number;
  lockStaleSeconds: number;
};

export const DEFAULT_CONFIG_PATH = '~/.config/porchday-builder-bridge/config.json';
export const expand = (path: string) => resolve(path.replace(/^~(?=$|\/)/, homedir()));

export class ConfigError extends Error {}

/** Reads the bridge settings. Only api_url, token_file, codex_session and
 * repo_dir are required; see apps/builder-bridge/README.md. */
export function loadConfig(path = DEFAULT_CONFIG_PATH): Config {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(readFileSync(expand(path), 'utf8')); } catch (error) {
    throw new ConfigError(`Could not read ${path}: ${(error as Error).message}`);
  }
  const text = (key: string, fallback?: string) => {
    const value = raw[key] ?? fallback;
    if (typeof value !== 'string' || !value.trim()) throw new ConfigError(`${key} must be a non-empty string in ${path}.`);
    return value.trim();
  };
  const apiUrl = text('api_url').replace(/\/+$/, '');
  const url = new URL(apiUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    throw new ConfigError('api_url must use https, except for a local development server.');
  const args = raw.codex_args ?? [];
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) throw new ConfigError('codex_args must be a list of strings.');
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = raw[key] ?? fallback;
    if (typeof value !== 'number' || value < min || value > max) throw new ConfigError(`${key} must be a number from ${min} to ${max}.`);
    return value;
  };
  return {
    apiUrl,
    tokenFile: expand(text('token_file')),
    codexSession: text('codex_session'),
    repoDir: expand(text('repo_dir')),
    lockFile: expand(text('lock_file', '~/.porchday-builder.lock')),
    codexCommand: text('codex_command', 'codex'),
    codexArgs: args,
    pollSeconds: number('poll_seconds', 3, 1, 60),
    lockStaleSeconds: number('lock_stale_seconds', 3600, 60, 86400),
  };
}

/** The token file must be private to its owner and hold at least 32 characters. */
export function readToken(path: string) {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new ConfigError(`${path} must not be readable by other users. Run: chmod 600 ${path}`);
  const token = readFileSync(path, 'utf8').trim();
  if (token.length < 32) throw new ConfigError(`${path} must contain the bridge token (at least 32 characters).`);
  return token;
}
