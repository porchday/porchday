import type {PublishedPost} from "./Social";
import {PhotoNotificationDetail} from "./PhotoCollection";
import {FeedReadControls} from "./FeedUnread";
import {PhotoFeed,PhotoFeedCalendar} from "./PhotoFeed";
import React,{useEffect,useMemo,useState} from "react";
import {get,items,type Json} from "./api";
import {useVault} from "./vault";
import {Alert,Button,useAction} from "./ui";
import {PhotosCalendar} from "./PhotosCalendar";
import {audienceOptions,audienceLabels,audienceCategories,type FeedAudience,type AuthorCategory,type FeedContent} from "./feed-filters";

export function FeedExperience({initialContent="everything",initialView="scroll",publishedPost,onReconciled}:{initialContent?:FeedContent;initialView?:"scroll"|"calendar";publishedPost?:PublishedPost|null;onReconciled?:()=>void}){
 const vault=useVault(),action=useAction();
 const [content,setContent]=useState<FeedContent>(initialContent),[view,setView]=useState(initialView),[audience,setAudience]=useState<FeedAudience>("connections");
 const [relations,setRelations]=useState<Map<string,AuthorCategory>>(new Map());
 useEffect(()=>{let alive=true;const refresh=()=>action.run(async()=>{const response=await get("/connections");if(alive)setRelations(new Map(items<Json>(response).map(c=>[c.member_a===vault.member.id?c.member_b:c.member_a,c.mutual_family?"family":"friends"])));});void refresh();window.addEventListener("porchday:connections-changed",refresh);return()=>{alive=false;window.removeEventListener("porchday:connections-changed",refresh);};},[vault.member.id]);
 const filter=useMemo(()=>({memberId:vault.member.id,audience,selected:audienceCategories[audience],relations}),[vault.member.id,audience,relations]);
 const labels={everything:"Everything",posts:"Posts",photos:"Photos"};
 return <>
  {new URLSearchParams(location.search).get("photo")&&<PhotoNotificationDetail id={new URLSearchParams(location.search).get("photo")!}/>}
  <div className="page-heading mobile-tab-heading"><h1>Feed</h1></div>
  <div className="feed-view-controls" aria-label="Feed view"><Button aria-pressed={view==="scroll"} onClick={()=>setView("scroll")}>Feed</Button><Button aria-pressed={view==="calendar"} onClick={()=>setView("calendar")}>Calendar</Button></div>
  <FeedReadControls/>
  <details className="feed-author-controls"><summary>Filters · {labels[content]} · {audienceLabels[audience]}</summary><div className="feed-filter-selects">
   <label>Show<select value={content} onChange={e=>setContent(e.target.value as FeedContent)}>{Object.entries(labels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
   <label>From<select value={audience} onChange={e=>setAudience(e.target.value as FeedAudience)}>{audienceOptions.map(value=><option key={value} value={value}>{audienceLabels[value]}</option>)}</select></label>
  </div></details>
  <Alert>{action.error}</Alert>
  {view==="scroll"?<PhotoFeed authorFilter={filter} content={content} publishedPost={publishedPost} onReconciled={onReconciled}/>:content==="posts"?<PhotosCalendar embedded authorFilter={filter} contentFilter="posts"/>:<PhotoFeedCalendar authorFilter={filter} content={content}/>}
 </>;
}
