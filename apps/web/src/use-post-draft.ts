import {useEffect,useRef,useState} from 'react';
import {encryptObject,type Audience} from '@porchday/crypto';
import type {useVault} from './vault';
import type {PersonTag} from './PeopleTags';
import type {PreparedLargeVideo} from './video-prepare';
import {PostDraftStore,type DraftFile} from './post-draft-store';
import {get} from './api';
import {pendingPublications} from './video-outbox';
export type PendingPhoto={largeVideo?:PreparedLargeVideo;photoDate?:string;mime?:string;poster?:string;tags?:PersonTag[];id:string;name:string;alt:string;blob:Blob;width:number;height:number;preview:string};
export type PostDraft={text:string;tags:PersonTag[];onBehalf:string;audience:Audience;timer:string;photos:PendingPhoto[];videoSources:File[];mode:'post'|'photos';album:string};
export function usePostDraft(vault:ReturnType<typeof useVault>,enabled:boolean,initial:PostDraft){
 const [attempt,setAttempt]=useState(0),[value,setValue]=useState(initial),[ready,setReady]=useState(!enabled),[status,setStatus]=useState(''),[error,setError]=useState('');
 const current=useRef(initial),store=useRef(new PostDraftStore(vault.member.id,'share')),chain=useRef(Promise.resolve()),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),live=useRef(true),dirty=useRef(false),version=useRef(0),loaded=useRef(!enabled),publication=useRef<string|undefined>(undefined);
 const vaultRef=useRef(vault);vaultRef.current=vault;
 function enqueue<T>(work:()=>Promise<T>):Promise<T>{const next=chain.current.then(work);chain.current=next.then(()=>{},()=>{});return next;}
 async function persist(snapshot:PostDraft,serial:number){
  if(!snapshot.text.trim()&&!snapshot.photos.length&&!snapshot.videoSources.length){await store.current.commit(null,[]);if(serial===version.current){dirty.current=false;if(live.current){setStatus('');setError('');}}return;}
  const files:DraftFile[]=[],photos=[];
  for(const p of snapshot.photos){const file=await store.current.file(p.blob,p.name);files.push(file);const {blob,preview,largeVideo,...fields}=p;photos.push({...fields,file,...(largeVideo?{duration:largeVideo.duration}:{})});}
  const sources=[];for(const file of snapshot.videoSources){const saved=await store.current.file(file,file.name);files.push(saved);sources.push(saved);}
  const {photos:_,videoSources:__,...fields}=snapshot,v=vaultRef.current;
  const payload={purpose:'porchday-post-draft-v1',owner:v.member.id,scope:'share',fields,photos,sources,...(publication.current?{publication:publication.current}:{})};
  const envelope=await encryptObject({payload,context:{id:crypto.randomUUID(),kind:'media',authorId:v.member.id,authorDeviceId:v.device.id,audience:'only_me',groupId:null,parentId:null,epoch:0,revision:1,createdAt:new Date().toISOString(),expiresAt:null},signingKey:v.privateKey,recipients:[{memberId:v.member.id,deviceId:v.device.id,publicKey:v.device.public_key}]});
  const d=v.device;await store.current.commit({envelope,author_key:{id:d.id,member_id:d.member_id,public_key:d.public_key,fingerprint:d.fingerprint}},files);
  if(serial===version.current){dirty.current=false;if(live.current){setStatus('Draft saved on this device');setError('');}}
 }
 function report(e:unknown){dirty.current=true;if(live.current){setStatus('');setError('Draft not saved. '+(e instanceof Error?e.message:'Keep this tab open and try again.'));}}
 function flush(){clearTimeout(timer.current);if(!enabled||!loaded.current)return Promise.resolve();const snapshot=current.current,serial=version.current;if(live.current)setStatus('Saving draft…');return enqueue(()=>persist(snapshot,serial));}
 function change<K extends keyof PostDraft>(key:K,next:PostDraft[K]|((old:PostDraft[K])=>PostDraft[K])){
  const old=current.current;current.current={...old,[key]:typeof next==='function'?(next as (old:PostDraft[K])=>PostDraft[K])(old[key]):next};setValue(current.current);
  if(!enabled||!loaded.current)return;publication.current=undefined;dirty.current=true;version.current++;setError('');setStatus('Saving draft…');clearTimeout(timer.current);timer.current=setTimeout(()=>void flush().catch(report),400);
 }
 async function clear(){if(!enabled)return;clearTimeout(timer.current);version.current++;await enqueue(()=>store.current.commit(null,[]));publication.current=undefined;dirty.current=false;if(live.current){setStatus('');setError('');}}
 async function beforePublish(id:string){if(!enabled)return;publication.current=id;await flush();}
 useEffect(()=>{
  if(!enabled)return;live.current=true;setError('');setReady(false);let canceled=false;
  void (async()=>{
   const sealed=await store.current.load();if(!sealed)return;
   const v=vaultRef.current,wrapped=sealed as Parameters<typeof v.open>[0],context=wrapped.envelope?.context;
   if(context?.authorId!==v.member.id||context.audience!=='only_me'||context.kind!=='media')throw Error('Saved draft identity did not match.');
   const data=await v.open(wrapped) as any;
   if(data.purpose!=='porchday-post-draft-v1'||data.owner!==v.member.id||data.scope!=='share'||typeof data.fields?.text!=='string'||data.fields.text.length>5000||!Array.isArray(data.photos)||data.photos.length>10||!Array.isArray(data.sources)||data.sources.length>10)throw Error('Saved draft is invalid.');
   if(data.publication){if(typeof navigator.storage?.getDirectory==='function'&&(await pendingPublications(v.member.id)).some(p=>p.id===data.publication)){await store.current.commit(null,[]);return;}try{await get('/posts/'+data.publication);await store.current.commit(null,[]);return;}catch(e){if((e as {status?:number}).status!==404)throw Error('Could not check whether this draft was already posted. Try again when connected.');}}
   const photos:PendingPhoto[]=[];
   for(const saved of data.photos){const {file,duration,...fields}=saved,blob=await store.current.readFile(file),preview=URL.createObjectURL(blob);const photo={...fields,blob,preview};if(duration!==undefined)photo.largeVideo={blob,mime:'video/mp4',width:fields.width,height:fields.height,duration,poster:fields.poster,preview,dispose:async()=>{URL.revokeObjectURL(preview);}};photos.push(photo);}
   const videoSources=[];for(const source of data.sources)videoSources.push(await store.current.readFile(source));
   if(canceled){for(const p of photos)URL.revokeObjectURL(p.preview);return;}
   current.current={...data.fields,photos,videoSources};setValue(current.current);setStatus('Draft restored · saved on this device');
  })().then(()=>{if(!canceled){loaded.current=true;setReady(true);}}).catch(e=>{if(!canceled){setError('Could not restore your saved draft. '+(e as Error).message);}});
  const unload=(event:BeforeUnloadEvent)=>{if(dirty.current){event.preventDefault();event.returnValue='';}};
  const hide=()=>{if(document.visibilityState==='hidden'&&dirty.current)void flush().catch(report);};
  window.addEventListener('beforeunload',unload);document.addEventListener('visibilitychange',hide);
  return()=>{canceled=true;live.current=false;clearTimeout(timer.current);if(dirty.current)void flush().catch(()=>{});window.removeEventListener('beforeunload',unload);document.removeEventListener('visibilitychange',hide);};
 },[enabled,vault.member.id,attempt]);
 return {value,change,ready,status,error,unsaved:dirty.current,retryRestore:()=>setAttempt(x=>x+1),flush,clear,beforePublish,retry:()=>void flush().catch(report),discard:async()=>{await clear();current.current=initial;setValue(initial);loaded.current=true;setReady(true);}};
}
