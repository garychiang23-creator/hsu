/* 許氏寫字台 service worker
 * 改版必做：CACHE 版本號 +1，否則 iPad 上拿到的還是舊版。
 * push_deploy.js 有 gate 會擋（index.html 改了但版本沒 +1 = 不准推）。
 */
const CACHE = 'hsu-v1';

const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './vendor/mcbopomofo.bundle.js',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // cache-first：5 MB 的引擎只該下載一次，離線也要能打字
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
