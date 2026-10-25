#!/usr/bin/env python3
"""Render deployable configs only from verified IDs. No database URLs or secrets."""
import json,re,sys
from pathlib import Path
name=sys.argv[1] if len(sys.argv)>1 else ''
if name not in ('staging','production'):raise SystemExit('Usage: configure-worker.py staging|production')
resources=json.loads(Path('infra/resources.json').read_text())
env=resources['environments'][name]
for role in ['auth','social','jobs']:
 value=env.get('hyperdrive_'+role,'')
 if not re.fullmatch('[a-f0-9]{32}',value) or value.startswith('00000000'):
  raise SystemExit('Missing verified '+name+' Hyperdrive '+role+' ID; provision it with query caching disabled first.')
base=json.loads(Path('apps/api/wrangler.local.jsonc').read_text())
host='porchday.com' if name=='production' else 'staging.porchday.com'
base.update(name='porchday-'+name,account_id=resources['account_id'],workers_dev=False)
base['vars'].update(APP_URL='https://'+host,ENVIRONMENT=name)
base['hyperdrive']=[{'binding':'HYPERDRIVE_'+r.upper(),'id':env['hyperdrive_'+r]} for r in ['auth','social','jobs']]
base['r2_buckets']=[{'binding':'MEDIA','bucket_name':env['bucket']},{'binding':'RECOVERY_JOURNAL','bucket_name':env['recovery_journal_bucket']}]
base['vars']['VAPID_SUBJECT']='https://porchday.com/contact'
base['queues']={'producers':[{'binding':'JOBS','queue':env['queue']}],'consumers':[{'queue':env['queue'],'max_batch_size':1,'max_batch_timeout':5,'max_retries':8,'dead_letter_queue':env['dead_letter_queue']}]}
base['triggers']={'crons':['* * * * *']}
base['limits']={'cpu_ms':30000}
base['routes']=[{'pattern':host,'custom_domain':True}]
for key in ['STAFF_ACCESS_ISSUER','STAFF_ACCESS_AUDIENCE']:
 if env.get(key.lower()):base['vars'][key]=env[key.lower()]
path=Path('apps/api/wrangler.'+name+'.jsonc');path.write_text(json.dumps(base,indent=2)+'\n')
print('Wrote '+str(path)+'; registration remains closed until admission gates pass.')
