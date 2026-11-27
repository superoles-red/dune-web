// End-to-end play test: ROM -> in-browser game.wasm -> host -> real Dune frames.
//
//   DUNE_ROM="/path/to/Dune (USA).gen" node tests/browser/play.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PLAY_PORT || 4322);
const LIVE_URL = process.env.PLAY_URL || null;
const URL = LIVE_URL || `http://127.0.0.1:${PORT}/`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROM = process.env.DUNE_ROM || null;
const OUT = path.join(ROOT, 'test-results', 'play');
const TIMEOUT = 20 * 60 * 1000;

if (!ROM || !fs.existsSync(ROM)) {
  console.log('play test SKIPPED: set DUNE_ROM=/path/to/Dune-USA.gen');
  process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });
for (const required of ['web/reference.json', 'web/py-package.zip', 'web/runtime/runtime.wasm', 'web/host/host.mjs']) {
  if (!fs.existsSync(path.join(ROOT, required))) {
    console.error(`missing ${required}; run: npm install && python3 tools/bundle_web.py`);
    process.exit(1);
  }
}

const server = LIVE_URL ? null : spawn('/usr/bin/python3', [path.join(ROOT, 'tools/serve.py'), '--port', String(PORT)], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'],
});
const problems = [];
const note = (message) => { problems.push(message); console.log(`PLAY PROBLEM: ${message}`); };

async function waitForServer() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { if ((await fetch(URL, { cache: 'no-store' })).ok) return; } catch { /* wait */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start on ${URL}`);
}

async function frameStats(page) {
  return page.evaluate(() => {
    const host = window.__DUNE_HOST;
    if (!host) return null;
    const stats = host.frameStats ? host.frameStats() : null;
    const canvas = document.getElementById('game-canvas');
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const colours = new Set();
    let nonBlack = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] || data[i + 1] || data[i + 2]) nonBlack += 1;
      colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    }
    return { ...(stats || {}), canvasNonBlack: nonBlack, canvasColours: colours.size };
  });
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
try {
  if (!LIVE_URL) await waitForServer();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__SPIKE_READY__ === true, null, { timeout: 60000 });
  await page.setInputFiles('#rom-input', ROM);
  await page.waitForFunction(
    () => window.__BUILD_RESULTS?.length > 0 || !document.getElementById('screen-error').classList.contains('hidden'),
    null, { timeout: TIMEOUT, polling: 1000 },
  );
  const result = await page.evaluate(() => window.__BUILD_RESULTS?.[0] ?? null);
  console.log('build:', JSON.stringify({ ok: result?.ok, cached: result?.cached, sha: result?.output_sha256, bytes: result?.output_bytes, seconds: result?.total_seconds && Math.round(result.total_seconds * 10) / 10 }));
  if (!result?.ok) { note('in-browser game.wasm build failed'); throw new Error('build failed'); }
  await page.screenshot({ path: path.join(OUT, '00-ready.png') });

  await page.click('#play');
  await page.waitForFunction(() => window.__DUNE_HOST != null, null, { timeout: 120000, polling: 200 });
  await page.waitForFunction(() => (window.__DUNE_HOST.metrics?.renderedFrames ?? 0) >= 2, null, { timeout: 120000, polling: 200 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, '01-menu.png') });
  let stats = await frameStats(page);
  console.log('boot frame:', JSON.stringify(stats));
  if (!(stats.canvasNonBlack > 500)) note('boot frame looks blank');

  const press = async (key, hold = 120) => {
    await page.keyboard.down(key);
    await page.waitForTimeout(hold);
    await page.keyboard.up(key);
    await page.waitForTimeout(700);
  };
  stats = await frameStats(page);
  console.log('menu frame:', JSON.stringify(stats));

  // START GAME is the first item: confirm with A.
  await press('KeyZ');
  await page.screenshot({ path: path.join(OUT, '02-startgame.png') });
  stats = await frameStats(page);
  console.log('start game frame:', JSON.stringify(stats));
  // Then confirm the first house with A.
  await press('KeyZ');
  await page.screenshot({ path: path.join(OUT, '03-house.png') });
  await press('KeyZ');
  await page.screenshot({ path: path.join(OUT, '04-mission.png') });
  stats = await frameStats(page);
  console.log('mission frame:', JSON.stringify(stats));

  const report = {
    build: { ok: result.ok, sha: result.output_sha256, bytes: result.output_bytes, seconds: result.total_seconds },
    errors,
    problems,
    frames: stats,
    screenshots: fs.readdirSync(OUT).filter((name) => name.endsWith('.png')),
  };
  fs.writeFileSync(path.join(OUT, 'play.json'), JSON.stringify(report, null, 2) + '\n');
  if (errors.length) note(`console errors: ${errors.slice(0, 3).join(' | ')}`);
  console.log(JSON.stringify(report, null, 2));
  console.log(problems.length ? 'PLAY FAILED' : 'PLAY OK');
  process.exitCode = problems.length ? 1 : 0;
} catch (error) {
  console.error('PLAY FAILED', String(error));
  process.exitCode = 1;
} finally {
  await browser.close();
  if (server) server.kill('SIGKILL');
}
