import type { Content, SocialObject } from "./api";
export const authorCategories = ["me", "family", "friends", "extended_family", "community"] as const;
export type AuthorCategory = typeof authorCategories[number];
export const defaultAuthorCategories: AuthorCategory[] = ["me", "family", "friends"];
export const authorLabels: Record<AuthorCategory, string> = {
  me: "Me", family: "Family", friends: "Friends", extended_family: "Extended family", community: "Community",
};
export type FeedContent = "everything" | "posts" | "photos";
export const audienceOptions = ["me", "friends", "family", "connections", "extended_family", "community"] as const;
export type FeedAudience = typeof audienceOptions[number];
export const audienceLabels: Record<FeedAudience,string> = {me:"Only me",friends:"Friends",family:"Family",connections:"Friends & Family",extended_family:"Extended family",community:"Community"};
export const audienceCategories: Record<FeedAudience,readonly AuthorCategory[]> = {me:["me"],friends:["me","friends"],family:["me","family"],connections:["me","friends","family"],extended_family:["me","family","extended_family"],community:authorCategories};
export type AuthorFilter = { memberId: string; audience?:FeedAudience; selected: readonly AuthorCategory[]; relations: ReadonlyMap<string, AuthorCategory> };
/** Presentation-only filtering. Rows must already be authorized by the service. */
export function matchesAuthor(row: Pick<SocialObject, "author_id"> & {author_category?:string;author_in_extended_family?:boolean}, filter: AuthorFilter) {
  if(filter.audience==="extended_family"&&row.author_in_extended_family!==undefined)return row.author_id===filter.memberId||row.author_in_extended_family;
  const category = row.author_id === filter.memberId ? "me" : filter.relations.get(row.author_id) ?? (authorCategories.includes(row.author_category as AuthorCategory)?row.author_category as AuthorCategory:undefined);
  return category !== undefined && filter.selected.includes(category);
}
export function matchesContent(content: Content, selected: FeedContent) {
  return selected !== "photos" || Boolean(content.media?.length);
}
