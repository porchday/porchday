import {constants} from 'node:fs';
import {dirname,resolve,sep} from 'node:path';
import {lstat,mkdir,open,rename,unlink,link} from 'node:fs/promises';
const root=resolve('artifacts/private/restore-ops');
async function protectedPath(path:string){
 path=resolve(path);if(!path.startsWith(root+sep))throw Error('RESTORE_PRIVATE_PATH_REQUIRED');
 const dirs:string[]=[];let directory=dirname(path),workspace=resolve('.');
 while(directory!==workspace){if(!directory.startsWith(workspace+sep))throw Error('RESTORE_PRIVATE_PATH_REQUIRED');dirs.unshift(directory);directory=dirname(directory);}
 for(const directory of dirs){
  try{await mkdir(directory,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||(directory===root||directory.startsWith(root+sep))&&(info.mode&0o077)!==0)throw Error('RESTORE_PRIVATE_DIRECTORY_REQUIRED');
 }
 return path;
}
export async function readRestorePrivate<T>(path:string):Promise<T>{
 path=await protectedPath(path);const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const info=await handle.stat();if(!info.isFile()||(info.mode&0o077)!==0||info.size>1_000_000)throw Error('RESTORE_PRIVATE_FILE_REQUIRED');return JSON.parse(await handle.readFile('utf8')) as T;}finally{await handle.close();}
}
export async function writeRestorePrivate(path:string,value:unknown,exclusive=false){
 path=await protectedPath(path);
 try{const existing=await lstat(path);if(!existing.isFile()||existing.isSymbolicLink()||(existing.mode&0o077)!==0)throw Error('RESTORE_PRIVATE_FILE_REQUIRED');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const temporary=path+'.'+crypto.randomUUID()+'.next',handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}
 try{
  if(exclusive)await link(temporary,path);else await rename(temporary,path);
  const directory=await open(dirname(path),constants.O_RDONLY|constants.O_NOFOLLOW);try{await directory.sync();}finally{await directory.close();}
 }finally{await unlink(temporary).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});}
}
