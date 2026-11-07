const CACHE_VERSION = "family-travel-v16";
const CACHE = CACHE_VERSION;
const SHELL = ["/", "/styles/home.css", "/scripts/home.js", "/data/trips.json", "/assets/app-icon.svg", "/assets/travel-icons.svg", "/trips/yeosu-2026-08/", "/trips/tongyeong-geoje-2026-07/", "/trips/anyang-market-2026-11/"];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))));
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || new URL(event.request.url).pathname.startsWith("/api/")) return;
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request).then(cached => cached || caches.match("/"))));
});
