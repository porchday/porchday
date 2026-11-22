import {test,expect} from 'vitest';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

function syntheticReview(environment:string){
 return {schemaVersion:1,environment,flags:{KEY_RECOVERY_ENABLED:false,LOGOUT_PHASE_TIMING:false,
  SESSION_DENIAL_CLEANUP_V1:true,SESSION_DENIAL_WRITER_V1:false,VIDEO_UPLOADS_V2:false,
  SESSION_DENIAL_PARTITIONS_V1:null as string|null,SESSION_DENIAL_QUEUE_TOPOLOGY_V1:null as string|null},
  HEALTH_MONITOR:{service:'synthetic-'+environment+'-monitor'}};
}
async function reviewFile(directory:string,environment:string){
 const path=join(directory,'reviewed-runtime.json');
 await writeFile(path,JSON.stringify(syntheticReview(environment)));return path;
}

test('deployment renderer separates aggregate datasets and keeps request log/tracing persistence disabled',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'porchday-metrics-config-'));
 try{
  await mkdir(join(directory,'infra'));await mkdir(join(directory,'apps/api'),{recursive:true});
  await writeFile(join(directory,'apps/api/wrangler.local.jsonc'),await readFile('apps/api/wrangler.local.jsonc'));
  const environments=Object.fromEntries(['staging','production'].map(name=>[name,{
   hyperdrive_auth:'1'.repeat(32),hyperdrive_social:'2'.repeat(32),hyperdrive_jobs:'3'.repeat(32),
   bucket:'porchday-'+name+'-media',recovery_journal_bucket:'porchday-'+name+'-journal',queue:'porchday-'+name+'-jobs',dead_letter_queue:'porchday-'+name+'-dead',
   ...(name==='production'?{legacy_app_url:'https://porchday.com'}:{}),
  }]));
  await writeFile(join(directory,'infra/resources.json'),JSON.stringify({account_id:'a'.repeat(32),environments}));
  for(const name of ['staging','production']){
   const result=spawnSync('python3',[resolve('scripts/configure-worker.py'),name,'--reviewed-runtime',await reviewFile(directory,name)],{cwd:directory,encoding:'utf8'});
   expect(result.status,result.stderr).toBe(0);
   const config=JSON.parse(await readFile(join(directory,'apps/api/wrangler.'+name+'.jsonc'),'utf8'));
   expect(config.analytics_engine_datasets).toEqual([{binding:'METRICS',dataset:'porchday_'+name+'_operations_v1'}]);
   expect(config.observability).toEqual({enabled:false,logs:{enabled:false,invocation_logs:false},traces:{enabled:false}});
   expect(config.logpush).toBe(false);
   for(const flag of ['CONTENT_WRITES_PAUSED','MEDIA_UPLOADS_PAUSED','SOCIAL_INVITATIONS_PAUSED'])expect(config.vars[flag]).toBe('false');
   // Builder chat is the one pause that defaults to on.
   expect(config.vars.BUILDER_CHAT_PAUSED).toBe('true');
  }
  Object.assign(environments.production,{content_writes_paused:true,media_uploads_paused:true,social_invitations_paused:true});
  await writeFile(join(directory,'infra/resources.json'),JSON.stringify({account_id:'a'.repeat(32),environments}));
  const paused=spawnSync('python3',[resolve('scripts/configure-worker.py'),'production','--reviewed-runtime',await reviewFile(directory,'production')],{cwd:directory,encoding:'utf8'});
  expect(paused.status,paused.stderr).toBe(0);
  const config=JSON.parse(await readFile(join(directory,'apps/api/wrangler.production.jsonc'),'utf8'));
  for(const flag of ['CONTENT_WRITES_PAUSED','MEDIA_UPLOADS_PAUSED','SOCIAL_INVITATIONS_PAUSED'])expect(config.vars[flag]).toBe('true');
  Object.assign(environments.production,{builder_chat_paused:false});
  await writeFile(join(directory,'infra/resources.json'),JSON.stringify({account_id:'a'.repeat(32),environments}));
  expect(spawnSync('python3',[resolve('scripts/configure-worker.py'),'production','--reviewed-runtime',await reviewFile(directory,'production')],{cwd:directory,encoding:'utf8'}).status).toBe(0);
  expect(JSON.parse(await readFile(join(directory,'apps/api/wrangler.production.jsonc'),'utf8')).vars.BUILDER_CHAT_PAUSED).toBe('false');
  for(const invalid of ['false',0]){
   Object.assign(environments.production,{builder_chat_paused:invalid});
   await writeFile(join(directory,'infra/resources.json'),JSON.stringify({account_id:'a'.repeat(32),environments}));
   const rejected=spawnSync('python3',[resolve('scripts/configure-worker.py'),'production','--reviewed-runtime',await reviewFile(directory,'production')],{cwd:directory,encoding:'utf8'});
   expect(rejected.status).not.toBe(0);expect(rejected.stderr).toContain('builder_chat_paused must be a JSON boolean');
  }
  delete (environments.production as Record<string,unknown>).builder_chat_paused;
  for(const invalid of ['false',1,null]){
   Object.assign(environments.production,{content_writes_paused:invalid});
   await writeFile(join(directory,'infra/resources.json'),JSON.stringify({account_id:'a'.repeat(32),environments}));
   const rejected=spawnSync('python3',[resolve('scripts/configure-worker.py'),'production','--reviewed-runtime',await reviewFile(directory,'production')],{cwd:directory,encoding:'utf8'});
   expect(rejected.status).not.toBe(0);expect(rejected.stderr).toContain('must be a JSON boolean');
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('deployment renderer renders explicit placement without inheriting local placement',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'porchday-placement-config-'));
 try{
  await mkdir(join(directory,'infra'));await mkdir(join(directory,'apps/api'),{recursive:true});
  const local=JSON.parse(await readFile('apps/api/wrangler.local.jsonc','utf8'));
  local.placement={region:'aws:us-east-1'};
  await writeFile(join(directory,'apps/api/wrangler.local.jsonc'),JSON.stringify(local));
  const resources=JSON.parse(await readFile('infra/resources.json','utf8'));
  const manifest=join(directory,'infra/resources.json');
  await writeFile(manifest,JSON.stringify(resources));
  for(const name of ['staging','production']){
   const result=spawnSync('python3',[resolve('scripts/configure-worker.py'),name,'--reviewed-runtime',await reviewFile(directory,name)],{cwd:directory,encoding:'utf8'});
   expect(result.status,result.stderr).toBe(0);
   const config=JSON.parse(await readFile(join(directory,'apps/api/wrangler.'+name+'.jsonc'),'utf8'));
   if(name==='staging')expect(config.placement).toEqual({region:'aws:us-west-2'});
   else expect(config).not.toHaveProperty('placement');
   expect(config.vars.SIGNUP_ENABLED).toBe(resources.environments[name].signup_enabled===true?'true':'false');
   expect(config.workers_dev).toBe(false);expect(config.preview_urls).toBe(false);
  }
  const output=join(directory,'apps/api/wrangler.staging.jsonc'),before=await readFile(output,'utf8');
  for(const invalid of [true,'aws:us-west-2',{},[],{region:7},{region:'https://example.com'},{region:'aws:us-west-2',mode:'smart'}]){
   resources.environments.staging.worker_placement=invalid;
   await writeFile(manifest,JSON.stringify(resources));
   const rejected=spawnSync('python3',[resolve('scripts/configure-worker.py'),'staging','--reviewed-runtime',await reviewFile(directory,'staging')],{cwd:directory,encoding:'utf8'});
   expect(rejected.status).not.toBe(0);expect(rejected.stderr).toContain('worker_placement must be null or an object');
   expect(await readFile(output,'utf8')).toBe(before);
  }
  delete resources.environments.production.worker_placement;
  await writeFile(manifest,JSON.stringify(resources));
  const absent=spawnSync('python3',[resolve('scripts/configure-worker.py'),'production','--reviewed-runtime',await reviewFile(directory,'production')],{cwd:directory,encoding:'utf8'});
  expect(absent.status,absent.stderr).toBe(0);
  expect(JSON.parse(await readFile(join(directory,'apps/api/wrangler.production.jsonc'),'utf8'))).not.toHaveProperty('placement');
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('production domain rendering preserves legacy access, signup, sender and resources with exact origin allowlists',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'porchday-domain-config-'));
 try{
  await mkdir(join(directory,'infra'));await mkdir(join(directory,'apps/api'),{recursive:true});
  const local=JSON.parse(await readFile('apps/api/wrangler.local.jsonc','utf8'));
  local.vars.LEGACY_APP_URL='https://unreviewed.example';
  await writeFile(join(directory,'apps/api/wrangler.local.jsonc'),JSON.stringify(local));
  const resources=JSON.parse(await readFile('infra/resources.json','utf8'));
  const manifest=join(directory,'infra/resources.json');await writeFile(manifest,JSON.stringify(resources));
  for(const name of ['staging','production']){
   const result=spawnSync('python3',[resolve('scripts/configure-worker.py'),name,'--reviewed-runtime',await reviewFile(directory,name)],{cwd:directory,encoding:'utf8'});
   expect(result.status,result.stderr).toBe(0);
   const config=JSON.parse(await readFile(join(directory,'apps/api/wrangler.'+name+'.jsonc'),'utf8'));
   expect(config.vars.APP_URL).toBe(name==='production'?'https://porchday.org':'https://staging.porchday.com');
   expect(config.vars.SIGNUP_ENABLED).toBe('true');
   expect(config.vars.EMAIL_FROM).toBe('Porchday <accounts@porchday.com>');
   expect(config.send_email).toEqual(local.send_email);
   expect(config.vars.VAPID_SUBJECT).toBe(name==='production'?'https://porchday.org/contact':'https://porchday.com/contact');
   expect(config.hyperdrive.map((binding:any)=>binding.id)).toEqual(['auth','social','jobs'].map(role=>resources.environments[name]['hyperdrive_'+role]));
   expect(config.routes).toEqual(name==='production'?['porchday.org','www.porchday.org','porchday.com','www.porchday.com'].map(pattern=>({pattern,custom_domain:true})):[]);
   const edge=spawnSync('python3',[resolve('scripts/configure-edge.py'),name],{cwd:directory,encoding:'utf8'});
   expect(edge.status,edge.stderr).toBe(0);
   const front=JSON.parse(await readFile(join(directory,'apps/api/wrangler.edge.'+name+'.jsonc'),'utf8'));
   expect(front.routes).toEqual((name==='production'?['porchday.org','www.porchday.org','porchday.com','www.porchday.com']:['staging.porchday.com']).map(pattern=>({pattern,custom_domain:true})));
   expect(front.placement).toEqual({mode:'off'});
   expect(front.services).toEqual([{binding:'API_BACKEND',service:'porchday-'+name}]);
   for(const privateBinding of ['hyperdrive','r2_buckets','queues','triggers'])expect(front).not.toHaveProperty(privateBinding);
   if(name==='production')expect(config.vars.LEGACY_APP_URL).toBe('https://porchday.com');
   else expect(config.vars).not.toHaveProperty('LEGACY_APP_URL');
  }
  const output=join(directory,'apps/api/wrangler.production.jsonc'),before=await readFile(output,'utf8');
  for(const origin of ['http://porchday.org','https://porchday.org/','https://porchday.org.evil.test','https://staging.porchday.com',null]){
   resources.environments.production.app_url=origin;await writeFile(manifest,JSON.stringify(resources));
   const rejected=spawnSync('python3',[resolve('scripts/configure-worker.py'),'production','--reviewed-runtime',await reviewFile(directory,'production')],{cwd:directory,encoding:'utf8'});
   expect(rejected.status).not.toBe(0);expect(rejected.stderr).toContain('reviewed canonical origin');expect(await readFile(output,'utf8')).toBe(before);
  }
  resources.environments.production.app_url='https://porchday.org';
  for(const origin of ['http://porchday.com','https://porchday.com/','https://porchday.org','https://porchday.com.evil.test','https://staging.porchday.com',null,undefined]){
   resources.environments.production.legacy_app_url=origin;await writeFile(manifest,JSON.stringify(resources));
   const rejected=spawnSync('python3',[resolve('scripts/configure-worker.py'),'production','--reviewed-runtime',await reviewFile(directory,'production')],{cwd:directory,encoding:'utf8'});
   expect(rejected.status).not.toBe(0);expect(rejected.stderr).toContain('reviewed production HTTPS origin');expect(await readFile(output,'utf8')).toBe(before);
  }
  const stagingOutput=join(directory,'apps/api/wrangler.staging.jsonc'),stagingBefore=await readFile(stagingOutput,'utf8');
  for(const origin of ['https://porchday.com',null,'']){
   resources.environments.staging.legacy_app_url=origin;await writeFile(manifest,JSON.stringify(resources));
   const rejected=spawnSync('python3',[resolve('scripts/configure-worker.py'),'staging','--reviewed-runtime',await reviewFile(directory,'staging')],{cwd:directory,encoding:'utf8'});
   expect(rejected.status).not.toBe(0);expect(rejected.stderr).toContain('forbidden outside production');expect(await readFile(stagingOutput,'utf8')).toBe(stagingBefore);
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('deployment renderer binds trace storage only to an explicitly provisioned D1 database',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'porchday-traces-config-'));
 try{
  await mkdir(join(directory,'infra'));await mkdir(join(directory,'apps/api'),{recursive:true});
  await writeFile(join(directory,'apps/api/wrangler.local.jsonc'),await readFile('apps/api/wrangler.local.jsonc'));
  const staging:Record<string,unknown>={hyperdrive_auth:'1'.repeat(32),hyperdrive_social:'2'.repeat(32),hyperdrive_jobs:'3'.repeat(32),
   bucket:'porchday-staging-media',recovery_journal_bucket:'porchday-staging-journal',queue:'porchday-staging-jobs',dead_letter_queue:'porchday-staging-dead'};
  const render=async()=>{
   await writeFile(join(directory,'infra/resources.json'),JSON.stringify({account_id:'a'.repeat(32),environments:{staging}}));
   const result=spawnSync('python3',[resolve('scripts/configure-worker.py'),'staging','--reviewed-runtime',await reviewFile(directory,'staging')],{cwd:directory,encoding:'utf8'});
   return {result,config:result.status===0?JSON.parse(await readFile(join(directory,'apps/api/wrangler.staging.jsonc'),'utf8')):undefined};
  };
  // The local placeholder database is never inherited.
  expect((await render()).config.d1_databases).toBeUndefined();
  staging.traces_d1_database_id='4f1b2c3d-0000-4000-8000-0000000000aa';
  expect((await render()).config.d1_databases).toEqual([{binding:'TRACES',database_name:'porchday-staging-traces',database_id:'4f1b2c3d-0000-4000-8000-0000000000aa',migrations_dir:'d1/traces'}]);
  for(const invalid of ['00000000-0000-0000-0000-000000000001','not-a-uuid',7]){
   staging.traces_d1_database_id=invalid;
   const {result}=await render();expect(result.status).not.toBe(0);expect(result.stderr).toContain('traces_d1_database_id');
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('journal rollout survives regeneration and cannot enable a writer without its reader',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'porchday-journal-config-'));
 try{
  await mkdir(join(directory,'infra'));await mkdir(join(directory,'apps/api'),{recursive:true});
  await writeFile(join(directory,'apps/api/wrangler.local.jsonc'),await readFile('apps/api/wrangler.local.jsonc'));
  const resources=JSON.parse(await readFile('infra/resources.json','utf8')),manifest=join(directory,'infra/resources.json');
  for(const name of ['staging','production']){
   const env=resources.environments[name],output=join(directory,'apps/api/wrangler.'+name+'.jsonc');
   env.journal_latency_recovery_v1=false;env.journal_latency_writer_v1=false;
   for(const writer of [true,false]){
    env.privacy_commit_recovery_v1=true;env.privacy_commit_writer_v1=writer;await writeFile(manifest,JSON.stringify(resources));
    const result=spawnSync('python3',[resolve('scripts/configure-worker.py'),name,'--reviewed-runtime',await reviewFile(directory,name)],{cwd:directory,encoding:'utf8'});expect(result.status,result.stderr).toBe(0);
    const rendered=JSON.parse(await readFile(output,'utf8'));expect(rendered.vars.PRIVACY_COMMIT_RECOVERY_V1).toBe('true');expect(rendered.vars.PRIVACY_COMMIT_WRITER_V1).toBe(String(writer));
   }
   env.privacy_commit_writer_v1=true;env.journal_latency_recovery_v1=true;
   for(const writer of [true,false]){
    env.journal_latency_writer_v1=writer;await writeFile(manifest,JSON.stringify(resources));
    const result=spawnSync('python3',[resolve('scripts/configure-worker.py'),name,'--reviewed-runtime',await reviewFile(directory,name)],{cwd:directory,encoding:'utf8'});expect(result.status,result.stderr).toBe(0);
    const rendered=JSON.parse(await readFile(output,'utf8'));expect(rendered.vars.JOURNAL_LATENCY_RECOVERY_V1).toBe('true');expect(rendered.vars.JOURNAL_LATENCY_WRITER_V1).toBe(String(writer));
   }
   env.journal_latency_writer_v1=true;env.journal_latency_recovery_v1=false;await writeFile(manifest,JSON.stringify(resources));
   const rejected=spawnSync('python3',[resolve('scripts/configure-worker.py'),name,'--reviewed-runtime',await reviewFile(directory,name)],{cwd:directory,encoding:'utf8'});expect(rejected.status).not.toBe(0);expect(rejected.stderr).toContain('latency writer requires');
   env.journal_latency_writer_v1=false;env.journal_latency_recovery_v1=false;
   const before=await readFile(output,'utf8');env.privacy_commit_writer_v1=true;env.privacy_commit_recovery_v1=false;await writeFile(manifest,JSON.stringify(resources));
   const invalid=spawnSync('python3',[resolve('scripts/configure-worker.py'),name,'--reviewed-runtime',await reviewFile(directory,name)],{cwd:directory,encoding:'utf8'});expect(invalid.status).not.toBe(0);expect(invalid.stderr).toContain('writer requires the recovery reader');expect(await readFile(output,'utf8')).toBe(before);
   env.privacy_commit_recovery_v1=true;
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('reviewed runtime contract preserves choices deterministically and rejects invalid input without overwriting output',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'porchday-reviewed-config-'));
 try{
  await mkdir(join(directory,'infra'));await mkdir(join(directory,'apps/api'),{recursive:true});
  const local=JSON.parse(await readFile('apps/api/wrangler.local.jsonc','utf8'));
  local.services=[{binding:'OTHER_SERVICE',service:'synthetic-other'},{binding:'HEALTH_MONITOR',service:'unreviewed-local'}];
  local.vars.SESSION_DENIAL_PARTITIONS_V1='true';local.vars.SESSION_DENIAL_QUEUE_TOPOLOGY_V1='true';
  await writeFile(join(directory,'apps/api/wrangler.local.jsonc'),JSON.stringify(local));
  const environments=Object.fromEntries(['staging','production'].map(name=>[name,{
   hyperdrive_auth:'1'.repeat(32),hyperdrive_social:'2'.repeat(32),hyperdrive_jobs:'3'.repeat(32),
   bucket:'synthetic-media',recovery_journal_bucket:'synthetic-journal',queue:'synthetic-jobs',dead_letter_queue:'synthetic-dead',
   ...(name==='production'?{legacy_app_url:'https://porchday.com'}:{}),
  }]));
  await writeFile(join(directory,'infra/resources.json'),JSON.stringify({account_id:'a'.repeat(32),environments}));
  const input=join(directory,'reviewed-runtime.json');
  for(const name of ['staging','production']){
   const output=join(directory,'apps/api/wrangler.'+name+'.jsonc');
   const run=(args=[name,'--reviewed-runtime',input])=>spawnSync('python3',[resolve('scripts/configure-worker.py'),...args],{cwd:directory,encoding:'utf8'});
   for(const enabled of [true,false]){
    const review=syntheticReview(name);
    for(const flag of ['KEY_RECOVERY_ENABLED','LOGOUT_PHASE_TIMING','SESSION_DENIAL_CLEANUP_V1','SESSION_DENIAL_WRITER_V1','VIDEO_UPLOADS_V2'] as const)review.flags[flag]=enabled;
    review.flags.SESSION_DENIAL_PARTITIONS_V1=enabled?' Synthetic partitions: A=4; B=8 ':'false';
    review.flags.SESSION_DENIAL_QUEUE_TOPOLOGY_V1=enabled?'Synthetic topology: α → β':'true';
    await writeFile(input,JSON.stringify(review));
    const result=run();expect(result.status,result.stderr).toBe(0);
    const first=await readFile(output,'utf8'),config=JSON.parse(first);
    for(const [flag,value] of Object.entries(review.flags))expect(config.vars[flag]).toBe(String(value));
    expect(config.services).toEqual([{binding:'OTHER_SERVICE',service:'synthetic-other'},{binding:'HEALTH_MONITOR',service:review.HEALTH_MONITOR.service}]);
    expect(run().status).toBe(0);expect(await readFile(output,'utf8')).toBe(first);
    // Input key order must not affect the generated bytes.
    review.flags=Object.fromEntries(Object.entries(review.flags).reverse()) as typeof review.flags;
    await writeFile(input,JSON.stringify(review));expect(run().status).toBe(0);expect(await readFile(output,'utf8')).toBe(first);
   }
   // Inclusive code-point bound, including astral Unicode and exact whitespace.
   for(const value of ['x',' ','é'.repeat(1024),'🦃'.repeat(1024)]){
    const review=syntheticReview(name);
    review.flags.SESSION_DENIAL_PARTITIONS_V1=value;review.flags.SESSION_DENIAL_QUEUE_TOPOLOGY_V1=value;
    await writeFile(input,JSON.stringify(review));expect(run().status).toBe(0);
    const config=JSON.parse(await readFile(output,'utf8'));
    expect(config.vars.SESSION_DENIAL_PARTITIONS_V1).toBe(value);expect(config.vars.SESSION_DENIAL_QUEUE_TOPOLOGY_V1).toBe(value);
   }
   const review=syntheticReview(name);await writeFile(input,JSON.stringify(review));expect(run().status).toBe(0);
   const before=await readFile(output,'utf8'),config=JSON.parse(before);
   expect(config.vars.SESSION_DENIAL_CLEANUP_V1).toBe('true');expect(config.vars.SESSION_DENIAL_WRITER_V1).toBe('false');
   expect(config.vars).not.toHaveProperty('SESSION_DENIAL_PARTITIONS_V1');expect(config.vars).not.toHaveProperty('SESSION_DENIAL_QUEUE_TOPOLOGY_V1');
   const invalid:unknown[]=[null,[],{...review,unknown:true},{...review,schemaVersion:true},{...review,schemaVersion:2},
    {...review,environment:name==='staging'?'production':'staging'},
    {...review,flags:{...review.flags,UNKNOWN_FLAG:false}},
    {...review,flags:{...review.flags,SESSION_DENIAL_WRITER_V1:true,SESSION_DENIAL_CLEANUP_V1:false}}];
   for(const key of Object.keys(review)){
    const missing:Record<string,unknown>={...review};delete missing[key];invalid.push(missing);
   }
   for(const flag of Object.keys(review.flags)){
    const missing:Record<string,unknown>={...review.flags};delete missing[flag];invalid.push({...review,flags:missing});
    const capability=flag==='SESSION_DENIAL_PARTITIONS_V1'||flag==='SESSION_DENIAL_QUEUE_TOPOLOGY_V1';
    const invalidValues=capability
     ? [true,false,0,1,{},[],'','x'.repeat(1025),'🦃'.repeat(1025),
       ...['\u0000','\n','\r','\t','\u001f','\u007f','\u0085','\u200b','\u202e','\ud800','\u2028','\u2029'].map(control=>'before'+control+'after')]
     : ['true','false',0,1,{},[],null];
    for(const value of invalidValues){
     invalid.push({...review,flags:{...review.flags,[flag]:value}});
    }
   }
   for(const binding of [null,{},[],{service:7},{service:''},{service:'https://private.example'},
    {service:'a'.repeat(64)},{service:'bad name'},{service:'valid',environment:'production'},{service:'valid',extra:true}])invalid.push({...review,HEALTH_MONITOR:binding});
   const raw=[...invalid.map(value=>JSON.stringify(value)),'{',JSON.stringify(review).replace('"schemaVersion":1','"schemaVersion":1,"schemaVersion":1'),JSON.stringify(review).replace('"KEY_RECOVERY_ENABLED":false','"KEY_RECOVERY_ENABLED":NaN')];
   for(const value of raw){
    await writeFile(input,value);const result=run();expect(result.status).not.toBe(0);expect(await readFile(output,'utf8')).toBe(before);
   }
   for(const args of [[name],[name,'--reviewed-runtime',join(directory,'missing.json')],[name,'--wrong-option',input]]){
    expect(run(args).status).not.toBe(0);expect(await readFile(output,'utf8')).toBe(before);
   }
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});
