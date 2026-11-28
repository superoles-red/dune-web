// WebKit (Safari engine) launch check for the BYOP shell.
//
//   DUNE_ROM="/path/to/Dune (USA).gen" node tests/browser/webkit-launch.mjs
//
// Boots the local fixed shell, builds the core from the ROM and starts Play,
// then checks that the canvas actually draws. Screenshots go to
// test-results/chrome-launch/. WebKit is downloaded with
//   npx --yes playwright@1.56.1 install webkit

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.WEBKIT_PORT || 4333);
const SITE_URL = `http://127.0.0.1:${PORT}/`;
const ROM = process.env.DUNE_ROM || null;
const OUT = path.join(ROOT, 'test-results', 'chrome-launch');
const TIMEOUT = 20 * 60 * 1000;

fs.mkdirSync(OUT, { recursive: true });
if (!ROM || !fs.existsSync(ROM)) {
  console.log('webkit launch test SKIPPED: set DUNE_ROM=/path/to/Dune-USA.gen');
  process.exit(0);
}

const problems = [];
const note = (message) => { problems.push(message); console.log(`WEBKIT PROBLEM: ${message}`); };

const server = spawn('/usr/bin/python3', [path.join(ROOT, 'tools/serve.py'), '--port', String(PORT)], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
});
for (let attempt = 0; attempt < 150; attempt += 1) {
  try { if ((await fetch(SITE_URL)).ok) break; } catch { /* wait */ }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const browser = await webkit.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ru-RU',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(SITE_URL, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__SPIKE_READY__ === true, null, { timeout: 120000 });
  const build = await page.evaluate(() => ({
    shell: window.__DUNE_SHELL_BUILD__ ?? null,
    app: window.__DUNE_APP_BUILD__ ?? null,
    crossOriginIsolated: self.crossOriginIsolated,
  }));
  console.log('webkit shell:', JSON.stringify(build));
  await page.screenshot({ path: path.join(OUT, 'webkit-01-setup.png') });

  await page.setInputFiles('#rom-input', ROM);
  await page.waitForFunction(
    () => window.__BUILD_RESULTS?.length > 0 || !document.getElementById('screen-error').classList.contains('hidden'),
    null, { timeout: TIMEOUT, polling: 1000 },
  );
  const result = await page.evaluate(() => window.__BUILD_RESULTS?.[0] ?? null);
  console.log('webkit build:', JSON.stringify({ ok: result?.ok, bytes: result?.output_bytes, seconds: result?.total_seconds }));
  if (!result?.ok) note('build failed in WebKit');
  await page.screenshot({ path: path.join(OUT, 'webkit-02-ready.png') });
  if (result?.ok) {
    await page.click('#play');
    await page.waitForFunction(() => window.__DUNE_HOST != null, null, { timeout: 120000, polling: 250 });
    await page.waitForFunction(() => (window.__DUNE_HOST.metrics?.renderedFrames ?? 0) >= 2, null, { timeout: 120000, polling: 250 });
    await page.waitForTimeout(1500);
    const frame = await page.evaluate(() => {
      const canvas = document.getElementById('game-canvas');
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let nonBlack = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] || data[i + 1] || data[i + 2]) nonBlack += 1;
      return {
        host: window.__DUNE_HOST.metrics,
        fault: window.__DUNE_HOST.fault,
        canvas: { width: canvas.width, height: canvas.height },
        nonBlack,
        errorVisible: !document.getElementById('screen-error').classList.contains('hidden'),
        errorText: document.getElementById('error-text')?.textContent ?? '',
      };
    });
    console.log('webkit play:', JSON.stringify({ frames: frame.host?.renderedFrames, fault: frame.fault, nonBlack: frame.nonBlack, canvas: frame.canvas, errorVisible: frame.errorVisible }));
    await page.screenshot({ path: path.join(OUT, 'webkit-03-play.png') });
    if (!(frame.nonBlack > 1000)) note(`WebKit canvas looks blank (${frame.nonBlack} non-black pixels)`);
    if (frame.errorVisible) note(`WebKit shows the error screen: ${frame.errorText}`);
    if (frame.fault) note(`WebKit host faulted: ${JSON.stringify(frame.fault)}`);
  }
  if (errors.length) note(`WebKit page errors: ${errors.join(' | ').slice(0, 300)}`);
} catch (error) {
  note(`WebKit run failed: ${String(error && error.message ? error.message : error).slice(0, 500)}`);
} finally {
  await browser.close();
  server.kill('SIGKILL');
}
fs.writeFileSync(path.join(OUT, 'webkit-launch.json'), `${JSON.stringify({ ok: problems.length === 0, problems }, null, 2)}\n`);
console.log(problems.length === 0 ? 'WEBKIT OK' : `WEBKIT FAILED (${problems.length})`);
if (problems.length) process.exitCode = 1;
