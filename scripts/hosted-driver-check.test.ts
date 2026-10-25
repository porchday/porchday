import {describe,it,expect} from 'vitest';
import {spawnSync} from 'node:child_process';

describe('Hosted driver regression execution boundary',()=>{
 it('requires the exact explicit phase invocation before private state or network access',()=>{
  for(const [args,code] of [[[], 'EXPLICIT_RUN_REQUIRED'],[['--run','--account=C'],'DRIVER_CHECK_ARGUMENTS_INVALID']] as const){
   const result=spawnSync(process.execPath,['--import','tsx','scripts/hosted-smoke.ts','driver-check',...args],{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH}});
   expect(result.status).toBe(1);expect(result.stdout).toBe('');
   expect(JSON.parse(result.stderr)).toEqual({phase:'driver-check',passed:false,code});
  }
 });
});
