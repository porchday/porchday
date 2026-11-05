import React, {useEffect,useRef,useState} from "react";
import {createPortal} from "react-dom";
import {Icon} from "./ui";
export const clampPhotoZoom=(value:number)=>Math.max(1,Math.min(6,value));
export function PhotoViewer({src,alt,onClose}:{src:string;alt:string;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),stage=useRef<HTMLDivElement>(null);
 const [scale,setScale]=useState(1),[pan,setPan]=useState({x:0,y:0});
 const pointers=useRef(new Map<number,{x:number;y:number}>());
 const close=useRef(onClose);close.current=onClose;
 function zoom(value:number){const next=clampPhotoZoom(value);setScale(next);if(next===1)setPan({x:0,y:0});}
 useEffect(()=>{const previous=document.activeElement,el=dialog.current!;el.showModal();const cancel=(e:Event)=>{e.preventDefault();close.current();};el.addEventListener("cancel",cancel);const overflow=document.body.style.overflow;document.body.style.overflow="hidden";return()=>{el.removeEventListener("cancel",cancel);el.close();document.body.style.overflow=overflow;if(previous instanceof HTMLElement&&previous.isConnected)previous.focus();};},[]);
 useEffect(()=>{const el=stage.current!;const wheel=(e:WheelEvent)=>{e.preventDefault();setScale(old=>{const next=clampPhotoZoom(old*Math.exp(-e.deltaY*.002));if(next===1)setPan({x:0,y:0});return next;});};el.addEventListener("wheel",wheel,{passive:false});return()=>el.removeEventListener("wheel",wheel);},[]);
 return createPortal(<dialog ref={dialog} className="photo-viewer" aria-label="Photo viewer" onKeyDown={e=>{if(e.key==="+"||e.key==="="){e.preventDefault();zoom(scale+.5);}if(e.key==="-"){e.preventDefault();zoom(scale-.5);}if(e.key==="0"){e.preventDefault();zoom(1);}}}>
  <div className="photo-viewer-toolbar"><button type="button" className="icon-button" aria-label="Close photo viewer" onClick={onClose}><Icon name="close"/></button><div><button type="button" aria-label="Zoom out" disabled={scale===1} onClick={()=>zoom(scale-.5)}>−</button><button type="button" onClick={()=>zoom(1)} aria-label="Reset photo zoom">{Math.round(scale*100)}%</button><button type="button" aria-label="Zoom in" disabled={scale===6} onClick={()=>zoom(scale+.5)}>+</button></div></div>
  <div ref={stage} className="photo-viewer-stage" onDoubleClick={()=>zoom(scale===1?2:1)} onPointerDown={e=>{if(e.pointerType==="mouse"&&e.button!==0)return;e.currentTarget.setPointerCapture(e.pointerId);pointers.current.set(e.pointerId,{x:e.clientX,y:e.clientY});}} onPointerMove={e=>{
   const old=pointers.current.get(e.pointerId);if(!old)return;const before=[...pointers.current.values()];pointers.current.set(e.pointerId,{x:e.clientX,y:e.clientY});const after=[...pointers.current.values()];
   if(before.length===2){const distance=(p:{x:number;y:number}[])=>Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);const d=distance(before);if(d>0)zoom(scale*distance(after)/d);}
   else if(scale>1){const width=e.currentTarget.clientWidth,height=e.currentTarget.clientHeight,x=e.clientX,y=e.clientY;setPan(p=>({x:Math.max(-width*(scale-1)/2,Math.min(width*(scale-1)/2,p.x+x-old.x)),y:Math.max(-height*(scale-1)/2,Math.min(height*(scale-1)/2,p.y+y-old.y))}));}
  }} onPointerUp={e=>pointers.current.delete(e.pointerId)} onPointerCancel={e=>pointers.current.delete(e.pointerId)} onLostPointerCapture={e=>pointers.current.delete(e.pointerId)}>
   <img src={src} alt={alt||"Shared photo"} draggable={false} style={{transform:`translate(${pan.x}px, ${pan.y}px) scale(${scale})`}}/>
  </div>{alt&&<p className="photo-viewer-caption">{alt}</p>}
 </dialog>,document.body);
}
