import React from 'react';
import {postTextParts} from './post-links';
export function PostText({text}:{text:string}){
 return <>{postTextParts(text).map((part,index)=>part.href
  ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer" className="post-link">{part.text}</a>
  : part.text)}</>;
}
