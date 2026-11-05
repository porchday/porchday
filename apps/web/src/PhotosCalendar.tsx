import {useCalendarScrollAnchor} from "./calendar-scroll-anchor";
import { matchesAuthor, matchesContent, type AuthorFilter, type FeedContent } from "./feed-filters";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { get, request, del, items, type Json, type SocialObject } from "./api";
import { useVault } from "./vault";
import { Alert, Button, Loading, Modal, useAction } from "./ui";
import { EncryptedPhoto } from "./Social";
import { contentTags, Tags } from "./PeopleTags";
import {
  localDay,
  adjacentDay,
  swipeDay,
  monthRange,
  monthCells,
  filterEntries,
  featuredEntry,
  type CalendarEntry,
} from "./photo-calendar";
export function PhotosCalendar({ embedded = false, authorFilter, contentFilter = "posts" }: { embedded?: boolean; authorFilter?: AuthorFilter; contentFilter?: FeedContent }) {
  const [anchor, setAnchor] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [count, setCount] = useState(1);
  const [author, setAuthor] = useState(""), [tag, setTag] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [directory, setDirectory] = useState<Record<string, { authors: [string, string][]; tags: [string, string][] }>>({});
  const loaded = useCallback((key: string, entries: CalendarEntry[]) => {
    const authors: [string,string][] = entries.map(e => [e.row.author_id, e.row.author_handle || "Member"]);
    const tags: [string,string][] = entries.flatMap(e => contentTags(e.content).map(t => [t.kind + ":" + t.id, t.label] as [string,string]));
    setDirectory(old => ({ ...old, [key]: { authors, tags } }));
  }, []);
  const selectDay = useCallback((day: string | null) => {
    if (day) {
      const date = new Date(day + "T12:00:00");
      const distance = (anchor.getFullYear() - date.getFullYear()) * 12 + anchor.getMonth() - date.getMonth();
      if (distance < 0) { setAnchor(new Date(date.getFullYear(), date.getMonth(), 1)); setCount(old => old - distance); }
      else setCount(old => Math.max(old, distance + 1));
    }
    setSelected(day);
  }, [anchor.getTime()]);
  const {root:monthsRoot,capture}=useCalendarScrollAnchor(count);
  function earlier() {capture();setCount(old=>old+1);}
  function jump(offset: number) {
    setSelected(null); setCount(1); setDirectory({});
    setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + offset, 1));
  }
  const authors = new Map(Object.values(directory).flatMap(d => d.authors));
  const tags = new Map(Object.values(directory).flatMap(d => d.tags));
  return <>
    {!embedded && <div className="page-heading"><h1>Calendar</h1><p>Older months above, newer months below.</p></div>}
    <section className="panel calendar-controls">
      <nav className="calendar-month" aria-label="Calendar navigation">
        <Button aria-label="Previous month" onClick={() => jump(-1)}>←</Button>
        <Button onClick={() => { setSelected(null); setCount(1); setDirectory({}); setAnchor(new Date(new Date().getFullYear(), new Date().getMonth(), 1)); }}>This month</Button>
        <Button aria-label="Next month" onClick={() => jump(1)}>→</Button>
      </nav>
      <div className="calendar-filters">
        <label>Posted by<select value={author} onChange={e => setAuthor(e.target.value)}><option value="">Everyone</option>{[...authors].map(([id,label]) => <option key={id} value={id}>@{label}</option>)}</select></label>
        <label>Tagged person<select value={tag} onChange={e => setTag(e.target.value)}><option value="">Anyone</option>{[...tags].map(([id,label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <Button onClick={() => {setAuthor(""); setTag("");}}>Clear filters</Button>
      </div>
    </section>
    <div className="calendar-earlier"><Button onClick={earlier}>Load earlier month</Button></div>
    <div ref={monthsRoot}>
    {Array.from({length:count}, (_,i) => {
      const month = new Date(anchor.getFullYear(), anchor.getMonth()-(count-1-i), 1), key = localDay(month).slice(0,7);
      return <CalendarMonth key={key} month={month} authorFilter={authorFilter} contentFilter={contentFilter} author={author} tag={tag} selected={selected?.startsWith(key + "-") ? selected : null} setSelected={selectDay} onLoaded={loaded}/>;
    })}
    </div>
  </>;
}
function CalendarMonth({month, author, tag, selected, setSelected, onLoaded, authorFilter, contentFilter}: {
  authorFilter?: AuthorFilter; contentFilter: FeedContent;
  month: Date; author: string; tag: string; selected: string | null;
  setSelected: (day: string | null) => void;
  onLoaded: (key: string, entries: CalendarEntry[]) => void;
}) {
  const vault = useVault(), action = useAction();
  const monthRef = useRef<HTMLElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!monthRef.current) return;
    if (typeof IntersectionObserver === "undefined") { setNear(true); return; }
    const observer = new IntersectionObserver(entries => setNear(entries.some(e => e.isIntersecting)), {rootMargin:"500px"});
    observer.observe(monthRef.current);
    return () => observer.disconnect();
  }, []);
  const [entries, setEntries] = useState<CalendarEntry[]>([]),
    [highlights, setHighlights] = useState<Json[]>([]),
    [loading, setLoading] = useState(false),
    [loadError, setLoadError] = useState(""),
    [unreadable, setUnreadable] = useState(0),
    [next, setNext] = useState<{ at: string; id: string } | null>(null),
    [refresh, setRefresh] = useState(0),
    [clock, setClock] = useState(Date.now());
  const touch = useRef<{ x: number; y: number; at: number } | null>(null);
  function changeDay(offset: number) {
    if (!selected) return;
    const day = adjacentDay(selected, offset);
    setSelected(day);
  }

  const generation = useRef(0),
    range = monthRange(month.getFullYear(), month.getMonth());
  async function load(more = false) {
    const current = ++generation.current;
    setLoading(true);
    setLoadError("");
    if (!more) {
      setEntries([]);
      setNext(null);
      setUnreadable(0);
      setHighlights([]);
    }
    try {
      const query = new URLSearchParams(range);
      if (more && next) {
        query.set("after_at", next.at);
        query.set("after_id", next.id);
      }
      const result = await get("/calendar?" + query),
        rows = items<SocialObject>(result),
        decoded: CalendarEntry[] = [];
      let missed = 0;
      for (let i = 0; i < rows.length; i += 4) {
        const batch = await Promise.all(
          rows.slice(i, i + 4).map(async (row) => {
            try {
              return { row, content: await vault.open(row) };
            } catch {
              missed++;
              return null;
            }
          }),
        );
        decoded.push(...batch.filter((e): e is CalendarEntry => e !== null));
        if (current !== generation.current) return;
      }
      const choices = await get(
        "/calendar/highlights?" +
          new URLSearchParams({
            start: localDay(month),
            end: localDay(
              new Date(month.getFullYear(), month.getMonth() + 1, 1),
            ),
          }),
      );
      if (current !== generation.current) return;
      setEntries((old) =>
        more
          ? [
              ...old,
              ...decoded.filter((e) => !old.some((o) => o.row.id === e.row.id)),
            ]
          : decoded,
      );
      setUnreadable((n) => (more ? n + missed : missed));
      setNext(result.next);
      setHighlights(items<Json>(choices));
    } catch {
      if (current === generation.current) {
        setEntries([]);
        setHighlights([]);
        setNext(null);
        setLoadError(
          "This month could not be loaded. Retry to check your current access.",
        );
      }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    if (near || selected) void load();
    return () => {
      generation.current++;
    };
  }, [month.getTime(), refresh, vault.member.id, near || Boolean(selected)]);
  useEffect(() => {
    setClock(Date.now());
    const timer = near || selected ? setInterval(() => setClock(Date.now()), 1000) : undefined;
    const update = () => {
      if ((near || selected) && document.visibilityState === "visible") setRefresh((v) => v + 1);
    };
    window.addEventListener("focus", update);
    window.addEventListener("porchday:connections-changed", update);
    return () => {
      if (timer) clearInterval(timer);
      window.removeEventListener("focus", update);
      window.removeEventListener("porchday:connections-changed", update);
    };
  }, [near, Boolean(selected)]);
  useEffect(() => {
    setEntries((old) =>
      old.some((e) => e.row.expires_at && Date.parse(e.row.expires_at) <= clock)
        ? filterEntries(old, "", [], clock)
        : old,
    );
  }, [clock]);
  const filtered = filterEntries(entries, author, tag ? [tag] : [], clock).filter(entry => (!authorFilter || matchesAuthor(entry.row, authorFilter)) && matchesContent(entry.content, contentFilter));
  const byDay = new Map<string, CalendarEntry[]>();
  for (const entry of filtered) {
    const day = localDay(new Date(entry.row.created_at));
    byDay.set(day, [...(byDay.get(day) || []), entry]);
  }
  useEffect(() => { onLoaded(localDay(month).slice(0,7), entries); }, [entries, month.getTime(), onLoaded]);
  async function choose(day: string, post_id: string, media_id: string | null) {
    await action.runSave(async () => {
      await request("/calendar/highlights/" + day, {
        method: "PUT",
        body: JSON.stringify({ post_id, media_id }),
      });
      setHighlights((old) => [
        ...old.filter((h) => h.day !== day),
        { day, post_id, media_id },
      ]);
    }, "Your daily highlight was saved.");
  }
  return (
    <>
      <section ref={monthRef} className="panel photo-calendar" data-calendar-month={localDay(month).slice(0,7)}>
        <h2>{month.toLocaleDateString(undefined, {month:"long", year:"numeric"})}</h2>
        <Alert>{loadError}</Alert>
        {loadError && (
          <Button onClick={() => setRefresh((v) => v + 1)}>Retry</Button>
        )}
        {unreadable > 0 && (
          <p role="status">
            {unreadable} encrypted{" "}
            {unreadable === 1 ? "post could" : "posts could"} not be opened on
            this device.
          </p>
        )}
        <div
          className="calendar-grid"
          aria-label={month.toLocaleDateString(undefined, {
            month: "long",
            year: "numeric",
          })}
        >
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
            <div className="calendar-weekday" key={d}>
              {d}
            </div>
          ))}
          {monthCells(month.getFullYear(), month.getMonth()).map((day, i) => {
            if (!day)
              return <div className="calendar-outside" key={"empty" + i} />;
            const rows = byDay.get(day) || [],
              choice = featuredEntry(
                rows,
                highlights.find((h) => h.day === day) as
                  | { post_id: string; media_id: string | null }
                  | undefined,
              );
            return (
              <button
                type="button"
                className={
                  "calendar-day" +
                  (day === localDay(new Date()) ? " calendar-today" : "")
                }
                key={day}
                aria-label={`${day}: ${rows.length} ${rows.length === 1 ? "post" : "posts"}${next ? ", more may be available" : ""}`}
                onClick={() => setSelected(day)}
              >
                <span className="calendar-day-number">
                  {Number(day.slice(-2))}
                </span>
                {choice?.media && (near || selected) ? (
                  <EncryptedPhoto media={choice.media} thumbnail />
                ) : choice ? (
                  <span className="calendar-excerpt">
                    {choice.entry.content.text?.slice(0, 80) || "Post"}
                  </span>
                ) : null}
                {rows.length > 1 && (
                  <span className="calendar-day-count">{rows.length}</span>
                )}
              </button>
            );
          })}
        </div>
        {loading && <Loading />}
        {next && (
          <>
            <p>
              More posts remain in this month. Load them to complete the
              calendar and filters.
            </p>
            <Button busy={loading} onClick={() => load(true)}>
              Load more this month
            </Button>
          </>
        )}
        <p className="muted">
          Highlights are personal to your calendar. Tags never expand an
          audience.
        </p>
      </section>
      {selected && (
        <Modal
          title={new Date(selected + "T12:00:00").toLocaleDateString(
            undefined,
            { dateStyle: "full" },
          )}
          onClose={() => setSelected(null)}
        >
          <div className="calendar-day-content" style={{ touchAction: "pan-y" }}
            onTouchStart={event => {
              const target = event.target as HTMLElement;
              if (event.touches.length !== 1 || target.closest("button,a,input,select,textarea,video")) { touch.current = null; return; }
              touch.current = { x: event.touches[0].clientX, y: event.touches[0].clientY, at: Date.now() };
            }}
            onTouchCancel={() => { touch.current = null; }}
            onTouchEnd={event => {
              const start = touch.current; touch.current = null;
              if (!start || event.changedTouches.length !== 1) return;
              const end = event.changedTouches[0];
              const offset = swipeDay(end.clientX - start.x, end.clientY - start.y, Date.now() - start.at);
              if (offset) changeDay(offset);
            }}>
          <nav aria-label="Day navigation">
            <Button onClick={() => changeDay(-1)}>Previous day</Button>
            <Button onClick={() => changeDay(1)}>Next day</Button>
          </nav>
          {loading && <Loading />}
          <Alert>{loadError}</Alert>
          <Alert>{action.error}</Alert>
          <Alert success>{action.notice}</Alert>
          {!loading && !loadError && !(byDay.get(selected) || []).length && (
            <p>
              No matching posts for this day
              {next ? " in the posts loaded so far" : ""}.
            </p>
          )}
          {(byDay.get(selected) || []).map(({ row, content }) => (
            <article className="calendar-post" key={row.id}>
              <a href={`/post/${row.id}`}>
                @{row.author_handle || "Member"} · Open post
              </a>
              <p>{content.text}</p>
              <Tags value={content.tags} />
              {content.media?.map((media) => (
                <div key={media.id}>
                  <EncryptedPhoto media={media} />
                  <Button
                    busy={action.busy}
                    onClick={() => choose(selected, row.id, media.id)}
                  >
                    {media.mime.startsWith("video/") ? "Feature this video" : "Feature this photo"}
                  </Button>
                </div>
              ))}
              <Button
                busy={action.busy}
                onClick={() => choose(selected, row.id, null)}
              >
                Feature this post
              </Button>
            </article>
          ))}
          <Button
            busy={action.busy}
            onClick={() =>
              action.runSave(async () => {
                await del("/calendar/highlights/" + selected);
                setHighlights((old) => old.filter((h) => h.day !== selected));
              }, "Automatic daily highlight restored.")
            }
          >
            Use automatic highlight
          </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
