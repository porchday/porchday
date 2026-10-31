import React, {useEffect,useRef,useState} from 'react';
import {ApiError,get,request,type Json,type SocialObject} from './api';
import {Button} from './ui';

export function mergeFeedFeatures(posts:SocialObject[],features:Json[]) {
  const seen=new Set<string>();
  return [...posts.map(row=>({kind:'post' as const,row})),...features.map(row=>({kind:'feature' as const,row}))]
    .filter(item=>{const key=item.kind+':'+item.row.id;if(seen.has(key))return false;seen.add(key);return true;})
    .sort((a,b)=>Date.parse(b.row.created_at)-Date.parse(a.row.created_at) || (a.kind==='post' && b.kind==='post' ? 0 : (a.kind+':'+a.row.id).localeCompare(b.kind+':'+b.row.id)));
}
export function featurePreview(plan:string) {
  const summary=/^Proposal overview v1\nSummary: ([^\n]+)/.exec(plan)?.[1];
  const text=(summary??plan).replace(/\s+/g,' ').trim();
  return text.length>240?text.slice(0,239)+'…':text;
}
export function FeedFeatureCard({feature,busy,onVote}:{feature:Json;busy:boolean;onVote:(value:number)=>void}) {
  return <article className="panel form-stack" style={{minWidth:0,overflowWrap:'anywhere'}} aria-label={`Feature proposal: ${feature.title}`}>
    <small>Feature addition · {feature.status==='voting'?'Open for voting':'Voting closed'}</small>
    <h2>{feature.title}</h2><p>{featurePreview(feature.plan)}</p>
    <strong>Net votes: {feature.score>0?'+':''}{feature.score} / +3 needed</strong>
    <p>Your vote: {feature.my_vote===1?'Support':feature.my_vote===-1?'Against':'Not voted'}</p>
    {feature.status==='voting' && <div className="inline-form" role="group" aria-label={`Vote on ${feature.title}`}>
      <Button disabled={busy} aria-pressed={feature.my_vote===1} onClick={()=>onVote(feature.my_vote===1?0:1)}>Support +1</Button>
      <Button disabled={busy} aria-pressed={feature.my_vote===-1} onClick={()=>onVote(feature.my_vote===-1?0:-1)}>Against −1</Button>
      {feature.my_vote!==0 && <Button disabled={busy} onClick={()=>onVote(0)}>Remove my vote</Button>}
    </div>}
    <a href={`/app/features?proposal=${encodeURIComponent(feature.id)}#feature-${encodeURIComponent(feature.id)}`}>Read full proposal</a>
  </article>;
}

/** Independent of encrypted posts: never hold up their first render. No persistent cache. */
export function useFeedFeatures(enabled:boolean) {
  const [features,setFeatures]=useState<Json[]>([]),[cursor,setCursor]=useState<string|null>(null);
  const [busy,setBusy]=useState(false),[paused,setPaused]=useState(false),[error,setError]=useState('');
  const state=useRef({generation:0,running:false,pages:1,denied:false,cursor:null as string|null});
  async function read(more=false) {
    const generation=state.current.generation;
    let next=more?state.current.cursor:null;
    const collected:Json[]=[];
    const count=more?1:state.current.pages;
    for(let page=0;page<count;page++) {
      const result=await get<Json>(`/builder-chat/features?surface=feed${next?'&cursor='+encodeURIComponent(next):''}`);
      if(generation!==state.current.generation)return;
      // Older APIs ignore surface=feed; require the explicit gated-response marker.
      if(result.feed_eligible!==true)throw new ApiError(404,{error:{code:'NOT_FOUND'}});
      state.current.denied=false;
      collected.push(...result.items);next=result.next_cursor;
      setPaused(result.paused);
      if(!next)break;
    }
    if(generation!==state.current.generation)return;
    setFeatures(previous=>Array.from(new Map((more?[...previous,...collected]:collected).map(f=>[f.id,f])).values()));
    state.current.cursor=next;setCursor(next);
    if(more)state.current.pages++;
  }
  async function run(more=false,vote?:{id:string;value:number}) {
    if(!enabled || state.current.running || (more && !state.current.cursor))return;
    const generation=state.current.generation;
    state.current.running=true;setBusy(true);setError('');
    let voteError='';
    try {
      if(vote) {
        try {await request(`/builder-chat/features/${encodeURIComponent(vote.id)}/vote`,{method:'PUT',body:JSON.stringify({value:vote.value})});}
        catch(e) {voteError=e instanceof Error?e.message:'Vote could not be saved.';}
      }
      await read(more);
      if(generation===state.current.generation && voteError)setError(voteError);
    } catch(e) {
      if(generation!==state.current.generation)return;
      // Clear inaccessible or unverified cards; never leave stale enabled voting controls.
      setFeatures([]);setCursor(null);state.current.cursor=null;
      state.current.denied=e instanceof ApiError && [401,403,404].includes(e.status);
      if(!state.current.denied)setError('Feature proposals could not be refreshed. Try again.');
    } finally {
      if(generation===state.current.generation){state.current.running=false;setBusy(false);}
    }
  }
  useEffect(()=>{
    state.current={generation:state.current.generation+1,running:false,pages:1,denied:false,cursor:null};
    setFeatures([]);setCursor(null);setError('');setBusy(false);
    if(!enabled)return;
    void run();
    const refresh=()=>{if(!document.hidden)void run();};
    const timer=setInterval(()=>{if(!state.current.denied)refresh();},15000);
    document.addEventListener('visibilitychange',refresh);window.addEventListener('focus',refresh);window.addEventListener('online',refresh);
    return ()=>{state.current.generation++;clearInterval(timer);document.removeEventListener('visibilitychange',refresh);window.removeEventListener('focus',refresh);window.removeEventListener('online',refresh);};
  },[enabled]);
  return {features:enabled?features:[],cursor:enabled?cursor:null,busy,paused,error:enabled?error:'',refresh:()=>run(),more:()=>run(true),vote:(id:string,value:number)=>run(false,{id,value})};
}
