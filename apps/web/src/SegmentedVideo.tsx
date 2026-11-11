import {PostText} from "./PostText";
import {verifyPhotoVideo} from './photo-video';
import type {PhotoProof} from '@porchday/crypto/photos';
import React,{useEffect,useRef,useState} from 'react';
import {validateVideoManifest} from '@porchday/crypto/video';
import type {EncryptedEnvelope} from '@porchday/crypto';
import {base64ToBytes} from '@porchday/crypto';
import type {MediaPayload} from './api';
import {useVault} from './vault';
import {Alert,Button} from './ui';
import {Tags} from './PeopleTags';
import {validatedPhoto} from './photo-safety';
import {registerVideoPlayback} from './video-playback';
export function SegmentedVideo({media,thumbnail=false,photoProof}:{media:MediaPayload;thumbnail?:boolean;photoProof?:PhotoProof}){
 const vault=useVault(),[url,setURL]=useState(''),[poster,setPoster]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),active=useRef<AbortController|null>(null);
 const stop=()=>{active.current?.abort();active.current=null;setURL('');setBusy(false);};
 useEffect(()=>{stop();setError('');const hidden=()=>{if(document.visibilityState!=='visible')stop();};document.addEventListener('visibilitychange',hidden);return()=>{active.current?.abort();document.removeEventListener('visibilitychange',hidden);};},[media.id]);
 useEffect(()=>{setPoster('');let closed=false,preview='';if((!media.posterExpiresAt||Date.parse(media.posterExpiresAt)>Date.now())&&media.poster&&media.poster.length<=100000){void validatedPhoto(base64ToBytes(media.poster)).then(value=>{if(!closed){preview=URL.createObjectURL(value.blob);setPoster(preview);}}).catch(()=>{});}return()=>{closed=true;URL.revokeObjectURL(preview);};},[media.id,media.poster]);
 async function play(){
  stop();const abort=new AbortController();active.current=abort;setBusy(true);setError('');
  try{
   const response=await fetch(`/api/v1/media/${media.id}/bytes`,{credentials:'same-origin',cache:'no-store',signal:abort.signal});if(!response.ok)throw Error('This video is no longer available.');
   const envelope=await response.json() as EncryptedEnvelope,content=await vault.open({id:media.id,envelope});abort.signal.throwIfAborted();
   if(envelope.context.kind!=='media'||content.mime!=='video/mp4')throw Error('This video has invalid metadata.');
   if(media.videoVersion===3&&!photoProof)throw Error('Video owner proof is missing.');
   const manifest=media.videoVersion===3?await verifyPhotoVideo(photoProof!,content.video):validateVideoManifest(content.video),playback=await registerVideoPlayback(media.id,manifest,envelope.context.expiresAt,abort.signal);
   let expiry=envelope.context.expiresAt?Date.parse(envelope.context.expiresAt):Infinity;
   const access=async()=>{try{const current=await fetch(`/api/v1/videos/${media.id}/access`,{credentials:'same-origin',cache:'no-store',signal:abort.signal});if(!current.ok)throw Error('This video is no longer available.');const result=await current.json();if(result.expiresAt)expiry=Math.min(expiry,Date.parse(result.expiresAt));if(expiry<=Date.now())throw Error('This video has expired.');}catch(e){if(!abort.signal.aborted){setError((e as Error).message);stop();}}};
   await access();abort.signal.throwIfAborted();const interval=setInterval(()=>{void access();},15000),timer=setInterval(()=>{if(expiry<=Date.now()){setError('This video has expired.');stop();}},1000);
   abort.signal.addEventListener('abort',()=>{clearInterval(interval);clearInterval(timer);playback.close();},{once:true});
   setURL(playback.url);
  }catch(e){if(!abort.signal.aborted)setError((e as Error).message);abort.abort();}finally{if(active.current===abort)setBusy(false);}
 }
 return <figure className="photo-figure">{url?<video src={url} controls playsInline preload="metadata" poster={poster||undefined} aria-label={media.alt||'Shared video'} onError={()=>{setError('This video could not be streamed. Check your connection and try again.');stop();}}/>:<>{poster&&<img src={poster} alt={media.alt||'Video preview'}/>}<Button disabled={busy||thumbnail} onClick={()=>void play()}>{busy?'Opening video…':thumbnail?'Video':'Play video'}</Button>{media.duration&&<span className="small-copy">{Math.floor(media.duration/60)}:{String(Math.floor(media.duration%60)).padStart(2,'0')}</span>}</>}<Alert>{error}</Alert>{!thumbnail&&media.alt&&<figcaption><PostText text={media.alt} tags={media.tags}/></figcaption>}{!thumbnail&&<Tags value={media.tags}/>}</figure>;
}
