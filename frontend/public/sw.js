// dRec PWA 서비스워커 — 설치 가능성 충족 + 정적 자원 최소 오프라인 캐시.
// API(/api/*)와 비-GET 요청은 캐시하지 않는다(녹음/전사/오디오는 항상 네트워크).
const CACHE = 'drec-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});
