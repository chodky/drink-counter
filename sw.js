/* 飲酒カウンター service worker — 本体はネットワーク優先（更新即反映）、
   画像などのアセットはキャッシュ優先（オフライン・低速回線対応） */
const VER = "dc-v1";
const CORE = ["./", "./index.html", "./logic.js", "./manifest.json"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VER).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== VER).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const isCore = e.request.mode === "navigate" || url.pathname.endsWith(".html") || url.pathname.endsWith("logic.js");
  if (isCore) {
    e.respondWith(
      fetch(e.request)
        .then(r => { const cp = r.clone(); caches.open(VER).then(c => c.put(e.request, cp)); return r; })
        .catch(() => caches.match(e.request, { ignoreSearch: true }))
    );
  } else {
    e.respondWith(
      caches.match(e.request).then(hit => hit ||
        fetch(e.request).then(r => { const cp = r.clone(); caches.open(VER).then(c => c.put(e.request, cp)); return r; }))
    );
  }
});
