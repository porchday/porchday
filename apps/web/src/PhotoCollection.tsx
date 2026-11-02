import React,{useEffect,useRef,useState} from "react";
import {get,request,del,items,message,type Content,type EncryptedEnvelope} from "./api";
import {useVault} from "./vault";
import {Alert,Button,Empty,Field,Loading,Modal,useAction} from "./ui";
import {EncryptedPhoto} from "./Social";
import {TagPicker,validTags} from "./PeopleTags";
import type {AlbumRow} from "./Albums";
export type PhotoGrant={id:string;photo_id:string;album_id:string|null;audience:string;envelope:EncryptedEnvelope;media_id:string};
export type PhotoRow={id:string;owner_id:string;photo_date:string;revision:number;created_at:string;expires_at:string|null;grants:PhotoGrant[]};
export async function openPhoto(vault:ReturnType<typeof useVault>,photo:PhotoRow,grant:PhotoGrant){
  const context=grant.envelope.context;
  if(context.kind!=="photo"||context.id!==grant.id||context.parentId!==photo.id||context.photoDate!==photo.photo_date||context.revision!==photo.revision)throw Error("Photo identity or date did not match its signed metadata.");
  const content=await vault.open({id:grant.id,author_id:photo.owner_id,envelope:grant.envelope});
  if(content.media?.length!==1||content.media[0].id!==grant.media_id)throw Error("Photo attachment did not match its signed metadata.");
  return content;
}
export function PhotoCard({photo,onChanged,album}:{photo:PhotoRow;onChanged:()=>void;album?:AlbumRow}){
  const vault=useVault(),action=useAction();
  const [content,setContent]=useState<Content|null>(null),[error,setError]=useState("");
  const [editing,setEditing]=useState(false),[date,setDate]=useState(photo.photo_date),[caption,setCaption]=useState("");
  const [tags,setTags]=useState<ReturnType<typeof validTags>>([]),[confirm,setConfirm]=useState<"delete"|"remove"|null>(null);
  useEffect(()=>{let alive=true;setContent(null);setError("");void(async()=>{
    let last:unknown=Error("No encrypted photo is available.");
    for(const grant of photo.grants){try{const decoded=await openPhoto(vault,photo,grant);if(alive){setContent(decoded);setDate(photo.photo_date);setCaption(decoded.media![0].alt);setTags(validTags(decoded.media![0].tags));}return;}catch(e){last=e;}}
    if(alive)setError(message(last));
  })();return()=>{alive=false;};},[photo,vault.member.id]);
  async function save(){await action.runSave(async()=>{
    const envelopes=[];
    for(const grant of photo.grants){const decoded=await openPhoto(vault,photo,grant);envelopes.push(await vault.sealPhotoUpdate({...decoded,media:decoded.media!.map(m=>({...m,alt:caption,tags}))},{...grant.envelope.context,photoDate:date,revision:photo.revision+1}));}
    await request("/photos/"+photo.id,{method:"PUT",body:JSON.stringify({photo_date:date,expected_revision:photo.revision,envelopes})});setEditing(false);onChanged();
  },"Photo updated.");}
  const own=photo.owner_id===vault.member.id,write=vault.member.status==="active";
  return <article className="panel independent-photo"><Alert>{error||action.error}</Alert><Alert success>{action.notice}</Alert>
    {content?<EncryptedPhoto media={content.media![0]}/>:!error&&<Loading/>}
    <p><time dateTime={photo.photo_date}>{photo.photo_date}</time></p>
    {own&&write&&content&&<Button variant="quiet" onClick={()=>setEditing(true)}>Edit photo</Button>}
    {album&&write&&(own||album.role==="admin")&&<Button variant="quiet" onClick={()=>setConfirm("remove")}>Remove from album</Button>}
    {own&&write&&<Button variant="quiet" onClick={()=>setConfirm("delete")}>Delete photo</Button>}
    {editing&&<Modal title="Edit photo" onClose={()=>setEditing(false)}><form className="form-stack" onSubmit={e=>{e.preventDefault();void save();}}><Field disabled={action.busy} label="Photo date" type="date" required value={date} onChange={e=>setDate(e.target.value)}/><Field disabled={action.busy} label="Caption" maxLength={1000} value={caption} onChange={e=>setCaption(e.target.value)}/><TagPicker value={tags} disabled={action.busy} onChange={setTags}/><p>Changing the date or caption keeps the photo’s existing sharing permissions.</p><Alert>{action.error}</Alert><Button type="submit" busy={action.busy} variant="primary">Save photo</Button></form></Modal>}
    {confirm&&<Modal title={confirm==="delete"?"Delete this photo?":"Remove from album?"} onClose={()=>setConfirm(null)}><p>{confirm==="delete"?"This deletes the photo and its album sharing paths. Copies already saved by others cannot be recalled.":"This removes only this album’s access. Other albums and the original audience keep their access."}</p><Alert>{action.error}</Alert><Button busy={action.busy} onClick={()=>action.runSave(async()=>{if(confirm==="delete")await del("/photos/"+photo.id);else{const grant=photo.grants.find(g=>g.album_id===album?.id);if(!grant)throw Error("Reload the album before removing this photo.");await del(`/photos/${photo.id}/grants/${grant.id}`);}setConfirm(null);onChanged();})}>Confirm</Button></Modal>}
  </article>;
}
export function PhotoCollection({album}:{album:AlbumRow}){
  const action=useAction(),generation=useRef(0);const [photos,setPhotos]=useState<PhotoRow[]>([]),[next,setNext]=useState<string|null>(null),[loaded,setLoaded]=useState(false);
  async function load(after?:string){const current=++generation.current;await action.run(async()=>{const result=await get("/photos?"+new URLSearchParams({album:album.id,...(after?{after}:{})}));if(current!==generation.current)return;setPhotos(old=>after?[...old,...items<PhotoRow>(result).filter(p=>!old.some(o=>o.id===p.id))]:items<PhotoRow>(result));setNext(result.next||null);setLoaded(true);});}
  useEffect(()=>{void load();return()=>{generation.current++;};},[album.id]);
  return <section><Alert>{action.error}</Alert>{!loaded&&<Loading/>}{loaded&&!photos.length&&<Empty icon="album" title="No photos yet">{album.role==="read"?"Photos added by album contributors will appear here.":<a href={"/app/share?album="+album.id}>Add photos from Share</a>}</Empty>}<div className="album-photo-grid">{photos.map(photo=><PhotoCard key={photo.id} photo={photo} album={album} onChanged={()=>load()}/>)}</div>{next&&<Button busy={action.busy} onClick={()=>load(next)}>Load more photos</Button>}</section>;
}
