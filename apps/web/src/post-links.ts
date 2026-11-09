export type PostTextPart = {text:string;href?:string};
/** Plain text only: recognize web URLs without interpreting markup or other schemes. */
export function postTextParts(text:string):PostTextPart[]{
 const parts:PostTextPart[]=[];let end=0;
 for(const match of text.matchAll(/(?:https?:\/\/|www\.)[^\s<>"'\u201c\u201d]+/giu)){
  const start=match.index!;
  if(start>0&&/[\p{L}\p{N}_@./:\-]/u.test(text[start-1]))continue;
  let value=match[0];
  // Sentence punctuation is not part of a pasted link. Keep balanced URL brackets.
  for(;;){
   const before=value;value=value.replace(/[.,!?;:\u2018\u2019]+$/u,'');
   for(const [open,close] of [['(',')'],['[',']'],['{','}']]){
    while(value.endsWith(close)&&value.split(close).length>value.split(open).length)value=value.slice(0,-1);
   }
   if(value===before)break;
  }
  try{
   const url=new URL(/^www\./i.test(value)?'https://'+value:value);
   if(!['http:','https:'].includes(url.protocol)||!url.hostname)continue;
   if(start>end)parts.push({text:text.slice(end,start)});
   parts.push({text:value,href:url.href});end=start+value.length;
  }catch{/* Invalid URLs remain literal text. */}
 }
 if(end<text.length)parts.push({text:text.slice(end)});
 return parts;
}
