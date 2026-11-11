import {postTextParts} from './post-links';
import type {PersonTag} from './PeopleTags';

// Handles are ASCII, 3–24 characters. Ignore emails, escaped @ signs and URLs.
export function handleTokens(text:string):{handle:string;start:number;end:number}[]{
 const result:{handle:string;start:number;end:number}[]=[];
 const urls:{start:number;end:number}[]=[];let offset=0;
 for(const part of postTextParts(text)){if(part.href)urls.push({start:offset,end:offset+part.text.length});offset+=part.text.length;}
 const pattern=/(^|[\s([{,;:!?])@([a-z0-9_]{3,24})(?![a-z0-9_])/gi;
 for(const match of text.matchAll(pattern)){
  const start=match.index!+match[1].length;
  if(urls.some(url=>start>=url.start&&start<url.end))continue;
  result.push({handle:match[2].toLowerCase(),start,end:start+match[2].length+1});
 }
 return result;
}
export function resolveMentionTags(text:string,existing:PersonTag[],people:PersonTag[]):PersonTag[]{
 const result=existing.filter(tag=>tag.source!=="mention");
 for(const {handle} of handleTokens(text)){
  // Previously stored identity wins over a subsequently reassigned handle.
  const previous=existing.find(tag=>tag.kind==='member'&&tag.label.toLowerCase()===handle);
  const person=previous
   ? people.find(tag=>tag.kind==='member'&&tag.id===previous.id)
   : people.find(tag=>tag.kind==='member'&&tag.label.toLowerCase()===handle);
  if(person&&!result.some(tag=>tag.kind===person.kind&&tag.id===person.id))
   result.push({...person,label:previous?.label||person.label,source:'mention'});
 }
 if(result.length>30)throw Error('Use at most 30 people per post, caption or comment.');
 return result;
}
