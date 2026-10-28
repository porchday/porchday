import type {BetterAuthPlugin} from 'better-auth';
import {createAuthMiddleware,APIError} from 'better-auth/api';
import {runtimeSessionDenied} from './session-denial';
import type {Env} from './types';

/** Apply at SDK dispatch, so internal endpoint session lookups enforce the same
 * denial as direct api.getSession. Cookie verification and SQL ownership lookup
 * remain Better Auth's responsibility. Missing/denied sessions retain the SDK's
 * ordinary anonymous behavior, including fresh credential and token sign-in.
 * Cookie caching must stay disabled. No successful lookup is cached here.
 */
export function sessionDenialAuth(env:Pick<Env,'RECOVERY_JOURNAL'|'ENVIRONMENT'>):BetterAuthPlugin{
 return {id:'porchday-session-denial',hooks:{before:[{
  matcher:()=>true,
  handler:createAuthMiddleware(async ctx=>{
   const adapter=ctx.context.internalAdapter;
   // Dispatch creates a request-local context before running these hooks. Never
   // mutate the shared adapter or install this during init (the SDK rebuilds it).
   ctx.context.internalAdapter={...adapter,findSession:async(...args)=>{
    const found=await adapter.findSession(...args);
    if(!found)return found;
    try{return await runtimeSessionDenied(env,found.session.id)?null:found;}
    catch{throw new APIError('SERVICE_UNAVAILABLE',{code:'SESSION_CHECK_UNAVAILABLE',message:'Please try again shortly.'});}
   }};
  }),
 }]}};
}
