const legacyOrigin = "https://porchday.com";
const canonicalOrigin = "https://porchday.org";

/** A fixed trusted authority preserves paths, queries and fragments without an open redirect. */
export function canonicalNavigation(destination: URL): string | null {
  return destination.origin === legacyOrigin
    ? canonicalOrigin + destination.pathname + destination.search + destination.hash
    : null;
}

export function needsDomainNavigation(destination: URL, currentOrigin: string): boolean {
  return currentOrigin === legacyOrigin && destination.origin === legacyOrigin;
}
