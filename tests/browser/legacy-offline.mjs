// Offline/PWA regression for the legacy BYOP root:
// first visit builds from ROM and caches the shell/Pyodide; going offline and
// reloading must start the old UI straight from OPFS (saved ROM + game.wasm).
//
//   DUNE_ROM="/path/to/Dune (USA).gen" node tests/browser/legacy-offline.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.LEGACY_PORT || 4550);
const URL = process.env.LEGACY_URL || `http://127.0.0.1:${PORT}/`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROM = process.env.DUNE_ROM || null;
const OUT = path.join(ROOT, 'test-results', 'legacy');
if (!ROM || !fs.existsSync(ROM)) { console.log('legacy-offline SKIPPED: set DUNE_ROM'); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });
const server = process.env.LEGACY_URL ? null : spawn('/usr/bin/python3', [path.join(ROOT, 'tools/serve.py'), '--port', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
const problems = [];
const note = (message) => { problems.push(message); console.log('PROBLEM ' + message); };
for (let attempt = 0; attempt < 150; attempt += 1) { try { if ((await fetch(URL)).ok) break; } catch { /* wait */ } await new Promise((r) => setTimeout(r, 100)); }
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ru-RU' });
  const page = await context.newPage();
  page.on('pageerror', (error) => note('pageerror: ' + error.message.slice(0, 200)));
  await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('#byop-rom'), null, { timeout: 60000 });
  await page.setInputFiles('#byop-rom', ROM);
  await page.waitForFunction(() => window.__BYOP_READY__ === true, null, { timeout: 300000, polling: 1000 });
  await page.waitForTimeout(2500);
  const sw = await page.evaluate(async () => { const reg = await navigator.serviceWorker.ready; const keys = await caches.keys(); let entries = 0; for (const key of keys) entries += (await (await caches.open(key)).keys()).length; return { scope: reg.scope, keys, entries }; });
  console.log('sw:', JSON.stringify(sw));
  if (sw.entries < 10) note('SW cache is too small: ' + sw.entries);
  await page.screenshot({ path: path.join(OUT, 'offline-01-online.png') });
  await context.setOffline(true);
  await page.reload({ waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => window.__BYOP_READY__ === true, null, { timeout: 180000, polling: 500 });
  await page.waitForTimeout(2500);
  const offline = await page.evaluate(() => ({ view: window.__DUNE_UI__?.view, scene: window.__DUNE_UI__?.state?.scene, buttons: [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null).map((b) => b.id).slice(0, 8), savedRom: !!window.__BYOP_BOOT__?.state?.savedRom, errors: (window.__DUNE_ERRORS__ || []).length }));
  console.log('offline:', JSON.stringify(offline));
  await page.screenshot({ path: path.join(OUT, 'offline-02-reloaded.png') });
  if (!offline.buttons.length) note('offline reload landed without the legacy home buttons');
  if (offline.errors) note('offline page has ' + offline.errors + ' errors');
  const report = { ok: problems.length === 0, problems, sw, offline };
  fs.writeFileSync(path.join(OUT, 'offline.json'), JSON.stringify(report, null, 2));
  console.log(problems.length === 0 ? 'LEGACY-OFFLINE OK' : 'LEGACY-OFFLINE FAILED');
} catch (error) {
  console.error('LEGACY-OFFLINE FAILED', String(error));
  process.exitCode = 1;
} finally {
  await browser.close();
  server?.kill('SIGKILL');
}
if (problems.length) process.exitCode = 1;
