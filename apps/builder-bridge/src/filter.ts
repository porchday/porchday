/** Patterns kept in step with scripts/check-secrets.py, plus a few shapes that
 * only matter in chat output. Matches are never logged or forwarded. */
export const SECRET_PATTERNS: [name: string, pattern: RegExp][] = [
  ['cloudflare_token', /cfut_[A-Za-z0-9_-]{20,}/],
  ['github_token', /gh[opusr]_[A-Za-z0-9_]{25,}|github_pat_[A-Za-z0-9_]{30,}/],
  ['private_key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ['pgp_private_key', /-----BEGIN PGP PRIVATE KEY BLOCK-----/],
  ['aws_access_key', /(?:AKIA|ASIA)[A-Z0-9]{16}/],
  ['slack_token', /xox[baprs]-[A-Za-z0-9-]{20,}/],
  ['postgres_credential', /postgres(?:ql)?:\/\/[^\s:/]{1,256}:[^\s@]{1,512}@(?!(?:localhost|127\.0\.0\.1|\[::1\])(?=[:/\s]|$))\S+/],
  ['openai_key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['assigned_secret', /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY)[A-Z0-9_]*\s*[=:]\s*["']?[^\s"']{12,}/i],
];

export const HELD_BACK = "[Part of Codex's reply was held back.]";

/** Replaces every paragraph that matches a secret pattern. Returns the names
 * of the patterns that matched so the server can record an audit entry. */
export function filterText(text: string): { text: string; matched: string[] } {
  const matched = new Set<string>();
  const paragraphs = text.split(/\n\s*\n/).map(paragraph => {
    const hits = SECRET_PATTERNS.filter(([, pattern]) => pattern.test(paragraph)).map(([name]) => name);
    hits.forEach(name => matched.add(name));
    return hits.length ? HELD_BACK : paragraph;
  });
  return { text: paragraphs.join('\n\n'), matched: [...matched].sort() };
}
