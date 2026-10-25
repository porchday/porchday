import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const temporary:string[]=[];
afterEach(()=>{for(const path of temporary.splice(0))rmSync(path,{recursive:true,force:true});});
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'porchday-monitor-config-'));temporary.push(directory);
 mkdirSync(join(directory,'infra'));mkdirSync(join(directory,'apps/monitor'),{recursive:true});
 writeFileSync(join(directory,'infra/resources.json'),JSON.stringify({account_id:'a'.repeat(32)}));
 writeFileSync(join(directory,'apps/monitor/wrangler.jsonc'),readFileSync('apps/monitor/wrangler.jsonc'));
 const run=(script:string,args:string[],env:Record<string,string>={})=>spawnSync('python3',[resolve('scripts',script),...args],{cwd:directory,encoding:'utf8',env:{PATH:process.env.PATH,...env}});
 const secrets={PORCHDAY_STAGING_OPERATIONS_HEALTH_TOKEN:'private-health-capability-1234567890',PORCHDAY_OPERATIONS_EMAIL:'private-operator@example.test',CLOUDFLARE_API_TOKEN:'private-deployment-capability-1234567890'};
 return{directory,run,secrets};
}
it('renders separate disabled-by-default monitoring and requires a distinct read token to enable metrics',()=>{
 const {directory,run,secrets}=fixture();expect(run('configure-monitor.py',['staging']).status).toBe(0);
 let config=JSON.parse(readFileSync(join(directory,'apps/monitor/wrangler.staging.jsonc'),'utf8'));
 expect(config.vars.METRICS_ENABLED).toBe('false');expect(config.vars.ANALYTICS_ACCOUNT_ID).toBe('a'.repeat(32));
 const disabled=run('upload-monitor-secrets.py',['staging','--check'],secrets);expect(disabled.status).toBe(0);expect(disabled.stdout).toContain('disabled and not ready');
 expect(run('configure-monitor.py',['staging','--enable-metrics']).status).toBe(0);
 config=JSON.parse(readFileSync(join(directory,'apps/monitor/wrangler.staging.jsonc'),'utf8'));expect(config.vars.METRICS_ENABLED).toBe('true');
 for(const token of [undefined,secrets.CLOUDFLARE_API_TOKEN]){
  const invalid=run('upload-monitor-secrets.py',['staging','--check'],{...secrets,...(token?{CLOUDFLARE_ANALYTICS_READ_TOKEN:token}:{})});expect(invalid.status).not.toBe(0);expect(invalid.stderr).toContain('distinct dedicated');expect(invalid.stdout+invalid.stderr).not.toMatch(/private-/);
 }
 const valid=run('upload-monitor-secrets.py',['staging','--check'],{...secrets,CLOUDFLARE_ANALYTICS_READ_TOKEN:'private-distinct-read-capability-1234567890'});expect(valid.status).toBe(0);expect(valid.stdout).toContain('verify read-only token scope');expect(valid.stdout+valid.stderr).not.toMatch(/private-/);
});
