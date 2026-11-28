/* DUNE BYOP — offline app shell service worker (v3).
 *
 * Versioning rules that keep a deployed shell from being mixed with an old one:
 *
 *  - Shell files (HTML, JS modules, the recompiler worker, the runtime loader)
 *    are NETWORK-FIRST.  A reload always tries the deployed bytes first and
 *    only falls back to the cache when the network is unavailable.  This makes
 *    the old "new index.html + cached app.mjs" combination impossible.
 *  - Heavy, version-pinned payloads (runtime/runtime.wasm, py-package.zip,
 *    vendor/pyodide/*, icons) stay CACHE-FIRST so offline play keeps working
 *    without downloading tens of megabytes on every visit.
 *  - VERSION is part of the cache name.  Activating a new worker deletes every
 *    other cache on the origin, so a stale shell can never survive an update.
 *  - The worker answers DUNE_PING with its VERSION; index.html uses that to
 *    detect a stale controller (see the bootstrap script there) and purge it.
 *
 * The player's ROM is never requested by the SW; the generated game.wasm lives
 * in OPFS (web/recompiler.worker.js) and is reused offline.
 */
const VERSION = 'dune-byop-v3';

/* Files fetched from the network first and cached for the offline fallback. */
const SHELL_FILES = [
  './',
  './index.html',
  './app.mjs',
  './i18n.mjs',
  './manifest.webmanifest',
  './reference.json',
  './recompiler.worker.js',
  './runtime/loader.mjs',
  './runtime/abi.json',
  './runtime/game-reference.json',
  './input/index.mjs',
  './input/gestures.mjs',
  './input/map-input.mjs',
  './input/order-input.mjs',
  './input/pan-inertia.mjs',
  './input/placement-mode.mjs',
  './input/context-action.mjs',
  './host/host.mjs',
  './host/audio.mjs',
  './host/audio-worklet.js',
  './saves/browser-files.mjs',
  './saves/campaign-state.mjs',
  './saves/save-files.mjs',
];

/* Heavy payloads that never change within a pinned build: cache first. */
const STATIC_FILES = [
  './runtime/runtime.wasm',
  './py-package.zip',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

const SHELL_PREFIXES = ['input/', 'host/', 'saves/', 'runtime/'];
const STATIC_PREFIXES = ['vendor/pyodide/', 'icons/'];

const scopePath = () => new URL(self.registration.scope).pathname;

const relativePath = (url) => {
  const scope = scopePath();
  return url.pathname.startsWith(scope) ? url.pathname.slice(scope.length) : null;
};

/* Unknown files are treated as shell: a wrong guess costs one network round
 * trip, while caching them forever could serve stale code after a deploy. */
const classify = (relative) => {
  if (relative == null) return 'other';
  if (STATIC_PREFIXES.some((prefix) => relative.startsWith(prefix))) return 'static';
  if (STATIC_FILES.some((file) => file.slice(2) === relative)) return 'static';
  if (SHELL_PREFIXES.some((prefix) => relative.startsWith(prefix))) return 'shell';
  if (relative === 'runtime/runtime.wasm') return 'static';
  if (SHELL_FILES.some((file) => file === './' ? relative === '' : file.slice(2) === relative)) return 'shell';
  return 'other';
};

const cacheName = VERSION;
const openCache = () => caches.open(cacheName);

const cachePut = async (request, response) => {
  if (!response || !response.ok) return response;
  if (response.type !== 'basic') return response;
  try {
    const cache = await openCache();
    await cache.put(request, response.clone());
  } catch {
    /* quota errors must not break the response */
  }
  return response;
};

const offlineFallback = async (request) => {
  const cache = await openCache();
  const cached = (await cache.match(request, { ignoreSearch: true })) || null;
  if (cached) return cached;
  return null;
};

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await openCache();
    // Cache files individually so one 404 does not break the whole install.
    await Promise.all([...SHELL_FILES, ...STATIC_FILES].map(async (path) => {
      try {
        const response = await fetch(path, { cache: 'reload' });
        if (response.ok) {
          await cache.put(path, response);
        } else {
          // Drain/cancel the body of a 404: an unconsumed install response has
          // been observed to leave Chromium's install event hanging.
          try { await response.body?.cancel(); } catch { /* already consumed */ }
        }
      } catch {
        /* offline first visit: the remaining entries still install */
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Delete every other cache on the origin: stale shell versions must never
    // be able to answer a request after this worker takes over.
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

/* index.html checks that the controller is not older than the page it served. */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'DUNE_PING') return;
  const payload = { type: 'DUNE_PONG', version: VERSION };
  const port = event.ports && event.ports[0];
  if (port) {
    port.postMessage(payload);
    return;
  }
  if (event.source && event.source.postMessage) event.source.postMessage(payload);
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // /?nosw=1 is an emergency escape hatch; the page also unregisters us.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cached = (await (await openCache()).match('./index.html')) || (await (await openCache()).match('./'));
        return cached || Response.error();
      }
    })());
    return;
  }

  const kind = classify(relativePath(url));
  if (kind === 'shell' || kind === 'other') {
    // Network first: never mix a freshly deployed index.html with old modules.
    event.respondWith((async () => {
      try {
        return await cachePut(request, await fetch(request, { cache: 'no-store' }));
      } catch {
        return (await offlineFallback(request)) || Response.error();
      }
    })());
    return;
  }

  // static: cache first, refreshed only by a new VERSION/install.
  event.respondWith((async () => {
    const cached = await offlineFallback(request);
    if (cached) return cached;
    try {
      return await cachePut(request, await fetch(request));
    } catch {
      return Response.error();
    }
  })());
});
