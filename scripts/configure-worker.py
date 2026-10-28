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
expected_origin='https://porchday.org' if name=='production' else 'https://staging.porchday.com'
origin=env.get('app_url',expected_origin)
if origin!=expected_origin:raise SystemExit('app_url must match the reviewed canonical origin for this environment.')
legacy=env.get('legacy_app_url')
# Retiring the old origin needs an explicit reviewed source change: omitting
# this field must never strand existing browser encryption keys or sessions.
if name=='production' and legacy!='https://porchday.com':
 raise SystemExit('legacy_app_url must be the reviewed production HTTPS origin during this transition.')
if name!='production' and 'legacy_app_url' in env:
 raise SystemExit('legacy_app_url is forbidden outside production during this transition.')
host=origin.removeprefix('https://')
base.update(name='porchday-'+name,account_id=resources['account_id'],workers_dev=False)
base['vars'].update(APP_URL=origin,ENVIRONMENT=name)
base['vars'].pop('LEGACY_APP_URL',None)
if legacy is not None:base['vars']['LEGACY_APP_URL']=legacy
# Placement is explicit per environment, not inherited from local development.
placement=env.get('worker_placement')
if placement is not None:
 if not isinstance(placement,dict) or set(placement)!={'region'} or not isinstance(placement['region'],str) or not re.fullmatch(r'[a-z][a-z0-9-]{1,15}:[a-z0-9][a-z0-9-]{1,63}',placement['region']):
  raise SystemExit('worker_placement must be null or an object containing one provider:region string.')
base.pop('placement',None)
if placement is not None:base['placement']=placement
signup=env.get('signup_enabled',False)
if type(signup) is not bool:raise SystemExit('signup_enabled must be a JSON boolean.')
base['vars']['SIGNUP_ENABLED']='true' if signup else 'false'
for flag in ['CONTENT_WRITES_PAUSED','MEDIA_UPLOADS_PAUSED','SOCIAL_INVITATIONS_PAUSED']:
 value=env.get(flag.lower(),False)
 if type(value) is not bool:
  raise SystemExit(flag.lower()+' must be a JSON boolean in infra/resources.json.')
 base['vars'][flag]='true' if value else 'false'
# Builder chat ships paused; only an explicit reviewed false opens it.
builder_paused=env.get('builder_chat_paused',True)
if type(builder_paused) is not bool:raise SystemExit('builder_chat_paused must be a JSON boolean in infra/resources.json.')
base['vars']['BUILDER_CHAT_PAUSED']='true' if builder_paused else 'false'
base['hyperdrive']=[{'binding':'HYPERDRIVE_'+r.upper(),'id':env['hyperdrive_'+r]} for r in ['auth','social','jobs']]
base['r2_buckets']=[{'binding':'MEDIA','bucket_name':env['bucket']},{'binding':'RECOVERY_JOURNAL','bucket_name':env['recovery_journal_bucket']}]
# Opt-in performance traces (docs/performance-tracing.md). Never inherit the
# local placeholder; bind only an explicitly provisioned database.
base.pop('d1_databases',None)
traces=env.get('traces_d1_database_id')
if traces is not None:
 if not isinstance(traces,str) or not re.fullmatch('[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',traces) or traces.startswith('00000000'):
  raise SystemExit('traces_d1_database_id must be a provisioned D1 database UUID.')
 base['d1_databases']=[{'binding':'TRACES','database_name':'porchday-'+name+'-traces','database_id':traces,'migrations_dir':'d1/traces'}]
base['vars']['MEDIA_BACKUP_ENABLED']='false'
if env.get('media_backup_enabled'):
 if env.get('verified_pitr_days',0)<7 or not env.get('media_backup_bucket') or env['media_backup_bucket'] in [env['bucket'],env['recovery_journal_bucket']]:
  raise SystemExit('Backup requires a separate private bucket and verified seven-day database backup/PITR retention policy.')
 base['r2_buckets'].append({'binding':'MEDIA_BACKUP','bucket_name':env['media_backup_bucket']})
 base['vars']['MEDIA_BACKUP_ENABLED']='true'
base['vars']['VAPID_SUBJECT']='https://porchday.org/contact' if name=='production' else 'https://porchday.com/contact'
base['queues']={'producers':[{'binding':'JOBS','queue':env['queue']}],'consumers':[{'queue':env['queue'],'max_batch_size':1,'max_batch_timeout':5,'max_retries':8,'dead_letter_queue':env['dead_letter_queue']}]}
base['triggers']={'crons':['* * * * *','17 3 * * *']}
base['limits']={'cpu_ms':30000}
# Disabling invocation logs alone does not establish that provider-enriched
# console/error records omit token-bearing request URLs. Keep application log
# persistence/tracing off; aggregate metrics and the independent monitor remain.
base['observability']={'enabled':False,'logs':{'enabled':False,'invocation_logs':False},'traces':{'enabled':False}}
base['logpush']=False
base['analytics_engine_datasets']=[{'binding':'METRICS','dataset':'porchday_'+name+'_operations_v1'}]
hosts=[host,'www.'+host] if name=='production' else [host]
if legacy is not None:hosts.extend([legacy.removeprefix('https://'),'www.'+legacy.removeprefix('https://')])
edge=env.get('edge_frontend',False)
if type(edge) is not bool:raise SystemExit('edge_frontend must be a JSON boolean.')
# The front end owns custom domains; backend uploads must not reclaim them.
base['routes']=[] if edge else [{'pattern':hostname,'custom_domain':True} for hostname in hosts]
for key in ['STAFF_ACCESS_ISSUER','STAFF_ACCESS_AUDIENCE']:
 if env.get(key.lower()):base['vars'][key]=env[key.lower()]
path=Path('apps/api/wrangler.'+name+'.jsonc');path.write_text(json.dumps(base,indent=2)+'\n')
print('Wrote '+str(path)+'; invited registration is '+('enabled' if signup else 'closed')+'.')
