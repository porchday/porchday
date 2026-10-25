#!/usr/bin/env python3
"""Check first-party text hygiene without rewriting established language styles."""
from pathlib import Path
import subprocess
import sys

EXTENSIONS = {'.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.swift', '.sql', '.md',
              '.json', '.jsonc', '.yml', '.yaml', '.toml', '.css', '.html', '.sh'}
EXCLUDED = ('third-party-licenses/', 'docs/archive/sample/', 'apps/web/public/source/')


def violations(name, content):
    if name.startswith(EXCLUDED) or (Path(name).suffix not in EXTENSIONS
                                    and Path(name).name != '.editorconfig'):
        return []
    try:
        text = content.decode('utf-8')
    except UnicodeDecodeError:
        return ['invalid UTF-8']
    problems = []
    if '\r' in text:
        problems.append('use LF line endings')
    if text and not text.endswith('\n'):
        problems.append('missing final newline')
    for number, line in enumerate(text.split('\n'), 1):
        trailing = line[len(line.rstrip(' \t')):]
        hard_break = name.endswith('.md') and trailing == '  ' and bool(line.strip())
        if trailing and not hard_break:
            problems.append(f'trailing whitespace at line {number}')
    return problems


def main():
    # Git supplies the repository boundary; ignored private state/dependencies and
    # build output are never traversed. Report paths/rules, never file contents.
    names = subprocess.check_output([
        'git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'
    ]).decode().split('\0')
    failed = False
    for name in sorted(set(filter(None, names))):
        path = Path(name)
        if not path.is_file() or path.is_symlink():
            continue
        for problem in violations(name, path.read_bytes()):
            print(f'{name}: {problem}')
            failed = True
    if not failed:
        print('First-party text formatting checks passed.')
    return int(failed)


if __name__ == '__main__':
    sys.exit(main())
