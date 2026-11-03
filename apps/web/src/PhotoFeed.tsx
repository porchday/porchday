import {useCalendarScrollAnchor} from "./calendar-scroll-anchor";
import {AttachmentAlbumPicker} from "./AttachmentAlbumPicker";
import {verifyAttachmentDate,updateAttachmentDate,type AttachmentDate} from "./attachment-photo-date";
import type {PhotoProof} from "@porchday/crypto/photos";
import { useNearViewport } from "./near-viewport";
import React,{useEffect,useRef,useState} from "react";
import {get,items,message,type MediaPayload,type SocialObject} from "./api";
import {useVault} from "./vault";
import {Alert,Button,Empty,Field,Loading,Modal,useAction} from "./ui";
import {EncryptedPhoto} from "./Social";
import {PhotoCard,openPhoto,type PhotoRow} from "./PhotoCollection";
import {matchesAuthor,type AuthorFilter} from "./feed-filters";
import {localDay,monthCells,calendarDate} from "./photo-calendar";
export type Entry={attachment_date?:AttachmentDate|null;id:string;kind:"photo"|"attachment";day:string;author_id:string;author_handle?:string;photo:PhotoRow|null;post:SocialObject|null;media?:MediaPayload;photoProof?:PhotoProof;error?:string};
export function usePhotos(month?:string,enabled=true,owned=false){
 const vault=useVault(),action=useAction(),generation=useRef(0),loading=useRef(false);
 const [entries,setEntries]=useState<Entry[]>([]),[next,setNext]=useState<string|null>(null),[loaded,setLoaded]=useState(false);
 async function load(after?:string){
  if(after&&loading.current)return;
  const current=++generation.current;loading.current=true;
  await action.run(async()=>{
   const result=await get("/photo-feed?"+new URLSearchParams({timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,...(month?{month}:{}),...(owned?{owner:"me"}:{}),...(after?{after}:{})}));
   const posts=new Map<string,ReturnType<typeof vault.open>>();
   const decoded=await Promise.all(items<Entry>(result).filter(entry=>!owned||entry.author_id===vault.member.id).map(async entry=>{
    try{
     let media:MediaPayload|undefined,photoProof:PhotoProof|undefined;
     if(entry.photo){let last:unknown=Error("No encrypted photo is available.");for(const grant of entry.photo.grants){try{const content=await openPhoto(vault,entry.photo,grant);media=content.media![0];photoProof=content.photoProof as PhotoProof;break;}catch(error){last=error;}}if(!media)throw last;}
     else if(entry.post){if(entry.attachment_date)await verifyAttachmentDate(vault,entry.attachment_date,entry.id,entry.post.id,entry.author_id,entry.day);if(!posts.has(entry.post.id))posts.set(entry.post.id,vault.open(entry.post));media=(await posts.get(entry.post.id)!).media?.find(m=>m.id===entry.id);}
     if(!media)throw Error("This attachment was not present in the signed post.");
     return {...entry,media,photoProof};
    }catch(error){return {...entry,error:message(error)};}
   }));
   if(current!==generation.current)return;
   setEntries(old=>after?[...old,...decoded.filter(e=>!old.some(o=>o.id===e.id&&o.kind===e.kind))]:decoded);setNext(result.next||null);setLoaded(true);
  });
  if(current===generation.current)loading.current=false;
 }
 useEffect(()=>{if(!enabled)return;setLoaded(false);setEntries([]);setNext(null);void load();const refresh=()=>void load();window.addEventListener("porchday:posts-shared",refresh);return()=>{generation.current++;loading.current=false;window.removeEventListener("porchday:posts-shared",refresh);};},[month,vault.member.id,enabled,owned]);
 return {entries,next,loaded,busy:action.busy,error:action.error,load};
}
function EntryCard({entry,refresh}:{entry:Entry;refresh:()=>void}){
 const vault=useVault(),action=useAction(),[editing,setEditing]=useState(false),[date,setDate]=useState(entry.day),[adding,setAdding]=useState(false);
 return <div><p className="muted">{entry.author_handle?"@"+entry.author_handle:"Member"}</p>{entry.photo?<PhotoCard photo={entry.photo} onChanged={refresh}/>:<article className="panel independent-photo"><Alert>{entry.error||action.error}</Alert>{entry.media&&<EncryptedPhoto media={entry.media}/>}<p>{!entry.error&&<><time dateTime={entry.day}>{entry.day}</time> · </>}<a href={"/post/"+entry.post!.id}>View post</a></p>{entry.author_id===vault.member.id&&vault.member.status==="active"&&<><Button variant="quiet" onClick={()=>setEditing(true)}>Edit photo date</Button>{entry.media&&!entry.error&&<Button variant="quiet" onClick={()=>setAdding(true)}>Add to album</Button>}</>}</article>}
 {adding&&<AttachmentAlbumPicker mediaId={entry.id} postId={entry.post!.id} day={entry.day} onClose={()=>setAdding(false)} onSaved={refresh}/>}
 {editing&&<Modal title="Edit photo date" onClose={()=>setEditing(false)}><form className="form-stack" onSubmit={e=>{e.preventDefault();void action.runSave(async()=>{await updateAttachmentDate(vault,entry.id,entry.post!.id,date);setEditing(false);refresh();});}}><Field label="Photo date" type="date" min="0001-01-01" max="9999-12-31" required value={date} disabled={action.busy} onChange={e=>setDate(e.target.value)}/><p>This changes where the photo appears in the photo calendar. The post date and audience stay the same.</p><Alert>{action.error}</Alert><Button type="submit" busy={action.busy}>Save date</Button></form></Modal>}
 </div>;
}
export function PhotoFeed({authorFilter}:{authorFilter:AuthorFilter}){
 const data=usePhotos(),sentinel=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  if(!data.next||data.busy||data.error||!sentinel.current)return;
  const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting))void data.load(data.next!);},{rootMargin:"600px"});observer.observe(sentinel.current);return()=>observer.disconnect();
 },[data.next,data.busy,data.error]);
 const visible=data.entries.filter(e=>matchesAuthor(e,authorFilter));
 return <><Alert>{data.error}</Alert><div className="album-photo-grid">{visible.map(entry=><EntryCard key={entry.kind+entry.id} entry={entry} refresh={()=>data.load()}/>)}</div>{data.busy&&<Loading/>}{data.loaded&&!data.next&&!visible.length&&<Empty icon="photo" title="No photos in this view"><a href="/share">Add photos from Share</a>, or change “Show photos by”.</Empty>}<div ref={sentinel}/>{data.next&&<Button busy={data.busy} onClick={()=>data.load(data.next!)}>Load more photos</Button>}</>;
}
function PhotoMonth({month,authorFilter}:{month:Date;authorFilter:AuthorFilter}){
 const {ref,near}=useNearViewport<HTMLElement>();
 const key=localDay(month).slice(0,7),data=usePhotos(key,near),[selected,setSelected]=useState<string|null>(null);
 const visible=data.entries.filter(e=>matchesAuthor(e,authorFilter));
 const label=month.toLocaleDateString(undefined,{month:"long",year:"numeric"});
 return <section ref={ref} className="panel photo-calendar"><h2>{label}</h2><Alert>{data.error}</Alert>
  <div className="calendar-grid" aria-label={label}>
   {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d=><div className="calendar-weekday" key={d}>{d}</div>)}
   {monthCells(month.getFullYear(),month.getMonth()).map((day,i)=>{if(!day)return <div className="calendar-outside" key={i}/>;const rows=visible.filter(e=>e.day===day);return <button type="button" className={"calendar-day"+(day===localDay(new Date())?" calendar-today":"")} key={day} aria-label={`${day}: ${rows.length} photos${data.next?", more may be available":""}`} onClick={()=>setSelected(day)}><span className="calendar-day-number">{Number(day.slice(-2))}</span>{rows.find(e=>e.media)?.media&&<EncryptedPhoto media={rows.find(e=>e.media)!.media!} photoProof={rows.find(e=>e.media)!.photoProof} thumbnail/>}{rows.length>1&&<span className="calendar-day-count">{rows.length}</span>}</button>;})}
  </div>{data.busy&&<Loading/>}{data.next&&<Button busy={data.busy} onClick={()=>data.load(data.next!)}>Load more photos in {label}</Button>}
  {selected&&<Modal title={selected} onClose={()=>setSelected(null)}>{visible.filter(e=>e.day===selected).map(entry=><EntryCard key={entry.kind+entry.id} entry={entry} refresh={()=>data.load()}/>)}{!visible.some(e=>e.day===selected)&&<p>No photos loaded for this day.</p>}{data.next&&<Button busy={data.busy} onClick={()=>data.load(data.next!)}>Load more photos in this month</Button>}</Modal>}
 </section>;
}
export function PhotoFeedCalendar({authorFilter}:{authorFilter:AuthorFilter}){
 const [anchor,setAnchor]=useState(()=>calendarDate(new Date().getFullYear(),new Date().getMonth())),[count,setCount]=useState(1);
 const {root,capture}=useCalendarScrollAnchor(count);
 function earlier(){capture();setCount(n=>n+1);}
 function move(offset:number){setAnchor(calendarDate(anchor.getFullYear(),anchor.getMonth()+offset));setCount(1);}
 return <><nav className="calendar-month" aria-label="Photo calendar navigation"><Button onClick={()=>move(-1)} aria-label="Previous month">←</Button><Button onClick={()=>{setAnchor(calendarDate(new Date().getFullYear(),new Date().getMonth()));setCount(1);}}>This month</Button><Button onClick={()=>move(1)} aria-label="Next month">→</Button><label>Jump to month<input type="month" value={localDay(anchor).slice(0,7)} onChange={e=>{if(/^\d{4}-\d{2}$/.test(e.target.value)){setAnchor(new Date(e.target.value+"-01T12:00:00"));setCount(1);}}}/></label></nav><div className="calendar-earlier"><Button onClick={earlier}>Load earlier month</Button></div><div ref={root}>{Array.from({length:count},(_,i)=>calendarDate(anchor.getFullYear(),anchor.getMonth()-count+1+i)).map(month=><PhotoMonth key={localDay(month)} month={month} authorFilter={authorFilter}/>)}</div></>;
}
