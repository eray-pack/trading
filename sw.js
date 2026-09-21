/* Caches the app shell so the journal opens instantly, even on a bad connection.
   Trade data always comes from the network — a stale P&L is worse than no P&L. */

const CACHE = "confluence-v10";

/* The files that change when I ship. These go network-first: a deploy has to reach
   the installed app on the next launch, not the one after. */
const CODE = ["./", "./index.html", "./app.js", "./style.css", "./manifest.webmanifest"];

/* These effectively never change, so cache-first is free speed. */
const STATIC = [
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
];

const isCode = url =>
  /\/(index\.html|app\.js|style\.css|manifest\.webmanifest)$/.test(url.pathname)
  || /\/trading\/?$/.test(url.pathname);

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // `cache: "reload"` bypasses the browser's own HTTP cache. Without it a fresh
    // service worker can fill its brand-new cache with the very files it replaced.
    await Promise.all([...CODE, ...STATIC].map(async p => {
      try { await c.put(p, await fetch(new Request(p, { cache: "reload" }))); }
      catch (_) { /* one missing file must not block activation */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const { request } = e;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Never cache Supabase: auth tokens and trade rows must always be live.
  if (url.hostname.endsWith("supabase.co")) return;
  if (url.origin !== self.location.origin) return;

  // App code and navigations: network first, cache only as the offline fallback.
  if (request.mode === "navigate" || isCode(url)) {
    e.respondWith((async () => {
      try {
        const res = await fetch(request);
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(request, copy)).catch(() => {});
        }
        return res;
      } catch (_) {
        return (await caches.match(request))
            || (await caches.match("./index.html"))
            || Response.error();
      }
    })());
    return;
  }

  // Everything else (icons): cache first, refreshed in the background.
  e.respondWith((async () => {
    const hit = await caches.match(request);
    const live = fetch(request).then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => hit);
    return hit || live;
  })());
});
