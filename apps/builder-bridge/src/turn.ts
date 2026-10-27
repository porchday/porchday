import { filterText } from './filter.ts';

export type Progress = 'reading' | 'editing' | 'testing' | 'committing' | 'working';
export type ClaimedMessage = { id: string; member_id: string; handle: string | null; body: string };

/** The prompt sent into the builder session for one member message. */
export function frame(message: ClaimedMessage, previousInterrupted = false) {
  return [
    `Builder chat message from @${message.handle ?? 'unknown'} (member ID ${message.member_id}), builder chat message ID ${message.id}.`,
    'Follow AGENTS.md, including its "Builder chat turns" section and the rollback rules there.',
    `End every commit message you make for this request with the line: Builder-Chat-Message: ${message.id}`,
    ...(previousInterrupted ? ['The previous builder chat turn was stopped at its time limit. Check git status before you continue.'] : []),
    '--- message ---',
    message.body,
    '--- end message ---',
  ].join('\n');
}

const shellWrapper = /^\S*(?:ba|z)?sh\s+-l?c\s+(["'])([\s\S]*)\1$/;
/** Maps a command Codex runs to a fixed label. The command itself and its
 * output are never forwarded. */
export function classify(command: string): Progress {
  const inner = command.trim().replace(shellWrapper, '$2');
  if (/\bgit\s+(?:commit|push|revert)\b/.test(inner)) return 'committing';
  if (/\b(?:vitest|pytest|unittest|tsc|playwright)\b|\bnpm\s+(?:run\s+)?(?:test|typecheck|build)\b|check-format|check-secrets/.test(inner)) return 'testing';
  if (/^(?:cat|sed|rg|grep|ls|head|tail|find|wc|nl|git\s+(?:log|show|diff|status|grep))\b/.test(inner)) return 'reading';
  return 'working';
}

// Leave room below the API's 65,536-byte body limit for commits and audit metadata.
const MAX_REPLY_LENGTH = 20_000;
const MAX_REPLY_JSON_BYTES = 48_000;
const TRUNCATED = '\n\n[Reply truncated to fit builder chat.]';
const jsonBytes = (text: string) => Buffer.byteLength(JSON.stringify(text), 'utf8');

function boundReply(text: string, suffix: string) {
  if (text.length <= MAX_REPLY_LENGTH && jsonBytes(text) <= MAX_REPLY_JSON_BYTES) return text;
  const ending = TRUNCATED + (suffix ? '\n\n' + suffix : '');
  const endingBytes = jsonBytes(ending) - 2;
  let prefix = '', bytes = 2; // JSON string quotes.
  for (const character of text) {
    const size = jsonBytes(character) - 2;
    if (prefix.length + character.length + ending.length > MAX_REPLY_LENGTH || bytes + size + endingBytes > MAX_REPLY_JSON_BYTES) break;
    prefix += character;
    bytes += size;
  }
  return prefix + ending;
}

type CodexEvent = { type?: string; item?: { type?: string; text?: string; command?: string }; error?: unknown; message?: unknown };

/** Folds Codex `exec --json` events into what a member may see: Codex's own
 * messages and a progress label. Command output, diffs, file contents and
 * reasoning are dropped here and never reach the network. */
export class TurnState {
  messages: string[] = [];
  progress: Progress = 'reading';
  completed = false;
  failed = false;
  apply(event: CodexEvent) {
    const item = event.item;
    if (event.type === 'turn.completed') { this.completed = true; return; }
    if (event.type === 'turn.failed' || event.type === 'error') { this.failed = true; return; }
    if (!item) return;
    if (item.type === 'agent_message' && event.type === 'item.completed' && typeof item.text === 'string') this.messages.push(item.text.trim());
    else if (item.type === 'command_execution' && typeof item.command === 'string') this.progress = classify(item.command);
    else if (item.type === 'file_change') this.progress = 'editing';
  }
  /** The filtered reply and the secret patterns that were held back. */
  reply(suffix = '') {
    const filtered = filterText([...this.messages.filter(Boolean), suffix].filter(Boolean).join('\n\n'));
    // Filter the full text before truncation so a credential cut at the boundary
    // cannot evade matching, and retain all audit pattern names.
    return { ...filtered, text: boundReply(filtered.text, filterText(suffix).text) };
  }
}
