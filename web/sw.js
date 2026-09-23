/* 离线缓存：
 * - 课表数据：网络优先，失败时回退缓存（保证拿到最新的加密数据）
 * - 页面外壳：stale-while-revalidate（先秒开缓存，再后台更新，避免长期停留旧版本）
 * - 失败响应（404 等）不写入缓存
 */
const CACHE = 'hhu-schedule-v1';
const ASSETS = ['./', './index.html', './style.css', './app.js', './layout.js', './manifest.webmanifest', './icon.svg'];

const putIfOk = (request, response) => {
  if (response && response.ok) {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(request, copy));
  }
  return response;
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => Promise.all(ASSETS.map((asset) => cache.add(asset).catch(() => null)))).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  if (url.pathname.endsWith('schedule.enc.json')) {
    event.respondWith(
      fetch(request)
        .then((response) => putIfOk(request, response))
        .catch(() => caches.match(request)),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((response) => putIfOk(request, response))
        .catch(() => (request.mode === 'navigate' ? caches.match('./index.html') : Response.error()));
      return hit || network;
    }),
  );
});
