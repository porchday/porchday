import type { Content, SocialObject } from "./api";
import { contentTags } from "./PeopleTags";
export type CalendarEntry = { row: SocialObject; content: Content };
export function localDay(date: Date) {
  return `${String(date.getFullYear()).padStart(4,"0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function calendarDate(year:number,month:number,day=1) {
  const date=new Date(0);date.setFullYear(year,month,day);date.setHours(0,0,0,0);return date;
}
export function monthRange(year: number, month: number) {
  return {
    start: calendarDate(year, month, 1).toISOString(),
    end: calendarDate(year, month + 1, 1).toISOString(),
  };
}
export function monthCells(year: number, month: number) {
  const offset = calendarDate(year, month, 1).getDay(),
    days = calendarDate(year, month + 1, 0).getDate();
  return Array.from({ length: Math.ceil((offset + days) / 7) * 7 }, (_, i) =>
    i < offset || i >= offset + days
      ? null
      : localDay(calendarDate(year, month, i - offset + 1)),
  );
}
export function filterEntries(
  entries: CalendarEntry[],
  author: string,
  tags: string[],
  now = Date.now(),
) {
  return entries.filter(
    ({ row, content }) =>
      (!row.expires_at || Date.parse(row.expires_at) > now) &&
      (!author || row.author_id === author) &&
      (!tags.length ||
        contentTags(content).some((t) => tags.includes(t.kind + ":" + t.id))),
  );
}
export function featuredEntry(
  entries: CalendarEntry[],
  choice?: { post_id: string; media_id: string | null },
) {
  const chosen = entries.find((e) => e.row.id === choice?.post_id);
  const entry =
    chosen || entries.find((e) => e.content.media?.length) || entries[0];
  if (!entry) return null;
  return {
    entry,
    media:
      entry.content.media?.find((m) => chosen && m.id === choice?.media_id) ||
      entry.content.media?.[0],
  };
}

export function adjacentDay(day: string, offset: number) {
  const date = new Date(day + "T12:00:00");
  date.setDate(date.getDate() + offset);
  return localDay(date);
}
export function swipeDay(dx: number, dy: number, elapsed: number) {
  return elapsed <= 1000 && Math.abs(dx) >= 60 && Math.abs(dx) > Math.abs(dy) * 1.5
    ? (dx < 0 ? 1 : -1) : 0;
}
