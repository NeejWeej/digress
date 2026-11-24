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
  // A navigation is asked for again as a new request made from its address: WebKit served the page from its own
  // cache when the navigation's request was passed on, even with cache: 'no-cache' (CI's WebKit, test_sw_fresh.py).
  e.respondWith(req.mode === 'navigate' ? fetchPage(req.url) : fetch(req, { cache: 'no-cache' }));
});
async function fetchPage(url) {
  const res = await fetch(new Request(url, { cache: 'no-cache', credentials: 'same-origin' }));
  return res.redirected ? Response.redirect(res.url, 302) : res;   // a navigation can't take a followed redirect as its answer
}
