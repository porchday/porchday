import {readFileSync,writeFileSync,openSync,fsyncSync,closeSync,renameSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import type {JournalStore} from '../../src/privacy-journal';

/** Disposable single-writer process-loss fixture, not a hosted R2 emulator.
 * Parent accesses it only before spawn or after confirmed child termination.
 */
export class ProcessJournalStore implements JournalStore{
 afterPut:((key:string,value:string)=>Promise<void>)|undefined;
 constructor(readonly directory:string){}
 private path(key:string){return join(this.directory,createHash('sha256').update(key).digest('hex')+'.json');}
 async get(key:string){
  let row:{key:string;text:string;etag:string};
  try{row=JSON.parse(readFileSync(this.path(key),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
  if(row.key!==key)throw Error('FIXTURE_KEY_MISMATCH');return{etag:row.etag,text:async()=>row.text};
 }
 async put(key:string,text:string,options?:{onlyIf?:{etagMatches?:string;etagDoesNotMatch?:string}}){
  const old=await this.get(key),condition=options?.onlyIf;
  if(condition?.etagDoesNotMatch==='*'&&old||condition?.etagMatches&&condition.etagMatches!==old?.etag)return null;
  const etag=randomUUID(),path=this.path(key),temporary=path+'.'+randomUUID();
  const fd=openSync(temporary,'wx',0o600);try{writeFileSync(fd,JSON.stringify({key,text,etag}));fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temporary,path);const directory=openSync(this.directory,'r');try{fsyncSync(directory);}finally{closeSync(directory);}
  await this.afterPut?.(key,text);return{etag};
 }
}
