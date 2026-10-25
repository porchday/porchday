#!/usr/bin/env python3
"""Private backup storage setup, only after actual DB/PITR verification. No secrets printed."""
import argparse,json,os,urllib.request,urllib.error
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('environment',choices=['staging','production']);p.add_argument('--verified-pitr-days',type=int,required=True);a=p.parse_args()
if a.verified_pitr_days<7:raise SystemExit('Verify a real database PITR window of at least seven days before enabling backups.')
resources=json.loads(Path('infra/resources.json').read_text());env=resources['environments'][a.environment]
if not all(env.get('hyperdrive_'+role) for role in ['auth','social','jobs']):raise SystemExit('Provision and verify the environment database first.')
account=os.environ['CLOUDFLARE_ACCOUNT_ID'];token=os.environ['CLOUDFLARE_API_TOKEN'];name='porchday-'+a.environment+'-media-backup'
if name in [env['bucket'],env['recovery_journal_bucket']]:raise SystemExit('Backup bucket must be separate from live media and journal.')
def api(path,method='GET',body=None):
 req=urllib.request.Request('https://api.cloudflare.com/client/v4/accounts/'+account+path,method=method,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},data=None if body is None else json.dumps(body).encode())
 try:
  with urllib.request.urlopen(req,timeout=30) as response:data=json.load(response)
 except urllib.error.HTTPError as e:raise RuntimeError('Backup setup failed with HTTP '+str(e.code)) from None
 if not data.get('success'):raise RuntimeError('Backup setup returned unsuccessful result')
 return data['result']
if name not in {b['name'] for b in api('/r2/buckets')['buckets']}:api('/r2/buckets','POST',{'name':name,'locationHint':'wnam'})
api('/r2/buckets/'+name+'/domains/managed','PUT',{'enabled':False})
custom=api('/r2/buckets/'+name+'/domains/custom')
if not isinstance(custom.get('domains'),list) or custom['domains']:raise SystemExit('Backup bucket must have no public custom domains.')
rules={'rules':[{'id':'expire-private-snapshots-after-seven-days','enabled':True,'conditions':{'prefix':'snapshots/'},'deleteObjectsTransition':{'condition':{'type':'Age','maxAge':604800}}}]}
api('/r2/buckets/'+name+'/lifecycle','PUT',rules)
actual=api('/r2/buckets/'+name+'/lifecycle')
if not any(r.get('id')==rules['rules'][0]['id'] and r.get('enabled') and r.get('deleteObjectsTransition',{}).get('condition',{}).get('maxAge')==604800 for r in actual.get('rules',[])):raise SystemExit('Backup lifecycle verification failed.')
env.update(media_backup_bucket=name,media_backup_enabled=True,verified_pitr_days=a.verified_pitr_days)
Path('infra/resources.json').write_text(json.dumps(resources,indent=2)+'\n')
print(a.environment+': private media backup bucket and seven-day lifecycle verified; render/deploy config, then verify first complete paired snapshot before admission.')
