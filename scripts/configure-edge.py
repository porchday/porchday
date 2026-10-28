#!/usr/bin/env python3
"""Render the public edge front end. No secrets, databases or event consumers."""
import json,sys
from pathlib import Path

name=sys.argv[1] if len(sys.argv)>1 else ''
if name not in ('staging','production'):
 raise SystemExit('Usage: configure-edge.py staging|production')
resources=json.loads(Path('infra/resources.json').read_text())
env=resources['environments'][name]
origin='https://porchday.org' if name=='production' else 'https://staging.porchday.com'
if env.get('app_url',origin)!=origin:raise SystemExit('Unexpected canonical origin')
values={'APP_URL':origin,'ENVIRONMENT':name}
hosts=[origin.removeprefix('https://')]
if name=='production':
 if env.get('legacy_app_url')!='https://porchday.com':raise SystemExit('Legacy origin must be preserved')
 values['LEGACY_APP_URL']=env['legacy_app_url']
 hosts+=['www.porchday.org','porchday.com','www.porchday.com']
config={
 'name':'porchday-'+name+'-edge','account_id':resources['account_id'],
 'main':'src/edge.ts','compatibility_date':'2026-10-24','compatibility_flags':['nodejs_compat'],
 'workers_dev':False,'preview_urls':False,'upload_source_maps':True,
 'placement':{'mode':'off'},'vars':values,
 'assets':{'directory':'../web/dist','binding':'ASSETS','not_found_handling':'single-page-application','run_worker_first':True},
 'services':[{'binding':'API_BACKEND','service':'porchday-'+name}],
 'version_metadata':{'binding':'CF_VERSION_METADATA'},
 'analytics_engine_datasets':[{'binding':'METRICS','dataset':'porchday_'+name+'_operations_v1'}],
 'limits':{'cpu_ms':30000},'logpush':False,
 'observability':{'enabled':False,'logs':{'enabled':False,'invocation_logs':False},'traces':{'enabled':False}},
 'routes':[{'pattern':host,'custom_domain':True} for host in hosts],
}
path=Path('apps/api/wrangler.edge.'+name+'.jsonc');path.write_text(json.dumps(config,indent=2)+'\n')
print('Wrote '+str(path)+'; verify domain ownership before moving custom-domain bindings.')
