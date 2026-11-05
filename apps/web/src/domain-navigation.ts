import { canonicalPath } from "./routes";
const legacyOrigin = "https://porchday.com";
const canonicalOrigin = "https://porchday.org";

/** A fixed trusted authority preserves paths, queries and fragments without an open redirect. */
export function canonicalNavigation(destination: URL): string | null {
  const path = canonicalPath(destination.pathname);
  if (destination.origin === legacyOrigin)
    return canonicalOrigin + path + destination.search + destination.hash;
  return path !== destination.pathname ? destination.origin + path + destination.search + destination.hash : null;
}

export function needsDomainNavigation(destination: URL, currentOrigin: string): boolean {
  return currentOrigin === legacyOrigin && destination.origin === legacyOrigin;
}
