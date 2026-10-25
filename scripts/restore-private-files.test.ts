import {describe,it,expect} from 'vitest';
import {chmod,mkdir,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {readRestorePrivate,writeRestorePrivate} from './restore-private-files.js';
describe('Private restore operator tickets',()=>{
 it('creates and atomically updates restricted files, preserving exclusive retries',async()=>{
  const dir='artifacts/private/restore-ops/test-'+crypto.randomUUID(),file=dir+'/ticket.json';
  try{
   await writeRestorePrivate(file,{v:1},true);expect((await stat(file)).mode&0o777).toBe(0o600);expect((await stat(dir)).mode&0o777).toBe(0o700);
   await expect(writeRestorePrivate(file,{v:2},true)).rejects.toMatchObject({code:'EEXIST'});expect(await readRestorePrivate(file)).toEqual({v:1});
   await writeRestorePrivate(file,{v:2});expect(await readRestorePrivate(file)).toEqual({v:2});
   await chmod(file,0o644);await expect(readRestorePrivate(file)).rejects.toThrow('RESTORE_PRIVATE_FILE_REQUIRED');
  }finally{await rm(dir,{recursive:true,force:true});}
 });
 it('refuses escaping the boundary and symlinked files/directories',async()=>{
  const dir='artifacts/private/restore-ops/test-'+crypto.randomUUID();await mkdir(dir,{mode:0o700});
  try{
   await expect(writeRestorePrivate('artifacts/private/outside.json',{})).rejects.toThrow('RESTORE_PRIVATE_PATH_REQUIRED');
   await writeFile(dir+'/real.json','{}',{mode:0o600});await symlink('real.json',dir+'/alias.json');
   await expect(readRestorePrivate(dir+'/alias.json')).rejects.toBeDefined();await expect(writeRestorePrivate(dir+'/alias.json',{})).rejects.toThrow('RESTORE_PRIVATE_FILE_REQUIRED');
   await symlink('.',dir+'/linked');await expect(writeRestorePrivate(dir+'/linked/no.json',{})).rejects.toThrow('RESTORE_PRIVATE_DIRECTORY_REQUIRED');
  }finally{await rm(dir,{recursive:true,force:true});}
 });
});
