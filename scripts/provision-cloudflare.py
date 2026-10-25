#!/usr/bin/env python3
"""Idempotent project storage/queue provisioning. Run with with-secrets.py."""
import os,json,urllib.request,urllib.error
from pathlib import Path
account=os.environ['CLOUDFLARE_ACCOUNT_ID'];token=os.environ['CLOUDFLARE_API_TOKEN']
def api(path,method='GET',body=None):
 req=urllib.request.Request('https://api.cloudflare.com/client/v4/accounts/'+account+path,method=method,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},data=json.dumps(body).encode() if body is not None else None)
 try:
  with urllib.request.urlopen(req,timeout=30) as f: result=json.load(f)
 except urllib.error.HTTPError as e:
  raise RuntimeError('Cloudflare request failed with HTTP '+str(e.code)) from None
 if not result.get('success'):raise RuntimeError('Cloudflare returned unsuccessful result')
 return result['result']
buckets={b['name'] for b in api('/r2/buckets')['buckets']}
queues={q['queue_name']:q['queue_id'] for q in api('/queues')}
resources=json.loads(Path('infra/resources.json').read_text()) if Path('infra/resources.json').exists() else {'account_id':account,'environments':{}}
for env in ['staging','production']:
 name='porchday-'+env+'-media';queue='porchday-'+env+'-jobs'
 journal='porchday-'+env+'-recovery-journal'
 if name not in buckets: api('/r2/buckets','POST',{'name':name,'locationHint':'wnam'})
 if journal not in buckets: api('/r2/buckets','POST',{'name':journal,'locationHint':'wnam'})
 # Public access is disabled at creation and explicitly checked/disabled.
 api('/r2/buckets/'+name+'/domains/managed','PUT',{'enabled':False})
 api('/r2/buckets/'+journal+'/domains/managed','PUT',{'enabled':False})
 if queue not in queues:
  result=api('/queues','POST',{'queue_name':queue});queues[queue]=result['queue_id']
 dlq=queue+'-dead-letter'
 if dlq not in queues:
  result=api('/queues','POST',{'queue_name':dlq});queues[dlq]=result['queue_id']
 resources['environments'].setdefault(env,{}).update({'bucket':name,'recovery_journal_bucket':journal,'queue':queue,'queue_id':queues[queue],'dead_letter_queue':dlq,'dead_letter_queue_id':queues[dlq]})
 print(env+': private media/recovery buckets and job queues ready')
Path('infra').mkdir(exist_ok=True)
Path('infra/resources.json').write_text(json.dumps(resources,indent=2)+'\n')
