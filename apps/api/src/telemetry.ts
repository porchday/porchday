/** Allowlist only; never log requests, raw paths, SQL/errors, bodies or identifiers. */
const codes=new Set(['accepted','send_failed','auth_failed','request_failed','cleanup_complete','cleanup_retry','outbox_retry','outbox_delivered','email_outbox_retry','journal_not_initialized','restore_quarantined','database_rollback_detected','journal_not_configured','journal_unavailable']);
const methods=new Set(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']);
const environments=new Set(['development','staging','production']);
export function event(name:'request'|'job'|'email'|'error',fields:{route?:string;method?:string;status?:number;durationMs?:number;code?:string;environment?:string;count?:number}={}){
 const safe:Record<string,string|number>={event:name};
 if(fields.route && normalizedRoute(fields.route)===fields.route)safe.route=fields.route;
 if(fields.method && methods.has(fields.method))safe.method=fields.method;
 if(fields.code && codes.has(fields.code))safe.code=fields.code;
 if(fields.environment && environments.has(fields.environment))safe.environment=fields.environment;
 for(const key of ['status','durationMs','count'] as const){const value=fields[key];if(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1e9)safe[key]=value;}
 try{console.log(JSON.stringify(safe));}catch{/* Telemetry failure must not block member requests or deletion work. */}
}
export function normalizedRoute(path:string):string{
 if(path.startsWith('/api/auth/')){
  const known=['sign-in/email','sign-up/email','sign-out','get-session','verify-email','request-password-reset','reset-password','send-verification-email','change-password','list-sessions','revoke-session','revoke-sessions'];
  return known.some(k=>path==='/api/auth/'+k)?path:'/api/auth/*';
 }
 if(path==='/health')return path;
 return path.startsWith('/api/')?'/api/*':'/assets/*';
}
