import React,{useEffect,useState} from "react";
import {get,items} from "./api";
import {useVault} from "./vault";
import {Alert,Button,Modal,useAction} from "./ui";
import type {AlbumRow} from "./Albums";
import {adoptAttachment} from "./photo-adopt";
export function AttachmentAlbumPicker({mediaId,postId,day,onClose,onSaved}:{mediaId:string;postId:string;day:string;onClose:()=>void;onSaved:()=>void}){
 const vault=useVault(),action=useAction(),[choices,setChoices]=useState<{id:string;name:string}[]>([]),[selected,setSelected]=useState("");
 useEffect(()=>{let alive=true;void action.run(async()=>{const available=[];let cursor:string|null=null;do{
  const page:any=await get("/albums"+(cursor?"?after="+encodeURIComponent(cursor):""));
  for(const row of items<AlbumRow>(page)){if(row.role==="read")continue;try{const metadata=await vault.open(row);available.push({id:row.id,name:String(metadata.name||"Album")});}catch{}}
  cursor=page.next||null;
 }while(cursor&&alive);if(alive)setChoices(available);});return()=>{alive=false;};},[vault.member.id]);
 return <Modal title="Add photo to an album" onClose={onClose}><div className="form-stack"><Alert>{action.error}</Alert><label>Album<select aria-label="Album" disabled={action.busy} value={selected} onChange={e=>setSelected(e.target.value)}><option value="">Choose an album</option>{choices.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><p>The original post keeps its audience. Everyone in this album will also be able to see the photo. Removing the post later does not remove the album photo; deleting the photo removes both.</p>{!action.busy&&!choices.length&&<p><a href="/albums">Create an album</a> first, or ask for permission to add photos to one.</p>}<Button variant="primary" busy={action.busy} disabled={!selected} onClick={()=>action.runSave(async()=>{await adoptAttachment(vault,postId,mediaId,day,selected);onSaved();onClose();})}>Add photo to album</Button></div></Modal>;
}
