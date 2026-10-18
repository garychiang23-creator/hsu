/* 許氏寫字台 service worker
 * 改版必做：SHELL 裡任何一支改了，CACHE 版本號就 +1，否則 iPad 上拿到的還是舊版。
 * push_deploy.js 有 gate 會擋（SHELL 檔案有變但版本沒往前 = 不准推）。
 */
const CACHE = 'hsu-v3';

/* 頁面本體＋它載入的每一支本地檔，同進同出（離線要能打字）。
 * 這是「版本一致」的單位：install 時整批一起抓、一起換，
 * 不會出現新的 clip.html 配上舊的 pad.js。所以頁面載入的本地檔一律要列在這裡，
 * smoke test 有斷言守著。 */
const SHELL = [
  './',
  './index.html',
  './clip.html',
  './pad.js',
  './pad.css',
  './manifest.json',
  './vendor/mcbopomofo.bundle.js',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
];

/* ⚠️ 絕對不可以快取的（2026-08-05 踩過，代價是好幾輪鬼打牆）：
 *   hsu.user.js / probe_l2.user.js / get.html
 * 這幾支是「要安裝到 iPad 上的腳本」和「取件頁」。
 * v1 的 sw.js 對整個 /hsu/ 一律 cache-first，結果使用者每次去 get.html 下載，
 * 拿到的都是快取裡的舊腳本 —— 檔案明明換了、行為卻永遠不變，查了五輪才發現。
 * 這類「安裝來源」檔案一律走網路，離線拿不到是正確行為。
 */
const shellUrls = () => new Set(SHELL.map((p) => new URL(p, self.location).href));

self.addEventListener('install', (e) => {
  // cache:'reload' ＝ 繞過瀏覽器的 HTTP 快取直接問伺服器。
  // GitHub Pages 給 max-age=600：不加的話，十分鐘內開過舊版的 iPad 會把舊檔裝進新版快取，
  // 然後一直卡到下一次升版。
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
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
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  // 非 shell（含腳本檔與取件頁）一律走網路，不碰快取
  if (!shellUrls().has(url.origin + url.pathname)) return;

  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }))
  );
});
