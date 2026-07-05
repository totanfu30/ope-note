/* ope-note Service Worker — オフライン動作用
 * キャッシュ戦略: プリキャッシュ＋キャッシュ優先（アプリは完全静的のため）。
 * ファイルを更新したら CACHE_VERSION を上げること（古いキャッシュは activate で削除）。
 */
const CACHE_VERSION = "ope-note-v21";

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./sw-register.js",
  "./manifest.webmanifest",
  "./vendor/xlsx.full.min.js",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      // cache:"reload" でブラウザのHTTPキャッシュを迂回し、必ず最新ファイルを取得して入れる
      // （これがないと更新時に古い内容を再キャッシュしてしまう）
      .then((cache) => cache.addAll(PRECACHE_URLS.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // 同一オリジンの正常応答のみキャッシュに追加（外部通信はそもそも行わない設計）
        if (response.ok && new URL(event.request.url).origin === self.location.origin) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});
