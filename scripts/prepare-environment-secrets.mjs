#!/usr/bin/env node
/** Generate environment-isolated server secrets without displaying their values. */
import {readFileSync,writeFileSync,renameSync,chmodSync,statSync,unlinkSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import webPush from 'web-push';

const path=join(homedir(),'.config','inner-circle','secrets.env');
const before=statSync(path),existing=readFileSync(path,'utf8');
const keys=new Set(existing.split(/\r?\n/).map(line=>line.trim().replace(/^export\s+/,'').split('=',1)[0]));
const additions=[];
for(const environment of ['STAGING','PRODUCTION']){
 const prefix='PORCHDAY_'+environment+'_';
 if(!keys.has(prefix+'BETTER_AUTH_SECRET'))additions.push(prefix+'BETTER_AUTH_SECRET='+randomBytes(48).toString('base64url'));
 if(!keys.has(prefix+'OPERATIONS_HEALTH_TOKEN'))additions.push(prefix+'OPERATIONS_HEALTH_TOKEN='+randomBytes(32).toString('base64url'));
 const publicPresent=keys.has(prefix+'VAPID_PUBLIC_KEY'),privatePresent=keys.has(prefix+'VAPID_PRIVATE_KEY');
 if(publicPresent!==privatePresent)throw new Error('Incomplete VAPID pair; restore the existing pair rather than rotating it silently.');
 if(!publicPresent){
  const pair=webPush.generateVAPIDKeys();
  additions.push(prefix+'VAPID_PUBLIC_KEY='+pair.publicKey,prefix+'VAPID_PRIVATE_KEY='+pair.privateKey);
 }
}
if(additions.length){
 const temporary=path+'.'+process.pid+'.tmp';
 try{
  writeFileSync(temporary,existing.replace(/\s*$/,'')+'\n\n# Generated Porchday environment secrets. Never commit or print.\n'+additions.join('\n')+'\n',{mode:0o600,flag:'wx'});
  const current=statSync(path);
  if(current.mtimeMs!==before.mtimeMs||current.size!==before.size)throw new Error('Secrets file changed; retry without overwriting those edits.');
  renameSync(temporary,path);
 }finally{try{unlinkSync(temporary);}catch{}}
}
chmodSync(path,0o600);
console.log(additions.length?'Created isolated staging/production auth and push secrets in the private configuration file.':'Environment secrets already exist; none were rotated.');
