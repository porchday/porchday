import React,{useEffect,useState} from 'react';
import {get} from './api';
import {useVault} from './vault';
import {Alert,Button,Field,useAction} from './ui';
import {localPhotoDate} from './photo-publish';
import {updateAttachmentDate,verifyAttachmentDate} from './attachment-photo-date';
export function AttachmentDateEditor({mediaId,postId,createdAt}:{mediaId:string;postId:string;createdAt:string}){
 const vault=useVault(),action=useAction(),[date,setDate]=useState(localPhotoDate(new Date(createdAt))),[loaded,setLoaded]=useState(false);
 useEffect(()=>{let alive=true;void action.run(async()=>{const result=await get(`/media/${mediaId}/photo-date`);if(result.date?.photo_date){await verifyAttachmentDate(vault,result.date,mediaId,postId,vault.member.id,result.date.photo_date);if(alive)setDate(result.date.photo_date);}if(alive)setLoaded(true);});return()=>{alive=false;};},[mediaId,postId,vault.member.id]);
 return <section className="form-stack"><Field label="Photo date" type="date" min="0001-01-01" max="9999-12-31" value={date} disabled={!loaded||action.busy} onChange={e=>setDate(e.target.value)}/><p className="small-copy">Saved separately from the post. The post date and audience stay the same.</p><Button variant="quiet" disabled={!loaded||!date} busy={action.busy} onClick={()=>action.runSave(async()=>{await updateAttachmentDate(vault,mediaId,postId,date);window.dispatchEvent(new Event('porchday:posts-shared'));},'Photo date saved.')}>Save photo date</Button><Alert>{action.error}</Alert><Alert success>{action.notice}</Alert></section>;
}
