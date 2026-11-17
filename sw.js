// Service Worker：让应用在没有网络时也能打开（看已经缓存在这台设备上的记录和缩略图）。
// 策略：应用自己的文件优先走网络（这样更新后马上生效），断网时用上次存下的副本。
// 对 Google Drive 的请求不经过这里。

const VERSION = 'birdlog-v1';
const SHELL = [
  './',
  './index.html',
  './config.js',
  './manifest.webmanifest',
  './css/app.css',
  './js/main.js',
  './js/ui.js',
  './js/store.js',
  './js/views.js',
  './js/viewer.js',
  './js/import-view.js',
  './js/importer.js',
  './js/imaging.js',
  './js/rawfile.js',
  './js/taxonomy.js',
  './js/backend-drive.js',
  './js/backend-local.js',
  './js/cache.js',
  './js/export.js',
  './js/util.js',
  './vendor/htm-preact.js',
  './vendor/exifr.js',
  './data/taxonomy.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req, { ignoreSearch: true });
        if (hit) return hit;
        if (req.mode === 'navigate') {
          const page = await caches.match('./index.html');
          if (page) return page;
        }
        return Response.error();
      }),
  );
});
