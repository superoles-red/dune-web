// Visual UX self-test for the BYOP shell. Runs the real flow in headless Chrome,
// writes screenshots for human review and fails on obvious layout problems.
//
//   DUNE_ROM="/path/to/Dune (USA).gen" node tests/browser/ux.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.UX_PORT || 4311);
const URL = `http://127.0.0.1:${PORT}/`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROM = process.env.DUNE_ROM || null;
const OUT = path.join(ROOT, 'test-results', 'ux');
const TIMEOUT = 20 * 60 * 1000;

fs.mkdirSync(OUT, { recursive: true });
const server = spawn('/usr/bin/python3', [path.join(ROOT, 'tools/serve.py'), '--port', String(PORT)], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'],
});
const problems = [];
const note = (message) => { problems.push(message); console.log(`UX PROBLEM: ${message}`); };

async function waitForServer() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if ((await fetch(URL, { cache: 'no-store' })).ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start on ${URL}`);
}

async function layoutCheck(page, label) {
  const info = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    tinyTargets: [...document.querySelectorAll('button:not([hidden]), label.drop')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (rect.height < 44 || rect.width < 44);
      })
      .map((element) => (element.id || element.className || element.tagName).toString().slice(0, 40)),
    text: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 400),
  }));
  if (info.scrollWidth > info.clientWidth + 1) note(`${label}: horizontal overflow ${info.scrollWidth} > ${info.clientWidth}`);
  for (const target of info.tinyTargets) note(`${label}: touch target < 44px: ${target}`);
  return info;
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
try {
  await waitForServer();
  for (const device of [
    { name: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, scale: 3 },
    { name: 'desktop', viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false, scale: 1 },
  ]) {
    const context = await browser.newContext({
      viewport: device.viewport,
      deviceScaleFactor: device.scale,
      isMobile: device.isMobile,
      hasTouch: device.hasTouch,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

    await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(() => window.__SPIKE_READY__ === true, null, { timeout: 60000 });
    await page.screenshot({ path: path.join(OUT, `${device.name}-1-setup.png`) });
    const setup = await layoutCheck(page, `${device.name}/setup`);
    if (!/Добавьте свою игру/.test(setup.text)) note(`${device.name}/setup: main title is missing`);
    if ((await page.locator('#open-saves').count()) === 0) note(`${device.name}/setup: saves entry is missing`);

    if (ROM && fs.existsSync(ROM)) {
      await page.setInputFiles('#rom-input', ROM);
      await page.waitForTimeout(4200);
      await page.screenshot({ path: path.join(OUT, `${device.name}-2-progress.png`) });
      await page.waitForFunction(
        () => window.__BUILD_RESULTS?.length > 0 || !document.getElementById('screen-error').classList.contains('hidden'),
        null,
        { timeout: TIMEOUT, polling: 1000 },
      );
      const failed = await page.evaluate(() => !document.getElementById('screen-error').classList.contains('hidden'));
      if (failed) note(`${device.name}: build failed: ${await page.textContent('#error-text')}`);
      await page.screenshot({ path: path.join(OUT, `${device.name}-3-ready.png`) });
      const ready = await layoutCheck(page, `${device.name}/ready`);
      if (!failed && !/Игра собрана|Игра уже собрана/.test(ready.text)) note(`${device.name}/ready: success title is missing`);

      await page.click('#open-saves');
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, `${device.name}-4-saves.png`) });
      await layoutCheck(page, `${device.name}/saves`);
      const savesText = await page.textContent('#saves-status');
      if (!savesText || savesText.trim().length < 3) note(`${device.name}/saves: empty status`);
      await page.click('#saves-close');

      await page.click('#details summary');
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, `${device.name}-5-details.png`) });
      const core = await page.textContent('#detail-core');
      if (!core || core.includes('—')) note(`${device.name}/details: core hash was not shown`);
    } else {
      console.log('UX: ROM not configured, skipped the build screens (screenshots 1 only)');
    }
    if (errors.length) note(`${device.name}: console errors: ${errors.slice(0, 3).join(' | ')}`);
    await context.close();
  }

  const summary = { screenshots: fs.readdirSync(OUT).filter((name) => name.endsWith('.png')), problems };
  fs.writeFileSync(path.join(OUT, 'ux.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  console.log(problems.length ? 'UX FAILED' : 'UX OK');
  process.exitCode = problems.length ? 1 : 0;
} catch (error) {
  console.error('UX FAILED', String(error));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGKILL');
}
