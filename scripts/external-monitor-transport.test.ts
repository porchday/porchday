import {afterEach,expect,it} from 'vitest';
import {createServer as netServer} from 'node:net';
import {createServer as tlsServer} from 'node:https';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Agent,buildConnector,fetch} from 'undici';
import {failoverConnector,type ConnectionEvidence} from './external-monitor-transport';

const cleanups:(()=>Promise<unknown>|void)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.reverse())await cleanup();cleanups.length=0;});
it('fails over a stalled TLS handshake without replaying a POST, and does not retry HTTP errors',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'porchday-tls-'));cleanups.push(()=>rmSync(dir,{recursive:true,force:true}));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
 const cert=readFileSync(join(dir,'cert.pem'));let requests=0;
 const server=tlsServer({key:readFileSync(join(dir,'key.pem')),cert},(req,res)=>{requests++;req.resume();res.writeHead(503);res.end('unavailable');});
 await new Promise<void>((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;
 const sockets=new Set<import('node:net').Socket>();
 const blackhole=netServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 await new Promise<void>((resolve,reject)=>blackhole.once('error',reject).listen(port,'::1',resolve));
 cleanups.push(async()=>{for(const socket of sockets)socket.destroy();await Promise.all([new Promise<void>(resolve=>server.close(()=>resolve())),new Promise<void>(resolve=>blackhole.close(()=>resolve()))]);});
 const evidence:ConnectionEvidence={phase:'dns',attempts:[]};
 const agent=new Agent({connect:failoverConnector(evidence,undefined,{resolve:async()=>[{address:'::1',family:6},{address:'127.0.0.1',family:4}],connect:buildConnector({ca:cert,timeout:100})})});cleanups.push(()=>agent.destroy());
 const response=await fetch(`https://localhost:${port}/logout`,{method:'POST',body:'once',dispatcher:agent});
 expect(response.status).toBe(503);await response.text();expect(requests).toBe(1);
 expect(evidence.attempts).toHaveLength(2);expect(evidence.attempts[0].error).toBe('UND_ERR_CONNECT_TIMEOUT');expect(evidence.phase).toBe('ready');
 expect(JSON.stringify(evidence)).not.toContain('127.0.0');
});
it('never fails over certificate errors',async()=>{
 let attempts=0;const evidence:ConnectionEvidence={phase:'dns',attempts:[]};
 const connector=failoverConnector(evidence,undefined,{resolve:async()=>[{address:'127.0.0.1',family:4},{address:'127.0.0.2',family:4}],connect:(_params,callback)=>{attempts++;callback(Object.assign(Error('certificate'),{code:'CERT_HAS_EXPIRED'}),null);}});
 const error=await new Promise<Error|null>(resolve=>connector({hostname:'localhost',host:'localhost',protocol:'https:',port:'443'},error=>resolve(error)));
 expect(error?.message).toBe('certificate');expect(attempts).toBe(1);
});
it('aborting while DNS resolves cannot dispatch a later connection',async()=>{
 let resolve!:(a:{address:string;family:number}[])=>void,attempts=0;const controller=new AbortController();
 const connector=failoverConnector({phase:'dns',attempts:[]},controller.signal,{resolve:()=>new Promise(r=>resolve=r),connect:()=>{attempts++;}});
 const result=new Promise<Error|null>(done=>connector({hostname:'localhost',host:'localhost',protocol:'https:',port:'443'},error=>done(error)));
 controller.abort();resolve([{address:'127.0.0.1',family:4}]);expect((await result)?.message).toBe('MONITOR_CONNECTION_ABORTED');await Promise.resolve();expect(attempts).toBe(0);
});
