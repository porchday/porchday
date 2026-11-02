import type { Content, SocialObject } from "./api";
export const authorCategories = ["me", "family", "friends", "extended_family", "community"] as const;
export type AuthorCategory = typeof authorCategories[number];
export const defaultAuthorCategories: AuthorCategory[] = ["me", "family", "friends"];
export const authorLabels: Record<AuthorCategory, string> = {
  me: "Me", family: "Family", friends: "Friends", extended_family: "Extended family", community: "Community",
};
export type FeedContent = "posts" | "photos";
export type AuthorFilter = { memberId: string; selected: readonly AuthorCategory[]; relations: ReadonlyMap<string, AuthorCategory> };
/** Presentation-only filtering. Rows must already be authorized by the service. */
export function matchesAuthor(row: Pick<SocialObject, "author_id">, filter: AuthorFilter) {
  const category = row.author_id === filter.memberId ? "me" : filter.relations.get(row.author_id);
  return category !== undefined && filter.selected.includes(category);
}
export function matchesContent(content: Content, selected: FeedContent) {
  return selected === "posts" || Boolean(content.media?.length);
}
