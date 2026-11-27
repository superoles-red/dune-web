// Wrapper localization + help sheet test (no ROM needed).
//
//   node tests/browser/i18n.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PLAY_PORT || 4329);
const URL = process.env.PLAY_URL || `http://127.0.0.1:${PORT}/`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.join(ROOT, 'test-results', 'i18n');
fs.mkdirSync(OUT, { recursive: true });

const server = process.env.PLAY_URL ? null : spawn('/usr/bin/python3', [path.join(ROOT, 'tools/serve.py'), '--port', String(PORT)], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
});
for (let attempt = 0; attempt < 150; attempt += 1) {
  try { if ((await fetch(URL)).ok) break; } catch { /* wait */ }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const problems = [];
const note = (message) => { problems.push(message); console.log(`I18N PROBLEM: ${message}`); };
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
try {
  const ruContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', isMobile: true, hasTouch: true });
  const ru = await ruContext.newPage();
  ru.on('pageerror', (error) => note(`ru pageerror: ${error.message.slice(0, 200)}`));
  await ru.goto(URL, { waitUntil: 'load' });
  await ru.waitForFunction(() => window.__SPIKE_READY__ === true, null, { timeout: 60000 });
  const ruState = await ru.evaluate(() => ({
    lang: document.documentElement.lang,
    title: document.querySelector('#screen-setup .title')?.textContent,
    toggle: document.getElementById('lang-toggle')?.textContent,
    help: document.getElementById('help-open')?.textContent,
    play: document.getElementById('play')?.textContent.replace(/\s+/g, ' ').trim(),
  }));
  console.log('ru:', JSON.stringify(ruState));
  if (ruState.lang !== 'ru') note('ru browser did not default to Russian');
  if (!ruState.title?.includes('Добавьте свою игру')) note('ru title is missing');
  if (ruState.toggle !== 'EN') note('ru toggle should offer EN');
  await ru.screenshot({ path: path.join(OUT, '01-ru.png') });

  // Help sheet in Russian.
  await ru.click('#help-open');
  await ru.waitForTimeout(300);
  const ruHelp = await ru.evaluate(() => ({
    visible: !document.getElementById('help-sheet').classList.contains('hidden'),
    text: document.getElementById('help-sheet')?.textContent.slice(0, 80),
  }));
  if (!ruHelp.visible) note('help sheet did not open');
  await ru.screenshot({ path: path.join(OUT, '02-ru-help.png') });
  await ru.click('#help-close');

  // Switch to English and reload.
  await ru.click('#lang-toggle');
  await ru.waitForFunction(() => document.documentElement.lang === 'en', null, { timeout: 60000 });
  await ru.waitForFunction(() => window.__SPIKE_READY__ === true, null, { timeout: 60000 });
  const enState = await ru.evaluate(() => ({
    lang: document.documentElement.lang,
    title: document.querySelector('#screen-setup .title')?.textContent,
    toggle: document.getElementById('lang-toggle')?.textContent,
    help: document.getElementById('help-open')?.textContent,
    drop: document.querySelector('#drop .btn')?.textContent,
  }));
  console.log('en after switch:', JSON.stringify(enState));
  if (!enState.title?.includes('Bring your own game')) note(`en title is wrong: ${enState.title}`);
  if (enState.toggle !== 'RU') note('en toggle should offer RU');
  if (!/How to play/.test(enState.help || '')) note(`en help button is wrong: ${enState.help}`);
  if (!/Choose ROM/.test(enState.drop || '')) note(`en drop button is wrong: ${enState.drop}`);
  await ru.screenshot({ path: path.join(OUT, '03-en.png') });
  await ru.click('#help-open');
  await ru.waitForTimeout(300);
  const enHelp = await ru.evaluate(() => ({
    title: document.getElementById('help-title')?.textContent,
    body: document.getElementById('help-sheet')?.textContent,
    pauseHelp: document.getElementById('game-help')?.textContent,
    close: document.getElementById('help-close')?.textContent,
  }));
  console.log('en help:', JSON.stringify({ title: enHelp.title, close: enHelp.close, pauseHelp: enHelp.pauseHelp }));
  if (!/How to play/.test(enHelp.title || '')) note('en help title is wrong');
  if (!/Got it/.test(enHelp.close || '')) note('en help close is wrong');
  if (!/Help/.test(enHelp.pauseHelp || '')) note('en pause help is wrong');
  if (!/Map: tap to select/.test(enHelp.body || '')) note('en help body is not translated');
  await ru.screenshot({ path: path.join(OUT, '04-en-help.png') });

  // Fresh English browser defaults to English.
  const enContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US', isMobile: true, hasTouch: true });
  const en = await enContext.newPage();
  await en.goto(URL, { waitUntil: 'load' });
  await en.waitForFunction(() => window.__SPIKE_READY__ === true, null, { timeout: 60000 });
  const fresh = await en.evaluate(() => ({ lang: document.documentElement.lang, title: document.querySelector('#screen-setup .title')?.textContent }));
  console.log('fresh en:', JSON.stringify(fresh));
  if (!fresh.title?.includes('Bring your own game')) note('fresh en browser did not default to English');

  const report = { ok: problems.length === 0, problems, ru: ruState, en: enState, fresh };
  fs.writeFileSync(path.join(OUT, 'i18n.json'), JSON.stringify(report, null, 2));
  console.log(problems.length === 0 ? 'I18N OK' : 'I18N FAILED');
} catch (error) {
  console.error('I18N FAILED', String(error));
  process.exitCode = 1;
} finally {
  await browser.close();
  server?.kill('SIGKILL');
}
if (problems.length) process.exitCode = 1;
