/* Bella English 오프라인 캐시
   - 화면(index.html)은 인터넷이 되면 항상 새 버전을 먼저 받음 → 업데이트가 바로 반영
   - 그림·아이콘은 한 번 받으면 저장해 두고 씀 → 빠르게 열림 */
const CACHE = 'bella-v1';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const isPage = req.mode === 'navigate' || req.url.endsWith('.html') || req.url.endsWith('/') || req.url.endsWith('.webmanifest');
  if(isPage){
    e.respondWith(fetch(req).then(res => { const c = res.clone(); caches.open(CACHE).then(ca => ca.put(req, c)); return res; })
      .catch(() => caches.match(req).then(r => r || caches.match('./'))));
  } else {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if(res.ok){ const c = res.clone(); caches.open(CACHE).then(ca => ca.put(req, c)); }
      return res;
    })));
  }
});
