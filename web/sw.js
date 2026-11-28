/* Dune BYOP (legacy frontend) — offline shell worker.
 *
 * The page is the original Dune Sega Web frontend; the ROM is a local File and
 * the generated game.wasm lives in OPFS, so neither is fetched here. This worker
 * only makes the wrapper/runtime/Pyodide and the original art available offline
 * after the first visit. Shell modules are network-first so a deploy can never
 * mix a new index.html with stale modules (the bug that produced a black canvas
 * with only the on-screen buttons).
 */
const VERSION = 'dune-byop-v6';
const SHELL_CACHE = VERSION;
const ASSET_CACHE = VERSION + '-assets';
const IMMUTABLE_PREFIXES = [
  './runtime/runtime.wasm',
  './py-package.zip',
  './vendor/pyodide/',
];
const SHELL_PATH = /(?:^|\/)(?:index\.html|byop-boot\.mjs|shell\.js|entry\.js|[^/]+\.mjs|[^/]+\.js|[^/]+\.css|app\.webmanifest|sw\.js)$/;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    for (const url of ['./', './index.html', './byop-boot.mjs', './app.webmanifest']) {
      try {
        const response = await fetch(url, { cache: 'reload' });
        if (response.ok) await cache.put(url, response);
      } catch { /* first visit may be partially offline */ }
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== SHELL_CACHE && key !== ASSET_CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'DUNE_PING') return;
  const payload = { type: 'DUNE_PONG', version: VERSION };
  // The page pings through a MessageChannel; reply on its port (event.source is
  // not guaranteed for service-worker MessageEvents, and a missed reply made the
  // page think its worker was stale, clearing caches and reloading).
  if (event.ports && event.ports[0]) event.ports[0].postMessage(payload);
  else event.source?.postMessage(payload);
});

const networkFirst = async (request) => {
  const cache = await caches.open(SHELL_CACHE);
  try {
    // bypass the HTTP cache (Pages serves max-age=600): a deploy must win
    const response = await fetch(request, { cache: 'no-store' });
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request)) || (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
  }
};

const cacheFirst = async (request, backgroundUpdate = true) => {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    if (backgroundUpdate) fetch(request).then((response) => { if (response.ok) cache.put(request, response); }).catch(() => {});
    return cached;
  }
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') cache.put(request, response.clone());
  return response;
};

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    // cache:'no-store' also bypasses GitHub Pages' max-age=600 HTML cache, so a
    // normal profile always gets the current index.html after a deploy.
    event.respondWith(networkFirst(request));
    return;
  }
  const relative = './' + url.pathname.replace(/^\/.*?(?:\/dune-web\/)?/, '').replace(/^\/+/, '');
  if (IMMUTABLE_PREFIXES.some((prefix) => relative.startsWith(prefix))) {
    event.respondWith(cacheFirst(request, false));
    return;
  }
  if (SHELL_PATH.test(url.pathname)) {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(cacheFirst(request));
});
