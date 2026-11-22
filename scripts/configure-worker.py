#!/usr/bin/env python3
"""Render deployable configs only from verified IDs. No database URLs or secrets.

Required CLI: configure-worker.py staging|production --reviewed-runtime FILE
FILE is private operator-reviewed JSON, never a provider dump or a source default:
{"schemaVersion":1,"environment":"staging","flags":{
 "KEY_RECOVERY_ENABLED":false,"LOGOUT_PHASE_TIMING":false,
 "SESSION_DENIAL_CLEANUP_V1":true,"SESSION_DENIAL_WRITER_V1":false,
 "VIDEO_UPLOADS_V2":false,"SESSION_DENIAL_PARTITIONS_V1":"synthetic-partitions",
 "SESSION_DENIAL_QUEUE_TOPOLOGY_V1":"synthetic-topology"},
 "HEALTH_MONITOR":{"service":"synthetic-health-monitor"}}
This example is synthetic, not a recommended runtime configuration.
All keys are required; unknown/duplicate keys are rejected. Five core flags are
JSON booleans. The two additional capability fields require strings or explicit
null (omit the variable) in either environment. Strings contain 1-1024 Unicode
code points and exclude controls, format controls, surrogates and line/paragraph
separators (Unicode categories Cc, Cf, Cs, Zl, Zp). Preserve strings exactly,
including spaces, case and boolean-looking text: "false" is text, false is invalid,
and null omits. No trimming, normalization, enum or activation inference applies.
Current application source does not consume these fields; no dependency is inferred.
HEALTH_MONITOR requires exactly a service name (1-63 ASCII letters/digits/hyphens,
starting with a letter). Provider environment fields are not normalized here.

Adapters must supply a reviewed file for the selected environment, fail on a
nonzero exit, and never reuse stale output after failure. Missing input has no
legacy fallback. Keep files outside source/artifacts/logs; bind review evidence
to the input digest and candidate privately. Review remains an operator action;
this schema validates structure and known constraints, not approval provenance.
Writer-off/cleanup-on rollback is supported. Recovery/video flags gate writes,
not compatible readers: deployment must separately preserve the reader-capable
rollback floor. This generator cannot prove previously admitted source versions.
"""
import json,re,sys,unicodedata
from pathlib import Path
name=sys.argv[1] if len(sys.argv)>1 else ''
if name not in ('staging','production') or len(sys.argv)!=4 or sys.argv[2]!='--reviewed-runtime':
 raise SystemExit('Usage: configure-worker.py staging|production --reviewed-runtime FILE (required)')

def exact_keys(value,keys,label):
 if not isinstance(value,dict) or set(value)!=set(keys):
  raise SystemExit(label+' must contain exactly the documented keys.')

def unique_object(pairs):
 result={}
 for key,value in pairs:
  if key in result:raise ValueError('Duplicate JSON key')
  result[key]=value
 return result

try:
 reviewed=json.loads(Path(sys.argv[3]).read_text(),object_pairs_hook=unique_object,
  parse_constant=lambda value: (_ for _ in ()).throw(ValueError('Non-JSON constant')))
except (OSError,ValueError):
 raise SystemExit('Cannot read reviewed runtime JSON; require valid JSON with unique keys.')
exact_keys(reviewed,['schemaVersion','environment','flags','HEALTH_MONITOR'],'Reviewed runtime')
if type(reviewed['schemaVersion']) is not int or reviewed['schemaVersion']!=1:
 raise SystemExit('Reviewed runtime schemaVersion must be 1.')
if reviewed['environment']!=name:raise SystemExit('Reviewed runtime environment must match the requested environment.')
required_flags=['KEY_RECOVERY_ENABLED','LOGOUT_PHASE_TIMING','SESSION_DENIAL_CLEANUP_V1','SESSION_DENIAL_WRITER_V1','VIDEO_UPLOADS_V2']
omittable_flags=['SESSION_DENIAL_PARTITIONS_V1','SESSION_DENIAL_QUEUE_TOPOLOGY_V1']
flags=reviewed['flags']
exact_keys(flags,required_flags+omittable_flags,'Reviewed runtime flags')
for flag in required_flags:
 if type(flags[flag]) is not bool:raise SystemExit(flag+' must be a JSON boolean.')
for flag in omittable_flags:
 value=flags[flag]
 if value is not None and (not isinstance(value,str) or not 1<=len(value)<=1024 or
  any(unicodedata.category(char) in {'Cc','Cf','Cs','Zl','Zp'} for char in value)):
  raise SystemExit(flag+' must be null or a 1-1024 code point string without controls or line separators.')
if flags['SESSION_DENIAL_WRITER_V1'] and not flags['SESSION_DENIAL_CLEANUP_V1']:
 raise SystemExit('Session denial writer requires cleanup; preserve cleanup during writer rollback.')
monitor=reviewed['HEALTH_MONITOR']
exact_keys(monitor,['service'],'HEALTH_MONITOR')
if not isinstance(monitor['service'],str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9-]{0,62}',monitor['service']):
 raise SystemExit('HEALTH_MONITOR service must be a valid Worker service name.')
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
# Never inherit local operational choices, including explicitly omitted flags.
for flag in required_flags+omittable_flags:
 base['vars'].pop(flag,None)
 if flag in required_flags:base['vars'][flag]='true' if flags[flag] else 'false'
 elif flags[flag] is not None:base['vars'][flag]=flags[flag]
base['services']=[binding for binding in base.get('services',[]) if binding.get('binding')!='HEALTH_MONITOR']
base['services'].append({'binding':'HEALTH_MONITOR','service':monitor['service']})
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
# Reader and writer admission is explicit and must survive config regeneration.
for flag in ['PRIVACY_COMMIT_RECOVERY_V1','PRIVACY_COMMIT_WRITER_V1','JOURNAL_LATENCY_RECOVERY_V1','JOURNAL_LATENCY_WRITER_V1']:
 value=env.get(flag.lower(),False)
 if type(value) is not bool:raise SystemExit(flag.lower()+' must be a JSON boolean in infra/resources.json.')
 base['vars'][flag]='true' if value else 'false'
if base['vars']['PRIVACY_COMMIT_WRITER_V1']=='true' and base['vars']['PRIVACY_COMMIT_RECOVERY_V1']!='true':
 raise SystemExit('Privacy commit writer requires the recovery reader; preserve the admitted reader during rollback.')
if base['vars']['JOURNAL_LATENCY_RECOVERY_V1']=='true' and base['vars']['PRIVACY_COMMIT_RECOVERY_V1']!='true':
 raise SystemExit('Journal latency recovery requires the privacy commit reader.')
if base['vars']['JOURNAL_LATENCY_WRITER_V1']=='true' and (base['vars']['JOURNAL_LATENCY_RECOVERY_V1']!='true' or base['vars']['PRIVACY_COMMIT_WRITER_V1']!='true'):
 raise SystemExit('Journal latency writer requires latency recovery and privacy commit writer; preserve recovery during rollback.')
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
base['vars']['OPERATIONAL_TRACING']='true' if env.get('operational_tracing') is True else 'false'
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
