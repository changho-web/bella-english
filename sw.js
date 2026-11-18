/* Bella English 오프라인 캐시
   - 화면(index.html)은 인터넷이 되면 항상 새 버전을 먼저 받음 → 업데이트가 바로 반영
   - 그림·아이콘은 한 번 받으면 저장해 두고 씀 → 빠르게 열림 */
const CACHE = 'bella-v1';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== 'bella-share' && !k.startsWith('bella-math-')).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  /* PENUP 등에서 "공유 → Bella English": 그림을 잠깐 저장하고 앱을 ?share=1로 엶 */
  if(req.method === 'POST' && new URL(req.url).pathname.endsWith('/share-target')){
    e.respondWith((async () => {
      const info = {t: Date.now(), ok: false, type: '', size: 0, name: '', keys: [], err: ''};
      try{
        const c = await caches.open('bella-share');
        const fd = await req.formData();
        let f = null;
        for(const [k, v] of fd.entries()){                 // 앱마다 보내는 이름이 달라도 첫 번째 파일을 받음
          const isFile = v && typeof v === 'object' && 'size' in v;
          info.keys.push(k + (isFile ? '=' + (v.type || '?') + '/' + v.size : '=text'));
          if(!f && isFile && v.size) f = v;
        }
        if(f){
          await c.put('shared-image', new Response(f, {headers: {'content-type': f.type || 'application/octet-stream'}}));
          Object.assign(info, {ok: true, type: f.type || '', size: f.size, name: f.name || ''});
        }
        await c.put('shared-info', new Response(JSON.stringify(info), {headers: {'content-type': 'application/json'}}));
      }catch(err){
        info.err = String(err && err.message || err).slice(0, 200);
        try{ await (await caches.open('bella-share')).put('shared-info', new Response(JSON.stringify(info))); }catch(e2){}
      }
      return Response.redirect('./?share=1', 303);
    })());
    return;
  }
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
