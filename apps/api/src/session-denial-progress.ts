import {z} from 'zod';
import type {JournalStore} from './privacy-journal';
import type {Env} from './types';

// Separate from the deployed v1 cursor: old binaries can safely resume their
// own idempotent scan on rollback. Neither cursor is authorization authority.
export const denialProgressKey='session-denial-maintenance/v2/progress.json';
const integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const pass=z.object({completedAt:integer,durationMs:integer,seen:integer,invalid:integer}).strict();
const schema=z.object({v:z.literal(2),cursor:z.string().min(1).max(8192).nullable(),pageCompletedAt:integer,
 passStartedAt:integer.nullable(),passSeen:integer,passInvalid:integer,lastPass:pass.nullable(),
}).strict();
export type DenialProgress=z.infer<typeof schema>;
export function parseDenialProgress(text:string):DenialProgress{
 if(text.length>16384)throw Error('SESSION_DENIAL_PROGRESS_INVALID');
 const value=schema.parse(JSON.parse(text));
 if(value.passInvalid>value.passSeen||value.lastPass&&(value.lastPass.invalid>value.lastPass.seen||value.lastPass.completedAt>value.pageCompletedAt||value.lastPass.durationMs>value.lastPass.completedAt)||
  (value.cursor===null?value.passStartedAt!==null||value.passSeen!==0||value.passInvalid!==0||!value.lastPass||value.lastPass.completedAt!==value.pageCompletedAt:
   value.passStartedAt===null||value.passStartedAt>value.pageCompletedAt||!!value.lastPass&&value.lastPass.completedAt>value.passStartedAt))throw Error('SESSION_DENIAL_PROGRESS_INVALID');
 return value;
}

export function denialProgressHealth(progress:DenialProgress,now=Date.now()){
 // Future timestamps are unknown evidence, not fresh progress.
 if(progress.pageCompletedAt>now)throw Error('SESSION_DENIAL_PROGRESS_INVALID');
 const pageAge=now-progress.pageCompletedAt,passAge=progress.lastPass?now-progress.lastPass.completedAt:null;
 const issues:string[]=[];
 if(pageAge>180000)issues.push('session_denial_cleanup_stale');
 if(passAge===null||passAge>300000)issues.push('session_denial_pass_stale');
 if((progress.lastPass?.durationMs??0)>300000||progress.passStartedAt!==null&&now-progress.passStartedAt>300000)issues.push('session_denial_pass_slow');
 if(progress.passInvalid>0||(progress.lastPass?.invalid??0)>0)issues.push('session_denial_cleanup_invalid');
 return {issues,snapshot:{page_age_seconds:Math.floor(pageAge/1000),pass_age_seconds:passAge===null?null:Math.floor(passAge/1000),
  last_pass_duration_seconds:progress.lastPass?Math.ceil(progress.lastPass.durationMs/1000):null,last_pass_seen:progress.lastPass?.seen??null,
  current_pass_seen:progress.passSeen,invalid_records:progress.passInvalid+(progress.lastPass?.invalid??0)}};
}

/** Read-only bounded monitoring; no cursor or session identifier is returned. */
export async function readDenialCleanupHealth(env:Pick<Env,'SESSION_DENIAL_CLEANUP_V1'|'RECOVERY_JOURNAL'>){
 if(env.SESSION_DENIAL_CLEANUP_V1!=='true')return {issues:[] as string[],snapshot:null};
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  if(!env.RECOVERY_JOURNAL)throw Error('SESSION_DENIAL_PROGRESS_UNAVAILABLE');
  const store=env.RECOVERY_JOURNAL as JournalStore;
  const progress=await Promise.race([
   (async()=>{const object=await store.get(denialProgressKey);return object?parseDenialProgress(await object.text()):null;})(),
   new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('SESSION_DENIAL_PROGRESS_UNAVAILABLE')),2000);}),
  ]);
  return progress?denialProgressHealth(progress):{issues:['session_denial_cleanup_missing'],snapshot:null};
 }catch{return {issues:['session_denial_cleanup_unavailable'],snapshot:null};}
 finally{if(timer!==undefined)clearTimeout(timer);}
}
