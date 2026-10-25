// Minimal service worker: makes the app installable and shows an offline page.
// It never caches pages or API responses (they contain private customer data).
const OFFLINE_HTML = '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title><body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#f4f8fc;color:#1f2a3d;text-align:center"><div><h1>You are offline</h1><p>Reconnect to the internet and reopen the app.</p></div>';
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE_HTML, { headers: { "content-type": "text/html" } })));
});
