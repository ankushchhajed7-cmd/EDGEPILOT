/* EdgePilot service worker.
 * Caches the app shell only. Market data is never cached here: a stale candle
 * served from a service worker would defeat the entire data-quality gate.
 */
// Single source of truth for the version lives in util.js, so the cache name
// changes automatically whenever EP.VERSION is bumped.
importScripts('./util.js');
const SHELL = 'edgepilot-shell-v' + self.EP.VERSION;
const FILES = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './util.js', './indicators.js', './stats.js', './engine.js',
  './backtest.js', './store.js', './api.js', './ui.js', './app.js',
  './icon-192.png', './icon-512.png', './apple-touch-icon.png', './favicon-32.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((cs) => cs.forEach((c) => c.postMessage({ type: 'EP_UPDATED', version: self.EP.VERSION })))
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return; // backend and fonts bypass the cache
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        const copy = r.clone();
        caches.open(SHELL).then((c) => c.put(e.request, copy));
        return r;
      })
      .catch(() => caches.match(e.request).then((m) => m || caches.match('./index.html')))
  );
});
