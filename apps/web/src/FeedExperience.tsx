import { PhotoFeed, PhotoFeedCalendar } from "./PhotoFeed";
import React, { useEffect, useMemo, useState } from "react";
import { get, items, type Json } from "./api";
import { useVault } from "./vault";
import { Alert, Button, useAction } from "./ui";
import { Feed } from "./Social";
import { PhotosCalendar } from "./PhotosCalendar";
import { authorCategories, authorLabels, defaultAuthorCategories, type AuthorCategory, type FeedContent } from "./feed-filters";

export function FeedExperience({ initialContent = "posts", initialView = "scroll" }: { initialContent?: FeedContent; initialView?: "scroll" | "calendar" }) {
  const vault = useVault();
  const [content, setContent] = useState<FeedContent>(initialContent);
  const [view, setView] = useState<"scroll" | "calendar">(initialView);
  const [selected, setSelected] = useState<AuthorCategory[]>([...defaultAuthorCategories]);
  const [relations, setRelations] = useState<Map<string, AuthorCategory>>(new Map());
  const action = useAction();
  useEffect(() => {
    let alive = true;
    const refresh = () => action.run(async () => {
      const response = await get("/connections");
      if (!alive) return;
      setRelations(new Map(items<Json>(response).map(c => [c.member_a === vault.member.id ? c.member_b : c.member_a, c.mutual_family ? "family" : "friends"])));
    });
    refresh();
    window.addEventListener("porchday:connections-changed", refresh);
    return () => { alive = false; window.removeEventListener("porchday:connections-changed", refresh); };
  }, [vault.member.id]);
  const filter = useMemo(() => ({memberId: vault.member.id, selected, relations}), [vault.member.id, selected, relations]);
  const summary = selected.length === 3 && defaultAuthorCategories.every(c => selected.includes(c)) ? "Me, Friends & Family" : selected.map(c => authorLabels[c]).join(", ") || "Nobody";
  return <>
    <div className="page-heading"><h1>Feed</h1></div>
    <div className="tabs" aria-label="Feed content">
      <button type="button" className={content === "posts" ? "active" : ""} aria-pressed={content === "posts"} onClick={() => setContent("posts")}>Posts</button>
      <button type="button" className={content === "photos" ? "active" : ""} aria-pressed={content === "photos"} onClick={() => setContent("photos")}>Photos Only</button>
    </div>
    <div className="feed-view-controls" aria-label="Feed view">
      <Button aria-pressed={view === "scroll"} onClick={() => setView("scroll")}>Infinite scroll</Button>
      <Button aria-pressed={view === "calendar"} onClick={() => setView("calendar")}>Calendar</Button>
    </div>
    <details className="feed-author-controls"><summary>Show {content === "photos" ? "photos" : "posts"} by <strong>{summary}</strong></summary>
      <div className="feed-author-options">{authorCategories.map(category => <label key={category}><input type="checkbox" checked={selected.includes(category)} onChange={e => setSelected(old => e.target.checked ? [...old, category] : old.filter(c => c !== category))}/>{authorLabels[category]}</label>)}</div>
    </details>
    <Alert>{action.error}</Alert>
    {content === "photos" ? (view === "scroll" ? <PhotoFeed authorFilter={filter}/> : <PhotoFeedCalendar authorFilter={filter}/>) : (view === "scroll" ? <Feed authorFilter={filter} contentFilter="posts" infinite /> : <PhotosCalendar embedded authorFilter={filter} contentFilter="posts" />)}
  </>;
}
