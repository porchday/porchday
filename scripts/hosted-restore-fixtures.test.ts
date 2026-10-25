import {describe,it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';
describe('Hosted restore fixture execution boundary',()=>{
 it('refuses both mutation phases without an explicit run flag before reading private state',()=>{
  for(const phase of ['prepare','after-snapshot']){
   const result=spawnSync(process.execPath,['--import','tsx','scripts/hosted-restore-fixtures.ts',phase],{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH}});
   expect(result.status).toBe(1);expect(result.stdout).toBe('');expect(JSON.parse(result.stderr)).toEqual({phase,error:'RESTORE_FIXTURE_EXPLICIT_RUN_REQUIRED'});
  }
 });
});
