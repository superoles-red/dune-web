// Safari engine (Playwright WebKit) smoke test for the legacy BYOP root.
//
// WebKit's headless build has no working OPFS/Worker Pyodide path here, so this
// test injects an in-memory OPFS + a stub recompiler worker that returns the
// already verified game.wasm. Everything after that (DuneHost boot, Module
// facade, legacy shell, menus, mission start) is the real code path.
//
//   CHROME-free: node tests/browser/webkit-legacy.mjs
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
const problems = [];
const note = (message) => { problems.push(message); console.log('WEBKIT PROBLEM ' + message); };
if (!fs.existsSync(WEBKIT)) { console.log('webkit-legacy SKIPPED: no WebKit binary'); process.exit(0); }
const game = fs.readFileSync(path.join(ROOT, '.local/wasm-full/game.wasm'));
const reference = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/reference.json'), 'utf8'));
const EXPECTED = reference.expected_game_sha256;
const ROM_SHA = 'b1bbe73186e0902fa8b2db0f227bf306e3d6a80fe592f927d1aa9d60c0f335ba';

const browser = await webkit.launch({ executablePath: WEBKIT, headless: true, timeout: 60000 });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ru-RU' });
  await context.addInitScript(({ b64, expected, romSha }) => {
    const files = new Map();
    files.set('game.wasm', Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const makeDir = (prefix) => ({
      async getDirectoryHandle(name) { return makeDir(prefix + name + '/'); },
      async getFileHandle(name, options = {}) {
        const key = prefix + name;
        if (!files.has(key) && !options.create) throw Object.assign(new Error('not found'), { name: 'NotFoundError' });
        return {
          async getFile() { const data = files.get(key) || new Uint8Array(); return { async arrayBuffer() { return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength); } }; },
          async createWritable() {
            let data = new Uint8Array();
            return { async write(chunk) { data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk); }, async close() { files.set(key, data); } };
          },
        };
      },
      async removeEntry(name) { files.delete(prefix + name); },
    });
    navigator.storage.getDirectory = async () => ({
      async getDirectoryHandle(name) { return makeDir(name + '/'); },
      async getFileHandle(name, options = {}) { return makeDir('')[options?.create ? 'getFileHandle' : 'getFileHandle'](name, options); },
    });
    // The BYOP worker normally builds game.wasm from the ROM; this test returns
    // the already verified core so WebKit only exercises the host + legacy UI.
    window.Worker = class FakeWorker extends EventTarget {
      constructor() { super(); }
      postMessage(message) {
        if (message && message.type === 'build') {
          setTimeout(() => this.dispatchEvent(Object.assign(new Event('message'), { data: { type: 'result', result: { ok: true, output_sha256: expected, output_bytes: 3553097, total_seconds: 0.2, cached: true } } })), 30);
        }
      }
      terminate() {}
    };
    window.__FAKE_ROM_SHA__ = romSha;
  }, { b64: game.toString('base64'), expected: EXPECTED, romSha: ROM_SHA });

  const page = await context.newPage();
  const logs = [];
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message.slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') logs.push('CONSOLE ' + m.text().slice(0, 200)); });
  await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('#byop-rom'), null, { timeout: 60000 });
  await page.setInputFiles('#byop-rom', ROM);
  await page.waitForFunction(() => window.__BYOP_READY__ === true, null, { timeout: 300000, polling: 500 });
  await page.waitForTimeout(4000);
  const home = await page.evaluate(() => ({
    view: window.__DUNE_UI__?.view, scene: window.__DUNE_UI__?.state?.scene,
    buttons: [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null).map((b) => b.id).slice(0, 10),
    errors: (window.__DUNE_ERRORS__ || []).length,
  }));
  console.log('home:', JSON.stringify(home));
  await page.screenshot({ path: path.join(OUT, '01-menu.png') });
  if (!home.buttons.length) note('legacy home has no visible buttons in WebKit');

  await page.evaluate(() => document.getElementById('new-campaign')?.click());
  await page.waitForTimeout(1500);
  const houses = await page.evaluate(() => ({ view: window.__DUNE_UI__?.view, buttons: [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null).map((b) => b.id).slice(0, 10) }));
  console.log('houses:', JSON.stringify(houses));
  if (!houses.buttons.includes('house-1')) note('house buttons are missing in WebKit');
  await page.screenshot({ path: path.join(OUT, '02-houses.png') });

  await page.evaluate(() => document.getElementById('house-1')?.click());
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.getElementById('mission-1')?.click());
  await page.waitForTimeout(1500);
  const dialog = await page.evaluate(() => !!document.querySelector('#native-confirmation:not([hidden])'));
  console.log('mission dialog:', dialog);
  if (!dialog) note('mission confirmation dialog did not appear in WebKit');
  await page.screenshot({ path: path.join(OUT, '03-dialog.png') });
  if (dialog) await page.locator('#native-confirmation .confirmation-actions button').first().click();
  await page.waitForTimeout(2500);
  for (let i = 0; i < 24; i += 1) {
    if (await page.locator('#native-yes').count()) break;
    await page.mouse.click(195, 420);
    await page.waitForTimeout(700);
  }
  if (await page.locator('#native-yes').count()) await page.click('#native-yes');
  let armed = false;
  for (let i = 0; i < 25; i += 1) {
    await page.waitForTimeout(1200);
    if (await page.evaluate(() => window.__DUNE_UI__?.state?.activeRunArmed)) { armed = true; break; }
  }
  await page.waitForTimeout(2500);
  const final = await page.evaluate(() => ({ scene: window.__DUNE_UI__?.state?.scene, armed: window.__DUNE_UI__?.state?.activeRunArmed, cursorHidden: window.__DUNE_HOST?.cameraDebug?.()?.cursorHidden, audio: window.__DUNE_HOST?.audio ? { enabled: window.__DUNE_HOST.audio.enabled, state: window.__DUNE_HOST.audio.context?.state ?? null } : null, errors: (window.__DUNE_ERRORS__ || []).length }));
  console.log('final:', JSON.stringify(final));
  await page.screenshot({ path: path.join(OUT, '04-map.png') });
  if (!armed) note('mission did not become armed in WebKit');
  if (final.errors) note('error panel has ' + final.errors + ' entries');
  fs.writeFileSync(path.join(OUT, 'webkit.json'), JSON.stringify({ ok: problems.length === 0, problems, home, houses, dialog, final }, null, 2));
  console.log(problems.length === 0 ? 'WEBKIT-LEGACY OK' : 'WEBKIT-LEGACY FAILED');
  if (logs.length) console.log('logs:', JSON.stringify(logs.slice(0, 8)));
} catch (error) {
  console.error('WEBKIT-LEGACY FAILED', String(error));
  process.exitCode = 1;
} finally {
  await browser.close();
}
if (problems.length) process.exitCode = 1;
