import React, { useEffect, useState } from "react";
import { get, post, request, type Json } from "./api";
import { Alert, Button, Loading, useAction } from "./ui";
import { proposalOverview, proposalSections } from "./feature-presentation";
import { Disclosure, type BuilderState } from "./BuilderChat";

export const featureStatus: Record<string,string> = {
  voting: "Open for voting", queued: "Queued for implementation", working: "Codex is implementing",
  delivered: "Code delivered · deployment may still be pending", needs_attention: "Needs review · implementation did not finish",
};
export function FeatureCard({ feature, busy, onVote }: { feature: Json; busy: boolean; onVote: (value: number) => void }) {
  const overview = proposalOverview(feature.plan);
  const sections = proposalSections(overview.original);
  return <article className="panel form-stack" id={`feature-${feature.id}`} style={{minWidth:0,overflowWrap:"anywhere"}}>
    <h2>{feature.title}</h2>
    <p>{featureStatus[feature.status]}</p>
    <p>{overview.summary}</p>
    {!!overview.highlights.length && <ul>{overview.highlights.map((point,index)=><li key={index}>{point}</li>)}</ul>}
    <strong>Net votes: {feature.score > 0 ? "+" : ""}{feature.score} / +3 needed</strong>
    {feature.status === "voting" && <div className="inline-form" role="group" aria-label={`Vote on ${feature.title}`}>
      <Button disabled={busy} aria-pressed={feature.my_vote === 1} onClick={() => onVote(feature.my_vote === 1 ? 0 : 1)}>Support +1</Button>
      <Button disabled={busy} aria-pressed={feature.my_vote === -1} onClick={() => onVote(feature.my_vote === -1 ? 0 : -1)}>Against −1</Button>
      {feature.my_vote !== 0 && <Button disabled={busy} onClick={() => onVote(0)}>Remove my vote</Button>}
    </div>}
    <div className="form-stack" aria-label={`Details for ${feature.title}`}>
      {overview.reviewed && sections.map(section=><details key={section.title}>
        <summary>{section.title}</summary>
        <p style={{whiteSpace:"pre-wrap"}}>{section.text}</p>
      </details>)}
      <details open={!overview.reviewed}>
        <summary>Complete original plan{!overview.reviewed ? " · summary needs review" : ""}</summary>
        <p style={{whiteSpace:"pre-wrap"}}>{overview.original}</p>
      </details>
      <details><summary>Attribution</summary><p>{feature.author_handle ? `Listed by @${feature.author_handle}.` : "Original author unavailable."} See sources and history for the original proposal’s provenance.</p></details>
    </div>
    {!!feature.commits?.length && <p>Commits: {feature.commits.map((hash: string) => <a key={hash} href={`https://github.com/porchday/porchday/commit/${hash}`} style={{marginRight:"0.5em"}}>{hash.slice(0,7)}</a>)}</p>}
  </article>;
}
export function FeatureAdditions() {
  const [state,setState] = useState<BuilderState | null>(null);
  const [features,setFeatures] = useState<Json[]>([]);
  const [cursor,setCursor] = useState<string | null>(null);
  const [text,setText] = useState("");
  const action = useAction();
  async function refresh(more = false) {
    const [next,board] = await Promise.all([get<BuilderState>("/builder-chat"),get<Json>(`/builder-chat/features${more && cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)]);
    setState(next); setFeatures(previous => more ? [...previous,...board.items] : board.items); setCursor(board.next_cursor);
  }
  useEffect(() => { action.run(() => refresh()); },[]);
  // Refresh active jobs without silently collapsing pages someone is reading.
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden && features.length <= 30) action.run(() => refresh()); },15000);
    return () => clearInterval(timer);
  },[features.length]);
  const pending = state?.messages.some(message => ["queued","working"].includes(message.status));
  return <>
    <div className="page-heading"><h1>Feature additions</h1></div>
    <p>Suggest a feature. Codex writes a plan for this board before changing the site. A net score of +3 queues implementation: each support adds 1, each vote against subtracts 1.</p>
    <p>One vote per person. Change or remove it until implementation is queued. This applies to web feature requests, not operator work.</p>
    <Alert>{action.error}</Alert><Alert success>{action.notice}</Alert>
    {!state ? <Loading /> : !state.disclosure.accepted ? <Disclosure version={state.disclosure.version} onAccepted={refresh} /> : <>
      <form className="panel form-stack" data-unsaved-draft={Boolean(text.trim()) || undefined} onSubmit={event => {
        event.preventDefault(); action.run(async () => { await post("/builder-chat/features",{message:text}); setText(""); await refresh(); },"Queued for planning. Follow progress in Builder chat; the plan will appear here when ready.");
      }}>
        <label className="field"><span>Suggest a feature</span><textarea rows={4} maxLength={2000} required value={text} onChange={event=>setText(event.target.value)} /></label>
        <small>Your resulting plan and handle will be visible to builder-chat participants. Keep private information out of the suggestion.</small>
        <Button variant="primary" busy={action.busy} disabled={!text.trim() || !!pending || state.paused || state.sent_today >= state.limits.daily_messages}>Generate a plan</Button>
        {pending && <p>A request is already queued or running. <a href="/app/builder-chat">View progress in Builder chat</a>.</p>}
        {state.paused && <p>Builder chat is paused.</p>}
      </form>
      {!features.length && <p>No feature plans yet.</p>}
      {features.map(feature=><FeatureCard key={feature.id} feature={feature} busy={action.busy || state.paused} onVote={value=>action.run(async()=>{
        await request(`/builder-chat/features/${feature.id}/vote`,{method:"PUT",body:JSON.stringify({value})}); await refresh();
      })} />)}
      {cursor && <Button busy={action.busy} onClick={()=>action.run(()=>refresh(true))}>Load more plans</Button>}
    </>}
  </>;
}
