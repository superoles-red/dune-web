// Regression test for the exact player path that used to look "stuck on
// loading": NEW CAMPAIGN -> house -> mission -> START dialog -> briefing pages
// -> PROCEED -> campaign intro -> mission map with activeRunArmed=1.
//
//   DUNE_ROM="/path/to/Dune (USA).gen" node tests/browser/legacy-start.mjs
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
if (!ROM || !fs.existsSync(ROM)) {
  console.log('legacy-start SKIPPED: set DUNE_ROM=/path/to/Dune-USA.gen');
  process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });
const server = process.env.LEGACY_URL ? null : spawn('/usr/bin/python3', [path.join(ROOT, 'tools/serve.py'), '--port', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
const problems = [];
const note = (message) => { problems.push(message); console.log('PROBLEM ' + message); };
for (let attempt = 0; attempt < 150; attempt += 1) {
  try { if ((await fetch(URL)).ok) break; } catch { /* wait */ }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ru-RU' })).newPage();
  page.on('pageerror', (error) => note('pageerror: ' + error.message.slice(0, 200)));
  await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('#byop-rom'), null, { timeout: 60000 });
  await page.setInputFiles('#byop-rom', ROM);
  await page.waitForFunction(() => window.__BYOP_READY__ === true, null, { timeout: 300000, polling: 1000 });
  await page.waitForTimeout(2500);
  const state = () => page.evaluate(() => {
    const ui = window.__DUNE_UI__;
    return {
      view: ui?.view, displayed: ui?.displayed, scene: ui?.state?.scene, armed: ui?.state?.activeRunArmed,
      house: ui?.state?.house, mission: ui?.state?.mission,
      dialog: !!document.querySelector('#native-confirmation:not([hidden])'),
      proceed: !!document.querySelector('#native-yes'),
      hint: document.getElementById('byop-native-hint') ? getComputedStyle(document.getElementById('byop-native-hint')).opacity : null,
      audio: window.__DUNE_HOST?.audio ? { enabled: window.__DUNE_HOST.audio.enabled, state: window.__DUNE_HOST.audio.context?.state ?? null } : null,
      errors: (window.__DUNE_ERRORS__ || []).length,
    };
  });
  const shot = (name) => page.screenshot({ path: path.join(OUT, name) });

  await page.evaluate(() => document.getElementById('new-campaign').click());
  await page.waitForTimeout(1000);
  await page.evaluate(() => document.getElementById('house-1').click());
  await page.waitForTimeout(1000);
  await page.evaluate(() => document.getElementById('mission-1').click());
  await page.waitForTimeout(1000);
  const dialogState = await state();
  if (!dialogState.dialog) note('START MISSION dialog did not appear');
  await page.locator('#native-confirmation .confirmation-actions button').first().click();
  await page.waitForTimeout(2500);
  // Briefing pages advance on a tap; the hint must be visible while no HTML controls exist.
  let sawHint = false;
  for (let i = 0; i < 24; i += 1) {
    if (await page.locator('#native-yes').count()) break;
    const current = await state();
    if (Number(current.hint) > 0.5) sawHint = true;
    await page.mouse.click(640, 400);
    await page.waitForTimeout(650);
  }
  if (!sawHint) console.log('warning: native briefing hint was not observed');
  await shot('start-01-briefing-end.png');
  if (!(await page.locator('#native-yes').count())) note('PROCEED button never appeared after the briefing');
  await page.click('#native-yes').catch(() => {});
  let armed = false;
  for (let i = 0; i < 20; i += 1) {
    await page.waitForTimeout(1200);
    const current = await state();
    if (current.armed) { armed = true; break; }
  }
  await page.waitForTimeout(2500);
  const final = await state();
  await shot('start-02-mission-map.png');
  if (!armed) note('mission never became armed (map did not start)');
  if (final.scene !== 'map') note('final scene is ' + final.scene);
  if (!final.audio?.enabled || final.audio?.state !== 'running') note('audio context is not running after the start clicks');
  const report = { ok: problems.length === 0, problems, final, dialogState };
  fs.writeFileSync(path.join(OUT, 'start.json'), JSON.stringify(report, null, 2));
  console.log('final:', JSON.stringify(final));
  console.log(problems.length === 0 ? 'LEGACY-START OK' : 'LEGACY-START FAILED');
} catch (error) {
  console.error('LEGACY-START FAILED', String(error));
  process.exitCode = 1;
} finally {
  await browser.close();
  server?.kill('SIGKILL');
}
if (problems.length) process.exitCode = 1;
