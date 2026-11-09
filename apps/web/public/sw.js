/* The application shell only. Never cache API responses, photos, or private content. */
const CACHE = "porchday-shell-v1";
const SHELL = [
  "/app-shell",
  "/icon.svg",
  "/logo.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.webmanifest",
];
self.addEventListener("install", (event) =>
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL))),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  ),
);
self.addEventListener("message", (event) => {
  if (event.data === "ACTIVATE_UPDATE") self.skipWaiting();
  if (event.data === "ACTIVATE_UPDATE_WHEN_SAFE") event.waitUntil((async () => {
    const clients = await self.clients.matchAll({type: "window", includeUncontrolled: true});
    const readiness = await Promise.all(clients.map(client => new Promise(resolve => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 2000);
      channel.port1.onmessage = reply => { clearTimeout(timer); channel.port1.close(); resolve(reply.data?.safe === true); };
      client.postMessage("PORCHDAY_UPDATE_SAFE", [channel.port2]);
    })));
    if (readiness.every(Boolean)) await self.skipWaiting();
  })());
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    url.origin !== location.origin ||
    url.pathname.startsWith("/api") ||
    event.request.method !== "GET"
  )
    return;
  if (url.pathname === "/manifest.webmanifest") {
    // Installed-app metadata must stay fresh independently of the cached shell.
    // Keep the precached public manifest as an offline fallback only.
    event.respondWith(
      fetch(event.request, { cache: "no-cache" }).catch(() =>
        caches.match("/manifest.webmanifest").then((cached) => cached || Response.error()),
      ),
    );
  } else if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match("/app-shell").then((cached) => cached || Response.error()),
      ),
    );
  } else if (
    url.pathname.startsWith("/assets/") ||
    SHELL.includes(url.pathname)
  ) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ||
          fetch(event.request).then((response) => {
            if (response.ok && response.type === "basic") {
              const copy = response.clone();
              caches
                .open(CACHE)
                .then((cache) => cache.put(event.request, copy));
            }
            return response;
          }),
      ),
    );
  }
});
self.addEventListener("push", (event) => {
  let payload = {}; try { payload = event.data?.json() || {}; } catch {}
  const feed = payload.url === "/";
  const tag = typeof payload.tag === "string" && /^[a-f0-9]{32}$/.test(payload.tag) ? payload.tag : "porchday-update";
  event.waitUntil(Promise.all([
    self.registration.showNotification("Porchday", {
      body: feed ? "New activity in your feed" : "You have a new update.",
      icon: "/icon-192.png", badge: "/icon-192.png", tag,
      data: { url: feed ? "/" : "/notifications" },
    }),
    Number.isSafeInteger(payload.count) && payload.count >= 0 ?
      (payload.count ? self.navigator.setAppBadge?.(payload.count) : self.navigator.clearAppBadge?.())?.catch(() => {}) : Promise.resolve(),
  ]));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destination = event.notification.data?.url === "/notifications" ? "/notifications" : "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.navigate(destination);
          return client.focus();
        }
      }
      return self.clients.openWindow(destination);
    }),
  );
});
