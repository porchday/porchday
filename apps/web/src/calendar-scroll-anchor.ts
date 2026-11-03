import {useLayoutEffect,useRef} from "react";

// Keep the existing month in place while prepended months load. A one-time
// adjustment misses the later insertion/removal of loading and paging controls.
export function useCalendarScrollAnchor(revision:number){
 const root=useRef<HTMLDivElement>(null);
 const saved=useRef<{element:Element;top:number}|null>(null);
 const stop=useRef<()=>void>(()=>{});
 const capture=()=>{
  stop.current();
  const element=root.current?.firstElementChild;
  saved.current=element?{element,top:element.getBoundingClientRect().top}:null;
 };
 useLayoutEffect(()=>{
  const anchor=saved.current; saved.current=null;
  if(!anchor||!root.current)return;
  const adjust=()=>{
   if(!anchor.element.isConnected)return;
   const difference=anchor.element.getBoundingClientRect().top-anchor.top;
   if(Math.abs(difference)>.5)window.scrollBy({top:difference,behavior:"instant"});
  };
  adjust();
  const observer=new ResizeObserver(adjust);observer.observe(root.current);
  // Stop when the reader navigates deliberately; never fight their scrolling.
  const cancel=()=>{
   observer.disconnect();
   for(const event of ["wheel","touchstart","pointerdown","keydown"])
    window.removeEventListener(event,cancel,true);
  };
  for(const event of ["wheel","touchstart","pointerdown","keydown"])
   window.addEventListener(event,cancel,{capture:true,passive:true});
  stop.current=cancel;
  return cancel;
 },[revision]);
 return {root,capture};
}
