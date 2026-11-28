// Credits replay regression: the old UI fetches ./credits/house-N.state.bin.
// BYOP does not commit that ROM-derived snapshot; the boot falls back to the
// same-origin old deployment (https://superoles-red.github.io/dune-sega-web/).
// This test drives the real credits route and checks the native credits scene.
//
//   DUNE_ROM="..." LEGACY_URL="https://superoles-red.github.io/dune-web/" \
//     node tests/browser/legacy-credits.mjs
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
if (!ROM || !fs.existsSync(ROM)) { console.log('legacy-credits SKIPPED: set DUNE_ROM'); process.exit(0); }
if (/localhost|127\.0\.0\.1/.test(URL)) { console.log('legacy-credits SKIPPED: needs the old deployment online (use LEGACY_URL=https://superoles-red.github.io/dune-web/)'); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });
const server = process.env.LEGACY_URL ? null : spawn('/usr/bin/python3', [path.join(ROOT, 'tools/serve.py'), '--port', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
const problems = [];
const note = (message) => { problems.push(message); console.log('PROBLEM ' + message); };
for (let attempt = 0; attempt < 150; attempt += 1) { try { if ((await fetch(URL)).ok) break; } catch { /* wait */ } await new Promise((r) => setTimeout(r, 100)); }
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ru-RU' })).newPage();
  page.on('pageerror', (error) => note('pageerror: ' + error.message.slice(0, 200)));
  await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('#byop-rom'), null, { timeout: 60000 });
  await page.setInputFiles('#byop-rom', ROM);
  await page.waitForFunction(() => window.__BYOP_READY__ === true, null, { timeout: 300000, polling: 1000 });
  await page.waitForTimeout(3000);
  const probe = await page.evaluate(async () => {
    try {
      const response = await fetch('./credits/house-1.state.bin');
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { ok: response.ok, status: response.status, bytes: bytes.length, head: Array.from(bytes.slice(0, 8)) };
    } catch (error) { return { error: String(error) }; }
  });
  console.log('credits fetch probe:', JSON.stringify(probe));
  const started = await page.evaluate(() => {
    const ui = window.__DUNE_UI__;
    if (!ui || typeof ui.replayCredits !== 'function' || !ui.store) return false;
    // Credits only exist after mission 9; mark it completed in memory, open the
    // mission grid (replayCredits requires view==='missions') and replay.
    ui.store.progress.houses[1].completed = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    ui.showMissions(1);
    setTimeout(() => ui.replayCredits(1), 80);
    return true;
  });
  if (!started) note('replayCredits is not available');
  let scene = null;
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(1000);
    scene = await page.evaluate(() => ({ view: window.__DUNE_UI__?.view, displayed: window.__DUNE_UI__?.displayed, scene: window.__DUNE_UI__?.state?.scene, message: document.getElementById('message')?.textContent || '', pending: window.__DUNE_UI__?.pendingScreen ? { kind: window.__DUNE_UI__.pendingScreen.kind, sent: window.__DUNE_UI__.pendingScreen.sent, target: window.__DUNE_UI__.pendingScreen.target } : null, busy: window.__DUNE_UI__?.busy, curtain: window.__DUNE_UI__?.curtain?.debug?.(), byopErrors: (window.__DUNE_ERRORS__ || []).length }));
    if (scene.scene === 'credits' || scene.displayed === 'native') break;
  }
  console.log('credits scene:', JSON.stringify(scene));
  await page.screenshot({ path: path.join(OUT, 'credits-01.png') });
  if (scene.scene !== 'credits' && !(scene.displayed === 'native' && !/Не удалось|недоступ/i.test(scene.message))) note('credits replay did not reach the native credits scene');
  if (scene.errors) note('error panel has ' + scene.errors + ' entries');
  const report = { ok: problems.length === 0, problems, scene };
  fs.writeFileSync(path.join(OUT, 'credits.json'), JSON.stringify(report, null, 2));
  console.log(problems.length === 0 ? 'LEGACY-CREDITS OK' : 'LEGACY-CREDITS FAILED');
} catch (error) {
  console.error('LEGACY-CREDITS FAILED', String(error));
  process.exitCode = 1;
} finally {
  await browser.close();
  server?.kill('SIGKILL');
}
if (problems.length) process.exitCode = 1;
