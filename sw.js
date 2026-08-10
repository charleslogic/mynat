const CACHE = 'mynat-v2';
const SHELL = [
    'supabase.umd.js',   // self-hosted Supabase lib — precached so auth survives CDN/network issues
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
    'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
    'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js',
    'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css',
    'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css',
];

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE)
            .then(c => c.addAll(SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k !== CACHE).map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('message', e => {
    if (e.data === 'SKIP_WAITING') self.skipWaiting();
    if (e.data === 'CLEAR_CACHE') {
        e.waitUntil(
            caches.keys()
                .then(keys => Promise.all(keys.map(k => caches.delete(k))))
                .then(() => self.clients.matchAll())
                .then(clients => clients.forEach(c => c.postMessage('RELOAD')))
        );
    }
});

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);

    // API calls: network only, offline fallback
    if (url.pathname.startsWith('/api')) {
        e.respondWith(
            fetch(e.request).catch(() =>
                new Response(
                    JSON.stringify({ ok: false, error: 'offline' }),
                    { headers: { 'Content-Type': 'application/json' } }
                )
            )
        );
        return;
    }

    // Same-origin app files (HTML, mynat.js, mynat.css, icon, manifest):
    // network-first so a new deploy is picked up on the very next load
    // instead of silently serving a stale cached copy until a hard refresh.
    // This used to only cover HTML — splitting app logic into mynat.js/
    // mynat.css (unlike hab, which keeps everything inline in index.html)
    // meant those files fell through to the cache-first branch below and
    // went stale after every deploy.
    if (url.origin === location.origin) {
        e.respondWith(
            fetch(e.request)
                .then(res => {
                    if (res && res.ok) {
                        const clone = res.clone();
                        caches.open(CACHE).then(c => c.put(e.request, clone));
                    }
                    return res;
                })
                .catch(() => caches.match(e.request))
        );
        return;
    }

    // Cross-origin CDN assets (Leaflet, fonts): cache-first. Safe to cache
    // indefinitely since these URLs are version-pinned — they never change
    // under the same URL.
    e.respondWith(
        caches.match(e.request).then(cached => {
            if (cached) return cached;
            return fetch(e.request).then(res => {
                if (res && res.ok) {
                    const clone = res.clone();
                    caches.open(CACHE).then(c => c.put(e.request, clone));
                }
                return res;
            });
        })
    );
});
