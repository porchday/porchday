import React,{useEffect,useRef,useState} from "react";
import {reactionDisplay,type ReactionPayload} from "@porchday/crypto/reactions";
import {EmojiGlyph} from "./EmojiPicker";
import {MemberAvatar} from "./MemberAvatar";
import {Modal} from "./ui";
export type ReactionPerson={memberId:string;handle?:string;payload:ReactionPayload};
function Chip({value,count,selected,disabled,toggle,inspect}:{value:ReactionPayload;count:number;selected:boolean;disabled:boolean;toggle:()=>void;inspect:()=>void}){
 const timer=useRef<ReturnType<typeof setTimeout>|null>(null),start=useRef<{x:number;y:number;id:number}|null>(null),suppress=useRef(false);
 const cancel=()=>{if(timer.current)clearTimeout(timer.current);timer.current=null;start.current=null;};
 useEffect(()=>cancel,[]);
 const label=reactionDisplay(value).name;
 return <button type="button" className={`reaction-chip ${selected?'selected':''}`} aria-label={`${label}, ${count} ${count===1?'person':'people'}`} aria-pressed={selected} disabled={disabled}
  title={`${label} · Hold or right-click to see who reacted`}
  onPointerDown={e=>{cancel();suppress.current=false;if(e.pointerType==='mouse'||e.button!==0||!e.isPrimary)return;start.current={x:e.clientX,y:e.clientY,id:e.pointerId};timer.current=setTimeout(()=>{timer.current=null;suppress.current=true;inspect();},500);}}
  onPointerMove={e=>{const p=start.current;if(p&&Math.hypot(e.clientX-p.x,e.clientY-p.y)>10)cancel();}}
  onPointerUp={cancel} onPointerCancel={cancel} onPointerLeave={cancel}
  onContextMenu={e=>{e.preventDefault();cancel();suppress.current=true;inspect();}}
  onKeyDown={e=>{if(e.key==='Enter'&&e.shiftKey){e.preventDefault();cancel();inspect();}}}
  onClick={e=>{if(suppress.current){suppress.current=false;e.preventDefault();return;}toggle();}}>
  <EmojiGlyph value={value}/>{count}
 </button>;
}
/** Parent key scopes the dialog and pending gestures to the current account/content. */
export function ReactionChips({entries,confirmed=entries,viewerId,disabled=false,onToggle,onSave,more,busy=false}:{entries:ReactionPerson[];confirmed?:ReactionPerson[];viewerId:string;disabled?:boolean;onToggle:(value:ReactionPayload)=>void;onSave?:(value:ReactionPayload)=>void;more?:()=>void;busy?:boolean}){
 const [selection,setSelection]=useState<string|null>(null),viewButton=useRef<HTMLButtonElement>(null);
 const choices=[...new Map(entries.map(e=>[e.payload.emoji,e.payload])).values()];
 const verified=[...new Map(confirmed.map(e=>[e.memberId+':'+e.payload.emoji,e])).values()];
 const tabs=[...new Map(verified.map(e=>[e.payload.emoji,e.payload])).values()];
 const selected=tabs.find(v=>v.emoji===selection)||tabs[0];
 useEffect(()=>{if(!tabs.length)setSelection(null);},[tabs.length]);
 return <>
  {choices.map(value=>{const people=entries.filter(e=>e.payload.emoji===value.emoji);return <span className="reaction-choice" key={value.emoji}>
   <Chip value={value} count={new Set(people.map(e=>e.memberId)).size} selected={people.some(e=>e.memberId===viewerId)} disabled={disabled} toggle={()=>onToggle(value)} inspect={()=>setSelection(value.emoji)}/>
   {onSave&&'custom' in value&&<button type="button" className="reaction-save-image" disabled={disabled} aria-label={`Save ${value.custom.name} to my images`} title="Save to my images" onClick={()=>onSave(value)}>＋</button>}
  </span>;})}
  {verified.length>0&&<button ref={viewButton} type="button" className="text-button reaction-view" onClick={()=>setSelection(tabs[0].emoji)}>View reactions</button>}
  {selection!==null&&selected&&<Modal title="Reactions" onClose={()=>setSelection(null)} returnFocusRef={viewButton}>
   <div className="reaction-detail-tabs" role="group" aria-label="Choose an emoji">
    {tabs.map(value=><button type="button" key={value.emoji} aria-pressed={value.emoji===selected.emoji} aria-label={reactionDisplay(value).name} onClick={()=>setSelection(value.emoji)}><EmojiGlyph value={value}/><span>{verified.filter(e=>e.payload.emoji===value.emoji).length}</span></button>)}
   </div>
   {more&&<p className="small-copy">Showing loaded reactions. <button type="button" className="text-button" disabled={busy} onClick={more}>{busy?"Loading…":"Load more"}</button></p>}
   <h3>{reactionDisplay(selected).name}</h3>
   <ul className="reaction-people">{verified.filter(e=>e.payload.emoji===selected.emoji).map(person=><li key={person.memberId}><MemberAvatar memberId={person.memberId} name={person.handle||'?'}/><span>{person.handle?'@'+person.handle:'Member'}{person.memberId===viewerId?' (you)':''}</span></li>)}</ul>
  </Modal>}
 </>;
}
