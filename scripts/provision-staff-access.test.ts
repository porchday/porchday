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
  self.apps=[];self.policies=[];self.idps=[];self.users=[];self.writes=[];self.embed_policies=False
 def present(self,item,prefix):
  value=copy.deepcopy(item)
  if self.embed_policies and prefix=='/access/apps':
   value['policies']=[{**copy.deepcopy(next(p for p in self.policies if p['id']==link['id'])),**link} for link in value['policies']]
  return value
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
    return [self.present(item,prefix) for item in items]
   if path.startswith(prefix+'/'):
    item=next(i for i in items if i['id']==path[len(prefix)+1:])
    if method=='PUT':
     item.update(copy.deepcopy(body))
     if self.embed_policies and prefix=='/access/policies':item['updated_at']='2026-10-25T20:00:00Z'
    return self.present(item,prefix)
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

test('explicit staging update changes only the exact roster and subsequent checks are idempotent',()=>run(String.raw`
original=m.provision(p,'owner@example.test')
p.policies[0].update(approval_required=False,isolation_required=False,purpose_justification_required=True,
 purpose_justification_prompt='Review access',created_at='2026-01-01',updated_at='2026-01-01',app_count=1,reusable=True)
before=copy.deepcopy((p.org,p.apps,p.policies,p.idps));p.writes=[]
reviewers={'staging':'Reviewer@example.test'}
out=m.update_roster(p,'owner@example.test',reviewers,'staging')
assert out==original
assert len(p.writes)==1 and p.writes[0][:2]==('/access/policies/'+p.policies[0]['id'],'PUT')
assert p.policies[0]['include']==[{'email':{'email':'owner@example.test'}},{'email':{'email':'reviewer@example.test'}}]
expected=copy.deepcopy(before);expected[2][0]['include']=copy.deepcopy(p.policies[0]['include'])
assert (p.org,p.apps,p.policies,p.idps)==expected
assert p.writes[0][2]==m.policy_update_body(p.policies[0])
assert 'owner@example.test' not in json.dumps(out) and 'reviewer@example.test' not in json.dumps(out)
p.writes=[]
assert m.update_roster(p,'owner@example.test',reviewers,'staging')==out
assert m.provision(p,'owner@example.test',check=True,reviewers=reviewers)==out
assert m.provision(p,'owner@example.test',reviewers=reviewers)==out
assert p.writes==[]
`));

test('default/check never expand a configured roster or repair existing policy/MFA drift',()=>run(String.raw`
m.provision(p,'owner@example.test');p.writes=[]
reviewers={'staging':'reviewer@example.test'}
for readonly in [False,True]:
 rejects(lambda:m.provision(p,'owner@example.test',check=readonly,reviewers=reviewers),'exact owner')
assert p.writes==[]
p.org['mfa_required_for_all_apps']=False
rejects(lambda:m.provision(p,'owner@example.test'),'not ready')
assert p.writes==[]
`));

test('both environments and OTP are preflighted before any roster write',()=>run(String.raw`
m.provision(p,'owner@example.test');p.writes=[]
reviewers={'staging':'reviewer@example.test'}
saved=copy.deepcopy(p.policies[1]);p.policies[1]['include']=[{'everyone':{}}]
rejects(lambda:m.update_roster(p,'owner@example.test',reviewers,'staging'),'exact owner')
p.policies[1]=saved
p.idps[0]['type']='oidc'
rejects(lambda:m.update_roster(p,'owner@example.test',reviewers,'staging'),'no unambiguous OTP')
assert p.writes==[]
`));

test('staging expansion refuses missing/same reviewer, production changes and unexpected current roster',()=>run(String.raw`
m.provision(p,'owner@example.test');p.writes=[]
for reviewers,env in [({},'staging'),({'staging':'OWNER@example.test'},'staging'),
 ({'staging':'r@example.test','production':'p@example.test'},'staging'),
 ({'production':'r@example.test'},'production')]:
 try:m.update_roster(p,'owner@example.test',reviewers,env)
 except m.AccessError as e:assert '@' not in str(e)
 else:raise AssertionError('Unsafe roster accepted')
p.policies[0]['include'].append({'email':{'email':'unexpected@example.test'}})
rejects(lambda:m.update_roster(p,'owner@example.test',{'staging':'r@example.test'},'staging'),'neither owner-only')
assert p.writes==[]
`));

test('a concurrent configuration change during the final preflight prevents the write',()=>run(String.raw`
m.provision(p,'owner@example.test');p.writes=[]
org_reads=0
def changing_api(path,method='GET',body=None):
 global org_reads
 if path=='/access/organizations' and method=='GET':
  org_reads+=1
  if org_reads==3:p.apps[1]['app_launcher_visible']=False
 return p(path,method,body)
rejects(lambda:m.update_roster(changing_api,'owner@example.test',{'staging':'r@example.test'},'staging'),'changed before update')
assert p.writes==[]
`));

