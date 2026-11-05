import React from "react";
import {MemberAvatar} from "./MemberAvatar";
import {useVault} from "./vault";
import {Icon} from "./ui";
import {localDate,relativeDate} from "./api";
export function postAudienceLabel(audience:string|undefined,groupId?:string|null){
 return audience==="only_me"?"Only me":groupId?"Group":({community:"Community",extended_family:"Extended family",family:"Family",friends:"Friends only"} as Record<string,string>)[audience||"connections"]||"Friends & family";
}
export function ActivityAuthor({memberId,handle,date,photoDate=false,sharing}:{memberId:string;handle?:string;date:string;photoDate?:boolean;sharing:string}){
 const vault=useVault();
 const day=photoDate?new Date(date+"T12:00:00"):null;
 const label=day?day.toLocaleDateString(undefined,{month:"short",day:"numeric",...(day.getFullYear()!==new Date().getFullYear()?{year:"numeric" as const}:{})}):relativeDate(date);
 return <a href={`/wall/${memberId}`} className="post-author">
  <MemberAvatar memberId={memberId} name={memberId===vault.member.id?vault.member.handle:handle||"?"}/>
  <div><strong>{memberId===vault.member.id?`@${vault.member.handle}`:handle?`@${handle}`:"A connection"}</strong>
   <span><time dateTime={date} title={day?`Photo date: ${day.toLocaleDateString()}`:localDate(date)}>{label}</time>{" "}· <Icon name="lock" size={11}/>{sharing}</span>
  </div>
 </a>;
}
