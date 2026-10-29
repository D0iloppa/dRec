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

// ── Web Push ────────────────────────────────────────────────────────────────
// 페이로드: {title, body, url, tag}. 같은 tag(회의별)는 기기에서 이전 알림을 교체한다.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(
    self.registration.showNotification(d.title || 'dRec', {
      body: d.body || '',
      tag: d.tag || undefined,
      renotify: !!d.tag,
      icon: '/icon.svg',
      badge: '/icon.svg',
      data: { url: d.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
      for (const c of list) {
        if (new URL(c.url).origin === self.location.origin && 'focus' in c) {
          await c.focus();
          // 열린 탭을 직접 navigate 하면 페이지가 새로 로드돼 진행 중인 녹음이 끊긴다 →
          // 이미 그 주소면 포커스만, 아니면 앱에 이동을 요청(앱이 녹음 중이면 무시). 구버전 앱은 포커스만 된다.
          if (c.url !== url) c.postMessage({ type: 'drec:navigate', url: new URL(url).pathname + new URL(url).search });
          return;
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
