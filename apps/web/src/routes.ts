/** Old bookmarks remain valid, but the website uses root-level member routes. */
export function canonicalPath(path: string): string {
  return path === "/app" ? "/" : path.startsWith("/app/") ? "/" + path.slice(5).replace(/^\/+/, "") : path;
}
const memberRoots = ["wall", "connections", "groups", "notifications", "settings", "albums", "photos", "share", "menu", "post", "features", "builder-chat", "performance", "diagnostics", "integrations"];
export function isMemberPath(path: string): boolean {
  return path === "/" || memberRoots.some(root => path === "/" + root || path.startsWith("/" + root + "/"));
}
export function loginDestination(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  const url = new URL(value, "https://porchday.invalid");
  const path = canonicalPath(url.pathname);
  return isMemberPath(path) || ["/about", "/mission", "/principles", "/privacy", "/community", "/accessibility", "/help", "/contact", "/staff", "/staff/moderation"].includes(path)
    ? path + url.search + url.hash : "/";
}
