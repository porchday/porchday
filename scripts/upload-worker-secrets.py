#!/usr/bin/env python3
"""Upload isolated environment secrets through stdin, never command arguments/logs."""
import json,os,subprocess,sys
from pathlib import Path

environment=sys.argv[1] if len(sys.argv)>1 else ''
if environment not in ('staging','production'):
 raise SystemExit('Usage: with-secrets.py python3 scripts/upload-worker-secrets.py staging|production')
config=Path('apps/api/wrangler.'+environment+'.jsonc')
if not config.exists():raise SystemExit('Generate verified deployment configuration first.')
settings=json.loads(config.read_text())
if settings.get('name')!='porchday-'+environment or settings.get('vars',{}).get('ENVIRONMENT')!=environment:
 raise SystemExit('Environment/configuration mismatch.')
prefix='PORCHDAY_'+environment.upper()+'_'
keys=['BETTER_AUTH_SECRET','VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','OPERATIONS_HEALTH_TOKEN']
payload={key:os.environ.get(prefix+key,'') for key in keys}
if not all(payload.values()):raise SystemExit('Generate the missing environment secrets first; none were uploaded.')
if not os.environ.get('CLOUDFLARE_API_TOKEN'):raise SystemExit('Cloudflare deployment token is required.')
result=subprocess.run(['npx','wrangler','secret','bulk','--config',str(config)],input=json.dumps(payload),text=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
if result.returncode:raise SystemExit('Worker secret upload failed. Check token scope and worker configuration without exposing secret values.')
print('Uploaded auth and Web Push secrets for '+environment+'. Values were not printed.')
