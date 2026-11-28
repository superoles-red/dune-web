// Safari engine (Playwright WebKit) regression for the legacy BYOP root.
//
// Headless WebKit here cannot run the Pyodide build and its OPFS is broken, so
// this test fulfils two requests at the network layer:
//   - byop-boot.mjs gets a test-only readCachedGame that decodes the verified
//     game.wasm embedded in the page (production code untouched);
//   - recompiler.worker.js is replaced by a stub worker returning that core.
// Everything else (DuneHost boot, Module facade, legacy shell, menus, mission
// start, audio) is the real code path that Safari runs.
//
//   node tests/browser/webkit-legacy.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const URL = process.env.LEGACY_URL || 'https://superoles-red.github.io/dune-web/';
const WEBKIT = process.env.WEBKIT_PATH || '/Users/oleskarpov/Library/Caches/ms-playwright/webkit-2336/pw_run.sh';
const ROM = process.env.DUNE_ROM || '/Users/oleskarpov/Downloads/Dune - The Battle for Arrakis (USA).gen';
const OUT = path.join(ROOT, 'test-results', 'webkit');
fs.mkdirSync(OUT, { recursive: true });
if (!fs.existsSync(WEBKIT)) { console.log('webkit-legacy SKIPPED: no WebKit binary'); process.exit(0); }
const game = fs.readFileSync(path.join(ROOT, '.local/wasm-full/game.wasm'));
const reference = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/reference.json'), 'utf8'));
const coreB64 = game.toString('base64');
const bootSource = fs.readFileSync(path.join(ROOT, 'web/byop-boot.mjs'), 'utf8');
const problems = [];
const note = (message) => { problems.push(message); console.log('WEBKIT PROBLEM ' + message); };

const patchedBoot = bootSource.replace(
  /async function readCachedGame\(romSha\) \{[\s\S]*?\n\}/,
  `async function readCachedGame(romSha) {\n  return Uint8Array.from(atob(window.__DUNE_TEST_CORE__), (c) => c.charCodeAt(0));\n}`,
);
if (!patchedBoot.includes('__DUNE_TEST_CORE__')) throw new Error('cannot patch readCachedGame for the WebKit test');
const stubWorker = `self.addEventListener('message', (event) => {\n  const message = event.data;\n  if (!message || message.type !== 'build') return;\n  self.postMessage({ type: 'result', result: { ok: true, output_sha256: '${reference.expected_game_sha256}', output_bytes: ${reference.expected_game_bytes}, total_seconds: 0.2, cached: true } });\n});`;

