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
self.addEventListener("push", (event) =>
  event.waitUntil(
    self.registration.showNotification("Porchday", {
      body: "You have a new update.",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: "porchday-update",
      data: { url: "/app" },
    }),
  ),
);
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.navigate("/app");
          return client.focus();
        }
      }
      return self.clients.openWindow("/app");
    }),
  );
});
