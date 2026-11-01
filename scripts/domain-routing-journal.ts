/** Append-only private intent records. Partial records fail closed on resume. */
import {constants,openSync,closeSync,fsyncSync,lstatSync,mkdirSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {validateRoutingState,validateRoutingTransition,type RoutingState,type RoutingPlan} from './domain-routing-recovery.ts';
export class FileRoutingJournal{
 private readonly directory:string;
 private readonly plan:RoutingPlan;
 constructor(directory:string,plan:RoutingPlan){
  this.plan=structuredClone(plan);
  this.directory=directory;mkdirSync(directory,{mode:0o700,recursive:true});const stat=lstatSync(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.())throw new Error('DEPLOYMENT_JOURNAL_PERMISSIONS');
 }
 async read():Promise<RoutingState|null>{
  const names=readdirSync(this.directory).sort();let previous:RoutingState|null=null;
  for(const [index,name] of names.entries()){
   if(name!==String(index+1).padStart(5,'0')+'.json')throw new Error('DEPLOYMENT_JOURNAL_SEQUENCE_INVALID');
   const path=join(this.directory,name),stat=lstatSync(path);
   if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid?.()||stat.size>4096)throw new Error('DEPLOYMENT_JOURNAL_PERMISSIONS');
   let value:unknown;try{value=JSON.parse(readFileSync(path,'utf8'));}catch{throw new Error('DEPLOYMENT_JOURNAL_INVALID');}
   validateRoutingState(this.plan,value as RoutingState);validateRoutingTransition(this.plan,previous,value as RoutingState);previous=value as RoutingState;
  }
  return previous;
 }
 async write(expected:RoutingState|null,next:RoutingState):Promise<void>{
  validateRoutingTransition(this.plan,expected,next);
  if(JSON.stringify(await this.read())!==JSON.stringify(expected))throw new Error('DEPLOYMENT_JOURNAL_CONFLICT');
  const path=join(this.directory,String(next.revision).padStart(5,'0')+'.json');let fd:number;
  try{fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
  catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('DEPLOYMENT_JOURNAL_CONFLICT');throw new Error('DEPLOYMENT_JOURNAL_WRITE_FAILED');}
  try{writeFileSync(fd,JSON.stringify(next)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  const directoryFd=openSync(this.directory,constants.O_RDONLY);try{fsyncSync(directoryFd);}finally{closeSync(directoryFd);}
 }
}
