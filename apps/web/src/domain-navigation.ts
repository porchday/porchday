const legacyOrigin = "https://porchday.com";
const publicPages = new Set([
  "/", "/join", "/about", "/principles", "/privacy", "/community",
  "/accessibility", "/help", "/contact",
]);

/** Explicit public navigation must reach the server's canonical-domain redirect.
 * Account, recovery and unknown routes keep the current SPA/origin behavior. */
export function needsDomainNavigation(destination: URL, currentOrigin: string): boolean {
  return currentOrigin === legacyOrigin && destination.origin === legacyOrigin &&
    publicPages.has(destination.pathname);
}
