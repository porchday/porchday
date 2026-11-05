import {constants,openSync,closeSync,fstatSync,readFileSync,realpathSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {deliverReleaseAlert,validateReleaseAlert} from './release-alerts.ts';
// Explicit retry of notification only. Never invokes a release, journey, lease or recovery write.
try{
 const [path,...extra]=process.argv.slice(2);if(!path||extra.length||!isAbsolute(path)||realpathSync(path)!==path)throw Error('RELEASE_ALERT_PATH_INVALID');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);let event:unknown;
 try{const stat=fstatSync(fd);if(!stat.isFile()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size>4096)throw Error('RELEASE_ALERT_FILE_INVALID');event=JSON.parse(readFileSync(fd,'utf8'));}finally{closeSync(fd);}
 validateReleaseAlert(event);const status=await deliverReleaseAlert(event);console.log('RELEASE_OWNER_NOTIFICATION_'+status.toUpperCase());if(status!=='delivered')process.exitCode=2;
}catch{console.error('RELEASE_OWNER_NOTIFICATION_UNCONFIRMED');process.exitCode=1;}
