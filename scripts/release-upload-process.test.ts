import {describe,it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {runReleaseProcess,createWranglerUploadProcess} from './release-upload-process.ts';
import type {ReleaseWranglerReceipt} from './release-wrangler.ts';
const base={cwd:process.cwd(),env:{PATH:process.env.PATH},signal:new AbortController().signal};
describe('bounded upload subprocess',()=>{
 it('rejects config drift, wrong targets and build hooks before starting Wrangler',async()=>{
  const root=mkdtempSync(join(tmpdir(),'porchday-config-')),configPath=join(root,'config.json'),accountId='a'.repeat(32);
  const config={name:'porchday-staging',account_id:accountId,no_bundle:true,workers_dev:false,preview_urls:false};
  try{
   const factory=(value:unknown)=>{
    const bytes=JSON.stringify(value);writeFileSync(configPath,bytes,{mode:0o600});
    return createWranglerUploadProcess({workspace:process.cwd(),receipt:{} as ReleaseWranglerReceipt,configPath,configSha256:createHash('sha256').update(bytes).digest('hex'),worker:'porchday-staging',accountId,apiToken:'synthetic-test-token',privateLogDirectory:root});
   };
   for(const patch of [{name:'porchday-production'},{account_id:'b'.repeat(32)},{no_bundle:false},{build:{command:'unreviewed'}},{env:{}},{containers:[]},{exports:{}},{workers_dev:true},{preview_urls:true}])await expect(factory({...config,...patch})('11111111-1111-1111-1111-111111111111',base.signal)).rejects.toThrow('UPLOAD_PROCESS_CONFIG_UNREVIEWED');
   const send=factory(config);writeFileSync(configPath,'changed');await expect(send('11111111-1111-1111-1111-111111111111',base.signal)).rejects.toThrow('UPLOAD_PROCESS_CONFIG_CHANGED');
  }finally{rmSync(root,{recursive:true,force:true});}
 });
 it('runs without a shell and extracts only an untrusted version hint',async()=>{
  const version='11111111-1111-1111-1111-111111111111';
  expect(await runReleaseProcess({...base,args:['-e',`console.log('Worker Version ID: ${version}');console.error('synthetic private diagnostics');`]})).toEqual({versionHint:version});
  expect(await runReleaseProcess({...base,args:['-e',"console.log('no version')"]})).toEqual({versionHint:null});
 });
 it('returns sanitized failures without subprocess diagnostics',async()=>{
  await expect(runReleaseProcess({...base,args:['-e',"console.error('synthetic secret value');process.exit(2)"]})).rejects.toThrow(/^UPLOAD_PROCESS_OUTCOME_UNKNOWN$/);
 });
 it('stops excessive output and never returns it',async()=>{
  await expect(runReleaseProcess({...base,args:['-e',"process.stdout.write('x'.repeat(2*1024*1024));setInterval(()=>{},1000)"]})).rejects.toThrow('UPLOAD_PROCESS_OUTPUT_LIMIT');
 });
 it('escalates timeout to SIGKILL and waits for termination',async()=>{
  const root=mkdtempSync(join(tmpdir(),'porchday-process-')),pidFile=join(root,'pid');
  try{
   await expect(runReleaseProcess({...base,timeoutMs:300,args:['-e',`require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`]})).rejects.toThrow('UPLOAD_PROCESS_TIMEOUT');
   const pid=Number(readFileSync(pidFile,'utf8'));expect(()=>process.kill(pid,0)).toThrow();
  }finally{rmSync(root,{recursive:true,force:true});}
 });
 it('handles cancellation before spawn and after startup',async()=>{
  const abort=new AbortController();abort.abort();await expect(runReleaseProcess({...base,signal:abort.signal,args:['-e','process.exit(0)']})).rejects.toThrow();
  const running=new AbortController(),timer=setTimeout(()=>running.abort(),150);
  try{await expect(runReleaseProcess({...base,signal:running.signal,args:['-e','setInterval(()=>{},1000)']})).rejects.toThrow('UPLOAD_PROCESS_CANCELLED');}finally{clearTimeout(timer);}
 });
 it('terminates an uploader after its controller is killed',async()=>{
  const root=mkdtempSync(join(tmpdir(),'porchday-orphan-')),ready=join(root,'ready'),exited=join(root,'exited');let controller:ReturnType<typeof spawn>|undefined;
  const waitFor=async(path:string)=>{const until=Date.now()+5000;while(!existsSync(path)){if(Date.now()>until)throw Error('fixture timeout');await new Promise(done=>setTimeout(done,20));}};
  try{
   const program=`require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));process.on('exit',()=>require('fs').writeFileSync(${JSON.stringify(exited)},'exited'));setInterval(()=>{},1000);`;
   const code=`import {runReleaseProcess} from ${JSON.stringify(new URL('./release-upload-process.ts',import.meta.url).href)};await runReleaseProcess({cwd:process.cwd(),env:{},signal:new AbortController().signal,args:['-e',${JSON.stringify(program)}]});`;
   controller=spawn(process.execPath,['--input-type=module','-e',code],{stdio:'ignore'});await waitFor(ready);
   const stopped=once(controller,'exit');controller.kill('SIGKILL');await stopped;await waitFor(exited);expect(readFileSync(exited,'utf8')).toBe('exited');
  }finally{if(controller?.exitCode===null&&controller.signalCode===null)controller.kill('SIGKILL');rmSync(root,{recursive:true,force:true});}
 });
});
