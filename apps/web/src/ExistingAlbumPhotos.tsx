import React,{useRef,useState} from "react";
import {usePhotos} from "./PhotoFeed";
import {EncryptedPhoto} from "./Social";
import {addPhotoToAlbum} from "./photo-album";
import {adoptAttachment} from "./photo-adopt";
import {useVault} from "./vault";
import {Alert,Button,Loading,Modal,useAction} from "./ui";

export function ExistingAlbumPhotos({albumId,onClose,onAdded}:{albumId:string;onClose:()=>void;onAdded:()=>Promise<void>}){
 const vault=useVault(),data=usePhotos(undefined,true,true),action=useAction(),saving=useRef(false);
 const [selected,setSelected]=useState<Set<string>>(new Set()),[added,setAdded]=useState<Set<string>>(new Set());
 const key=(entry:typeof data.entries[number])=>entry.kind+":"+entry.id;
 async function save(){
  if(saving.current||!selected.size)return;
  saving.current=true;
  await action.runSave(async()=>{
   let completed=0;
   try{
    for(const entry of data.entries.filter(e=>selected.has(key(e)))){
     if(entry.photo)await addPhotoToAlbum(vault,entry.photo.id,albumId);
     else if(entry.post)await adoptAttachment(vault,entry.post.id,entry.id,entry.day,albumId);
     else throw Error("This photo is no longer available.");
     const id=key(entry);completed++;
     setAdded(old=>new Set([...old,id]));
     setSelected(old=>{const next=new Set(old);next.delete(id);return next;});
     action.setNotice(`${completed} ${completed===1?"photo added":"photos added"}.`);
    }
   }finally{if(completed)await onAdded();}
  });
  saving.current=false;
 }
 return <Modal title="Choose existing photos" onClose={()=>{if(!saving.current)onClose();}}>
  <p>Select from your past uploads, including photos attached to posts. Their existing audiences keep access.</p>
  <Alert>{data.error||action.error}</Alert><Alert success>{action.notice}</Alert>
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
  <div className="album-actions"><Button variant="primary" busy={action.busy} disabled={!selected.size} onClick={save}>Add {selected.size||"selected"} {selected.size===1?"photo":"photos"}</Button><Button disabled={action.busy} onClick={()=>{if(!saving.current)onClose();}}>Done</Button></div>
 </Modal>;
}
