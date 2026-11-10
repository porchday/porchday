import React,{useCallback,useEffect,useRef,useState} from 'react';
import {base64ToBytes,canonicalJson,type EncryptedEnvelope} from '@porchday/crypto';
import {verifyPhotoBytes,type PhotoProof} from '@porchday/crypto/photos';
import type {MediaPayload} from './api';
import {useVault} from './vault';
import {useNearViewport} from './near-viewport';
import {photoCache,photoEpoch,photoMatches,subscribePhotos,schedulePhoto} from './photo-cache';
import {validatedPhoto} from './photo-safety';
import {PhotoViewer} from './PhotoViewer';
import {Tags} from './PeopleTags';
import {Icon} from './ui';
import {traced,markOnce,currentTraceId} from './tracing';
import {observeVisibleMilestone} from './visible-milestone';
import {causeOf} from './causal-links';

export function CachedEncryptedPhoto({media,thumbnail=false,photoProof}:{media:MediaPayload;thumbnail?:boolean;photoProof?:PhotoProof}){
 const imageRef=useRef<HTMLImageElement>(null);
 const vault=useVault(),{ref,near}=useNearViewport<HTMLDivElement>(false,6,20);
 const {ref:displayRef,near:displayNear}=useNearViewport<HTMLDivElement>(false,2);
 const attach=useCallback((element:HTMLDivElement|null)=>{ref.current=element;displayRef.current=element;},[]);
 const [epoch,setEpoch]=useState(photoEpoch),[opened,setOpened]=useState<{key:string;url:string;parentId?:string|null}|null>(null),[error,setError]=useState(''),[viewer,setViewer]=useState(false);
 const width=Number.isSafeInteger(media.width)&&media.width>0&&media.width<=16000?media.width:1;
 const height=Number.isSafeInteger(media.height)&&media.height>0&&media.height<=16000?media.height:1;
 const scope=vault.member.id+':'+vault.device.id+':'+vault.keys.map(key=>key.getFingerprint()).sort().join(',');
 const key=canonicalJson({scope,id:media.id,mime:media.mime,width,height,proof:photoProof??null});
 const identity=key+':'+epoch;
 const url=opened?.key===identity?opened.url:'';
 const identityRef=useRef(identity);identityRef.current=identity;
 const openedRef=useRef(opened);openedRef.current=opened;
 const invalidations=useRef(0);
 useEffect(()=>subscribePhotos(target=>{
  const current=openedRef.current;
  if(photoMatches(key,target,current?.key===identityRef.current?current:undefined)){
   invalidations.current++;setEpoch(photoEpoch());
  }
 }),[key]);
 useEffect(()=>{
  setOpened(null);setError('');setViewer(false);
  if(!near||document.visibilityState==='hidden')return;
  const revision=invalidations.current;
  let alive=true,objectUrl='';let timer:ReturnType<typeof setTimeout>|undefined;
  const controller=new AbortController();
  void schedulePhoto(()=>{if(revision!==invalidations.current)throw Error('Photo access changed.');return photoCache.read(key,async()=>{
    const response=await fetch(`/api/v1/media/${media.id}/bytes`,{method:'HEAD',credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error('This attachment is no longer available.');
  },async()=>{
    const response=await fetch(`/api/v1/media/${media.id}/bytes`,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw Error('This attachment is no longer available.');
    const envelope=await response.json() as EncryptedEnvelope;
    const payload=await vault.open({id:media.id,envelope});
    if(payload.mime!==media.mime||typeof payload.bytes!=='string')throw Error('Unsupported media format.');
    const bytes=base64ToBytes(payload.bytes);
    if(photoProof)await verifyPhotoBytes(photoProof,bytes);
    const decoded=await traced('media decode',()=>validatedPhoto(bytes),{bytes:bytes.length,...causeOf(payload)});
    if(decoded.width!==width||decoded.height!==height)throw Error('Photo dimensions did not match its signed metadata.');
    return {...decoded,parentId:envelope.context.parentId,expiresAt:envelope.context.expiresAt?Date.parse(envelope.context.expiresAt):null};
  });},()=>{const box=ref.current?.getBoundingClientRect();return !box?-Infinity:box.bottom>0&&box.top<window.innerHeight?1:-Math.max(0,box.top-window.innerHeight,-box.bottom)/Math.max(1,window.innerHeight);},controller.signal).then(value=>{
    if(!alive||revision!==invalidations.current||identityRef.current!==identity)return;
    if(value.expiresAt!==null&&(!Number.isFinite(value.expiresAt)||value.expiresAt<=Date.now()))throw Error('This attachment expired.');
    objectUrl=URL.createObjectURL(value.blob);setOpened({key:identity,url:objectUrl,parentId:value.parentId});markOnce('photo-decoded');
    const expire=()=>{if(!alive||value.expiresAt===null)return;const left=value.expiresAt-Date.now();if(left<=0){URL.revokeObjectURL(objectUrl);objectUrl='';setOpened(null);setViewer(false);setError('This attachment expired.');}else timer=setTimeout(expire,Math.min(left,2147483647));};expire();
  }).catch(error=>{if(alive&&revision===invalidations.current)setError(error instanceof Error?error.message:'Unable to open photo.');});
  return()=>{alive=false;controller.abort();if(timer)clearTimeout(timer);if(objectUrl)URL.revokeObjectURL(objectUrl);};
 },[identity,near]);
 useEffect(()=>{const image=imageRef.current;if(!currentTraceId()||!image||!url)return;return observeVisibleMilestone(image,()=>image.getAttribute('src')===url,()=>markOnce('first-visible-photo'));},[url]);
 return <div ref={attach} className={thumbnail?'calendar-thumbnail stable-photo':'stable-photo'}><figure>
  <div className="stable-photo-frame" style={{aspectRatio:`${width} / ${height}`}}>
   {url&&displayNear?<img ref={imageRef} src={url} width={width} height={height} alt={media.alt||'Shared photo (no description provided)'} decoding="async" role={thumbnail?undefined:'button'} tabIndex={thumbnail?undefined:0} aria-label={thumbnail?undefined:`Open photo: ${media.alt||'Shared photo'}`} onClick={thumbnail?undefined:()=>setViewer(true)} onKeyDown={thumbnail?undefined:e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setViewer(true);}}}/>:<div className="photo-placeholder"><Icon name={error?'shield':'photo'} size={24}/><span>{error||(displayNear?'Opening encrypted media…':'Media loads as you scroll')}</span></div>}
  </div>
  {!thumbnail&&media.alt&&<figcaption>{media.alt}</figcaption>}{!thumbnail&&<Tags value={media.tags}/>}
  {!thumbnail&&viewer&&url&&<PhotoViewer src={url} alt={media.alt||''} onClose={()=>setViewer(false)}/>}
 </figure></div>;
}
