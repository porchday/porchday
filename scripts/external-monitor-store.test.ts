import {chmodSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {atomicJson,privateDirectory,privateFile,readState,persistState,record} from './external-monitor-store';
import {initialState} from './external-monitor-alerts';
const directories:string[]=[];
function directory(){const path=mkdtempSync(join(tmpdir(),'porchday-monitor-test-'));directories.push(path);return path;}
afterEach(()=>{for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true});});
describe('monitor persistence',()=>{
 it('persists undelivered events privately across restarts',()=>{
  const path=directory();privateDirectory(path);expect(readState(path)).toEqual(initialState());
  const state={...initialState(),incident:true,pending:[{id:'event',kind:'outage' as const,at:'2026-10-28T21:00:00Z',failedChecks:['login']}],lastRelayAttempt:{id:'event',at:'2026-10-28T21:00:01Z'}};
  persistState(path,state);expect(readState(path)).toEqual(state);
  expect(JSON.parse(privateFile(join(path,'state.json')))).toEqual(state);
 });
 it('refuses shared-readable configuration, symlinks and corrupt state',()=>{
  const path=directory(),file=join(path,'config.json');writeFileSync(file,'{}',{mode:0o644});
  expect(()=>privateFile(file)).toThrow('MONITOR_FILE_PERMISSIONS');chmodSync(file,0o600);
  symlinkSync(file,join(path,'link'));expect(()=>privateFile(join(path,'link'))).toThrow('MONITOR_FILE_PERMISSIONS');
  atomicJson(join(path,'state.json'),{...initialState(),pending:[{id:'event',kind:'outage',at:'2026-10-28T21:00:00Z',failedChecks:['private content']}]});
  expect(()=>readState(path)).toThrow();
  atomicJson(join(path,'state.json'),{...initialState(),lastRelayAttempt:null});expect(()=>readState(path)).toThrow('MONITOR_STATE_INVALID');
 });
 it('keeps failures and timestamp gaps in append-only history',()=>{
  const path=directory();
  const base={v:1 as const,environment:'production' as const,healthy:false,checks:[{name:'login',ok:false}],durationMs:12,scope:'login_authorized_reads_logout_and_readiness' as const};
  record(path,{...base,at:'2026-10-28T21:00:00.000Z'});
  record(path,{...base,at:'2026-10-28T22:00:00.000Z',healthy:true,checks:[{name:'login',ok:true}]});
  const rows=readFileSync(join(path,'observations-2026-10.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  expect(rows).toHaveLength(2);expect(rows[0].healthy).toBe(false);expect(Date.parse(rows[1].at)-Date.parse(rows[0].at)).toBe(3600000);
 });
});
