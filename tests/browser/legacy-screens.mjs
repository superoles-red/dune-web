// Legacy UI screens regression: OPTIONS (music/sound), LANGUAGES (RU switch),
// HOW TO PLAY (tutorial guide), FILES & OFFLINE panel, and navigation back home.
//
//   DUNE_ROM="/path/to/Dune (USA).gen" node tests/browser/legacy-screens.mjs
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
if (!ROM || !fs.existsSync(ROM)) { console.log('legacy-screens SKIPPED: set DUNE_ROM'); process.exit(0); }
fs.mkdirSync(OUT, { recursive: true });
const server = process.env.LEGACY_URL ? null : spawn('/usr/bin/python3', [path.join(ROOT, 'tools/serve.py'), '--port', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
const problems = [];
const note = (message) => { problems.push(message); console.log('PROBLEM ' + message); };
for (let attempt = 0; attempt < 150; attempt += 1) { try { if ((await fetch(URL)).ok) break; } catch { /* wait */ } await new Promise((r) => setTimeout(r, 100)); }
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ru-RU' })).newPage();
  page.on('pageerror', (error) => note('pageerror: ' + error.message.slice(0, 200)));
  page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) note('console: ' + message.text().slice(0, 200)); });
  await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => document.querySelector('#byop-rom'), null, { timeout: 60000 });
  await page.setInputFiles('#byop-rom', ROM);
  await page.waitForFunction(() => window.__BYOP_READY__ === true, null, { timeout: 300000, polling: 1000 });
  await page.waitForTimeout(3000);
  const state = () => page.evaluate(() => {
    const ui = window.__DUNE_UI__;
    return {
      view: ui?.view, displayed: ui?.displayed, scene: ui?.state?.scene,
      music: ui?.state?.music, sound: ui?.state?.sound, language: ui?.art?.language?.code,
      buttons: [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null).map((b) => ({ id: b.id, label: b.getAttribute('aria-label') || b.textContent.trim().slice(0, 18) })).slice(0, 16),
      errors: (window.__DUNE_ERRORS__ || []).length,
    };
  });
  const shot = (name) => page.screenshot({ path: path.join(OUT, name) });
  const click = async (id) => page.evaluate((elementId) => document.getElementById(elementId)?.click(), id);
  const back = async () => {
    const clicked = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
      const button = buttons.find((b) => /back|назад/i.test(b.getAttribute('aria-label') || '') || /^\s*(back|назад)\s*$/i.test(b.textContent.trim()));
      if (!button) return { found: false, labels: buttons.map((b) => (b.getAttribute('aria-label') || b.textContent.trim()).slice(0, 20)) };
      button.click();
      return { found: true, label: button.getAttribute('aria-label') || button.textContent.trim() };
    });
    await page.waitForTimeout(1500);
    const after = await page.evaluate(() => ({ view: window.__DUNE_UI__?.view, busy: window.__DUNE_UI__?.busy, curtain: window.__DUNE_UI__?.curtain?.debug?.() }));
    console.log('back:', JSON.stringify({ clicked, after }));
    return after;
  };

  await click('open-options'); await page.waitForTimeout(1500);
  const options = await state();
  console.log('options:', JSON.stringify(options));
  await shot('screens-01-options.png');
  if (options.view !== 'native' || options.displayed !== 'options') note('OPTIONS screen did not open');
  const musicBefore = await page.evaluate(() => ({ label: document.getElementById('option-0')?.getAttribute('aria-label'), gain: window.__DUNE_HOST?.audio?.music ?? null }));
  await click('option-0'); await page.waitForTimeout(1200);
  const musicAfter = await page.evaluate(() => ({ label: document.getElementById('option-0')?.getAttribute('aria-label'), gain: window.__DUNE_HOST?.audio?.music ?? null }));
  console.log('music after click:', JSON.stringify({ before: musicBefore, after: musicAfter }));
  if (musicAfter.label === musicBefore.label && musicAfter.gain === musicBefore.gain) note('MUSIC row did not change the music label/gain');

  await click('open-languages'); await page.waitForTimeout(1200);
  const languages = await state();
  console.log('languages:', JSON.stringify({ view: languages.view, language: languages.language, buttons: languages.buttons.map((b) => b.id) }));
  await shot('screens-02-languages.png');
  if (languages.view !== 'languages') note('LANGUAGES screen did not open');
  await click('language-ru'); await page.waitForTimeout(1200);
  const ru = await state();
  console.log('after RU:', JSON.stringify({ language: ru.language, errors: ru.errors }));
  if (ru.language !== 'ru') note('language did not switch to RU');
  await back();

  await click('open-controls'); await page.waitForTimeout(2000);
  const controls = await state();
  console.log('controls:', JSON.stringify({ view: controls.view, buttons: controls.buttons.map((b) => b.id || b.label).slice(0, 12), errors: controls.errors }));
  await shot('screens-03-controls.png');
  if (controls.view !== 'controls') note('HOW TO PLAY screen did not open');
  await back();

  await click('open-platform'); await page.waitForTimeout(1500);
  const platform = await state();
  console.log('platform:', JSON.stringify({ view: platform.view, buttons: platform.buttons.map((b) => b.id || b.label).slice(0, 12), errors: platform.errors }));
  await shot('screens-04-platform.png');
  if (platform.view !== 'platform') note('FILES & OFFLINE screen did not open');
  await back();
  await back();
  const home = await state();
  console.log('home:', JSON.stringify({ view: home.view, displayed: home.displayed, buttons: home.buttons.map((b) => b.id) }));
  await shot('screens-05-home.png');
  if (home.view !== 'home') note('did not return to the home screen');
  if (home.language !== 'ru') note('RU language choice was not kept');

  const report = { ok: problems.length === 0, problems, options, languages, ru, controls, platform, home };
  fs.writeFileSync(path.join(OUT, 'screens.json'), JSON.stringify(report, null, 2));
  console.log(problems.length === 0 ? 'LEGACY-SCREENS OK' : 'LEGACY-SCREENS FAILED');
} catch (error) {
  console.error('LEGACY-SCREENS FAILED', String(error));
  process.exitCode = 1;
} finally {
  await browser.close();
  server?.kill('SIGKILL');
}
if (problems.length) process.exitCode = 1;
