import React from "react";

const primaryOrigin = "https://porchday.org";
const previousOrigin = "https://porchday.com";

export function LegacyDomainNotice({ origin, path }: { origin: string; path: string }) {
  if (origin !== previousOrigin || !(path === "/app" || path.startsWith("/app/") ||
    ["/login", "/forgot", "/reset", "/verify"].includes(path))) return null;
  return (
    <aside className="domain-move-notice" aria-label="Porchday website address">
      <p>Porchday is now at <a href={primaryOrigin + "/app"} target="_blank" rel="noopener noreferrer">porchday.org</a>. Your saved encryption keys still work here.</p>
      <details>
        <summary>Moving to porchday.org</summary>
        <p>Use the same email and password, then your saved encryption recovery secret to unlock your history. Keep this browser’s data and the old installed app until your history opens at porchday.org. Installing the new site creates a separate app.</p>
      </details>
    </aside>
  );
}

export function PreviousDomainUnlockHint({ origin }: { origin: string }) {
  if (origin !== primaryOrigin) return null;
  return (
    <p className="domain-unlock-hint">
      Previously used porchday.com? <a href={previousOrigin + "/app"} target="_blank" rel="noopener noreferrer">Open porchday.com</a> in your original browser to keep using its saved keys while you locate your recovery secret. Keep its browser data and installed app until your history opens here.
    </p>
  );
}
