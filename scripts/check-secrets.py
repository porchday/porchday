#!/usr/bin/env python3
"""Fail on likely deploy secrets; never echo matching text."""
import re,subprocess
from pathlib import Path
patterns=[r'cfut_[A-Za-z0-9_-]{20,}',r'gh[opusr]_[A-Za-z0-9_]{25,}',r'github_pat_[A-Za-z0-9_]{30,}',r'postgres(?:ql)?://[^\s:]+:[^\s@]+@(?!localhost|127\.0\.0\.1)[^\s]+']
failed=[]
for name in subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard'],text=True).splitlines():
 p=Path(name)
 if not p.is_file() or p.stat().st_size>2_000_000:continue
 try:s=p.read_text()
 except UnicodeDecodeError:continue
 if any(re.search(pattern,s) for pattern in patterns):failed.append(name)
if failed:
 print('Potential secret detected in files: '+', '.join(failed));raise SystemExit(1)
print('No deployment credential patterns found in tracked or candidate files.')
