// The demo's service worker, in place of the app's (web/sw.js): the demo keeps nothing to work offline for. It's here
// only so a visit right after a deploy opens the new page. GitHub Pages sends everything with max-age=600, so the
// browser used its own copy of the old page for up to ten minutes (the old tab names, until a reload). Every request
// to the site is checked with it instead (cache: 'no-cache': a 304 when unchanged). lib/ paths carry their version
// and never change, so they keep the usual caching.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || /\/lib\//.test(url.pathname)) return;
  e.respondWith(fetch(req, { cache: 'no-cache' }));   // a navigation's mode becomes same-origin; its redirect mode is kept
});
