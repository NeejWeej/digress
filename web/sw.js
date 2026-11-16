// Digress's service worker: keeps the app usable without a connection, for reviewing flashcards.
//  - The page itself, prompts.js and threads.js: network first, so you always get the latest; the cached copy only when offline.
//  - Libraries from the CDNs and fonts: versioned URLs that never change, so cache first.
//  - GET /api/files/<id> (pasted screenshots, snips kept with cards): ids are never reused, so cache first.
//  - Everything else under /api/ (conversations, chat, cards) always goes to the server; the page keeps
//    its own offline copy of your cards and sends changes once the server is back.
// Only runs on https or localhost (a browser rule), e.g. Tailscale Serve or 127.0.0.1.
const CACHE = 'digress-v2';   // v2: libraries now load with integrity hashes (CORS); v1's opaque copies can't be checked
const LIBS = /^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
  await self.clients.claim();
})()));

async function cacheFirst(req) {
  const c = await caches.open(CACHE);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') c.put(req, res.clone());
  return res;
}
async function networkFirst(req, key) {
  const c = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) c.put(key, res.clone());
    return res;
  } catch (e) {
    return (await c.match(key)) || Response.error();
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (LIBS.test(req.url)) return e.respondWith(cacheFirst(req));
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') return e.respondWith(networkFirst(req, new URL('./', self.registration.scope).href));
  if (/\/(prompts|threads)\.js$/.test(url.pathname)) return e.respondWith(networkFirst(req, url.origin + url.pathname));
  if (/\/api\/files\/[a-f0-9]{32}$/.test(url.pathname)) return e.respondWith(cacheFirst(req));
});
