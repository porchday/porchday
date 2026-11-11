import React from 'react';
import {postTextParts} from './post-links';
import {handleTokens} from './mentions';
import {validTags} from './PeopleTags';
export function PostText({text,tags}:{text:string;tags?:unknown}){
 const people=validTags(tags);
 return <>{postTextParts(text).map((part,index)=>{
  if(part.href)return <a key={index} href={part.href} target="_blank" rel="noopener noreferrer" className="post-link">{part.text}</a>;
  const nodes:React.ReactNode[]=[];let end=0;
  for(const token of handleTokens(part.text)){
   const person=people.find(p=>p.kind==='member'&&p.label.toLowerCase()===token.handle);
   if(!person)continue;
   nodes.push(part.text.slice(end,token.start),<a key={token.start} href={`/wall/${encodeURIComponent(person.id)}`}>{part.text.slice(token.start,token.end)}</a>);end=token.end;
  }
  nodes.push(part.text.slice(end));return <React.Fragment key={index}>{nodes}</React.Fragment>;
 })}</>;
}
