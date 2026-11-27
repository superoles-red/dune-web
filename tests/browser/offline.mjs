// Offline/PWA end-to-end test:
//   1. first visit caches the shell, runtime and Pyodide distribution;
//   2. build the game once (so game.wasm lands in OPFS);
//   3. go offline, reload, and start the game from cache.
//
//   DUNE_ROM="/path/to/Dune (USA).gen" node tests/browser/offline.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PLAY_PORT || 4327);
const URL = process.env.PLAY_URL || `http://127.0.0.1:${PORT}/`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROM = process.env.DUNE_ROM || null;
const OUT = path.join(ROOT, 'test-results', 'offline');
const TIMEOUT = 20 * 60 * 1000;

if (!ROM || !fs.existsSync(ROM)) {
  console.log('offline test SKIPPED: set DUNE_ROM=/path/to/Dune-USA.gen');
  process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });

const server = process.env.PLAY_URL ? null : spawn('/usr/bin/python3', [path.join(ROOT, 'tools/serve.py'), '--port', String(PORT)], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
});
const problems = [];
const note = (message) => { problems.push(message); console.log(`OFFLINE PROBLEM: ${message}`); };

for (let attempt = 0; attempt < 150; attempt += 1) {
  try { if ((await fetch(URL)).ok) break; } catch { /* wait */ }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message.slice(0, 200)}`));
  page.on('console', (message) => { if (message.type() === 'error') problems.push(`console: ${message.text().slice(0, 200)}`); });

  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__SPIKE_READY__ === true, null, { timeout: 90000 });
  const registration = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false };
    const reg = await navigator.serviceWorker.ready;
    return { supported: true, scope: reg.scope, active: !!reg.active };
  });
  console.log('service worker:', JSON.stringify(registration));
  if (!registration.supported || !registration.active) note('service worker did not activate');

  // Build once online: this triggers the Pyodide/vendor fetches the SW caches
  // and writes game.wasm into OPFS for offline reuse.
  await page.setInputFiles('#rom-input', ROM);
  await page.waitForFunction(
    () => window.__BUILD_RESULTS?.length > 0 || !document.getElementById('screen-error').classList.contains('hidden'),
    null, { timeout: TIMEOUT, polling: 1000 },
  );
  const firstBuild = await page.evaluate(() => window.__BUILD_RESULTS?.[0] ?? null);
  console.log('online build:', JSON.stringify({ ok: firstBuild?.ok, cached: firstBuild?.cached, bytes: firstBuild?.output_bytes, seconds: firstBuild?.total_seconds && Math.round(firstBuild.total_seconds * 10) / 10 }));
  if (!firstBuild?.ok) note('online build failed');

  const cacheInfo = await page.evaluate(async () => {
    const keys = await caches.keys();
    const cache = await caches.open(keys[0]);
    const requests = await cache.keys();
    return { keys, entries: requests.length, vendor: requests.filter((request) => request.url.includes('/vendor/pyodide/')).length };
  });
  console.log('cache:', JSON.stringify(cacheInfo));
  if (cacheInfo.entries < 10) note(`only ${cacheInfo.entries} SW cache entries`);
  if (cacheInfo.vendor < 3) note('Pyodide distribution was not cached');
  await page.screenshot({ path: path.join(OUT, '01-online-ready.png') });

  // Go offline and reload: the shell must come from the service worker.
  await context.setOffline(true);
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__SPIKE_READY__ === true, null, { timeout: 90000 });
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  console.log('offline reload controlled:', controlled);
  if (!controlled) note('offline page is not controlled by the service worker');

  // Re-select the ROM file offline: the build should come from OPFS instantly.
  await page.setInputFiles('#rom-input', ROM);
  await page.waitForFunction(
    () => window.__BUILD_RESULTS?.length > 0 || !document.getElementById('screen-error').classList.contains('hidden'),
    null, { timeout: TIMEOUT, polling: 1000 },
  );
  const offlineBuild = await page.evaluate(() => window.__BUILD_RESULTS?.[0] ?? null);
  console.log('offline build:', JSON.stringify({ ok: offlineBuild?.ok, cached: offlineBuild?.cached, bytes: offlineBuild?.output_bytes, seconds: offlineBuild?.total_seconds && Math.round(offlineBuild.total_seconds * 10) / 10 }));
  if (!offlineBuild?.ok) note('offline build from OPFS failed');
  if (offlineBuild?.ok && !offlineBuild?.cached) note('offline build was not served from the cache');
  await page.screenshot({ path: path.join(OUT, '02-offline-ready.png') });

  if (offlineBuild?.ok) {
    await page.click('#play');
    await page.waitForFunction(() => (window.__DUNE_HOST?.metrics?.renderedFrames ?? 0) >= 2, null, { timeout: 120000, polling: 250 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, '03-offline-play.png') });
    const frame = await page.evaluate(() => window.__DUNE_HOST.frameStats());
    console.log('offline play frame:', JSON.stringify({ serial: frame?.serial, nonzero: frame?.nonzero }));
    if (!(frame?.serial > 0)) note('offline game did not render frames');
  }

  const manifest = await page.evaluate(async () => {
    const response = await fetch('./manifest.webmanifest').catch(() => null);
    if (!response?.ok) return null;
    const json = await response.json();
    return { name: json.name, display: json.display, icons: json.icons?.length, start: json.start_url };
  });
  console.log('manifest:', JSON.stringify(manifest));
  if (!manifest) note('manifest is not reachable');
  else if (manifest.icons < 2) note('manifest has too few icons');

  const report = { ok: problems.length === 0, problems, firstBuild: { ok: firstBuild?.ok, cached: firstBuild?.cached }, offlineBuild: { ok: offlineBuild?.ok, cached: offlineBuild?.cached }, registration, cacheInfo, manifest };
  fs.writeFileSync(path.join(OUT, 'offline.json'), JSON.stringify(report, null, 2));
  console.log(problems.length === 0 ? 'OFFLINE OK' : 'OFFLINE FAILED');
} catch (error) {
  console.error('OFFLINE FAILED', String(error));
  process.exitCode = 1;
} finally {
  await browser.close();
  server?.kill('SIGKILL');
}
if (problems.length) process.exitCode = 1;
