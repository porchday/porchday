import {hasPendingSaves, pendingSaves} from './pending-saves';

/** Public shell only; no member data is fetched or persisted by this updater. */
export function startAutomaticUpdates(options: {idleMs?: number; checkMs?: number; reload?: () => void} = {}) {
  const current = document.querySelector<HTMLMetaElement>('meta[name="porchday-build"]')?.content;
  const idleMs = options.idleMs ?? 60_000;
  let lastActivity = Date.now(), stopped = false, checking = false, target = '', reloading = false;
  let registration: ServiceWorkerRegistration | undefined;
  const edited = new Set<Element>();
  const safe = () => {
    if (hasPendingSaves() || !navigator.onLine || document.querySelector('[data-unsaved-draft="true"],dialog[open],[role="dialog"]')) return false;
    if ([...document.querySelectorAll('video,audio')].some(el => !(el as HTMLMediaElement).paused && !(el as HTMLMediaElement).ended)) return false;
    if (document.activeElement?.matches('input,textarea,select,[contenteditable="true"]')) return false;
    for (const el of edited) {
      if (!el.isConnected || el.closest('[data-draft-saved="true"]')) { edited.delete(el); continue; }
      return false;
    }
    return document.hidden || Date.now() - lastActivity >= idleMs;
  };
  const attempt = () => {
    if (stopped || reloading || !safe()) return;
    // The worker independently asks every controlled tab before taking over.
    registration?.waiting?.postMessage('ACTIVATE_UPDATE_WHEN_SAFE');
    if (!target || target === current) return;
    try {
      const previous = JSON.parse(sessionStorage.getItem('porchday-auto-update') || 'null');
      if (previous?.target === target && Date.now() - previous.at < 300_000) return;
      sessionStorage.setItem('porchday-auto-update', JSON.stringify({target, at: Date.now()}));
    } catch { return; } // Do not risk a reload loop when storage is unavailable.
    reloading = true;
    (options.reload || (() => location.reload()))();
  };
  const check = async () => {
    if (stopped || checking || !navigator.onLine) return;
    checking = true;
    try {
      if (current) {
        const response = await fetch('/app-shell', {cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(10_000)});
        if (response.ok && response.headers.get('content-type')?.includes('text/html')) {
          const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
          const next = doc.querySelector<HTMLMetaElement>('meta[name="porchday-build"]')?.content;
          if (next && /^[a-f0-9]{24}$/.test(next)) target = next;
        }
      }
      await registration?.update().catch(() => {});
    } catch { /* Routine polling failures are silent; normal offline UI remains. */ }
    finally { checking = false; attempt(); }
  };
  const activity = (event: Event) => {
    lastActivity = Date.now();
    if ((event.type === 'input' || event.type === 'change') && event.target instanceof Element) edited.add(event.target);
  };
  const message = (event: MessageEvent) => {
    if (event.data === 'PORCHDAY_UPDATE_SAFE') event.ports[0]?.postMessage({safe: safe()});
  };
  const controllerChanged = () => { void check(); };
  const visible = () => { attempt(); if (!document.hidden) void check(); };
  const events = ['pointerdown', 'keydown', 'input', 'change', 'scroll'];
  events.forEach(name => document.addEventListener(name, activity, {capture: true, passive: true}));
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('online', check);
  window.addEventListener('focus', check);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', message);
    navigator.serviceWorker.addEventListener('controllerchange', controllerChanged);
    void navigator.serviceWorker.register('/sw.js', {scope: '/', updateViaCache: 'none'}).then(reg => {
      if (stopped) return;
      registration = reg;
      void check();
    }).catch(() => {});
  }
  void check();
  const checkTimer = setInterval(check, options.checkMs ?? 300_000);
  const idleTimer = setInterval(attempt, Math.min(idleMs, 15_000));
  const unsubscribe = pendingSaves.subscribe(attempt);
  return () => {
    stopped = true; clearInterval(checkTimer); clearInterval(idleTimer); unsubscribe();
    events.forEach(name => document.removeEventListener(name, activity, true));
    document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('online', check); window.removeEventListener('focus', check);
    navigator.serviceWorker?.removeEventListener('message', message);
    navigator.serviceWorker?.removeEventListener('controllerchange', controllerChanged);
  };
}
