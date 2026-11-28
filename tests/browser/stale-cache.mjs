// Stale-cache / shell-version regression test for the BYOP site.
//
// Reproduces the failure mode of the old cache-first service worker: a freshly
// deployed index.html is served from the network while app.mjs (and other shell
// files) still come from an old Service Worker cache.  Then it checks that the
// new shell (sw.js v3, network-first + self-repair + visible error screen) ends
// up with a single consistent build even for a browser that was stuck on the
// old worker, and that a corrupted offline cache shows a readable error screen
// instead of a dead/black page.
//
//   node tests/browser/stale-cache.mjs
//
// Old deploy snapshots are read from git history, so the repository must be
// reachable. Uses the system Chrome (CHROME_PATH override). Screenshots and JSON
// land in test-results/chrome-launch/.
//
// NOTE: every scenario gets its own browser process. Chromium keeps a stale
// service-worker registration for an origin alive for a while, and installing a
// newer worker for the same localhost origin in a *second* context of the same
// browser intermittently hangs its install event. A fresh browser is both
// deterministic and closer to different players' machines.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WEB = path.join(ROOT, 'web');
const OUT = path.join(ROOT, 'test-results', 'chrome-launch');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.STALE_PORT || (4400 + Math.floor(Math.random() * 200)));
const SITE_URL = `http://127.0.0.1:${PORT}/`;

fs.mkdirSync(OUT, { recursive: true });

const problems = [];
const note = (message) => {
  problems.push(message);
  console.log(`STALE-CACHE PROBLEM: ${message}`);
};

/* ------------------------------------------------------- old deploy data -- */

const git = (...args) => {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
};

const snapshot = (commit, files) => Object.fromEntries(files.map((file) => [file, git('show', `${commit}:web/${file}`)]));

// Deploy #1: the offline/PWA shell (no i18n yet) plus the cache-first v2 worker.
const OLD_DEPLOY = {
  'index.html': git('show', '02345e1:web/index.html'),
  'app.mjs': git('show', '02345e1:web/app.mjs'),
  'sw.js': git('show', 'b92eb24:web/sw.js'),
};
// Deploy #2: the pre-fix "current" shell (new index/app, same cache-first worker).
const PRE_FIX_DEPLOY = {
  ...snapshot('b92eb24', ['index.html', 'app.mjs']),
  'sw.js': git('show', 'b92eb24:web/sw.js'),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
};

/* --------------------------------------------------------------- server -- */

// mode: 'old' | 'prefix' | 'fixed'
const serverState = { mode: 'fixed', down: false };

const oldIndex = (name) => {
  if (name === '' || name === 'index.html') return OLD_DEPLOY['index.html'];
  if (name === 'app.mjs') return OLD_DEPLOY['app.mjs'];
  if (name === 'sw.js') return OLD_DEPLOY['sw.js'];
  // The 02345e1 deploy predates i18n.mjs, but the v2 worker caches it; serve the
  // current file so the cached shell matches what a real v2 cache would hold.
  return undefined;
};

const preFixIndex = (name) => {
  if (name === '' || name === 'index.html') return PRE_FIX_DEPLOY['index.html'];
  if (name === 'app.mjs') return PRE_FIX_DEPLOY['app.mjs'];
  if (name === 'sw.js') return PRE_FIX_DEPLOY['sw.js'];
  return undefined;
};

const readStorage = (name) => {
  try {
    return fs.readFileSync(path.join(WEB, name));
  } catch {
    return null;
  }
};

