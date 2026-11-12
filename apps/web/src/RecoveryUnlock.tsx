import React,{useEffect,useState} from 'react';
import {get,post,type Device,type Member} from './api';
import {verifyStatement,type UnlockedPrivateKey} from '@porchday/crypto';
import {combineContactRecoveryShares,openRecoveryPayload,recoveryDigest} from '@porchday/crypto/recovery';
import {Alert,Button,Field,useAction} from './ui';
import {unlockRecoveryPasskey} from './recovery-passkeys';
import {RecoveryQR,RecoveryScanner} from './RecoveryScanner';
import {checkedMethod,checkPairingInvitation,discardExpiredRecovery,finishRecoveryRequest,pairingCode,receivePairing,recoveryState,restorePendingRecovery,shareBinding,startRecoveryRequest,type PendingRecovery,type RecoveryState} from './recovery-client';
export function RecoveryUnlock({member,onSecret,onPaired}:{member:Member;onSecret:(secret:string,pending?:PendingRecovery)=>Promise<void>;onPaired:(active:{device:Device;key:UnlockedPrivateKey;history:UnlockedPrivateKey[]})=>void}){
 const [state,setState]=useState<RecoveryState|null>(null),[pending,setPending]=useState<PendingRecovery|null>(null),[label,setLabel]=useState('My other device'),[privateDevice,setPrivateDevice]=useState(false);
 const action=useAction();
 useEffect(()=>{let alive=true;void restorePendingRecovery(member.id).then(v=>{if(alive)setPending(v);});const refresh=async()=>{if(document.hidden||!navigator.onLine)return;try{const value=await recoveryState();if(alive)setState(value);}catch{/* Manual actions show failures; secret recovery stays available. */}};void refresh();const timer=setInterval(refresh,5000);return()=>{alive=false;clearInterval(timer);};},[member.id]);
 const record=pending?state?.requests.find(r=>r.id===pending.record.statement.id):null;
 async function begin(kind:'pair'|'contacts',methodId:string|null,invitationId?:string){if(!privateDevice)throw Error('Choose a private device before saving its encryption keys.');try{const next=await startRecoveryRequest(member,kind,methodId,label,invitationId);setPending(next);setState(await recoveryState());}catch(error){setPending(await restorePendingRecovery(member.id));throw error;}}
 async function collect(){
  if(!pending||!state)throw Error('No active recovery request.');const s=pending.record.statement;
  if(Date.parse(s.expiresAt)<=Date.now())throw Error('This request expired. Start a new request.');
  const method=state.methods.find(m=>m.id===s.methodId),m=await checkedMethod(method,member.id);
  const rows=state.responses.filter(r=>r.request_id===s.id),shares:string[]=[],seen=new Set<string>();
  for(const row of rows){const contact=m.contacts.find((c:any)=>c.memberId===row.member_id),a=row.record.statement;
   if(!contact||seen.has(contact.memberId)||a.memberId!==contact.memberId||a.requestId!==s.id||a.methodId!==m.id||a.requestFingerprint!==s.fingerprint)throw Error('Recovery approval mismatch.');
   if(!state.contacts.some(c=>c.method_id===m.id&&c.member_id===contact.memberId&&c.accepted_at&&!c.declined_at))continue;
   const current=await get('/devices/'+a.deviceId);if(current.revoked_at||current.member_id!==contact.memberId)continue;
   await verifyStatement(row.record,current.public_key);
   const payload=await openRecoveryPayload<{share:string}>(a.ciphertext,shareBinding(member.id,m.id,s.fingerprint,s.id),pending.key,current.public_key);
   if(await recoveryDigest(payload.share)!==contact.shareHash)throw Error('Recovery share mismatch.');seen.add(contact.memberId);shares.push(payload.share);
  }
  if(shares.length<2)throw Error('Two different accepted contacts must approve this request.');
  await onSecret(await combineContactRecoveryShares(shares.slice(0,2)),pending);
 }
 if(!state?.enabled)return null;
 return <section className="panel form-stack" data-diagnostic-private>
  <h2>Other ways to recover your data</h2><Alert>{action.error}</Alert>
  {(state?.methods??[]).filter(m=>m.kind==='passkey'&&!m.disabled_at).map(method=><Button key={method.id} variant="outline" busy={action.busy} onClick={()=>action.run(async()=>{const m=await checkedMethod(method,member.id);await onSecret(await unlockRecoveryPasskey(member.id,method.id,m.passkey));})}>Unlock with {method.record.statement.label}</Button>)}
  {!pending?<><Field label="Name this device" value={label} maxLength={80} onChange={e=>setLabel(e.target.value)}/><label className="check-field"><input type="checkbox" checked={privateDevice} onChange={e=>setPrivateDevice(e.target.checked)}/>This is my private device. Save its encryption keys here so it can help me recover later.</label>
   <Button variant="outline" busy={action.busy} disabled={!privateDevice} onClick={()=>action.run(()=>begin('pair',null))}>Use another trusted device</Button>
   {privateDevice&&<details><summary>Scan a code displayed on my trusted device</summary><RecoveryScanner onRead={code=>{void action.run(async()=>begin('pair',null,await checkPairingInvitation(member.id,code)));}}/></details>}
   {(state?.methods??[]).filter(m=>m.kind==='contacts'&&!m.disabled_at).map(method=><Button key={method.id} variant="outline" busy={action.busy} disabled={!privateDevice} onClick={()=>action.run(()=>begin('contacts',method.id))}>Ask my recovery contacts</Button>)}
   <p className="small-copy">These methods must have been set up before losing access. Login passwords and email or text-message codes cannot decrypt your history.</p>
  </>:<><strong>{pending.record.statement.kind==='pair'?'Approve from your trusted device':'Ask two contacts to approve'}</strong>
   {pending.record.statement.kind==='pair'?<><p>On your already unlocked device, open Account & keys → Recovery, scan this code, and approve the transfer. Both devices must be signed in to this account.</p><RecoveryQR value={pairingCode(pending.record)}/></>:<p>Contact your chosen people outside Porchday. Ask them to open Account & keys and compare this full request fingerprint with you before approving.</p>}
   <code style={{overflowWrap:'anywhere'}}>{pending.record.statement.fingerprint}</code><p>Expires {new Date(pending.record.statement.expiresAt).toLocaleString()}.</p>
   {pending.record.statement.kind==='pair'?<Button variant="primary" busy={action.busy} disabled={record?.state!=='approved'} onClick={()=>action.run(async()=>{const active=await receivePairing(pending,record);onPaired(active);})}>{record?.state==='approved'?'Verify transfer and unlock':'Waiting for your trusted device'}</Button>:<Button variant="primary" busy={action.busy} onClick={()=>action.run(collect)}>Recover with approved contacts ({state?.responses.filter(r=>r.request_id===pending.record.statement.id).length??0}/2)</Button>}
   {!record&&Date.parse(pending.record.statement.expiresAt)>Date.now()&&<Button variant="outline" busy={action.busy} onClick={()=>action.run(async()=>{await post('/key-recovery/requests',pending.record);setState(await recoveryState());})}>Resume request</Button>}
   <Button variant="quiet" busy={action.busy} onClick={()=>action.run(async()=>{if(Date.parse(pending.record.statement.expiresAt)>Date.now())await finishRecoveryRequest(pending,true);else await discardExpiredRecovery(pending);setPending(null);})}>Cancel recovery request</Button>
  </>}
 </section>;
}