test('post-write drift is reported without automatic retry or rollback',()=>run(String.raw`
m.provision(p,'owner@example.test');p.writes=[]
def changing_api(path,method='GET',body=None):
 result=p(path,method,body)
 if method=='PUT':p.apps[1]['app_launcher_visible']=False
 return result
rejects(lambda:m.update_roster(changing_api,'owner@example.test',{'staging':'r@example.test'},'staging'),'outcome requires manual review')
assert len(p.writes)==1
assert len(p.policies[1]['include'])==1
`));

test('shared policies and unknown update fields are refused rather than silently changed',()=>run(String.raw`
m.provision(p,'owner@example.test');p.writes=[]
p.policies[0]['app_count']=2
rejects(lambda:m.update_roster(p,'owner@example.test',{'staging':'r@example.test'},'staging'),'shared')
p.policies[0]['app_count']=1;p.policies[0]['future_security_setting']=True
rejects(lambda:m.update_roster(p,'owner@example.test',{'staging':'r@example.test'},'staging'),'Unrecognized policy')
assert p.writes==[]
`));

test('an uncertain provider write reports fixed manual-review guidance without private values or retries',()=>run(String.raw`
m.provision(p,'owner@example.test');p.writes=[]
def failing_api(path,method='GET',body=None):
 result=p(path,method,body)
 if method=='PUT':raise m.AccessError('Provider body includes reviewer@example.test')
 return result
try:m.update_roster(failing_api,'owner@example.test',{'staging':'reviewer@example.test'},'staging')
except m.AccessError as e:
 assert 'outcome requires manual review' in str(e) and 'Do not retry automatically' in str(e)
 assert '@' not in str(e)
else:raise AssertionError('Expected uncertain outcome')
assert len(p.writes)==1
`));

test('provider uid aliases are preserved in readback but omitted from the staging policy update',()=>run(String.raw`
m.provision(p,'owner@example.test')
for policy in p.policies:policy['uid']=policy['id']
p.writes=[]
before=copy.deepcopy(p.policies)
reviewers={'staging':'reviewer@example.test'}
out=m.update_roster(p,'owner@example.test',reviewers,'staging')
assert len(p.writes)==1 and 'uid' not in p.writes[0][2]
assert all(policy['uid']==policy['id'] for policy in p.policies)
assert p.policies[1]==before[1]
p.writes=[]
assert m.provision(p,'owner@example.test',check=True,reviewers=reviewers)==out
assert m.update_roster(p,'owner@example.test',reviewers,'staging')==out
assert p.writes==[]
`));

test('a mismatched or malformed uid in either environment rejects the update before writes',()=>run(String.raw`
m.provision(p,'owner@example.test');p.writes=[]
for policy in p.policies:
 for invalid in ['different-policy',None,0,'']:
  policy['uid']=invalid
  rejects(lambda:m.update_roster(p,'owner@example.test',{'staging':'r@example.test'},'staging'),'identity alias')
  assert p.writes==[]
 policy['uid']=policy['id']
`));

test('post-write uid drift cannot pass verification',()=>run(String.raw`
m.provision(p,'owner@example.test')
for policy in p.policies:policy['uid']=policy['id']
p.writes=[]
def changed_alias(path,method='GET',body=None):
 result=p(path,method,body)
 if method=='PUT':p.policies[0]['uid']='different-policy'
 return result
rejects(lambda:m.update_roster(changed_alias,'owner@example.test',{'staging':'r@example.test'},'staging'),'outcome requires manual review')
assert len(p.writes)==1
`));

test('one policy update verifies full policy embeds in app list/detail without mutating applications',()=>run(String.raw`
m.provision(p,'owner@example.test')
for policy in p.policies:policy.update(uid=policy['id'],updated_at='2026-10-25T19:00:00Z',created_at='2026-01-01T00:00:00Z')
p.embed_policies=True;p.writes=[]
apps_before=copy.deepcopy(p.apps);production_before=copy.deepcopy(p.policies[1])
reviewers={'staging':'reviewer@example.test'}
out=m.update_roster(p,'owner@example.test',reviewers,'staging')
assert len(p.writes)==1 and p.writes[0][:2]==('/access/policies/'+p.policies[0]['id'],'PUT')
assert p.apps==apps_before and p.policies[1]==production_before
for app in [p('/access/apps')[0],p('/access/apps/'+p.apps[0]['id'])]:
 assert app['policies'][0]['include']==p.policies[0]['include']
 assert app['policies'][0]['updated_at']==p.policies[0]['updated_at']
p.writes=[]
assert m.provision(p,'owner@example.test',check=True,reviewers=reviewers)==out
assert m.update_roster(p,'owner@example.test',reviewers,'staging')==out
assert p.writes==[]
`));

test('policy embeds do not mask a changed application policy precedence',()=>run(String.raw`
m.provision(p,'owner@example.test');p.embed_policies=True;p.writes=[]
def changed_precedence(path,method='GET',body=None):
 result=p(path,method,body)
 if method=='PUT':p.apps[0]['policies'][0]['precedence']=2
 return result
rejects(lambda:m.update_roster(changed_precedence,'owner@example.test',{'staging':'r@example.test'},'staging'),'outcome requires manual review')
assert len(p.writes)==1
`));

