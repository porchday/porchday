import {it,expect} from 'vitest';
import {buildSync} from 'esbuild';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {alertBody} from './external-monitor-alerts.ts';

it('runs the bundled one-shot CLI, persists before dispatch, and reconciles after restart without network access',()=>{
 const directory=mkdtempSync(join(tmpdir(),'porchday-cli-')),id='00000000-0000-0000-0000-000000000001';
 try{
  buildSync({entryPoints:[fileURLToPath(new URL('./external-monitor.ts',import.meta.url))],outfile:join(directory,'monitor.mjs'),bundle:true,platform:'node',format:'esm',target:'node24',logLevel:'silent'});
  writeFileSync(join(directory,'config.json'),JSON.stringify({environment:'production',healthToken:'fixture-health-token-'.repeat(3),synthetic:{id,email:id+'@example.test',password:'fixture-password-'.repeat(3)},issue:52}),{mode:0o600});
  writeFileSync(join(directory,'fetch.mjs'),`let revoked=false;globalThis.fetch=async(url,init={})=>{const u=new URL(url);if(!['porchday.org','porchday.com','status.porchday.com'].includes(u.hostname))throw Error('NETWORK_FORBIDDEN');let body=null,status=200,headers={'content-type':'application/json','cache-control':'no-store'};if(u.pathname==='/status')body={last_checked_at:new Date().toISOString()};else if(u.pathname.includes('operations')){status=process.env.TEST_MONITOR_FAIL==='1'?503:200;body={status:status===200?'ok':'degraded',issues:status===200?[]:['fixture']};}else if(u.pathname.endsWith('/sign-in/email')){body={user:{id:${JSON.stringify(id)}}};headers['set-cookie']='__Secure-fixture.session_token=fixture; Secure; Path=/';}else if(u.pathname.startsWith('/api/v1/me')){status=revoked?401:200;body=revoked?{}:{id:${JSON.stringify(id)}};}else if(u.pathname.startsWith('/api/v1/feed'))body={items:[]};else if(u.pathname.endsWith('/sign-out')){revoked=true;body={};}else if(!u.pathname.endsWith('/get-session'))throw Error('UNEXPECTED_ROUTE');return new Response(JSON.stringify(body),{status,headers});};`,{mode:0o600});
  const gh=join(directory,'gh');writeFileSync(gh,`#!${process.execPath}\nconst fs=require('fs'),p=require('path'),d=process.env.TEST_MONITOR_DIRECTORY,args=process.argv.slice(2),method=args[args.indexOf('--method')+1],route=args[args.indexOf('--method')+2];if(method==='POST'){let raw='';process.stdin.on('data',x=>raw+=x);process.stdin.on('end',()=>{const body=JSON.parse(raw),event=JSON.parse(body.inputs.payload).event,state=JSON.parse(fs.readFileSync(p.join(d,'state','state.json')));if(state.lastRelayAttempt?.id!==event.id)process.exit(7);fs.appendFileSync(p.join(d,'posts'),event.id+'\\n');console.log('null');});}else console.log(route.includes('/comments?')?(fs.existsSync(p.join(d,'comments.json'))?fs.readFileSync(p.join(d,'comments.json'),'utf8'):'[]'):JSON.stringify({title:'External production availability alerts (operator-mac)'}));`,{mode:0o700});
  const run=(failed:boolean)=>spawnSync(process.execPath,['--import',join(directory,'fetch.mjs'),join(directory,'monitor.mjs'),join(directory,'config.json'),join(directory,'state'),'--once'],{timeout:15000,encoding:'utf8',env:{PATH:process.env.PATH,HOME:directory,PORCHDAY_MONITOR_GH_PATH:gh,TEST_MONITOR_DIRECTORY:directory,TEST_MONITOR_FAIL:failed?'1':'0'}});
  const first=run(true);expect(first.status,first.stderr).toBe(1);const state=JSON.parse(readFileSync(join(directory,'state/state.json'),'utf8'));expect(state.pending).toHaveLength(1);expect(readFileSync(join(directory,'posts'),'utf8').trim().split('\n')).toEqual([state.pending[0].id]);
  const second=run(true);expect(second.status,second.stderr).toBe(1);expect(readFileSync(join(directory,'posts'),'utf8').trim().split('\n')).toHaveLength(1);
  writeFileSync(join(directory,'comments.json'),JSON.stringify([{body:alertBody(state.pending[0],'operator-mac'),user:{login:'github-actions[bot]',type:'Bot'}}]),{mode:0o600});
  const third=run(false);expect(third.status,third.stderr).toBe(1);expect(JSON.parse(readFileSync(join(directory,'state/state.json'),'utf8')).pending).toEqual([]);
  const fourth=run(false);expect(fourth.status,fourth.stderr).toBe(1);expect(readFileSync(join(directory,'posts'),'utf8').trim().split('\n')).toHaveLength(2);expect(JSON.parse(readFileSync(join(directory,'state/state.json'),'utf8')).pending[0].kind).toBe('recovery');
 }finally{rmSync(directory,{recursive:true,force:true});}
});
