import type {JournalStore} from './privacy-journal';
import type {Env} from './types';

/** Independent immutable records, checked by member and appeal authorization.
 * Writers must not be enabled before every session consumer enforces denials.
 * Session IDs are internal UUIDs, never bearer tokens or signed cookies.
 */
const sessionIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class SessionDenialError extends Error {
 constructor(readonly code:'SESSION_DENIAL_NOT_CONFIGURED'|'SESSION_DENIAL_ID_INVALID'|'SESSION_DENIAL_READ_FAILED'|'SESSION_DENIAL_INVALID'|'SESSION_DENIAL_UNCONFIRMED'){super(code);}
}
async function recordFor(sessionId:string){
 if(typeof sessionId!=='string'||!sessionIdPattern.test(sessionId))throw new SessionDenialError('SESSION_DENIAL_ID_INVALID');
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('porchday-session-denial-v1\0'+sessionId));
 const digest=[...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('');
 return {key:`session-denials/v1/${digest}.json`,text:JSON.stringify({v:1,kind:'session-denial',sessionId})};
}
async function readExact(store:JournalStore,record:{key:string;text:string}){
 let object:Awaited<ReturnType<JournalStore['get']>>,text:string;
 try{object=await store.get(record.key);if(!object)return false;text=await object.text();}
 catch{throw new SessionDenialError('SESSION_DENIAL_READ_FAILED');}
 // Canonical immutable bytes include the session ID and format. A conflicting
 // entry is an integrity failure, never permission to authenticate or overwrite.
 if(text!==record.text)throw new SessionDenialError('SESSION_DENIAL_INVALID');
 return true;
}
export async function sessionDenied(store:JournalStore,verifiedSessionId:string):Promise<boolean>{
 return readExact(store,await recordFor(verifiedSessionId));
}
/** One conditional write. A lost acknowledgement is reconciled by reading the
 * exact immutable record. No mutation retry, SQL, queue or global-control write.
 * An unconfirmed result must not authorize success or SQL cleanup. A denial that
 * persisted despite that error remains effective for all future guarded reads.
 */
export async function persistSessionDenial(store:JournalStore,verifiedSessionId:string):Promise<void>{
 const record=await recordFor(verifiedSessionId);
 let acknowledged=false;
 try{acknowledged=!!await store.put(record.key,record.text,{onlyIf:{etagDoesNotMatch:'*'}});}
 catch{/* Unknown write outcome: reconcile once without exposing provider errors. */}
 if(acknowledged)return;
 if(await readExact(store,record))return;
 throw new SessionDenialError('SESSION_DENIAL_UNCONFIRMED');
}

/** Check only an ID obtained from verified server-side session lookup. Hosted
 * readers have no bypass flag: disabling future writers must not undo denials.
 * Match the existing journal's explicit unbound local-development exception.
 */
export async function runtimeSessionDenied(env:Pick<Env,'RECOVERY_JOURNAL'|'ENVIRONMENT'>,verifiedSessionId:string):Promise<boolean>{
 if(!env.RECOVERY_JOURNAL){
  if(env.ENVIRONMENT==='development')return false;
  throw new SessionDenialError('SESSION_DENIAL_NOT_CONFIGURED');
 }
 return sessionDenied(env.RECOVERY_JOURNAL as JournalStore,verifiedSessionId);
}
