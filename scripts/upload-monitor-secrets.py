#!/usr/bin/env python3
"""Install monitor-only capabilities via stdin. Never print a value or recipient."""
import json,os,re,subprocess,sys
from pathlib import Path

environment=sys.argv[1] if len(sys.argv)>1 else ''
if environment not in ('staging','production') or any(arg!='--check' for arg in sys.argv[2:]):
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
metrics=settings.get('vars',{}).get('METRICS_ENABLED')=='true'
read_token=os.environ.get('PORCHDAY_'+environment.upper()+'_ANALYTICS_READ_TOKEN') or os.environ.get('CLOUDFLARE_ANALYTICS_READ_TOKEN','')
if metrics:
 if not re.fullmatch(r'[a-f0-9]{32}',settings.get('vars',{}).get('ANALYTICS_ACCOUNT_ID','')):
  raise SystemExit('Missing or invalid analytics account configuration.')
 if not re.fullmatch(r'[^\s]{32,256}',read_token) or read_token in [os.environ.get('CLOUDFLARE_API_TOKEN'),os.environ.get('CF_API_TOKEN')]:
  raise SystemExit('Metrics require a distinct dedicated Account Analytics Read token. The deployment token is not accepted.')
if '--check' in sys.argv:
 print('Monitor secret configuration is ready; nothing was uploaded. Metrics '+('enabled; verify read-only token scope before upload.' if metrics else 'disabled and not ready for pilot admission.'))
 raise SystemExit(0)
if not os.environ.get('CLOUDFLARE_API_TOKEN'):raise SystemExit('Cloudflare deployment token is required.')
payload={'OPERATIONS_HEALTH_TOKEN':token,'MONITOR_RECIPIENT':recipient}
if metrics:payload['CLOUDFLARE_ANALYTICS_READ_TOKEN']=read_token
result=subprocess.run(['npx','wrangler','secret','bulk','--config',str(config)],input=json.dumps(payload),text=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
if result.returncode:raise SystemExit('Monitor secret upload failed. Check token scope and configuration without exposing values.')
print('Uploaded monitor-only capabilities for '+environment+'. Values and recipient were not printed.')
