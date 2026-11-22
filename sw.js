// Homebase service worker: lets the app open instantly and work offline.
// Change VERSION whenever app files change so phones pick up the update.
const VERSION = "homebase-v32";
const FILES = [
  "./", "index.html", "app.css", "features.css", "app.js", "theme.js", "vault.js", "art.js", "skylines.js", "manifest.webmanifest",
  "fonts/cormorant-garamond-latin-wght-normal.woff2", "fonts/cormorant-garamond-latin-wght-italic.woff2", "fonts/jost-latin-wght-normal.woff2",
  "icon-192.png", "icon-512.png", "apple-touch-icon.png",
  // app modules (app.js is the entry; it imports these)
  "js/auth.js", "js/calendar-tab.js", "js/calendar.js", "js/courses.js", "js/discover-ideas.js", "js/discover.js", "js/draw.js", "js/events.js", "js/firebase.js", "js/growth.js", "js/ics.js", "js/journal.js", "js/kits.js", "js/location.js", "js/look.js", "js/nav.js", "js/places.js", "js/protected.js", "js/screentime.js", "js/settings.js", "js/sound.js", "js/state.js", "js/study.js", "js/sync.js", "js/tasks.js", "js/timer.js", "js/toast.js", "js/today.js", "js/todo.js", "js/util.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first (so updates show up), cached copy when offline or when the network is too slow.
const SLOW_MS = 3000;
let slowUntil = 0;
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  // Video players stay on YouTube and Vimeo. Never cache them.
  if (url.hostname === "www.youtube-nocookie.com" || url.hostname === "www.youtube.com" || url.hostname === "player.vimeo.com" || url.hostname === "vimeo.com") return;
  // Firebase code files never change for a given version: cache-first, so the app opens offline.
  if (url.origin === "https://www.gstatic.com" && url.pathname.startsWith("/firebasejs/")) {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      }))
    );
    return;
  }
  if (url.origin !== location.origin) return;
  // A Homebase spot link is only a hash (#discover/spot?...). The network request is the
  // document without that hash, so GitHub Pages and this cache still serve the app.
  // "no-cache" makes the browser check GitHub for a newer copy every time,
  // so updates show up right away instead of up to 10 minutes later.
  const fromNetwork = fetch(e.request.mode === "navigate" ? e.request.url : e.request, { cache: "no-cache" });
  // Save a copy for offline use. Only good answers, so an error page never replaces the saved app.
  const saved = fromNetwork.then((res) => {
    if (!res.ok) return null;
    const copy = res.clone();
    return caches.open(VERSION).then((c) => c.put(e.request, copy));
  }).catch(() => {});
  const fromCache = () => caches.match(e.request).then((r) => r || caches.match("index.html"));
  // If GitHub answers with an error page, prefer the saved copy.
  const answer = fromNetwork.then((res) => res.ok ? res : caches.match(e.request).then((hit) => hit || res));
  // On a weak signal, don't leave the screen waiting: after 3 s use the saved copy
  // (if there is one) and let the download finish in the background for next time.
  // Once one file has been that slow, the files right behind it skip the wait.
  const wait = Date.now() < slowUntil ? 0 : SLOW_MS;
  const slow = new Promise((resolve) => setTimeout(resolve, wait))
    .then(() => caches.match(e.request))
    .then((hit) => { if (hit && wait) slowUntil = Date.now() + 10000; return hit; });
  e.respondWith(
    Promise.race([answer, slow.then((hit) => hit || answer)]).catch(fromCache)
  );
  e.waitUntil(saved);
});
