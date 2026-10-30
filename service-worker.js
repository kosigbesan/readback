/* ReadBack service worker.
   The point of this app is that it works in a car, which is exactly where
   signal disappears. Cache the shell and the document parsers on install,
   serve cache first, and never cache the voice API. */
const CACHE = "readback-v2";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./vendor/pdf.min.js",
  "./vendor/pdf.worker.min.js",
  "./vendor/mammoth.min.js",
  "./vendor/jszip.min.js"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Voice rendering is live data. Never cache it.
  if (url.hostname.endsWith("elevenlabs.io")) return;

  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req, { ignoreSearch: true }).then((hit) => {
        if (hit) return hit;
        return fetch(req).then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            const cp = res.clone();
            caches.open(CACHE).then((c) => c.put(req, cp));
          }
          return res;
        }).catch(() => caches.match("./index.html"));
      })
    );
    return;
  }

  // Cross origin: network with a cache fallback, but never hand back HTML
  // for a script or font request.
  e.respondWith(
    fetch(req).then((res) => {
      const cp = res.clone();
      caches.open(CACHE).then((c) => c.put(req, cp)).catch(() => {});
      return res;
    }).catch(() => caches.match(req))
  );
});
