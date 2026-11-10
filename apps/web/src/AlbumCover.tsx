import {canonicalJson} from "@porchday/crypto";
import type {PhotoProof} from "@porchday/crypto/photos";
import React,{useEffect,useState} from "react";
import type {MediaPayload} from "./api";
import {openPhoto,type PhotoRow} from "./photo-record";
import {useVault} from "./vault";
import {useNearViewport} from "./near-viewport";
import {EncryptedPhoto} from "./Social";
import {Icon} from "./ui";
export function AlbumCover({photo}:{photo?:PhotoRow|null}){
 const vault=useVault(),{ref,near}=useNearViewport<HTMLDivElement>(),[opened,setOpened]=useState<{identity:string;media:MediaPayload;proof:PhotoProof}|null>(null);
 const identity=canonicalJson(JSON.parse(JSON.stringify(photo??null)))+vault.member.id+vault.keys.map(key=>key.getFingerprint()).sort().join(',');
 const media=opened?.identity===identity?opened:null;
 useEffect(()=>{let alive=true;setOpened(null);if(photo&&near)void(async()=>{for(const grant of photo.grants){try{const content=await openPhoto(vault,photo,grant);if(alive)setOpened({identity,media:content.media![0],proof:content.photoProof as PhotoProof});return;}catch{/* Keep a neutral cover when keys are unavailable. */}}})();return()=>{alive=false;};},[identity,near,vault.privateKey]);
 return <div ref={ref} className="album-cover">{media?<EncryptedPhoto media={media.media} photoProof={media.proof} thumbnail/>:<Icon name="album" size={40}/>}</div>;
}
