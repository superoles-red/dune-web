// Campaign stability soak: after reaching the mission, run a long emulated
// session with camera work, selections, the building console and periodic
// saves, and watch for faults, stalls, frame stalls and memory growth.
//
//   DUNE_ROM="/path/to/Dune (USA).gen" node tests/browser/soak.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PLAY_PORT || 4333);
const URL = process.env.PLAY_URL || `http://127.0.0.1:${PORT}/`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROM = process.env.DUNE_ROM || null;
const OUT = path.join(ROOT, 'test-results', 'soak');
const TIMEOUT = 20 * 60 * 1000;

if (!ROM || !fs.existsSync(ROM)) {
  console.log('soak test SKIPPED: set DUNE_ROM=/path/to/Dune-USA.gen');
  process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });
const server = process.env.PLAY_URL ? null : spawn('/usr/bin/python3', [path.join(ROOT, 'tools/serve.py'), '--port', String(PORT)], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
});
const problems = [];
const note = (message) => { problems.push(message); console.log(`SOAK PROBLEM: ${message}`); };
for (let attempt = 0; attempt < 150; attempt += 1) {
  try { if ((await fetch(URL)).ok) break; } catch { /* wait */ }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const snapshot = (page) => page.evaluate(() => {
  const host = window.__DUNE_HOST;
  const campaign = (() => {
    try {
      const bytes = new Uint8Array(host.memory.buffer, host.exports.dune_web_campaign_json());
      let end = 0;
      while (end < bytes.length && bytes[end]) end += 1;
      const json = JSON.parse(new TextDecoder().decode(bytes.subarray(0, end)));
      return { scene: json.scene, armed: json.activeRunArmed, mission: json.mission };
    } catch { return null; }
  })();
  return {
    instructions: host.metrics.instructions,
    masterCycles: host.metrics.masterCycles,
    renderedFrames: host.metrics.renderedFrames,
    fault: host.metrics.fault,
    stalled: !!host.metrics.stalled,
    fps: host.metrics.fps,
    wasmBytes: host.memory.buffer.byteLength,
    heap: performance.memory ? performance.memory.usedJSHeapSize : 0,
    campaign,
  };
});

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ru-RU' });
  const page = await context.newPage();
  page.on('pageerror', (error) => note(`pageerror: ${error.message.slice(0, 200)}`));

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__SPIKE_READY__ === true, null, { timeout: 60000 });
  await page.setInputFiles('#rom-input', ROM);
  await page.waitForFunction(() => window.__BUILD_RESULTS?.length > 0, null, { timeout: TIMEOUT, polling: 1000 });
  await page.click('#play');
  await page.waitForFunction(() => window.__DUNE_HOST != null, null, { timeout: 120000 });
  let reached = null;
  for (let i = 1; i <= 32; i += 1) {
    await page.evaluate(() => window.__DUNE_HOST.advanceInstructions(1_600_000));
    await page.keyboard.down('KeyZ'); await page.waitForTimeout(120); await page.keyboard.up('KeyZ');
    reached = await snapshot(page);
    if (reached.campaign?.armed === 1) break;
  }
  if (reached?.campaign?.armed !== 1) note('did not reach an armed mission');
  const start = await snapshot(page);
  console.log('start:', JSON.stringify({ instructions: start.instructions, wasmBytes: start.wasmBytes, heap: start.heap, mission: start.campaign?.mission }));
  await page.screenshot({ path: path.join(OUT, '01-start.png') });
  const box = await page.locator('#game-canvas').boundingBox();

  const rounds = Number(process.env.SOAK_ROUNDS || 24);
  for (let round = 0; round < rounds; round += 1) {
    await page.evaluate(() => window.__DUNE_HOST.advanceInstructions(2_000_000));
    // Camera work.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 4; step += 1) {
      await page.mouse.move(box.x + box.width / 2 + (round % 2 ? step * 9 : -step * 9), box.y + box.height / 2, { steps: 1 });
      await page.waitForTimeout(20);
    }
    await page.mouse.up();
    await page.waitForTimeout(120);
    if (round % 4 === 1) await page.mouse.wheel(0, round % 8 ? 120 : -120);
    // Select a building and open its console every few rounds.
    if (round % 6 === 2) {
      await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2, { delay: 90 });
      for (let wait = 0; wait < 12; wait += 1) {
        await page.waitForTimeout(250);
        const visible = await page.evaluate(() => document.getElementById('building-cells').hidden === false);
        if (visible) break;
      }
      const buttons = await page.locator('#building-cells button').count();
      if (buttons) {
        await page.locator('#building-cells button').nth(Math.min(2, buttons - 1)).click();
        await page.waitForTimeout(300);
        const exit = await page.evaluate(() => {
          const ui = window.__DUNE_HOST.buildingUi?.();
          const index = Array.isArray(ui?.cells) ? ui.cells.findIndex((cell) => cell.key === 'exit') : -1;
          return index;
        });
        if (exit >= 0) await page.locator('#building-cells button').nth(exit).click();
        await page.waitForTimeout(400);
      }
    }
    // Periodic save through the pause sheet.
    if (round % 8 === 5) {
      const clickDom = (id) => page.evaluate((elementId) => document.getElementById(elementId).click(), id);
      await clickDom('game-menu');
      await page.waitForTimeout(250);
      await clickDom('game-save');
      await page.waitForTimeout(500);
      await clickDom('game-sheet-close');
      await page.waitForTimeout(200);
    }
    const current = await snapshot(page);
    if (current.fault) { note(`fault at round ${round}`); break; }
    if (current.stalled) note(`stalled flag at round ${round}`);
  }

  const end = await snapshot(page);
  const elapsed = { instructions: end.instructions - start.instructions, frames: end.renderedFrames - start.renderedFrames };
  const memory = { wasmGrowth: end.wasmBytes - start.wasmBytes, heapGrowth: end.heap - start.heap };
  console.log('end:', JSON.stringify({ ...end, elapsed, memory }));
  await page.screenshot({ path: path.join(OUT, '02-end.png') });
  if (end.fault) note('game faulted at the end of the soak');
  if (end.stalled) note('stall flag set at the end of the soak');
  if (elapsed.instructions < 20_000_000) note(`only ${elapsed.instructions} instructions simulated`);
  if (elapsed.frames < 50) note(`only ${elapsed.frames} native frames rendered`);
  if (!end.campaign?.armed) note('mission is no longer armed after the soak');
  if (memory.wasmGrowth > 64 * 1024 * 1024) note(`wasm memory grew by ${Math.round(memory.wasmGrowth / 1048576)} MiB`);
  if (memory.heapGrowth > 128 * 1024 * 1024) note(`JS heap grew by ${Math.round(memory.heapGrowth / 1048576)} MiB`);

  const report = { ok: problems.length === 0, problems, start, end, elapsed, memory, rounds };
  fs.writeFileSync(path.join(OUT, 'soak.json'), JSON.stringify(report, null, 2));
  console.log(problems.length === 0 ? 'SOAK OK' : 'SOAK FAILED');
} catch (error) {
  console.error('SOAK FAILED', String(error));
  process.exitCode = 1;
} finally {
  await browser.close();
  server?.kill('SIGKILL');
}
if (problems.length) process.exitCode = 1;
