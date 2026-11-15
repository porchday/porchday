import React,{createContext,useContext,useEffect,useRef,useState} from 'react';
import {base64ToBytes,canonicalJson,type EncryptedEnvelope} from '@porchday/crypto';
import {verifyPhotoBytes,type PhotoProof} from '@porchday/crypto/photos';
import type {MediaPayload} from './api';
import {useVault} from './vault';
import {PhotoViewer} from './PhotoViewer';
import {photoCache,subscribePhotos} from './photo-cache';
import {validatedMedia,isVideo} from './video';

export type GalleryPhoto={media:MediaPayload;photoProof?:PhotoProof};
export type GallerySource={id:string;parentId?:string;photos:()=>Promise<GalleryPhoto[]>};
export type GalleryPage={sources:GallerySource[];next:string|null};
const Gallery=createContext<((media:MediaPayload,source?:string,photoProof?:PhotoProof,trigger?:HTMLElement)=>boolean)|null>(null);
const Group=createContext<string|undefined>(undefined);
export function PhotoGalleryGroup({id,children}:{id:string;children:React.ReactNode}){return <Group.Provider value={id}>{children}</Group.Provider>;}
export function usePhotoGallery(){const open=useContext(Gallery),group=useContext(Group);return (media:MediaPayload,photoProof?:PhotoProof,trigger?:HTMLElement)=>open?.(media,group,photoProof,trigger)??false;}
export function PhotoGallery({sources,next=null,loadMore,inherit=false,children}:{sources:GallerySource[];next?:string|null;loadMore?:(cursor:string)=>Promise<GalleryPage>;inherit?:boolean;children:React.ReactNode}){
 const parent=useContext(Gallery);
 return inherit&&parent?<>{children}</>:<Group.Provider value={undefined}><GalleryController sources={sources} next={next} loadMore={loadMore}>{children}</GalleryController></Group.Provider>;
}
function GalleryController({sources,next,loadMore,children}:{sources:GallerySource[];next:string|null;loadMore?: (cursor:string)=>Promise<GalleryPage>;children:React.ReactNode}){
 const latest=useRef({sources,next,loadMore});latest.current={sources,next,loadMore};
 const [current,setCurrent]=useState<{source:string;photo:GalleryPhoto}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[end,setEnd]=useState<1|-1|null>(null);
 const session=useRef(0),moving=useRef(false),list=useRef<GallerySource[]>([]),cursor=useRef<string|null>(null);
 const trigger=useRef<HTMLElement|undefined>(undefined);
 const active=useRef(current);active.current=current;
 const resolved=useRef(new Map<string,GalleryPhoto[]>());
 const close=()=>{resolved.current.clear();session.current++;moving.current=false;setCurrent(null);setBusy(false);setError('');};
 useEffect(()=>()=>{session.current++;},[]);

 // Invalidated access must close the full-size image too, including offscreen cards.
 useEffect(()=>subscribePhotos(target=>{const selected=active.current;if(!selected)return;const parent=list.current.find(s=>s.id===selected.source)?.parentId??selected.source;if(!target||('mediaId' in target?target.mediaId===selected.photo.media.id:target.parentId===parent))close();}),[]);
 function open(media:MediaPayload,source?:string,photoProof?:PhotoProof,opener?:HTMLElement){const rows=latest.current.sources,id=source??rows[0]?.id;if(!id||!rows.some(s=>s.id===id))return false;session.current++;trigger.current=opener;resolved.current.clear();list.current=[...rows];cursor.current=latest.current.next;moving.current=false;setBusy(false);setError('');setEnd(null);setCurrent({source:id,photo:{media,photoProof}});return true;}
 async function move(direction:1|-1){
  if(!current||moving.current)return;const generation=session.current;moving.current=true;setBusy(true);setError('');setEnd(null);
  try{
   let sourceIndex=list.current.findIndex(s=>s.id===current.source),first=true;
   while(sourceIndex>=0){
    if(sourceIndex>=list.current.length){
     const after=cursor.current;if(direction<0||!after||!latest.current.loadMore)break;
     const page=await latest.current.loadMore(after);if(generation!==session.current)return;
     if(page.next===after)throw Error('More photos could not be loaded. Try again.');
     cursor.current=page.next;list.current.push(...page.sources.filter(s=>!list.current.some(old=>old.id===s.id)));
     if(sourceIndex>=list.current.length&&!page.next)break;
     continue;
    }
    const source=list.current[sourceIndex],photos=resolved.current.get(source.id)??(await source.photos()).filter(p=>!isVideo(p.media.mime));if(generation!==session.current)return;resolved.current.set(source.id,photos);
    const index=first?photos.findIndex(p=>p.media.id===current.photo.media.id)+direction:direction===1?0:photos.length-1;
    if(index>=0&&index<photos.length){setCurrent({source:source.id,photo:photos[index]});return;}
    first=false;sourceIndex+=direction;
   }
   setEnd(direction);
  }catch(e){if(generation===session.current)setError(e instanceof Error?e.message:'Unable to load the next photo.');}
  finally{if(generation===session.current){moving.current=false;setBusy(false);}}
 }
 return <Gallery.Provider value={open}>{children}{current&&<GalleryImage returnFocus={trigger.current} photo={current.photo} onClose={close} onPrevious={()=>void move(-1)} onNext={()=>void move(1)} busy={busy} notice={error||(end===1?'No more photos.':end===-1?'This is the first photo.':'')} previousDisabled={end===-1} nextDisabled={end===1}/>}</Gallery.Provider>;
}
function GalleryImage({photo,...controls}:{photo:GalleryPhoto;returnFocus?:HTMLElement;onClose:()=>void;onPrevious:()=>void;onNext:()=>void;busy:boolean;notice:string;previousDisabled:boolean;nextDisabled:boolean}){
 const vault=useVault(),scope=vault.member.id+':'+vault.device.id+':'+vault.keys.map(key=>key.getFingerprint()).sort().join(',');
 const priorScope=useRef(scope);useEffect(()=>{if(priorScope.current!==scope)controls.onClose();priorScope.current=scope;},[scope]);
 const [opened,setOpened]=useState<{id:string;url:string}|null>(null),[error,setError]=useState('');
 const url=opened?.id===photo.media.id?opened.url:'';
 useEffect(()=>{
  setOpened(null);setError('');
  let alive=true,objectUrl='',timer:ReturnType<typeof setTimeout>|undefined;const controller=new AbortController(),{media,photoProof}=photo;
  const key=canonicalJson({scope,id:media.id,mime:media.mime,width:media.width,height:media.height,proof:photoProof??null});
  const read=async(method='GET')=>{const r=await fetch(`/api/v1/media/${media.id}/bytes`,{method,credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});if(!r.ok)throw Error('This photo is no longer available.');return r;};
  void photoCache.read(key,async()=>{await read('HEAD');},async()=>{
   const envelope=await(await read()).json() as EncryptedEnvelope,payload=await vault.open({id:media.id,envelope});
   if(payload.mime!==media.mime||typeof payload.bytes!=='string')throw Error('Unsupported photo format.');
   const bytes=base64ToBytes(payload.bytes);if(photoProof)await verifyPhotoBytes(photoProof,bytes);
   const decoded=await validatedMedia(bytes,media.mime);if(decoded.width!==media.width||decoded.height!==media.height)throw Error('Photo dimensions did not match its signed metadata.');
   return {...decoded,parentId:envelope.context.parentId,expiresAt:envelope.context.expiresAt?Date.parse(envelope.context.expiresAt):null};
  }).then(value=>{
   if(!alive)return;
   const expire=()=>{if(!alive||value.expiresAt===null)return;const left=value.expiresAt-Date.now();if(!Number.isFinite(left)||left<=0){if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl='';setOpened(null);setError('This photo expired.');}else timer=setTimeout(expire,Math.min(left,2147483647));};
   if(value.expiresAt!==null&&value.expiresAt<=Date.now())throw Error('This photo expired.');objectUrl=URL.createObjectURL(value.blob);setOpened({id:media.id,url:objectUrl});expire();
  }).catch(e=>{if(alive)setError(e instanceof Error?e.message:'Unable to open photo.');});
  return()=>{alive=false;controller.abort();if(timer)clearTimeout(timer);if(objectUrl)URL.revokeObjectURL(objectUrl);};
 },[photo.media.id,scope]);
 return <PhotoViewer photoKey={photo.media.id} src={url} alt={photo.media.alt||''} {...controls} notice={error||controls.notice||(!url?'Opening photo…':'')}/>;
}