const serve = (request, response) => {
  if (serverState.down) {
    // Simulate a dead network: the SW must fall back to its cache on its own.
    request.socket.destroy();
    return;
  }
  const url = new URL(request.url, 'http://127.0.0.1');
  let name = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (name === '' || name.endsWith('/')) name = `${name}index.html`;
  let body;
  if (serverState.mode === 'old') {
    body = oldIndex(name);
    if (body === undefined) body = readStorage(name);
  } else if (serverState.mode === 'prefix') {
    body = preFixIndex(name);
    if (body === undefined) body = readStorage(name);
  } else {
    body = readStorage(name);
  }
  const headers = {
    'Cache-Control': 'no-store',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream',
  };
  if (typeof body === 'string') body = Buffer.from(body);
  if (body == null) {
    const text = Buffer.from('not found');
    response.writeHead(404, { ...headers, 'Content-Length': text.length });
    response.end(text);
    return;
  }
  response.writeHead(200, { ...headers, 'Content-Length': body.length });
  response.end(body);
};

const server = http.createServer(serve);
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
console.log(`server on ${SITE_URL}`);

/* ------------------------------------------------------------- helpers -- */

const contextOptions = { viewport: { width: 1100, height: 900 }, locale: 'ru-RU' };

const launch = () => chromium.launch({
  executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
  headless: true,
  args: ['--no-sandbox'],
});

const waitReady = (page, timeout = 90000) =>
  page.waitForFunction(() => window.__SPIKE_READY__ === true, null, { timeout });

const waitSwActive = (page) =>
  page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false };
    const reg = await navigator.serviceWorker.ready;
    return { supported: true, active: !!reg.active, scope: reg.scope };
  });

const waitCached = async (page, cacheName, minimum = 10) => {
  await page.waitForFunction(async ({ cacheName: name, minimum: count }) => {
    const keys = await caches.keys();
    const key = name ? keys.find((candidate) => candidate === name) : keys[0];
    if (!key) return false;
    const cache = await caches.open(key);
    return (await cache.keys()).length >= count;
  }, { cacheName, minimum }, { timeout: 90000, polling: 250 });
  return page.evaluate(async () => {
    const keys = await caches.keys();
    const out = {};
    for (const key of keys) {
      const cache = await caches.open(key);
      out[key] = (await cache.keys()).length;
    }
    return { keys, entries: out };
  });
};

const pingController = (page) => page.evaluate(async () => {
  const controller = navigator.serviceWorker?.controller;
  if (!controller) return { controller: null, reply: null };
  const reply = await new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 1800);
    channel.port1.onmessage = (event) => { clearTimeout(timer); resolve(event.data ?? null); };
    controller.postMessage({ type: 'DUNE_PING' }, [channel.port2]);
  });
  return { controller: controller.scriptURL, reply };
});

const pageState = (page) => page.evaluate(() => ({
  shellBuild: window.__DUNE_SHELL_BUILD__ ?? null,
  appBuild: window.__DUNE_APP_BUILD__ ?? null,
  spikeReady: window.__SPIKE_READY__ === true,
  hasLangToggle: !!document.getElementById('lang-toggle'),
  hasFreshBootstrap: !!document.getElementById('error-reload-clean'),
  screen: [...document.querySelectorAll('main > section')]
    .filter((section) => !section.classList.contains('hidden'))
    .map((section) => section.id),
  errorVisible: !document.getElementById('screen-error').classList.contains('hidden'),
  errorText: document.getElementById('error-text')?.textContent ?? '',
  errorDetails: document.getElementById('error-details')?.textContent ?? '',
  repair: (() => { try { return JSON.parse(sessionStorage.getItem('dune-shell-repair') || 'null'); } catch { return null; } })(),
  uncaught: window.__DUNE_ERRORS__ ?? [],
}));

const report = { scenarios: {} };

