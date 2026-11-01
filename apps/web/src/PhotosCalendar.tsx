import React, { useEffect, useRef, useState } from "react";
import { get, request, del, items, type Json, type SocialObject } from "./api";
import { useVault } from "./vault";
import { Alert, Button, Loading, Modal, useAction } from "./ui";
import { EncryptedPhoto } from "./Social";
import { contentTags, Tags } from "./PeopleTags";
import {
  localDay,
  monthRange,
  monthCells,
  filterEntries,
  featuredEntry,
  type CalendarEntry,
} from "./photo-calendar";
export function PhotosCalendar() {
  const vault = useVault(),
    action = useAction();
  const [month, setMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  const [entries, setEntries] = useState<CalendarEntry[]>([]),
    [highlights, setHighlights] = useState<Json[]>([]),
    [author, setAuthor] = useState(""),
    [tag, setTag] = useState(""),
    [selected, setSelected] = useState<string | null>(null),
    [loading, setLoading] = useState(false),
    [loadError, setLoadError] = useState(""),
    [unreadable, setUnreadable] = useState(0),
    [next, setNext] = useState<{ at: string; id: string } | null>(null),
    [refresh, setRefresh] = useState(0),
    [clock, setClock] = useState(Date.now());
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
    void load();
    return () => {
      generation.current++;
    };
  }, [month.getTime(), refresh, vault.member.id]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    const update = () => {
      if (document.visibilityState === "visible") setRefresh((v) => v + 1);
    };
    window.addEventListener("focus", update);
    window.addEventListener("porchday:connections-changed", update);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", update);
      window.removeEventListener("porchday:connections-changed", update);
    };
  }, []);
  useEffect(() => {
    setEntries((old) =>
      old.some((e) => e.row.expires_at && Date.parse(e.row.expires_at) <= clock)
        ? filterEntries(old, "", [], clock)
        : old,
    );
  }, [clock]);
  const available = filterEntries(entries, "", [], clock);
  const filtered = filterEntries(entries, author, tag ? [tag] : [], clock);
  const byDay = new Map<string, CalendarEntry[]>();
  for (const entry of filtered) {
    const day = localDay(new Date(entry.row.created_at));
    byDay.set(day, [...(byDay.get(day) || []), entry]);
  }
  const tags = [
    ...new Map(
      available
        .flatMap((e) => contentTags(e.content))
        .map((t) => [t.kind + ":" + t.id, t]),
    ).entries(),
  ];
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
      <div className="page-heading">
        <h1>Photos</h1>
        <p>A month of moments from your connections.</p>
      </div>
      <section className="panel photo-calendar">
        <div className="calendar-month">
          <Button
            type="button"
            aria-label="Previous month"
            onClick={() => {
              setSelected(null);
              setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1));
            }}
          >
            ←
          </Button>
          <h2 aria-live="polite">
            {month.toLocaleDateString(undefined, {
              month: "long",
              year: "numeric",
            })}
          </h2>
          <Button
            type="button"
            aria-label="Next month"
            onClick={() => {
              setSelected(null);
              setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1));
            }}
          >
            →
          </Button>
        </div>
        <div className="calendar-filters">
          <label>
            Posted by
            <select value={author} onChange={(e) => setAuthor(e.target.value)}>
              <option value="">Everyone</option>
              {[
                ...new Map(
                  available.map((e) => [
                    e.row.author_id,
                    e.row.author_handle || "Member",
                  ]),
                ).entries(),
              ].map(([id, label]) => (
                <option key={id} value={id}>
                  @{label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Tagged person
            <select value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">Anyone</option>
              {tags.map(([id, t]) => (
                <option key={id} value={id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            onClick={() => {
              setAuthor("");
              setTag("");
            }}
          >
            Clear filters
          </Button>
        </div>
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
                {choice?.media ? (
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
          <Alert>{action.error}</Alert>
          <Alert success>{action.notice}</Alert>
          {!(byDay.get(selected) || []).length && (
            <p>
              No matching posts for this day
              {next ? " in the posts loaded so far" : ""}.
            </p>
          )}
          {(byDay.get(selected) || []).map(({ row, content }) => (
            <article className="calendar-post" key={row.id}>
              <a href={`/app/post/${row.id}`}>
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
                    Feature this photo
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
        </Modal>
      )}
    </>
  );
}
