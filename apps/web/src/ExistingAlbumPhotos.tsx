import React,{useRef,useState} from "react";
import {usePhotos} from "./PhotoFeed";
import {EncryptedPhoto} from "./Social";
import {addPhotoToAlbum} from "./photo-album";
import {adoptAttachment} from "./photo-adopt";
import {useVault} from "./vault";
import {Alert,Button,Loading,Modal,useAction} from "./ui";

export function ExistingAlbumPhotos({albumId,onClose,onAdded}:{albumId:string;onClose:()=>void;onAdded:(count:number)=>void}){
 const vault=useVault(),data=usePhotos(undefined,true,true),action=useAction(),saving=useRef(false);
 const [selected,setSelected]=useState<Set<string>>(new Set()),[added,setAdded]=useState<Set<string>>(new Set());
 const [progress,setProgress]=useState<{current:number;total:number}|null>(null);
 const key=(entry:typeof data.entries[number])=>entry.kind+":"+entry.id;
 async function save(){
  if(saving.current||!selected.size)return;
  saving.current=true;
  const total=selected.size;
  let completed=0;
  const succeeded=await action.runSave(async()=>{
   const entries=data.entries.filter(e=>selected.has(key(e)));
   if(entries.length!==total)throw Error("Some selected photos are no longer available. Close the picker and choose again.");
   for(const entry of entries){
    setProgress({current:completed+1,total});
    if(entry.photo)await addPhotoToAlbum(vault,entry.photo.id,albumId);
    else if(entry.post)await adoptAttachment(vault,entry.post.id,entry.id,entry.day,albumId);
    else throw Error("This photo is no longer available.");
    const id=key(entry);completed++;
    setAdded(old=>new Set([...old,id]));
    setSelected(old=>{const next=new Set(old);next.delete(id);return next;});
   }
   return true;
  });
  saving.current=false;
  setProgress(null);
  if(completed)onAdded(completed);
  if(succeeded)onClose();
  else if(completed)action.setNotice(`${completed} of ${total} photos added. The remaining ${total-completed} ${total-completed===1?"photo is":"photos are"} still selected for retry.`);
 }
 return <Modal title="Choose existing photos" onClose={()=>{if(!saving.current)onClose();}}>
  <p>Select from your past uploads, including photos attached to posts. Their existing audiences keep access.</p>
  <Alert>{data.error||action.error}</Alert>{progress?<p role="status">Adding photo {progress.current} of {progress.total}…</p>:<Alert success>{action.notice}</Alert>}
  <div className="existing-photo-grid">{data.entries.map(entry=>{
   const id=key(entry),included=added.has(id)||entry.photo?.grants.some(g=>g.album_id===albumId),unavailable=!!entry.error||!entry.media;
   return <div className="existing-photo-choice" key={id}>
    {entry.media&&<EncryptedPhoto media={entry.media} photoProof={entry.photoProof} thumbnail/>}
    <label><input type="checkbox" checked={!!included||selected.has(id)} disabled={action.busy||!!included||unavailable} onChange={event=>{const checked=event.target.checked;setSelected(old=>{const next=new Set(old);if(checked)next.add(id);else next.delete(id);return next;});}}/>
     <span><time dateTime={entry.day}>{entry.day}</time><small>{included?"Already in this album":unavailable?"Photo unavailable":entry.kind==="attachment"?"From a post":"Photo upload"}</small></span>
    </label>
   </div>;
  })}</div>
  {data.busy&&<Loading/>}
  {data.loaded&&!data.entries.length&&!data.next&&<p>No past uploads are available.</p>}
  {data.next&&<Button busy={data.busy} disabled={action.busy} onClick={()=>data.load(data.next!)}>Load older photos</Button>}
  <div className="album-actions"><Button variant="primary" aria-busy={action.busy} disabled={action.busy||!selected.size} onClick={save}>{progress?`Adding ${progress.current} of ${progress.total}…`:`Add ${selected.size||"selected"} ${selected.size===1?"photo":"photos"}`}</Button><Button disabled={action.busy} onClick={()=>{if(!saving.current)onClose();}}>Done</Button></div>
 </Modal>;
}
