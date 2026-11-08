# Quiet automatic updates

Owner request, November 8, 2026; issue #190.

The browser, PWA and default native web shells check the public application shell on startup, foreground/online events and every five minutes. A public build marker identifies a changed frontend, including a rollback. No update banner or install button is shown. Reload waits until the page is backgrounded or idle for one minute, with no active save, unsaved edit, focused editor, open dialog or playing media. Encrypted saved Share drafts may survive the reload; unsaved/importing drafts defer it. Unsubmitted form edits conservatively defer until their controls leave the page. Failed polling stays silent and retries later. A session-local throttle prevents rapid reload loops if deployment propagation serves an old document.

A waiting service worker asks every open window whether updating is safe. Busy or nonresponsive clients defer activation. Every tab independently protects its work before reloading. Older open clients that do not support the safety protocol defer worker activation until they close; the new behavior takes effect when they next load the updated UI. Normal first installation remains the browser's service-worker lifecycle.

Routine background access-sharing progress is silent. Failed access updates retain a retry and explain that eligible people/devices may lack access. Offline/outage, failed operations, storage failures and blocking saves remain actionable. Existing opt-in social notifications are unchanged; this request concerns operational app notices, not removal of explicitly requested social notifications.

Native binary updates are distributed through TestFlight/App Store and follow OS/user automatic-update settings. Web code cannot force-install a signed binary. No new native binary is required for this shared UI behavior. Physical resume/update acceptance remains under #49/#114; automated Chromium/WebKit checks cover idle updates and deferral for drafts, saves, playback, dialogs and form edits.