const browser = await webkit.launch({ executablePath: WEBKIT, headless: true, timeout: 60000 });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ru-RU' });
  const page = await context.newPage();
  const logs = [];
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message.slice(0, 300)));
  page.on('console', (m) => { if (!/\[host\]/.test(m.text())) logs.push(m.type() + ' ' + m.text().slice(0, 240)); });
  await context.addInitScript(({ b64, sha, bytes }) => {
    window.__DUNE_TEST_CORE__ = b64;
    window.__DUNE_TEST_SHA__ = sha;
    window.__DUNE_TEST_BYTES__ = bytes;
  }, { b64: coreB64, sha: reference.expected_game_sha256, bytes: reference.expected_game_bytes });
  await page.route('**/byop-boot.mjs*', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: patchedBoot }));
  await page.route('**/recompiler.worker.js*', (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: stubWorker }));

  await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('#byop-rom'), null, { timeout: 60000 });
  await page.setInputFiles('#byop-rom', ROM);
  const booted = await page.waitForFunction(() => window.__BYOP_READY__ === true, null, { timeout: 180000, polling: 500 }).then(() => true).catch(() => false);
  if (!booted) {
    const diag = await page.evaluate(() => ({ byop: window.__BYOP_STATUS__, error: window.__BYOP_ERROR__, ready: window.__BYOP_READY__ ?? null, text: document.getElementById('byop-text')?.textContent?.slice(0, 200), errors: (window.__DUNE_ERRORS__ || []).slice(0, 3) })).catch((e) => ({ evalError: String(e) }));
    console.log('boot diag:', JSON.stringify(diag));
    console.log('logs:', JSON.stringify(logs.slice(0, 14)));
    await page.screenshot({ path: path.join(OUT, '00-boot-failed.png') }).catch(() => {});
    throw new Error('WebKit boot did not reach __BYOP_READY__');
  }
  await page.waitForTimeout(4000);
  const home = await page.evaluate(() => ({ view: window.__DUNE_UI__?.view, scene: window.__DUNE_UI__?.state?.scene, buttons: [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null).map((b) => b.id).slice(0, 10), errors: (window.__DUNE_ERRORS__ || []).length }));
  console.log('home:', JSON.stringify(home));
  await page.screenshot({ path: path.join(OUT, '01-menu.png') });
  if (!home.buttons.length) note('legacy home has no visible buttons in WebKit');
  // The old art pipeline paints labels/frames into per-button canvases. WebKit
  // used to get blank crops from the packed atlas (img.decode + createImageBitmap
  // crop overload), leaving black-on-black buttons; assert the pixels exist.
  const painted = await page.evaluate(() => [...document.querySelectorAll('#scene-ui button')].map((button) => {
    const canvas = button.querySelector('canvas');
    if (!canvas || !canvas.width || !canvas.height) return { id: button.id, painted: 0 };
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let nonBlack = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] || data[i + 1] || data[i + 2] || data[i + 3]) nonBlack += 1;
    return { id: button.id, painted: nonBlack };
  }));
  console.log('button canvases:', JSON.stringify(painted));
  if (!painted.some((item) => item.painted > 100)) note('button canvases are blank in WebKit (atlas decode regression)');

  await page.evaluate(() => document.getElementById('new-campaign')?.click());
  await page.waitForTimeout(1500);
  const houses = await page.evaluate(() => ({ view: window.__DUNE_UI__?.view, buttons: [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null).map((b) => b.id).slice(0, 10) }));
  console.log('houses:', JSON.stringify(houses));
  if (!houses.buttons.includes('house-1')) note('house buttons are missing in WebKit');
  await page.screenshot({ path: path.join(OUT, '02-houses.png') });

  await page.evaluate(() => document.getElementById('house-1')?.click());
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.getElementById('mission-1')?.click());
  await page.waitForTimeout(1500);
  const dialog = await page.evaluate(() => !!document.querySelector('#native-confirmation:not([hidden])'));
  if (dialog) await page.locator('#native-confirmation .confirmation-actions button').first().click();
  await page.waitForTimeout(2500);
  for (let i = 0; i < 24; i += 1) {
    if (await page.locator('#native-yes').count()) break;
    await page.mouse.click(195, 420);
    await page.waitForTimeout(700);
  }
  if (await page.locator('#native-yes').count()) await page.click('#native-yes');
  let armed = false;
  for (let i = 0; i < 30; i += 1) {
    await page.waitForTimeout(1200);
    if (await page.evaluate(() => window.__DUNE_UI__?.state?.activeRunArmed)) { armed = true; break; }
  }
  await page.waitForTimeout(2500);
  const final = await page.evaluate(() => ({ scene: window.__DUNE_UI__?.state?.scene, armed: window.__DUNE_UI__?.state?.activeRunArmed, cursorHidden: window.__DUNE_HOST?.cameraDebug?.()?.cursorHidden, audio: window.__DUNE_HOST?.audio ? { enabled: window.__DUNE_HOST.audio.enabled, state: window.__DUNE_HOST.audio.context?.state ?? null } : null, errors: (window.__DUNE_ERRORS__ || []).length }));
  console.log('final:', JSON.stringify(final));
  await page.screenshot({ path: path.join(OUT, '03-map.png') });
  if (!armed) note('mission did not become armed in WebKit');
  fs.writeFileSync(path.join(OUT, 'webkit.json'), JSON.stringify({ ok: problems.length === 0, problems, home, houses, dialog, final, logs: logs.slice(0, 12) }, null, 2));
  console.log(problems.length === 0 ? 'WEBKIT-LEGACY OK' : 'WEBKIT-LEGACY FAILED');
} catch (error) {
  console.error('WEBKIT-LEGACY FAILED', String(error));
  process.exitCode = 1;
} finally {
  await browser.close();
}
if (problems.length) process.exitCode = 1;
