import {test,expect} from 'vitest';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

test('deployment renderer separates aggregate datasets and keeps request log/tracing persistence disabled',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'porchday-metrics-config-'));
 try{
  await mkdir(join(directory,'infra'));await mkdir(join(directory,'apps/api'),{recursive:true});
  await writeFile(join(directory,'apps/api/wrangler.local.jsonc'),await readFile('apps/api/wrangler.local.jsonc'));
  const environments=Object.fromEntries(['staging','production'].map(name=>[name,{
   hyperdrive_auth:'1'.repeat(32),hyperdrive_social:'2'.repeat(32),hyperdrive_jobs:'3'.repeat(32),
   bucket:'porchday-'+name+'-media',recovery_journal_bucket:'porchday-'+name+'-journal',queue:'porchday-'+name+'-jobs',dead_letter_queue:'porchday-'+name+'-dead',
  }]));
  await writeFile(join(directory,'infra/resources.json'),JSON.stringify({account_id:'a'.repeat(32),environments}));
  for(const name of ['staging','production']){
   const result=spawnSync('python3',[resolve('scripts/configure-worker.py'),name],{cwd:directory,encoding:'utf8'});
   expect(result.status,result.stderr).toBe(0);
   const config=JSON.parse(await readFile(join(directory,'apps/api/wrangler.'+name+'.jsonc'),'utf8'));
   expect(config.analytics_engine_datasets).toEqual([{binding:'METRICS',dataset:'porchday_'+name+'_operations_v1'}]);
   expect(config.observability).toEqual({enabled:false,logs:{enabled:false,invocation_logs:false},traces:{enabled:false}});
   expect(config.logpush).toBe(false);
   for(const flag of ['CONTENT_WRITES_PAUSED','MEDIA_UPLOADS_PAUSED','SOCIAL_INVITATIONS_PAUSED'])expect(config.vars[flag]).toBe('false');
  }
  Object.assign(environments.production,{content_writes_paused:true,media_uploads_paused:true,social_invitations_paused:true});
  await writeFile(join(directory,'infra/resources.json'),JSON.stringify({account_id:'a'.repeat(32),environments}));
  const paused=spawnSync('python3',[resolve('scripts/configure-worker.py'),'production'],{cwd:directory,encoding:'utf8'});
  expect(paused.status,paused.stderr).toBe(0);
  const config=JSON.parse(await readFile(join(directory,'apps/api/wrangler.production.jsonc'),'utf8'));
  for(const flag of ['CONTENT_WRITES_PAUSED','MEDIA_UPLOADS_PAUSED','SOCIAL_INVITATIONS_PAUSED'])expect(config.vars[flag]).toBe('true');
  for(const invalid of ['false',1,null]){
   Object.assign(environments.production,{content_writes_paused:invalid});
   await writeFile(join(directory,'infra/resources.json'),JSON.stringify({account_id:'a'.repeat(32),environments}));
   const rejected=spawnSync('python3',[resolve('scripts/configure-worker.py'),'production'],{cwd:directory,encoding:'utf8'});
   expect(rejected.status).not.toBe(0);expect(rejected.stderr).toContain('must be a JSON boolean');
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('deployment renderer reproduces retained staging placement without inheriting it into production',async()=>{
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
   const result=spawnSync('python3',[resolve('scripts/configure-worker.py'),name],{cwd:directory,encoding:'utf8'});
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
   const rejected=spawnSync('python3',[resolve('scripts/configure-worker.py'),'staging'],{cwd:directory,encoding:'utf8'});
   expect(rejected.status).not.toBe(0);expect(rejected.stderr).toContain('worker_placement must be null or an object');
   expect(await readFile(output,'utf8')).toBe(before);
  }
  delete resources.environments.production.worker_placement;
  await writeFile(manifest,JSON.stringify(resources));
  const absent=spawnSync('python3',[resolve('scripts/configure-worker.py'),'production'],{cwd:directory,encoding:'utf8'});
  expect(absent.status,absent.stderr).toBe(0);
  expect(JSON.parse(await readFile(join(directory,'apps/api/wrangler.production.jsonc'),'utf8'))).not.toHaveProperty('placement');
 }finally{await rm(directory,{recursive:true,force:true});}
});
