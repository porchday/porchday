import { expect, it } from "vitest";
import { canonicalPath, isMemberPath, loginDestination } from "../src/routes";
import { canonicalNavigation } from "../src/domain-navigation";
it("maps old routes without changing similarly named paths or assets", () => {
  for (const [before, after] of [["/app", "/"], ["/app/", "/"], ["/app/connections", "/connections"], ["/app/albums/id", "/albums/id"], ["/app//evil.test", "/evil.test"], ["/app-shell", "/app-shell"], ["/application", "/application"], ["/appeals", "/appeals"]]) expect(canonicalPath(before)).toBe(after);
  for (const host of ["https://porchday.org", "https://staging.porchday.com", "http://localhost:5173"])
    expect(canonicalNavigation(new URL(host + "/app/connections?handle=friend#keep"))).toBe(host + "/connections?handle=friend#keep");
  expect(canonicalNavigation(new URL("https://porchday.com/app/connections?handle=friend#keep"))).toBe("https://porchday.org/connections?handle=friend#keep");
});
it("classifies member routes without capturing public/API or lookalike paths", () => {
  for (const path of ["/", "/connections", "/albums/id", "/post/id", "/wall/id", "/settings/data", "/share", "/photos", "/groups/id", "/notifications", "/features", "/builder-chat", "/menu", "/performance", "/integrations/authorize"]) expect(isMemberPath(path),path).toBe(true);
  for (const path of ["/login", "/join", "/privacy", "/api/v1/me", "/app-shell", "/connections-evil", "/unknown", "//evil.test"]) expect(isMemberPath(path),path).toBe(false);
});
it("returns to permitted deep links after login without permitting open redirects", () => {
  expect(loginDestination("/connections?handle=friend#person")).toBe("/connections?handle=friend#person");
  expect(loginDestination("/app/albums/id?view=all")).toBe("/albums/id?view=all");
  for (const value of ["https://evil.test", "//evil.test", "/\\evil.test", "/app//evil.test", "/api/auth/sign-out", "/unknown", "/%2f%2fevil.test"]) expect(loginDestination(value),value).toBe("/");
});
