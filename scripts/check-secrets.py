#!/usr/bin/env python3
"""Reject credential files and common secret formats without echoing values.

This fast, dependency-free working-tree check complements the full-history
Gitleaks workflow. It is not a guarantee that arbitrary passwords are absent.
"""
from pathlib import Path
import hashlib
import re
import subprocess
import sys

# Byte patterns also cover binary files. Matches are deliberately never printed.
PATTERNS = [
    ('Cloudflare API token', rb'cfut_[A-Za-z0-9_-]{20,}'),
    ('GitHub token', rb'gh[opusr]_[A-Za-z0-9_]{25,}|github_pat_[A-Za-z0-9_]{30,}'),
    ('private key', rb'-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{64,}'),
    ('OpenPGP private key', rb'-----BEGIN PGP PRIVATE KEY BLOCK-----[\r\n]+(?:[A-Za-z-]+:[^\r\n]*\r?\n)*\s*[A-Za-z0-9+/=\r\n]{64,}'),
    ('AWS access key', rb'(?:AKIA|ASIA)[A-Z0-9]{16}'),
    ('Slack token', rb'xox[baprs]-[A-Za-z0-9-]{20,}'),
    ('remote PostgreSQL credential',
     rb'postgres(?:ql)?://[^\s:/]{1,256}:[^\s@]{1,512}@(?!(?:localhost|127\.0\.0\.1|\[::1\])(?=[:/\s]|$))[^\s]+'),
]
RULES = [(name, re.compile(pattern)) for name, pattern in PATTERNS]
BLOCK = 1024 * 1024
OVERLAP = 4096


def sensitive_filename(name):
    path = Path(name)
    base = path.name.lower()
    return (base in {'.env', '.envrc', 'secrets.env', '.dev.vars', 'credentials.json'}
            or (base.startswith('.env.') and base != '.env.example')
            or base.startswith('.dev.vars.')
            or path.suffix.lower() in {'.key', '.p8', '.p12', '.pfx', '.mobileprovision'}
            or ('artifacts' in path.parts and 'private' in path.parts))


def content_rules(stream):
    found = set()
    previous = b''
    while True:
        block = stream.read(BLOCK)
        if not block:
            break
        data = previous + block
        found.update(name for name, pattern in RULES if pattern.search(data))
        previous = data[-OVERLAP:]
    return sorted(found)


def main():
    names = subprocess.check_output([
        'git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'
    ]).decode('utf-8', errors='surrogateescape').split('\0')
    failures = []
    for name in sorted(set(filter(None, names))):
        path = Path(name)
        encoded = name.encode('utf-8', errors='surrogateescape')
        failures.extend((name, 'credential-shaped filename: ' + rule)
                        for rule, pattern in RULES if pattern.search(encoded))
        if sensitive_filename(name):
            failures.append((name, 'credential/private file must stay outside Git'))
        # Never traverse a symlink to private files outside the repository.
        if path.is_symlink() or not path.is_file():
            continue
        try:
            with path.open('rb') as stream:
                failures.extend((name, rule) for rule in content_rules(stream))
        except OSError:
            failures.append((name, 'file could not be scanned'))
    for name, rule in failures:
        encoded = name.encode('utf-8', errors='surrogateescape')
        display = ('[redacted filename sha256:' + hashlib.sha256(encoded).hexdigest()[:16] + ']'
                   if any(pattern.search(encoded) for _, pattern in RULES) else repr(name))
        print(f'{display}: {rule}')
    if not failures:
        print('No credential files or supported secret patterns found in tracked or candidate files.')
    return int(bool(failures))


if __name__ == '__main__':
    sys.exit(main())
