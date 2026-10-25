import {test,expect} from 'vitest';
import {spawnSync} from 'node:child_process';

// Synthetic in-memory provider: exercises provisioning without network or credentials.
const fixture=String.raw`
import copy,importlib.util,json
spec=importlib.util.spec_from_file_location('access','scripts/provision-staff-access.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Provider:
 def __init__(self):
  self.org={'auth_domain':'old-team.cloudflareaccess.com','name':'old','preserve':'untouched'}
  self.apps=[];self.policies=[];self.idps=[];self.users=[];self.writes=[]
 def __call__(self,path,method='GET',body=None):
  collections={'/access/apps':self.apps,'/access/policies':self.policies,'/access/identity_providers':self.idps,'/access/users':self.users}
  if method!='GET':self.writes.append((path,method,copy.deepcopy(body)))
  if path=='/access/organizations':
   if method=='PUT':self.org=copy.deepcopy(body)
   return copy.deepcopy(self.org)
  for prefix,items in collections.items():
   if path==prefix:
    if method=='POST':
     item={**copy.deepcopy(body),'id':prefix.split('/')[-1]+'-'+str(len(items)+1)}
     if prefix=='/access/apps':item['aud']=str(len(items)+1)*64
     items.append(item);return copy.deepcopy(item)
    return copy.deepcopy(items)
   if path.startswith(prefix+'/'):return copy.deepcopy(next(i for i in items if i['id']==path[len(prefix)+1:]))
  raise AssertionError('Unexpected API path')
p=Provider()
def rejects(fn,part):
 try:fn()
 except m.AccessError as e:assert part in str(e),str(e)
 else:raise AssertionError('Expected safe rejection')
`;

function run(code:string){
 const result=spawnSync('python3',['-c',fixture+'\n'+code],{encoding:'utf8'});
 expect(result.status,result.stderr).toBe(0);
}

test('staff setup creates two closed applications with one distinct audience each, then verifies without writes',()=>run(String.raw`
out=m.provision(p,'Owner@example.test')
assert p.org['preserve']=='untouched'
assert p.org['mfa_required_for_all_apps'] is True
assert p.org['mfa_config']['amr_matching_enabled'] is False
assert len(p.apps)==2 and len(p.policies)==2 and len(p.idps)==1
for env,app,policy in zip(m.HOSTS,p.apps,p.policies):
 assert [d['uri'] for d in app['destinations']]==[m.HOSTS[env]+'/staff',m.HOSTS[env]+'/api/staff']
 assert app['policies']==[{'id':policy['id'],'precedence':1}]
 assert policy['include']==[{'email':{'email':'owner@example.test'}}]
 assert policy['require']==[{'login_method':{'id':p.idps[0]['id']}}]
 assert app['mfa_config']==policy['mfa_config']==m.MFA
 assert app['session_duration']==policy['session_duration']=='1h'
assert 'owner@example.test' not in json.dumps(out)
p.writes=[]
assert m.provision(p,'Owner@example.test',check=True)==out
assert m.provision(p,'Owner@example.test')==out
assert p.writes==[]
`));

test('read-only readiness does not change an unconfigured account',()=>run(String.raw`
rejects(lambda:m.provision(p,'owner@example.test',check=True),'not ready')
assert p.writes==[]
`));

test('populated teams and unrelated apps are not renamed or changed',()=>run(String.raw`
p.users=[{'id':'existing-user'}]
rejects(lambda:m.provision(p,'owner@example.test'),'Refusing to rename')
assert p.writes==[]
p.users=[];p.apps=[{'name':'Unrelated'}]
rejects(lambda:m.provision(p,'owner@example.test'),'Unrelated')
assert p.writes==[]
`));

test('policy broadening, disabled MFA, bypass overrides and extra policies fail verification',()=>run(String.raw`
m.provision(p,'owner@example.test');p.writes=[]
saved=copy.deepcopy(p.policies[0])
p.policies[0]['include']=[{'everyone':{}}]
rejects(lambda:m.provision(p,'owner@example.test',check=True),'exact owner')
p.policies[0]=copy.deepcopy(saved);p.policies[0]['mfa_config']['mfa_disabled']=True
rejects(lambda:m.provision(p,'owner@example.test',check=True),'independent MFA')
p.policies[0]=saved
p.apps[0]['destinations'][0]['overrides']=[{'behavior':'public','path_pattern':'*'}]
rejects(lambda:m.provision(p,'owner@example.test',check=True),'bypass overrides')
del p.apps[0]['destinations'][0]['overrides']
p.apps[0]['policies'].append({'id':'bypass-policy'})
rejects(lambda:m.provision(p,'owner@example.test',check=True),'policy/MFA mismatch')
assert p.writes==[]
`));

test('partial successful provisioning can resume without duplicating apps or policies',()=>run(String.raw`
m.provision(p,'owner@example.test')
p.apps.pop();p.writes=[]
m.provision(p,'owner@example.test')
assert [(path,method) for path,method,body in p.writes]==[('/access/apps','POST')]
assert len(p.apps)==len(p.policies)==2
`));

test('duplicate names and ambiguous OTP providers stop before creating applications',()=>run(String.raw`
m.provision(p,'owner@example.test');p.writes=[]
p.apps.append(copy.deepcopy(p.apps[0]))
rejects(lambda:m.provision(p,'owner@example.test'),'duplicate')
p.apps.pop();p.idps.append({**p.idps[0],'id':'another-otp'})
rejects(lambda:m.provision(p,'owner@example.test'),'Multiple OTP')
assert p.writes==[]
`));

test('real provider omitted false defaults and unset inactivity placeholder remain idempotent',()=>run(String.raw`
m.provision(p,'owner@example.test')
p.org['service_token_inactivity']={'enabled':False,'inactivity_threshold_days':None,'action':None}
del p.org['mfa_config']['amr_matching_enabled']
for app in p.apps:
 for key in ['path_cookie_attribute','allow_iframe','skip_interstitial']:del app[key]
p.writes=[]
m.provision(p,'owner@example.test',check=True)
m.provision(p,'owner@example.test')
assert p.writes==[]
p.org['mfa_config']['amr_matching_enabled']=True
rejects(lambda:m.provision(p,'owner@example.test',check=True),'not ready')
assert p.writes==[]
`));

test('organization normalization preserves configured inactivity controls',()=>run(String.raw`
p.org['service_token_inactivity']={'enabled':True,'inactivity_threshold_days':30,'action':'revoke'}
m.provision(p,'owner@example.test')
assert p.org['service_token_inactivity']=={'enabled':True,'inactivity_threshold_days':30,'action':'revoke'}
`));
