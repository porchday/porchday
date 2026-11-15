import React,{useEffect,useRef,useState} from 'react';
import {ApiError,auth} from './api';
import {ActionFeedback,Button,Field,useAction} from './ui';

/** Only the failed recovery action is resumed; credentials stay in component memory. */
export function useRecoveryAction(memberId:string){
 const action=useAction(),[pending,setPending]=useState<{id:string;work:()=>Promise<unknown>;notice?:string}|null>(null);
 const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const run=(id:string,work:()=>Promise<unknown>,notice?:string)=>{
  setPending(null);return action.run(async()=>{try{return await work();}catch(error){if(error instanceof ApiError&&error.code==='RECENT_AUTH_REQUIRED'){setPending({id,work,notice});throw Error('');}throw error;}},notice);
 };
 const confirmation=(id:string)=>pending?.id===id?<RecoveryConfirmation memberId={memberId} onCancel={()=>setPending(null)} onConfirmed={()=>{if(mounted.current)void run(pending.id,pending.work,pending.notice);}}/>:null;
 return {...action,runRecovery:run,confirmation,confirming:!!pending};
}
function RecoveryConfirmation({memberId,onCancel,onConfirmed}:{memberId:string;onCancel:()=>void;onConfirmed:()=>void}){
 const [password,setPassword]=useState(''),[code,setCode]=useState(''),[factor,setFactor]=useState(false),action=useAction(),element=useRef<HTMLDivElement>(null),active=useRef(true);
 useEffect(()=>{active.current=true;element.current?.scrollIntoView({block:'nearest'});return()=>{active.current=false;};},[]);
 return <div ref={element} className="panel form-stack" role="group" aria-label="Confirm your identity" data-diagnostic-private>
  <strong>Confirm it’s you</strong><p>Enter your Porchday login password to continue. You’ll stay signed in, and your recovery note stays on this device.</p>
  <form className="form-stack" onSubmit={event=>{event.preventDefault();if(action.busy)return;void action.run(async()=>{try{await auth('confirm-password',{memberId,password,...factor?{code}:{}});}catch(error){if(error instanceof ApiError&&error.code==='TWO_FACTOR_REQUIRED'){setFactor(true);throw Error('Enter the current code from your authenticator app to continue.');}throw error;}setPassword('');setCode('');if(active.current)onConfirmed();});}}>
   <Field label="Porchday login password" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} disabled={action.busy} required/>
   {factor&&<Field label="Authenticator code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,'').slice(0,6))} disabled={action.busy} required/>}
   <Button variant="primary" busy={action.busy} disabled={!password||(factor&&code.length!==6)}>Confirm and continue</Button>
   <ActionFeedback error={action.error}/>
   <Button type="button" variant="quiet" disabled={action.busy} onClick={()=>{setPassword('');setCode('');onCancel();}}>Cancel</Button>
  </form>
 </div>;
}
