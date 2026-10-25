#!/usr/bin/env python3
"""Run a trusted command with deployment credentials; never echo credential values."""
import os, sys
from pathlib import Path
p = Path.home() / '.config/inner-circle/secrets.env'
env = os.environ.copy()
for line in p.read_text().splitlines():
    entry = line.strip().removeprefix('export ')
    if entry and not entry.startswith('#') and '=' in entry:
        key, value = entry.split('=', 1)
        if key.strip().isidentifier():
            env[key.strip()] = value.strip().strip('\"\'')
if env.get('GITHUB_TOKEN'):
    env['GH_TOKEN'] = env['GITHUB_TOKEN']
if len(sys.argv) < 2:
    raise SystemExit('Usage: with-secrets.py COMMAND [ARG ...]')
os.execvpe(sys.argv[1], sys.argv[1:], env)
