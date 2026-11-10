import {useEffect} from 'react';
import {useVault} from './vault';
import {enrollContentPreviews,type PreviewEnrollmentReceipt} from './notification-previews';
import {recordDiagnostic,safeDiagnosticError} from './diagnostics';
export function NotificationPreviewEnrollment(){
 const vault=useVault();
 useEffect(()=>{
  let active=true,busy=false,changedWhileBusy=false;
  const receipt:PreviewEnrollmentReceipt={};
  const refresh=async()=>{
   if(!active||busy||document.hidden)return;
   busy=true;
   try{await enrollContentPreviews(vault,()=>active,receipt);}
   catch(error){recordDiagnostic('operation',{operation:'notification_preview',stage:'enroll',outcome:'generic_fallback',error:safeDiagnosticError(error).error,code:safeDiagnosticError(error).code||"unknown"});}
   finally{busy=false;if(changedWhileBusy){changedWhileBusy=false;delete receipt.key;delete receipt.at;void refresh();}}
  };
  const changed=()=>{delete receipt.key;delete receipt.at;if(busy)changedWhileBusy=true;else void refresh();};
  void refresh();const timer=setInterval(refresh,60000);
  window.addEventListener('porchday:push-changed',changed);window.addEventListener('online',refresh);document.addEventListener('visibilitychange',refresh);
  return()=>{active=false;clearInterval(timer);window.removeEventListener('porchday:push-changed',changed);window.removeEventListener('online',refresh);document.removeEventListener('visibilitychange',refresh);};
 },[vault.member.id,vault.device.id,vault.privateKey]);
 return null;
}
