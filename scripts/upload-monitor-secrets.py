#!/usr/bin/env python3
"""Install monitor-only capabilities via stdin. Never print a value or recipient."""
import json,os,re,subprocess,sys
from pathlib import Path

environment=sys.argv[1] if len(sys.argv)>1 else ''
if environment not in ('staging','production'):
 raise SystemExit('Usage: with-secrets.py python3 scripts/upload-monitor-secrets.py staging|production [--check]')
config=Path('apps/monitor/wrangler.'+environment+'.jsonc')
if not config.exists():raise SystemExit('Generate the monitor configuration first.')
settings=json.loads(config.read_text())
if settings.get('name')!='porchday-monitor-'+environment or settings.get('vars',{}).get('ENVIRONMENT')!=environment:
 raise SystemExit('Monitor environment/configuration mismatch.')
token=os.environ.get('PORCHDAY_'+environment.upper()+'_OPERATIONS_HEALTH_TOKEN','')
# The default is the same account owner used by the verified billing alert.
# An explicit operational address can override it in the private secrets file.
recipient=os.environ.get('PORCHDAY_OPERATIONS_EMAIL') or os.environ.get('cloudflare_username','')
if len(token)<32 or not re.fullmatch(r'[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+',recipient):
 raise SystemExit('Missing operations token or valid private operator email configuration.')
if '--check' in sys.argv:
 print('Monitor secret configuration is ready; nothing was uploaded.')
 raise SystemExit(0)
if not os.environ.get('CLOUDFLARE_API_TOKEN'):raise SystemExit('Cloudflare deployment token is required.')
payload={'OPERATIONS_HEALTH_TOKEN':token,'MONITOR_RECIPIENT':recipient}
result=subprocess.run(['npx','wrangler','secret','bulk','--config',str(config)],input=json.dumps(payload),text=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
if result.returncode:raise SystemExit('Monitor secret upload failed. Check token scope and configuration without exposing values.')
print('Uploaded monitor-only capabilities for '+environment+'. Values and recipient were not printed.')
