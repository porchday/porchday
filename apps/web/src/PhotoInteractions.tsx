import React,{useEffect,useRef,useState} from "react";
import {get,request,del,items,message,type EncryptedEnvelope,type Device,type Content} from "./api";
import {useVault} from "./vault";
import {Alert,Button,Icon,useAction} from "./ui";
import type {PhotoRow} from "./photo-record";
export const photoEmoji=[{id:"like",icon:"👍"},{id:"love",icon:"❤️"},{id:"laugh",icon:"😄"},{id:"celebrate",icon:"🎉"},{id:"care",icon:"🤗"},{id:"sunshine",icon:"☀️"}];
type Row={id:string;photo_id:string;author_id:string;author_handle?:string;author_key:Device;kind:"comment"|"reaction";envelope:EncryptedEnvelope;content?:Content;error?:string};
export function validatePhotoInteraction(row:Row,photo:PhotoRow){
 const c=row.envelope.context;
 if(c.id!==row.id||c.authorId!==row.author_id||row.photo_id!==photo.id||c.parentId!==photo.id||c.audience!=="photo"||c.groupId!==null||c.kind!==row.kind||!["comment","reaction"].includes(c.kind)||c.revision!==1||
 (c.expiresAt?Date.parse(c.expiresAt):null)!==(photo.expires_at?Date.parse(photo.expires_at):null))throw Error("Photo conversation identity did not match its signed content.");
}
export function PhotoInteractions({photo}:{photo:PhotoRow}){
 const vault=useVault(),action=useAction();const [expanded,setExpanded]=useState(false),[rows,setRows]=useState<Row[]>([]),[next,setNext]=useState<string|null>(null),[text,setText]=useState("");
 const generation=useRef(0),pending=useRef<{envelope:EncryptedEnvelope;text:string}|null>(null);
 async function load(after?:string){const token=++generation.current;try{const result=await get(`/photos/${photo.id}/interactions`+(after?"?after="+encodeURIComponent(after):""));
  const opened=await Promise.all(items<Row>(result).map(async row=>{try{validatePhotoInteraction(row,photo);return {...row,content:await vault.open(row)};}catch(error){return {...row,error:message(error)};}}));
  if(token===generation.current){setRows(old=>after?[...old,...opened.filter(r=>!old.some(o=>o.id===r.id))]:opened);setNext(result.next||null);}
 }catch(error){if(token===generation.current)setRows([]);throw error;}}
 useEffect(()=>{if(expanded)void action.run(()=>load());return()=>{generation.current++;};},[expanded,photo.id,vault.member.id]);
 const own=rows.find(r=>r.kind==="reaction"&&r.author_id===vault.member.id),write=vault.member.status==="active";
 async function send(kind:"comment"|"reaction",value:string){await action.runSave(async()=>{
  if(kind==="reaction"&&own?.content?.emoji===value){await del(`/photos/${photo.id}/interactions/${own.id}`);await load();return;}
  const key=kind+":"+value;
  if(!pending.current||pending.current.text!==key)pending.current={text:key,envelope:await vault.seal(kind==="comment"?{text:value}:{emoji:value},{kind,audience:"photo",parentId:photo.id,expiresAt:photo.expires_at?new Date(photo.expires_at).toISOString():null},photo.id)};
  try{await request(`/photos/${photo.id}/interactions`,{method:"POST",body:JSON.stringify({envelope:pending.current.envelope})});}
  catch(error){if(error&&typeof error==="object"&&"code" in error&&["AUDIENCE_CHANGED","INVALID_CREATION_TIME"].includes(String(error.code)))pending.current=null;throw error;}
  pending.current=null;if(kind==="comment")setText("");await load();
 });}
 return <section className="photo-conversation" aria-label="Photo comments and reactions">
  <Button variant="quiet" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}><Icon name="comment"/> Comments & reactions</Button>
  {expanded&&<div className="form-stack"><Alert>{action.error}</Alert>
   <p className="small-copy">Shared with people who can see this photo, including through its albums. New viewers may not see earlier comments.</p>
   <div className="row">{photoEmoji.map(emoji=><Button key={emoji.id} variant="quiet" aria-label={`React ${emoji.icon}`} aria-pressed={own?.content?.emoji===emoji.id} disabled={!write||action.busy} onClick={()=>send("reaction",emoji.id)}>{emoji.icon}</Button>)}</div>
   {rows.filter(r=>r.kind==="reaction").map(row=><span key={row.id} className="small-copy">{row.error?"Unable to open reaction":`${photoEmoji.find(e=>e.id===row.content?.emoji)?.icon||"Reaction"} @${row.author_handle||"member"}`} </span>)}
   {rows.filter(r=>r.kind==="comment").map(row=><div key={row.id}><strong>@{row.author_handle||"member"}</strong><p style={{whiteSpace:"pre-wrap"}}>{row.error||String(row.content?.text||"")}</p>{write&&(row.author_id===vault.member.id||photo.owner_id===vault.member.id)&&<Button variant="quiet" disabled={action.busy} onClick={()=>action.runSave(async()=>{await del(`/photos/${photo.id}/interactions/${row.id}`);await load();})}>Delete comment</Button>}</div>)}
   {next&&<Button busy={action.busy} onClick={()=>action.run(()=>load(next))}>Load more comments and reactions</Button>}
   {write&&<form className="form-stack" onSubmit={e=>{e.preventDefault();if(text.trim())void send("comment",text.trim());}}><label>Comment<textarea maxLength={5000} value={text} disabled={action.busy} onChange={e=>setText(e.target.value)} placeholder="Write a comment…"/></label><Button variant="primary" type="submit" disabled={!text.trim()} busy={action.busy}>Comment</Button></form>}
  </div>}
 </section>;
}
