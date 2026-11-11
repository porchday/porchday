import {canonicalJson} from "@porchday/crypto";
import {PhotoInteractions} from "./PhotoInteractions";
import {updatePhoto} from "./photo-update";
import {type PhotoProof} from "@porchday/crypto/photos";
import React,{useEffect,useRef,useState} from "react";
import {get,request,del,items,message,type Content,type EncryptedEnvelope} from "./api";
import {useVault} from "./vault";
import {Alert,Button,Empty,Field,Loading,Modal,useAction} from "./ui";
import {EncryptedPhoto} from "./Social";
import {TagPicker,validTags,useMentionResolver} from "./PeopleTags";
import type {AlbumRow} from "./Albums";
import {openPhoto,type PhotoRow} from "./photo-record";
export {openPhoto,type PhotoRow,type PhotoGrant} from "./photo-record";
import {addPhotoToAlbum} from "./photo-album";
export function PhotoCard({photo,onChanged,album,header}:{photo:PhotoRow;onChanged:()=>void;album?:AlbumRow;header?:React.ReactNode}){
  const vault=useVault(),action=useAction(),resolveMentions=useMentionResolver();
  const photoIdentity=canonicalJson(JSON.parse(JSON.stringify(photo)))+vault.member.id+vault.keys.map(key=>key.getFingerprint()).sort().join(',');
  const [opened,setOpened]=useState<{identity:string;content:Content}|null>(null),[error,setError]=useState("");
  const content=opened?.identity===photoIdentity?opened.content:null;
  const [adding,setAdding]=useState(false),[destination,setDestination]=useState("");
  const [choices,setChoices]=useState<{id:string;name:string}[]>([]);
  async function chooseAlbum(){setAdding(true);setDestination("");await action.run(async()=>{
    const available=[];let after:string|null=null;
    do{const result:any=await get("/albums"+(after?"?after="+encodeURIComponent(after):""));for(const row of items<AlbumRow>(result)){
      if(row.role==="read"||photo.grants.some(g=>g.album_id===row.id))continue;
      try{const metadata=await vault.open(row);available.push({id:row.id,name:String(metadata.name||"Album")});}catch{/* A destination must have usable encryption keys. */}
    }after=result.next||null;}while(after);setChoices(available);
  });}
  const [editing,setEditing]=useState(false),[date,setDate]=useState(photo.photo_date),[caption,setCaption]=useState("");
  const [tags,setTags]=useState<ReturnType<typeof validTags>>([]),[confirm,setConfirm]=useState<"delete"|"remove"|null>(null);
  useEffect(()=>{let alive=true;setOpened(null);setError("");void(async()=>{
    let last:unknown=Error("No encrypted photo is available.");
    for(const grant of photo.grants){try{const decoded=await openPhoto(vault,photo,grant);if(alive){setOpened({identity:photoIdentity,content:decoded});setDate(photo.photo_date);setCaption(decoded.media![0].alt);setTags(validTags(decoded.media![0].tags));}return;}catch(e){last=e;}}
    if(alive)setError(message(last));
  })();return()=>{alive=false;};},[photoIdentity,vault.member.id,vault.privateKey]);
  async function save(){await action.runSave(async()=>{
    const resolvedTags=await resolveMentions(caption,tags);
    await updatePhoto(vault,photo,date,m=>({...m,alt:caption,tags:resolvedTags}));setEditing(false);onChanged();
  },"Photo updated.");}
  const own=photo.owner_id===vault.member.id,write=vault.member.status==="active";
  return <article data-feed-readable={content ? "true" : "false"} className={"panel independent-photo"+(header?" feed-photo-card":"")}>{header&&<header className="post-heading">{header}</header>}<Alert>{error||action.error}</Alert><Alert success>{action.notice}</Alert>
    {content?<EncryptedPhoto media={content.media![0]} photoProof={content.photoProof as PhotoProof}/>:!error&&<Loading/>}
    {!header&&<p><time dateTime={photo.photo_date}>{photo.photo_date}</time></p>}
    {content&&<PhotoInteractions photo={photo}/>}
    {own&&write&&content&&<><Button variant="quiet" onClick={()=>setEditing(true)}>Edit photo</Button><Button variant="quiet" onClick={chooseAlbum}>Add to album</Button></>}
    {album&&write&&(own||album.role==="admin")&&<Button variant="quiet" onClick={()=>setConfirm("remove")}>Remove from album</Button>}
    {own&&write&&<Button variant="quiet" onClick={()=>setConfirm("delete")}>Delete photo</Button>}
    {adding&&<Modal title="Add photo to an album" onClose={()=>setAdding(false)}><div className="form-stack"><Alert>{action.error}</Alert><label>Album<select aria-label="Album" value={destination} disabled={action.busy} onChange={e=>setDestination(e.target.value)}><option value="">Choose an album</option>{choices.map(choice=><option key={choice.id} value={choice.id}>{choice.name}</option>)}</select></label>{!action.busy&&!choices.length&&<p>No other writable albums are available. Create one in Albums first.</p>}<p>Everyone in the selected album will be able to see this photo. Its original audience and other albums keep their access. Future album members may receive album history.</p><Button variant="primary" disabled={!destination} busy={action.busy} onClick={()=>action.runSave(async()=>{await addPhotoToAlbum(vault,photo.id,destination);setAdding(false);onChanged();},"Photo added to album.")}>Add photo to album</Button></div></Modal>}
    {editing&&<Modal title="Edit photo" onClose={()=>setEditing(false)}><form className="form-stack" onSubmit={e=>{e.preventDefault();void save();}}><Field disabled={action.busy} label="Photo date" type="date" required value={date} onChange={e=>setDate(e.target.value)}/><Field disabled={action.busy} label="Caption" maxLength={1000} value={caption} onChange={e=>setCaption(e.target.value)}/><TagPicker text={caption} value={tags} disabled={action.busy} onChange={setTags}/><p>Changing the date or caption keeps the photo’s existing sharing permissions.</p><Alert>{action.error}</Alert><Button type="submit" busy={action.busy} variant="primary">Save photo</Button></form></Modal>}
    {confirm&&<Modal title={confirm==="delete"?"Delete this photo?":"Remove from album?"} onClose={()=>setConfirm(null)}><p>{confirm==="delete"?"This deletes the photo, its original post attachment if present, and its album sharing paths. Copies already saved by others cannot be recalled.":"This removes only this album’s access. Other albums and the original audience keep their access."}</p><Alert>{action.error}</Alert><Button busy={action.busy} onClick={()=>action.runSave(async()=>{if(confirm==="delete")await del("/photos/"+photo.id);else{const grant=photo.grants.find(g=>g.album_id===album?.id);if(!grant)throw Error("Reload the album before removing this photo.");await del(`/photos/${photo.id}/grants/${grant.id}`);}setConfirm(null);onChanged();})}>Confirm</Button></Modal>}
  </article>;
}
export function PhotoCollection({album}:{album:AlbumRow}){
  const action=useAction(),generation=useRef(0);const [photos,setPhotos]=useState<PhotoRow[]>([]),[next,setNext]=useState<string|null>(null),[loaded,setLoaded]=useState(false);
  async function load(after?:string){const current=++generation.current;await action.run(async()=>{const result=await get("/photos?"+new URLSearchParams({album:album.id,...(after?{after}:{})}));if(current!==generation.current)return;setPhotos(old=>after?[...old,...items<PhotoRow>(result).filter(p=>!old.some(o=>o.id===p.id))]:items<PhotoRow>(result));setNext(result.next||null);setLoaded(true);});}
  useEffect(()=>{void load();return()=>{generation.current++;};},[album.id]);
  return <section><Alert>{action.error}</Alert>{!loaded&&<Loading/>}{loaded&&!photos.length&&<Empty icon="album" title="No photos yet">{album.role==="read"?"Photos added by album contributors will appear here.":<a href={"/share?album="+album.id}>Add photos from Share</a>}</Empty>}<div className="album-photo-grid">{photos.map(photo=><PhotoCard key={photo.id} photo={photo} album={album} onChanged={()=>load()}/>)}</div>{next&&<Button busy={action.busy} onClick={()=>load(next)}>Load more photos</Button>}</section>;
}

export function PhotoNotificationDetail({id}:{id:string}){
 const [photo,setPhoto]=useState<PhotoRow|null>(null),[closed,setClosed]=useState(false),action=useAction();
 const vault=useVault();
 async function load(){await action.run(async()=>{if(!/^[a-f0-9-]{36}$/i.test(id))throw Error("This photo link is unavailable.");const result=await get("/photos/"+id);setPhoto(result.photo);});}
 useEffect(()=>{setClosed(false);setPhoto(null);void load();},[id,vault.member.id]);
 if(closed)return null;
 return <Modal title="Photo" onClose={()=>{setClosed(true);history.replaceState(null,"",location.pathname);window.dispatchEvent(new PopStateEvent("popstate"));}}><Alert>{action.error}</Alert>{photo?<PhotoCard photo={photo} onChanged={load}/>:!action.error&&<Loading/>}</Modal>;
}
