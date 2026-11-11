import {TagPicker,Tags,useMentionResolver,type PersonTag} from "./PeopleTags";
import {PostText} from "./PostText";
import {useNearViewport} from "./near-viewport";
import {ReactionChips} from "./ReactionChips";
import {EmojiPicker} from "./EmojiPicker";
import {validateReactionPayload,type ReactionPayload} from "@porchday/crypto/reactions";
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
 const {ref,near}=useNearViewport<HTMLElement>();
 const vault=useVault(),action=useAction();const [expired,setExpired]=useState(false),[expanded,setExpanded]=useState(false),[rows,setRows]=useState<Row[]>([]),[ownReaction,setOwnReaction]=useState<Row|null>(null),[next,setNext]=useState<string|null>(null),[text,setText]=useState("");
 const resolveMentions=useMentionResolver();
 const [tags,setTags]=useState<PersonTag[]>([]);
 const [picker,setPicker]=useState(false);const addButton=useRef<HTMLButtonElement>(null);
 const generation=useRef(0),pending=useRef<{envelope:EncryptedEnvelope;text:string}|null>(null);
 async function load(after?:string){const token=++generation.current;try{const result=await get(`/photos/${photo.id}/interactions`+(after?"?after="+encodeURIComponent(after):""));
  const opened=await Promise.all(items<Row>(result).map(async row=>{try{validatePhotoInteraction(row,photo);const content=await vault.open(row);if(row.kind==="reaction")await validateReactionPayload(content);return {...row,content};}catch(error){return {...row,error:message(error)};}}));
  let own:Row|null=null;if(result.own_reaction){const row=result.own_reaction as Row;validatePhotoInteraction(row,photo);if(row.author_id!==vault.member.id||row.kind!=="reaction")throw Error("Reaction identity did not match.");own={...row};try{own.content=await vault.open(row);await validateReactionPayload(own.content);}catch(error){own.error=message(error);}}
  if(token===generation.current){setOwnReaction(own);setRows(old=>after?[...old,...opened.filter(r=>!old.some(o=>o.id===r.id))]:opened);setNext(result.next||null);}
 }catch(error){if(token===generation.current){setRows([]);setOwnReaction(null);}throw error;}}
 useEffect(()=>{const deadline=photo.expires_at?Date.parse(photo.expires_at):null;const check=()=>setExpired(deadline!==null&&Date.now()>=deadline);check();if(deadline===null)return;const timer=setInterval(check,1000);return()=>clearInterval(timer);},[photo.id,photo.expires_at]);
 useEffect(()=>{if(expired){generation.current++;pending.current=null;setRows([]);setOwnReaction(null);setText("");}},[expired]);
 useEffect(()=>{pending.current=null;setText("");setTags([]);setRows([]);setOwnReaction(null);setNext(null);},[photo.id,vault.member.id]);
 useEffect(()=>{if(near&&!expired)void action.run(()=>load());return()=>{generation.current++;};},[near,expired,photo.id,vault.member.id,vault.device.id]);
 const own=ownReaction||rows.find(r=>r.kind==="reaction"&&r.author_id===vault.member.id),write=vault.member.status==="active";
 async function send(kind:"comment"|"reaction",value:string|ReactionPayload){await action.runSave(async()=>{
  if(kind==="reaction"&&own?.content?.emoji===(typeof value==="string"?value:value.emoji)){await del(`/photos/${photo.id}/interactions/${own.id}`);await load();return;}
  const commentTags=kind==="comment"?await resolveMentions(String(value),tags):[];
  const key=kind+":"+JSON.stringify([value,commentTags]);
  if(!pending.current||pending.current.text!==key)pending.current={text:key,envelope:await vault.seal(kind==="comment"?{text:value,tags:commentTags}:await validateReactionPayload(value),{kind,audience:"photo",parentId:photo.id,expiresAt:photo.expires_at?new Date(photo.expires_at).toISOString():null},photo.id)};
  try{await request(`/photos/${photo.id}/interactions`,{method:"POST",body:JSON.stringify({envelope:pending.current.envelope})});}
  catch(error){if(error&&typeof error==="object"&&"code" in error&&["AUDIENCE_CHANGED","INVALID_CREATION_TIME"].includes(String(error.code)))pending.current=null;throw error;}
  pending.current=null;if(kind==="comment"){setText("");setTags([]);}else setPicker(false);await load();
 });}
 if(expired)return <p>This photo has expired.</p>;
 const reactions=[...rows.filter(r=>r.kind==="reaction"&&!r.error),...(ownReaction&&!ownReaction.error&&!rows.some(r=>r.id===ownReaction.id)?[ownReaction]:[])];
 const comments=rows.filter(r=>r.kind==="comment");
 return <section ref={ref} className="photo-conversation" aria-label="Photo comments and reactions">
  <div className="post-actions"><div className="reaction-area"><div className="reaction-chips">
   <ReactionChips key={photo.id+':'+vault.member.id+':'+vault.device.id} viewerId={vault.member.id} entries={reactions.map(row=>({memberId:row.author_id,handle:row.author_id===vault.member.id?vault.member.handle:row.author_handle,payload:row.content as ReactionPayload}))} more={next?()=>void action.run(()=>load(next)):undefined} busy={action.busy} disabled={!write||action.busy} onToggle={value=>void send("reaction",value)}/>
   <button type="button" ref={addButton} className="reaction-add" aria-label="Add a reaction" aria-expanded={picker} disabled={!write||action.busy} onClick={()=>setPicker(true)}><Icon name="smile" size={18}/><Icon name="plus" size={10}/></button>
  </div></div><button type="button" className="text-button comment-toggle" aria-label="Comment" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}><Icon name="comment" size={18}/>{comments.length||""} <span>Comment</span></button></div>
  {picker&&<EmojiPicker onSelect={value=>send("reaction",value)} onClose={()=>setPicker(false)} busy={action.busy} error={action.error} returnFocusRef={addButton}/>}
  {!picker&&<Alert>{action.error}</Alert>}
  {rows.some(r=>r.kind==="reaction"&&r.error)&&<p className="small-copy">Some reactions could not be opened.</p>}
  {next&&!expanded&&<button type="button" className="text-button" disabled={action.busy} onClick={()=>action.run(()=>load(next))}>Load more reactions and comments</button>}
  {expanded&&<section className="comments" aria-label="Comments">
   {comments.map(row=><article key={row.id} className="comment"><strong>@{row.author_handle||"member"}</strong><p style={{whiteSpace:"pre-wrap"}}>{row.error||<PostText text={String(row.content?.text||"")} tags={row.content?.tags}/>}</p><Tags value={row.content?.tags}/>{write&&(row.author_id===vault.member.id||photo.owner_id===vault.member.id)&&<Button variant="quiet" disabled={action.busy} onClick={()=>action.runSave(async()=>{await del(`/photos/${photo.id}/interactions/${row.id}`);await load();})}>Delete comment</Button>}</article>)}
   {next&&<Button busy={action.busy} onClick={()=>action.run(()=>load(next))}>Load more comments and reactions</Button>}
   {write&&<form className="form-stack comment-composer" onSubmit={e=>{e.preventDefault();if(text.trim())void send("comment",text.trim());}}><label>Comment<textarea data-diagnostic-input="photo-comment" maxLength={5000} value={text} disabled={action.busy} onChange={e=>setText(e.target.value)} placeholder="Write a comment…"/></label><TagPicker text={text} value={tags} onChange={setTags} disabled={action.busy}/><Button variant="primary" type="submit" disabled={!text.trim()} busy={action.busy}>Comment</Button></form>}
  </section>}
 </section>;
}
