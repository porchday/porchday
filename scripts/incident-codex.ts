import {execFileSync} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {statSync} from 'node:fs';
import WebSocket from 'ws';

/** The daemon control socket uses WebSocket over Unix, not JSONL. Connecting,
 * initializing and reading status perform no model inference. */
export class IncidentCodex {
 private sequence=0;
 private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 private socket:WebSocket;
 private opened:Promise<void>;
 constructor(executable:string){
  let version:any;
  try{version=JSON.parse(execFileSync(executable,['app-server','daemon','version'],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}));}catch{throw Error('INCIDENT_DAEMON_UNAVAILABLE');}
  const path=version.socketPath;
  if(version.status!=='running'||typeof path!=='string'||!isAbsolute(path))throw Error('INCIDENT_DAEMON_UNAVAILABLE');
  const stat=statSync(path);if(!stat.isSocket()||stat.uid!==process.getuid?.())throw Error('INCIDENT_DAEMON_SOCKET_INVALID');
  this.socket=new WebSocket('ws+unix://'+path+':/',{handshakeTimeout:5000,maxPayload:4*1024*1024});
  this.opened=new Promise((resolve,reject)=>{this.socket.once('open',resolve);this.socket.once('error',()=>reject(Error('INCIDENT_CODEX_DISCONNECTED')));});
  this.socket.on('message',data=>{
   let message:any;try{message=JSON.parse(data.toString());}catch{return;}
   if(typeof message.id!=='number'||message.method)return;
   const request=this.pending.get(message.id);if(!request)return;
   this.pending.delete(message.id);clearTimeout(request.timer);
   if(message.error)request.reject(Error('INCIDENT_CODEX_RPC_FAILED'));else request.resolve(message.result);
  });
  const failed=()=>{for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(Error('INCIDENT_CODEX_DISCONNECTED'));}this.pending.clear();};
  this.socket.on('error',failed);this.socket.on('close',failed);
 }
 async initialize(){
  await this.opened;
  await this.call('initialize',{clientInfo:{name:'porchday_incident_dispatch',title:'Porchday incident responder',version:'1.0.0'},capabilities:{experimentalApi:true}});
  this.socket.send(JSON.stringify({method:'initialized',params:{}}));
 }
 call(method:string,params:unknown):Promise<any>{
  const id=++this.sequence;
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('INCIDENT_CODEX_RPC_TIMEOUT'));},15000);
   this.pending.set(id,{resolve,reject,timer});
   this.socket.send(JSON.stringify({id,method,params}),error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(Error('INCIDENT_CODEX_DISCONNECTED'));}});
  });
 }
 close(){this.socket.terminate();}
}