try {
  /* ------------------------------------------------ 1. fresh profile ----- */
  console.log('scenario 1: fresh profile');
  serverState.mode = 'fixed';
  {
    const browser = await launch();
    try {
      const context = await browser.newContext(contextOptions);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto(SITE_URL, { waitUntil: 'load', timeout: 90000 });
      await waitReady(page);
      await waitSwActive(page);
      const cache = await waitCached(page, 'dune-byop-v3');
      await page.reload({ waitUntil: 'load', timeout: 90000 });
      await waitReady(page);
      const state = await pageState(page);
      const ping = await pingController(page);
      await page.screenshot({ path: path.join(OUT, 'fresh-profile.png') });
      console.log('fresh profile:', JSON.stringify({ cache: cache.keys, state: { shellBuild: state.shellBuild, appBuild: state.appBuild, screen: state.screen }, ping: ping.reply }));
      report.scenarios.freshProfile = { cache, state, ping, errors };
      if (state.shellBuild !== 'dune-byop-v3') note(`fresh: shell build marker is ${state.shellBuild}`);
      if (state.appBuild !== state.shellBuild) note(`fresh: app build ${state.appBuild} != shell ${state.shellBuild}`);
      if (!state.spikeReady) note('fresh: app did not become ready');
      if (state.errorVisible) note(`fresh: error screen is visible: ${state.errorText}`);
      if (errors.length) note(`fresh: page errors: ${errors.join(' | ').slice(0, 300)}`);
      if (cache.keys.length !== 1 || cache.keys[0] !== 'dune-byop-v3') note(`fresh: unexpected caches ${JSON.stringify(cache.keys)}`);
      await context.close();
    } finally {
      await browser.close();
    }
  }

  /* ------------------------------- 2. control: old cache-first mixing ---- */
  console.log('scenario 2: cache-first mixing (control)');
  serverState.mode = 'old';
  {
    const browser = await launch();
    try {
      const context = await browser.newContext(contextOptions);
      const page = await context.newPage();
      await page.goto(SITE_URL, { waitUntil: 'load', timeout: 90000 });
      await waitReady(page);
      const registration = await waitSwActive(page);
      const cache = await waitCached(page, 'dune-byop-v2');
      console.log('control old deploy:', JSON.stringify({ registration, cache: cache.keys }));
      // "Deploy" the pre-fix shell: new index/app from the network, SW unchanged.
      serverState.mode = 'prefix';
      await page.reload({ waitUntil: 'load', timeout: 90000 });
      await page.waitForFunction(() => window.__SPIKE_READY__ === true, null, { timeout: 90000 }).catch(() => {});
      const state = await pageState(page);
      const ping = await pingController(page);
      await page.screenshot({ path: path.join(OUT, 'stale-cache-control-mixing.png') });
      console.log('control after deploy:', JSON.stringify({ shellBuild: state.shellBuild, appBuild: state.appBuild, hasLangToggle: state.hasLangToggle, ping: ping.reply }));
      report.scenarios.staleMixingControl = { registration, cache, state, ping };
      // New index.html (language toggle) + old cached app.mjs (no build marker):
      // the shell versions are mixed, exactly the state the fix has to prevent.
      if (!state.hasLangToggle) note('control: the new index.html was not served');
      if (state.appBuild !== null) note(`control: expected the stale app (no build marker), got ${state.appBuild}`);
      if (state.shellBuild !== null) note('control: expected the pre-fix index (no bootstrap marker)');
      await context.close();
    } finally {
      await browser.close();
    }
  }

  /* ------------- 3. fixed shell self-repairs a browser stuck on v2 SW ---- */
  console.log('scenario 3: self-heal, corrupted cache, recovery');
  serverState.mode = 'old';
  {
    const browser = await launch();
    let context = await browser.newContext(contextOptions);
    let page = await context.newPage();
    const consoleLines = [];
    page.on('console', (message) => consoleLines.push(`[${message.type()}] ${message.text()}`));
    await page.goto(SITE_URL, { waitUntil: 'load', timeout: 90000 });
    await waitReady(page);
    await waitSwActive(page);
    const cacheBefore = await waitCached(page, 'dune-byop-v2');
    console.log('self-heal: old deploy cached', JSON.stringify(cacheBefore.keys));
    // "Deploy": new shell with v3 worker. The stale v2 worker serves the old
    // app.mjs first; the new bootstrap must notice, purge and reload on its own.
    serverState.mode = 'fixed';
    await page.reload({ waitUntil: 'load', timeout: 90000 });
    await page.waitForFunction(
      () => window.__DUNE_APP_BUILD__ === 'dune-byop-v3' && window.__DUNE_SHELL_BUILD__ === 'dune-byop-v3',
      null, { timeout: 90000, polling: 250 },
    );
    await waitReady(page);
    await waitSwActive(page);
    await waitCached(page, 'dune-byop-v3');
    await page.waitForTimeout(1500);
    const state = await pageState(page);
    const ping = await pingController(page);
    const cachesNow = await page.evaluate(() => caches.keys());
    await page.screenshot({ path: path.join(OUT, 'stale-cache-selfhealed.png') });
    console.log('self-heal after deploy:', JSON.stringify({ appBuild: state.appBuild, shellBuild: state.shellBuild, screen: state.screen, repair: state.repair, ping: ping.reply, cachesNow }));
    report.scenarios.staleCacheSelfHeal = { cacheBefore, state, ping, cachesNow, console: consoleLines.slice(-40) };
    if (state.appBuild !== 'dune-byop-v3') note(`self-heal: app build is ${state.appBuild}`);
    if (state.errorVisible) note(`self-heal: error screen is visible: ${state.errorText}`);
    if (!state.screen.includes('screen-setup')) note(`self-heal: setup screen is not shown (${state.screen.join(',')})`);
    if (!state.repair || !state.repair.count) note('self-heal: no automatic repair was recorded');
    if (!ping.reply || ping.reply.version !== 'dune-byop-v3') note(`self-heal: controller did not answer v3: ${JSON.stringify(ping)}`);
    if (cachesNow.length !== 1 || cachesNow[0] !== 'dune-byop-v3') note(`self-heal: stale caches survived: ${JSON.stringify(cachesNow)}`);

    /* ------------------ 4. corrupted offline cache -> readable error ----- */
    console.log('scenario 3b: corrupted cache while offline');
    await page.evaluate(async () => {
      const keys = await caches.keys();
      for (const key of keys) {
        const cache = await caches.open(key);
        for (const request of await cache.keys()) {
          if (request.url.endsWith('/app.mjs')) await cache.delete(request);
        }
      }
    });
    serverState.down = true;
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    await page.evaluate(() => location.reload()).catch(() => {});
    await page.waitForFunction((before) => performance.timeOrigin > before, timeOrigin, { timeout: 60000 }).catch(() => {});
    await page.waitForFunction(
      () => !document.getElementById('screen-error')?.classList.contains('hidden'),
      null, { timeout: 45000, polling: 250 },
    ).catch(() => {});
    const broken = await pageState(page);
    const errorUi = await page.evaluate(() => ({
      visible: !document.getElementById('screen-error').classList.contains('hidden'),
      fatal: document.getElementById('screen-error').classList.contains('fatal'),
      title: document.getElementById('error-title')?.textContent ?? '',
      text: document.getElementById('error-text')?.textContent ?? '',
      detailsShown: !document.getElementById('error-details')?.hidden,
      reloadButton: (document.getElementById('error-reload-clean')?.getBoundingClientRect().height ?? 0) > 0,
      copyButton: (document.getElementById('error-copy')?.getBoundingClientRect().height ?? 0) > 0,
      bodyFatal: document.body.classList.contains('fatal-error'),
      screen: [...document.querySelectorAll('main > section')].filter((section) => !section.classList.contains('hidden')).map((section) => section.id),
    }));
    await page.screenshot({ path: path.join(OUT, 'stale-cache-corrupted-offline.png') });
    console.log('corrupted offline cache:', JSON.stringify({ title: errorUi.title, text: errorUi.text.slice(0, 120), fatal: errorUi.fatal, detailsShown: errorUi.detailsShown, screen: errorUi.screen }));
    report.scenarios.corruptedCache = { state: broken, errorUi };
    if (!errorUi.visible) note('corrupted cache: no visible error screen (blank/black page)');
    if (!errorUi.fatal) note('corrupted cache: error screen is not the fatal overlay');
    if (!errorUi.text || /^Что-то пошло не так\.$/.test(errorUi.text)) note(`corrupted cache: error text is not descriptive: ${errorUi.text}`);
    if (!errorUi.reloadButton) note('corrupted cache: reload-without-cache button is missing');
    if (!errorUi.copyButton) note('corrupted cache: copy-report button is missing');
    if (errorUi.screen.length !== 1 || errorUi.screen[0] !== 'screen-error') note(`corrupted cache: extra screens visible: ${errorUi.screen.join(',')}`);

    /* ---------------------- 5. the error screen repairs the page -------- */
    console.log('scenario 3c: recovery from the error screen');
    serverState.down = false;
    await page.click('#error-reload-clean');
    await page.waitForFunction(
      () => window.__SPIKE_READY__ === true && window.__DUNE_APP_BUILD__ === 'dune-byop-v3',
      null, { timeout: 90000, polling: 250 },
    );
    await waitReady(page);
    const recovered = await pageState(page);
    const recoveredPing = await pingController(page);
    await page.screenshot({ path: path.join(OUT, 'stale-cache-recovered.png') });
    console.log('recovered:', JSON.stringify({ appBuild: recovered.appBuild, shellBuild: recovered.shellBuild, ping: recoveredPing.reply }));
    report.scenarios.recovered = { state: recovered, ping: recoveredPing };
    if (recovered.errorVisible) note('recovery: error screen still visible');
    if (recovered.appBuild !== 'dune-byop-v3' || recovered.shellBuild !== 'dune-byop-v3') note('recovery: builds are still inconsistent');
    if (!recovered.screen.includes('screen-setup')) note('recovery: setup screen is not shown');
    await context.close();
    await browser.close();
  }

  /* ----------------------------------------- 6. ?nosw=1 emergency mode --- */
  console.log('scenario 4: ?nosw=1 emergency mode');
  {
    const browser = await launch();
    try {
      const context = await browser.newContext(contextOptions);
      const page = await context.newPage();
      await page.goto(`${SITE_URL}?nosw=1`, { waitUntil: 'load', timeout: 90000 });
      await waitReady(page);
      await page.waitForTimeout(2000);
      const registration = await page.evaluate(async () => {
        if (!('serviceWorker' in navigator)) return 0;
        return (await navigator.serviceWorker.getRegistrations()).length;
      });
      const banner = await page.evaluate(() => {
        const element = document.getElementById('nosw-banner');
        return { hidden: element?.hidden ?? true, text: element?.textContent?.trim() ?? '' };
      });
      const cachesNow = await page.evaluate(() => caches.keys());
      await page.screenshot({ path: path.join(OUT, 'nosw-emergency.png') });
      console.log('nosw mode:', JSON.stringify({ registration, banner: banner.hidden, cachesNow }));
      report.scenarios.nosw = { registration, banner, cachesNow };
      if (registration !== 0) note(`nosw: ${registration} service worker registration(s) remained`);
      if (banner.hidden) note('nosw: emergency banner is not visible');
      if (cachesNow.length) note(`nosw: caches were not cleared: ${JSON.stringify(cachesNow)}`);
      await context.close();
    } finally {
      await browser.close();
    }
  }
} catch (error) {
  note(String(error && error.stack ? error.stack : error));
} finally {
  fs.writeFileSync(path.join(OUT, 'stale-cache.json'), `${JSON.stringify({ ok: problems.length === 0, problems, ...report }, null, 2)}\n`);
  await new Promise((resolve) => server.close(resolve));
}

console.log(problems.length === 0 ? 'STALE-CACHE OK' : `STALE-CACHE FAILED (${problems.length})`);
if (problems.length) process.exitCode = 1;