test('Launcher creation is closed, isolated from staff MFA and idempotent',()=>run(String.raw`
m.provision(p,'owner@example.test');roster={'staging':'reviewer@example.test'}
m.update_roster(p,'owner@example.test',roster,'staging');p.embed_policies=True
before=copy.deepcopy((p.org,p.apps,p.policies,p.idps));p.writes=[]
out=m.enable_launcher(p,'owner@example.test',roster)
assert [w[:2] for w in p.writes]==[('/access/policies','POST'),('/access/apps','POST')]
assert (p.org,p.apps[:2],p.policies[:2],p.idps)==before
policy=p.policies[-1];app=p.apps[-1]
assert policy['include']==[{'email':{'email':'owner@example.test'}},{'email':{'email':'reviewer@example.test'}}]
assert policy['require']==[{'login_method':{'id':p.idps[0]['id']}}]
assert 'mfa_config' not in policy and 'mfa_config' not in app
assert app['policies']==[{'id':policy['id'],'precedence':1}]
assert app['type']=='app_launcher' and app['allowed_idps']==[p.idps[0]['id']]
assert not app['skip_app_launcher_login_page']
assert out['launcher']=={'application_id':app['id'],'policy_id':policy['id']}
assert all(value not in json.dumps(out) for value in ['owner@example.test','reviewer@example.test'])
p.writes=[]
assert m.enable_launcher(p,'owner@example.test',roster)==out
assert m.provision(p,'owner@example.test',check=True,reviewers=roster)==out
assert p.writes==[]
`));

test('Launcher refuses unrelated/duplicate apps and invalid roster or staff drift before writes',()=>run(String.raw`
m.provision(p,'owner@example.test');roster={'staging':'reviewer@example.test'}
m.update_roster(p,'owner@example.test',roster,'staging');p.writes=[]
for invalid in [{},{'production':'reviewer@example.test'},{'staging':'reviewer@example.test','production':'other@example.test'}]:
 rejects(lambda:m.enable_launcher(p,'owner@example.test',invalid),'requires')
p.apps[1]['mfa_config']['mfa_disabled']=True
rejects(lambda:m.enable_launcher(p,'owner@example.test',roster),'MFA')
assert p.writes==[]
p.apps[1]['mfa_config']['mfa_disabled']=False
m.enable_launcher(p,'owner@example.test',roster);p.writes=[]
p.apps.append(copy.deepcopy(p.apps[-1]))
rejects(lambda:m.enable_launcher(p,'owner@example.test',roster),'Multiple Launcher')
assert p.writes==[]
`));

test('Launcher refuses a broader, shared or MFA-blocked enrollment policy',()=>run(String.raw`
m.provision(p,'owner@example.test');roster={'staging':'reviewer@example.test'}
m.update_roster(p,'owner@example.test',roster,'staging');m.enable_launcher(p,'owner@example.test',roster)
saved=copy.deepcopy(p.policies[-1]);p.writes=[]
for patch in [{'include':[{'everyone':{}}]},{'mfa_config':m.MFA},{'app_count':2}]:
 p.policies[-1]={**copy.deepcopy(saved),**patch}
 rejects(lambda:m.provision(p,'owner@example.test',check=True,reviewers=roster),'Launcher')
p.policies[-1]=saved;p.apps[-1]['policies'].append({'id':'other'})
rejects(lambda:m.provision(p,'owner@example.test',check=True,reviewers=roster),'exactly')
assert p.writes==[]
`));

test('Launcher preflight races fail without writes and postflight drift is not retried',()=>run(String.raw`
m.provision(p,'owner@example.test');roster={'staging':'reviewer@example.test'}
m.update_roster(p,'owner@example.test',roster,'staging');p.writes=[]
reads=0
def race(path,method='GET',body=None):
 global reads
 if path=='/access/users':
  reads+=1
  if reads==2:p.users.append({'id':'new-user'})
 return p(path,method,body)
rejects(lambda:m.enable_launcher(race,'owner@example.test',roster),'changed before')
assert p.writes==[]
def changed(path,method='GET',body=None):
 value=p(path,method,body)
 if path=='/access/apps' and method=='POST':p.apps[1]['session_duration']='2h'
 return value
rejects(lambda:m.enable_launcher(changed,'owner@example.test',roster),'Do not retry automatically')
assert len(p.writes)==2
`));

test('Launcher can explicitly resume a verified orphan policy without duplicating or opening it',()=>run(String.raw`
m.provision(p,'owner@example.test');roster={'staging':'reviewer@example.test'}
m.update_roster(p,'owner@example.test',roster,'staging')
policy=p('/access/policies','POST',m.launcher_policy_body('owner@example.test',p.idps[0]['id'],{'staging':'reviewer@example.test','production':''}))
p.policies[-1]['app_count']=0;p.writes=[]
def provider(path,method='GET',body=None):
 value=p(path,method,body)
 if path=='/access/apps' and method=='POST':p.policies[-1]['app_count']=1
 return value
m.enable_launcher(provider,'owner@example.test',roster)
assert [w[:2] for w in p.writes]==[('/access/apps','POST')]
assert len(p.policies)==3
`));
