import {onlyRecoveredOwnDevicesMissing,hasRecoveredAccess} from './recovered-history-access';
import {request,type Device,type EncryptedEnvelope} from './api';
import {useEffect,useRef} from "react";
import {useVault} from "./vault";
import {preparePhotoRefresh,submitPhotoRefresh,photoRefreshOutcome,type PreparedPhotoRefresh} from "./photo-album";
import type {PhotoRow} from "./photo-record";
import {startAccessUpdates} from './access-updates';

export function PhotoAudienceSharing(){
 const vault=useVault();
 const context=`${vault.member.id}:${vault.member.status||"active"}:${vault.device.id}:${vault.device.revoked_at||""}`;
 const latest=useRef(context);latest.current=context;
 useEffect(()=>{
  if((vault.member.status||'active')!=='active'||vault.device.revoked_at)return;
  let mounted=true,after:string|null=null;
  const covered=new Set<string>();
  const fingerprints=new Set((vault.keys||[vault.privateKey]).filter(Boolean).map(key=>key.getFingerprint()));
  const current=()=>mounted&&latest.current===context;
  const enabled=()=>current()&&navigator.onLine&&document.visibilityState!=='hidden';
  const sharing=startAccessUpdates<PreparedPhotoRefresh>({
   enabled,
   list:async signal=>{
    const page=await request<{items:PhotoRow[];next:string|null}>(`/photos/history-refresh${after?'?after='+encodeURIComponent(after):''}`,{signal});
    after=page.next;
    return {items:page.items};
   },
   prepare:async(id,signal)=>{
    const check=()=>{if(!enabled()||signal.aborted)throw new DOMException('Sharing stopped.','AbortError');};
    const {photo}=await request<{photo:PhotoRow}>(`/photos/${id}`,{signal});check();
    const grant=photo.grants.find(g=>g.album_id===null);
    if(photo.owner_id!==vault.member.id||!grant)throw Error('Photo history is unavailable.');
    const snapshot=await request(`/photos/${id}/grants/${grant.id}/refresh-audience`,{signal});check();
    if(onlyRecoveredOwnDevicesMissing(grant.envelope,snapshot.devices as Device[],vault.member.id,fingerprints,snapshot.existing_peer_grants_complete===true)){
     const cacheKey=JSON.stringify([grant.id,photo.revision,grant.media_id,grant.envelope.recipients,snapshot.epoch]);
     if(!covered.has(cacheKey)){
      const media=await request<EncryptedEnvelope>(`/media/${grant.media_id}/bytes`,{signal});check();
      if(hasRecoveredAccess(media,vault.member.id,fingerprints))covered.add(cacheKey);
     }
     if(covered.has(cacheKey))return null;
    }
    return preparePhotoRefresh(vault,photo,grant,check,true);
   },
   save:async candidate=>{
    if(!current())throw new DOMException('Sharing stopped.','AbortError');
    await submitPhotoRefresh(candidate,true);
   },
   reconcile:async(candidate,signal)=>photoRefreshOutcome(candidate,(await request<{photo:PhotoRow}>(`/photos/${candidate.photoId}`,{signal})).photo),
   cleanup:async candidate=>{if(current())await request(`/media/${candidate.body.media_id}`,{method:'DELETE',backgroundSave:true,keepNavigation:true});},
   state:()=>{},
   changed:()=>{if(current())window.dispatchEvent(new Event('porchday:posts-shared'));},
  });
  const recheck=()=>{if(enabled())void sharing.recheck();else sharing.suspend();};
  window.addEventListener('online',recheck);window.addEventListener('offline',recheck);window.addEventListener('focus',recheck);
  window.addEventListener('porchday:connections-changed',recheck);document.addEventListener('visibilitychange',recheck);
  const interval=setInterval(recheck,20_000);
  return()=>{mounted=false;sharing.dispose();clearInterval(interval);
   window.removeEventListener('online',recheck);window.removeEventListener('offline',recheck);window.removeEventListener('focus',recheck);
   window.removeEventListener('porchday:connections-changed',recheck);document.removeEventListener('visibilitychange',recheck);
  };
 },[context]);
 // Background retries require no user action; keep them out of the page UI.
 return null;
}
