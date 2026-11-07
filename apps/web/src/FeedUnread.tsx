import {feedVisible,FeedDwell} from "./feed-visibility";
import React,{createContext,useContext,useEffect,useRef,useState} from 'react';
import {get,request,message} from './api';
import {useVault} from './vault';
import {Button,Alert} from './ui';
export type FeedReadItem={kind:'post'|'photo';id:string};
type State={count:number|null;seen:(item:FeedReadItem)=>void;markAll:()=>Promise<void>};
const Context=createContext<State>({count:null,seen:()=>{},markAll:async()=>{}});
export function FeedUnreadProvider({children}:{children:React.ReactNode}){
 const vault=useVault(),[count,setCount]=useState<number|null>(null),controller=useRef<State>({count:null,seen:()=>{},markAll:async()=>{}});
 useEffect(()=>{
  let retryDelay=2000;let alive=true,serial=Promise.resolve(),timer:ReturnType<typeof setTimeout>|undefined;
  const pending=new Map<string,FeedReadItem>(),acknowledged=new Set<string>();
  const key=(x:FeedReadItem)=>x.kind+':'+x.id;
  const badge=(n:number)=>{const nav=navigator as Navigator&{setAppBadge?:(n:number)=>Promise<void>;clearAppBadge?:()=>Promise<void>};void(n?nav.setAppBadge?.(n):nav.clearAppBadge?.())?.catch(()=>{});};
  const apply=(r:any)=>{if(alive&&Number.isSafeInteger(r.count)&&r.count>=0){setCount(r.count);badge(r.count);}};
  const enqueue=(work:()=>Promise<void>)=>{const result=serial.then(()=>{if(alive)return work();});serial=result.catch(()=>{});return result;};
  const flush=()=>enqueue(async()=>{
   const batch=[...pending.values()].slice(0,100);if(!batch.length)return;
   const r=await request('/feed/read',{method:'PUT',body:JSON.stringify({items:batch})});
   if(!alive)return;retryDelay=2000;for(const x of batch){pending.delete(key(x));acknowledged.add(key(x));}while(acknowledged.size>2000)acknowledged.delete(acknowledged.values().next().value!);apply(r);
   if(pending.size)schedule();
  });
  const schedule=()=>{if(timer||document.visibilityState==='hidden'||!navigator.onLine)return;timer=setTimeout(()=>{timer=undefined;void flush().catch(()=>{retryDelay=Math.min(60000,retryDelay*2);if(alive&&pending.size)schedule();});},retryDelay);};
  const refresh=()=>{if(document.visibilityState==='hidden')return;void enqueue(async()=>apply(await get('/feed/unread'))).catch(()=>{});if(pending.size)schedule();};
  controller.current={count:null,seen:x=>{if(!alive||acknowledged.has(key(x))||pending.size>=1000)return;pending.set(key(x),x);schedule();},markAll:()=>enqueue(async()=>{const r=await request('/feed/read-all',{method:'PUT',body:'{}'});if(alive){pending.clear();acknowledged.clear();apply(r);}})};
  setCount(null);refresh();const poll=setInterval(refresh,30000);
  document.addEventListener('visibilitychange',refresh);window.addEventListener('online',refresh);window.addEventListener('porchday:posts-shared',refresh);
  return()=>{alive=false;clearInterval(poll);clearTimeout(timer);pending.clear();controller.current={count:null,seen:()=>{},markAll:async()=>{}};document.removeEventListener('visibilitychange',refresh);window.removeEventListener('online',refresh);window.removeEventListener('porchday:posts-shared',refresh);badge(0);};
 },[vault.member.id]);
 return <Context.Provider value={{count,seen:item=>controller.current.seen(item),markAll:()=>controller.current.markAll()}}>{children}</Context.Provider>;
}
export function FeedBadge(){const {count}=useContext(Context);return count!==null&&count>0?<span className="feed-unread-badge" aria-label={`${count} unread feed items`}>{count>99?'99+':count}</span>:null;}
export function FeedReadControls(){const {count,markAll}=useContext(Context),[busy,setBusy]=useState(false),[error,setError]=useState('');return <><div className="feed-read-controls"><span>{count===null?'Checking unread activity…':count?`${count} unread`:'You’re caught up'}</span>{count!==null&&count>0&&<Button busy={busy} onClick={async()=>{setBusy(true);setError('');try{await markAll();}catch(e){setError(message(e));}finally{setBusy(false);}}}>Mark all as read</Button>}</div><Alert>{error}</Alert></>;}
/** Continuous foreground visibility, not list loading or observer prefetch. */
export function ReadableFeedItem({item,ready,photo=false,children}:{item:FeedReadItem;ready:boolean;photo?:boolean;children:React.ReactNode}){
 const ref=useRef<HTMLDivElement>(null),{seen}=useContext(Context),callback=useRef(seen);callback.current=seen;
 useEffect(()=>{
  const node=ref.current;if(!node||!ready)return;const dwell=new FeedDwell();let done=false;let poll:ReturnType<typeof setInterval>|undefined;
  const check=()=>{
   if(done)return;
   const rect=node.getBoundingClientRect(),height=window.innerHeight;
   const opened=node.querySelector('[data-feed-readable="true"]');
   const img=node.querySelector<HTMLImageElement>('img.viewable-photo');
   const eligible=document.visibilityState==='visible'&&!!opened&&feedVisible(rect,{width:window.innerWidth,height})&&(!photo||!!img&&img.complete&&img.naturalWidth>0);
   if(dwell.update(eligible,performance.now())){done=true;clearInterval(poll);poll=undefined;callback.current(item);}
  };
  const observer=new IntersectionObserver(entries=>{if(done)return;if(entries.some(e=>e.isIntersecting)){poll??=setInterval(check,100);check();}else{clearInterval(poll);poll=undefined;dwell.update(false,performance.now());}},{threshold:[0,.25,.5,.75,1]});observer.observe(node);
  document.addEventListener('visibilitychange',check);
  return()=>{observer.disconnect();clearInterval(poll);document.removeEventListener('visibilitychange',check);};
 },[item.kind,item.id,ready,photo]);
 return <div ref={ref}>{children}</div>;
}
