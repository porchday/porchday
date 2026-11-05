import {constants,openSync,closeSync,lstatSync,realpathSync} from 'node:fs';import {join,isAbsolute} from 'node:path';
import {DatabaseSync} from 'node:sqlite';import {setTimeout as sleep} from 'node:timers/promises';
import {pollReleaseWatches,type WatchDeliveryState} from './release-watch-delivery.ts';
function privateDatabase(path:string){try{closeSync(openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600));}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0)throw Error('WATCH_DATABASE_INVALID');return new DatabaseSync(path);}
let guard:DatabaseSync|undefined,db:DatabaseSync|undefined;
try{
 const [root,mode,...extra]=process.argv.slice(2);if(!root||extra.length||!['--once','--continuous'].includes(mode)||!isAbsolute(root)||realpathSync(root)!==root)throw Error('WATCH_ARGUMENTS');
 const stat=lstatSync(root);if(!stat.isDirectory()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0)throw Error('WATCH_ROOT_INVALID');
 guard=privateDatabase(join(root,'release-watch-lock.sqlite'));guard.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
 db=privateDatabase(join(root,'release-watch-delivery.sqlite'));db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS delivery (operation TEXT PRIMARY KEY, value TEXT NOT NULL)');
 const database=db,store={read:(id:string)=>{const row=database.prepare('SELECT value FROM delivery WHERE operation=?').get(id) as {value:string}|undefined;return row?JSON.parse(row.value) as WatchDeliveryState:null;},write:(id:string,value:WatchDeliveryState)=>{database.prepare('INSERT INTO delivery(operation,value) VALUES (?,?) ON CONFLICT(operation) DO UPDATE SET value=excluded.value').run(id,JSON.stringify(value));}};
 let stopping=false;process.on('SIGTERM',()=>{stopping=true});process.on('SIGINT',()=>{stopping=true});
 do{const result=await pollReleaseWatches(root,store);console.log(JSON.stringify({at:new Date().toISOString(),...result}));if(mode==='--once'){if(result.errors||result.pending)process.exitCode=2;break;}if(!stopping)await sleep(20000);}while(!stopping);
}catch{console.error('RELEASE_WATCH_STOPPED');process.exitCode=1;}finally{db?.close();guard?.close();}
