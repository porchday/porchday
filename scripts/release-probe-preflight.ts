import postgres from 'postgres';
import {validateProbeConfig,type ProbeConfig} from './external-monitor-probe.ts';
import {validateReleaseDatabaseTarget} from './release-schema.ts';
import type {DeploymentPorts} from './deployment-recovery.ts';

/** Read only: no login, session creation, password/hash retrieval or member output.
 * This catches stale fixture configuration; it cannot guarantee future existence
 * or password validity. The normal post-activation journey remains required.
 */
export async function verifyReleaseProbeFixture(options:{connection:string;branchId:string;config:ProbeConfig;signal:AbortSignal}):Promise<void>{
 validateReleaseDatabaseTarget(options.connection,options.branchId);validateProbeConfig(options.config);
 const {signal,config}=options;signal.throwIfAborted();
 const db=postgres(options.connection,{max:1,prepare:false,fetch_types:false,ssl:'verify-full',connect_timeout:5,onnotice:()=>{}});
 const cancel=()=>{void db.end({timeout:0}).catch(()=>{});};signal.addEventListener('abort',cancel,{once:true});
 try{
  const result=await db.begin('isolation level repeatable read read only',async tx=>{
   await tx`set local statement_timeout='5s'`;
   await tx`set local lock_timeout='1s'`;
   await tx`set local transaction_timeout='8s'`;
   return await tx`select exists (
    select 1 from public.auth_user u
    where u.id=${config.synthetic.id} and u.email=${config.synthetic.email}
      and u."emailVerified"=true
      and app.auth_member_status(u.id::uuid) not in ('hold','deleted','deleting','suspended')
      and exists (select 1 from public.auth_account a where a."userId"=u.id
        and a."providerId"='credential' and a.password is not null and length(a.password)>0)
   ) as valid`;
  });
  signal.throwIfAborted();
  if(result.length!==1||result[0].valid!==true)throw Error('RELEASE_PROBE_FIXTURE_INVALID');
 }catch(error){
  if(signal.aborted)throw Error('RELEASE_PROBE_PREFLIGHT_CANCELLED');
  if(error instanceof Error&&error.message==='RELEASE_PROBE_FIXTURE_INVALID')throw error;
  throw Error('RELEASE_PROBE_PREFLIGHT_READ_FAILED');
 }finally{signal.removeEventListener('abort',cancel);await db.end({timeout:1}).catch(()=>{});}
}

/** Run after the existing authorization and before the controller records an
 * activation intent. Never block rollback or replay a dispatched activation.
 */
export function withReleaseProbePreflight(ports:DeploymentPorts,check:(signal:AbortSignal)=>Promise<void>):DeploymentPorts{
 return {...ports,authorize:async(plan,direction,signal)=>{
  await ports.authorize(plan,direction,signal);
  if(direction==='activate'){signal.throwIfAborted();await check(signal);signal.throwIfAborted();}
 }};
}
