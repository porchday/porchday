import {onlyRecoveredOwnDevicesMissing,hasRecoveredAccess} from './recovered-history-access';
import type {Device,EncryptedEnvelope} from './api';
import {useEffect,useRef,useState} from "react";
import {get} from "./api";
import {useVault} from "./vault";
import {refreshPhotoGrant} from "./photo-album";
import type {PhotoRow} from "./photo-record";

// Catch-up runs only on the unlocked author's device. Never infer consent from
// the UI: the server computes the current graph and directional history choice.
export function PhotoAudienceSharing(){
 const vault=useVault();
 const [state,setState]=useState<"idle"|"sharing"|"unfinished">("idle");
 const retry=useRef<()=>void>(()=>{});
 const context=`${vault.member.id}:${vault.member.status||"active"}:${vault.device.id}:${vault.device.revoked_at||""}`;
 const latest=useRef(context);latest.current=context;
 useEffect(()=>{
  setState("idle");
  if((vault.member.status||"active")!=="active"||vault.device.revoked_at)return;
  let mounted=true,running=false,paused=false,after:string|null=null;
  const covered=new Set<string>();
  const fingerprints=new Set((vault.keys||[vault.privateKey]).filter(Boolean).map(key=>key.getFingerprint()));
  const current=()=>mounted&&latest.current===context;
  const enabled=()=>current()&&navigator.onLine&&document.visibilityState!=="hidden";
  const check=()=>{if(!enabled())throw new DOMException("Sharing stopped.","AbortError");};
  const run=async()=>{
   if(running||paused||!enabled())return;
   running=true;let failed=false;
   try{
    {
     check();
     const page:{items:PhotoRow[];next:string|null}=await get(`/photos/history-refresh${after?"?after="+encodeURIComponent(after):""}`);
     check();
     for(const photo of page.items){
      check();
      const grant=photo.grants.find(g=>g.album_id===null);
      if(photo.owner_id!==vault.member.id||!grant)throw Error("Photo history is unavailable.");
      try{
       const snapshot=await get(`/photos/${photo.id}/grants/${grant.id}/refresh-audience`);check();
       if(onlyRecoveredOwnDevicesMissing(grant.envelope,snapshot.devices as Device[],vault.member.id,fingerprints,snapshot.existing_peer_grants_complete===true)){
         const cacheKey=JSON.stringify([grant.id,photo.revision,grant.media_id,grant.envelope.recipients,snapshot.epoch]);
         if(covered.has(cacheKey))continue;
         const media=await get<EncryptedEnvelope>(`/media/${grant.media_id}/bytes`);check();
         if(hasRecoveredAccess(media,vault.member.id,fingerprints)){covered.add(cacheKey);continue;}
       }
       setState("sharing");await refreshPhotoGrant(vault,photo,grant,check,true);check();window.dispatchEvent(new Event("porchday:posts-shared"));}
      catch(error){check();failed=true;}
     }
     after=page.next;
    }
   }catch{failed=true;}
   finally{
    running=false;
    if(current()){
     // A rejected or unconfirmed save needs an explicit retry, avoiding repeated
     // encryption/uploads every timer tick. The next read reconciles lost saves.
     paused=failed&&enabled();setState(failed?"unfinished":"idle");
    }
   }
  };
  const recheck=()=>{void run();};
  retry.current=()=>{paused=false;void run();};
  window.addEventListener("online",recheck);window.addEventListener("focus",recheck);
  window.addEventListener("porchday:connections-changed",recheck);
  document.addEventListener("visibilitychange",recheck);
  const interval=setInterval(recheck,20_000);recheck();
  return ()=>{mounted=false;clearInterval(interval);retry.current=()=>{};
   window.removeEventListener("online",recheck);window.removeEventListener("focus",recheck);
   window.removeEventListener("porchday:connections-changed",recheck);
   document.removeEventListener("visibilitychange",recheck);
  };
 },[context]);
 if(state==="idle")return null;
 return <div className="panel" role="status"><p>{state==="sharing"?"Updating encrypted photo access for eligible devices… You can keep using Porchday.":"Some encrypted photo access updates are pending. Your photos have not been reposted. You can keep using Porchday."}</p>{state==="unfinished"&&<button type="button" onClick={()=>retry.current()}>Retry access updates</button>}</div>;
}
