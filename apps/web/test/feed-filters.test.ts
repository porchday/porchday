import { describe, it, expect } from "vitest";
import { matchesAuthor, matchesContent, defaultAuthorCategories, type AuthorFilter } from "../src/feed-filters";
const filter: AuthorFilter = { memberId: "self", selected: defaultAuthorCategories, relations: new Map([
  ["parent", "family"], ["friend", "friends"], ["cousin", "extended_family"], ["neighbor", "community"],
]) };
describe("Feed presentation filters", () => {
  it("defaults to self and direct friends/family without treating unknown authors as friends", () => {
    expect(["self", "parent", "friend", "cousin", "neighbor", "stranger"].filter(author_id => matchesAuthor({author_id}, filter))).toEqual(["self", "parent", "friend"]);
  });
  it("permits zero or selected categories without granting any additional rows", () => {
    expect(matchesAuthor({author_id:"self"}, {...filter, selected:[]})).toBe(false);
    expect(matchesAuthor({author_id:"cousin"}, {...filter, selected:["extended_family"]})).toBe(true);
    expect(matchesAuthor({author_id:"stranger"}, {...filter, selected:["community"]})).toBe(false);
  });
  it("uses service-derived two-hop categories without treating them as direct friends",()=>{
    const row={author_id:"remote",author_category:"community"};
    expect(matchesAuthor(row,filter)).toBe(false);
    expect(matchesAuthor(row,{...filter,selected:["community"]})).toBe(true);
    expect(matchesAuthor({...row,author_category:"unknown"},{...filter,selected:["community"]})).toBe(false);
  });
  it("excludes text-only decrypted posts from Photos and keeps them in Posts", () => {
    expect(matchesContent({text:"hello"}, "photos")).toBe(false);
    expect(matchesContent({text:"hello",media:[]}, "photos")).toBe(false);
    expect(matchesContent({text:"hello"}, "posts")).toBe(true);
    expect(matchesContent({media:[{id:"image",alt:"",mime:"image/jpeg",name:"",width:2,height:2}]}, "photos")).toBe(true);
  });
});
