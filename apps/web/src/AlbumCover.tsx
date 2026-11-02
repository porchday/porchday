import React,{useEffect,useState} from "react";
import type {MediaPayload} from "./api";
import {openPhoto,type PhotoRow} from "./photo-record";
import {useVault} from "./vault";
import {useNearViewport} from "./near-viewport";
import {EncryptedPhoto} from "./Social";
import {Icon} from "./ui";
export function AlbumCover({photo}:{photo?:PhotoRow|null}){
 const vault=useVault(),{ref,near}=useNearViewport<HTMLDivElement>(),[media,setMedia]=useState<MediaPayload|null>(null);
 useEffect(()=>{let alive=true;setMedia(null);if(photo&&near)void(async()=>{for(const grant of photo.grants){try{const content=await openPhoto(vault,photo,grant);if(alive)setMedia(content.media![0]);return;}catch{/* Keep a neutral cover when keys are unavailable. */}}})();return()=>{alive=false;};},[photo,near,vault.member.id]);
 return <div ref={ref} className="album-cover">{media?<EncryptedPhoto media={media} thumbnail/>:<Icon name="album" size={40}/>}</div>;
}
