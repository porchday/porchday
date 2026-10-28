import {appendFileSync,closeSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {alertBody,initialState,type AlertState} from './external-monitor-alerts';
import type {Observation} from './external-monitor-probe';

export function privateFile(path:string):string {
 const stat=lstatSync(path);
 if(!stat.isFile() || stat.isSymbolicLink() || (stat.mode&0o077)!==0 || stat.uid!==process.getuid?.())throw Error('MONITOR_FILE_PERMISSIONS');
 return readFileSync(path,'utf8');
}
export function privateDirectory(path:string):void {
 mkdirSync(path,{recursive:true,mode:0o700});const stat=lstatSync(path);
 if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.())throw Error('MONITOR_DIRECTORY_PERMISSIONS');
}
export function atomicJson(path:string,value:unknown):void {
 const temporary=path+'.'+randomUUID()+'.tmp',fd=openSync(temporary,'wx',0o600);
 try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
 renameSync(temporary,path);
}
export function readState(directory:string):AlertState {
 let state:AlertState;
 try{state=JSON.parse(privateFile(join(directory,'state.json')));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return initialState();throw Error('MONITOR_STATE_INVALID');}
 if(state.v!==1||typeof state.incident!=='boolean'||![0,1,2].includes(state.healthyStreak)
  ||(state.lastAt!==null&&!Number.isFinite(Date.parse(state.lastAt)))||!Array.isArray(state.pending))throw Error('MONITOR_STATE_INVALID');
 for(const event of state.pending)alertBody(event,'operator-mac');
 return state;
}
export function persistState(directory:string,state:AlertState):void {atomicJson(join(directory,'state.json'),state);}
export function record(directory:string,observation:Observation):void {
 const month=observation.at.slice(0,7);if(!/^\d{4}-\d{2}$/.test(month))throw Error('MONITOR_DATE_INVALID');
 // Append-only observations preserve failures. Gaps remain explicit in timestamp
 // spacing and must be reported as unknown by any availability calculation.
 appendFileSync(join(directory,`observations-${month}.jsonl`),JSON.stringify(observation)+'\n',{mode:0o600});
}
