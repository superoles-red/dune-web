/* DUNE BYOP — offline app shell service worker.
 *
 * Caches the wrapper, the pinned runtime, the Pyodide package and the Pyodide
 * distribution. The player's ROM is never requested by the SW; the generated
 * game.wasm lives in OPFS (web/recompiler.worker.js) and is reused offline.
 */
const VERSION = 'dune-byop-v1';
const CORE = [
  './',
  './index.html',
  './app.mjs',
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
  './recompiler.worker.js',
  './runtime/runtime.wasm',
  './runtime/loader.mjs',
  './runtime/abi.json',
  './runtime/game-reference.json',
  './reference.json',
  './py-package.zip',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // Cache files individually so one 404 does not break the whole install.
    await Promise.all(CORE.map(async (url) => {
      try {
        const response = await fetch(url, { cache: 'reload' });
        if (response.ok) await cache.put(url, response);
      } catch {
        /* offline first visit: the remaining entries still install */
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

const shellFetch = async (request) => {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') cache.put(request, response.clone());
  return response;
};

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // No ROM, save files or wasm builds are requested from the network by the SW:
  // the game data is either a local File (never a request) or OPFS.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        const cache = await caches.open(VERSION);
        return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }
  event.respondWith(shellFetch(request).catch(() => Response.error()));
});
