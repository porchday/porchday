#!/usr/bin/env python3
"""Render independent monitoring config. Does not deploy or send email."""
import json,sys
from pathlib import Path
name=sys.argv[1] if len(sys.argv)>1 else ''
if name not in ('staging','production') or any(arg!='--enable-metrics' for arg in sys.argv[2:]):raise SystemExit('Usage: configure-monitor.py staging|production [--enable-metrics]')
resources=json.loads(Path('infra/resources.json').read_text())
config=json.loads(Path('apps/monitor/wrangler.jsonc').read_text())
config.update(name='porchday-monitor-'+name,account_id=resources['account_id'])
config['vars']['ENVIRONMENT']=name
config['vars']['ANALYTICS_ACCOUNT_ID']=resources['account_id']
config['vars']['METRICS_ENABLED']='true' if '--enable-metrics' in sys.argv else 'false'
# Only the production application moves to .org. Keep the independent status
# hosts, verified sender and Durable Object identity unchanged.
config['routes']=[{'pattern':'status.porchday.com' if name=='production' else 'staging-status.porchday.com','custom_domain':True}]
config['triggers']={'crons':['* * * * *']}
config['send_email']=[{'name':'EMAIL','allowed_sender_addresses':['accounts@porchday.com']}]
config['limits']={'cpu_ms':1000}
path=Path('apps/monitor/wrangler.'+name+'.jsonc')
path.write_text(json.dumps(config,indent=2)+'\n')
print('Wrote '+str(path)+'. Deploy only after the target exists and monitor secrets are installed.')
