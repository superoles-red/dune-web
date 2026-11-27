// Campaign continuation test: save a mission, reload the whole page (fresh
// process), rebuild from OPFS and press "Continue" — the saved mission must be
// restored exactly, with the HUD and the mission number intact.
//
//   DUNE_ROM="/path/to/Dune (USA).gen" node tests/browser/continue.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PLAY_PORT || 4331);
const URL = process.env.PLAY_URL || `http://127.0.0.1:${PORT}/`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROM = process.env.DUNE_ROM || null;
const OUT = path.join(ROOT, 'test-results', 'continue');
const TIMEOUT = 20 * 60 * 1000;

if (!ROM || !fs.existsSync(ROM)) {
  console.log('continue test SKIPPED: set DUNE_ROM=/path/to/Dune-USA.gen');
  process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });
const server = process.env.PLAY_URL ? null : spawn('/usr/bin/python3', [path.join(ROOT, 'tools/serve.py'), '--port', String(PORT)], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
});
const problems = [];
const note = (message) => { problems.push(message); console.log(`CONTINUE PROBLEM: ${message}`); };
for (let attempt = 0; attempt < 150; attempt += 1) {
  try { if ((await fetch(URL)).ok) break; } catch { /* wait */ }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const readCampaign = (page) => page.evaluate(() => {
  const host = window.__DUNE_HOST;
  const bytes = new Uint8Array(host.memory.buffer, host.exports.dune_web_campaign_json());
  let end = 0;
  while (end < bytes.length && bytes[end]) end += 1;
  const campaign = JSON.parse(new TextDecoder().decode(bytes.subarray(0, end)));
  return { scene: campaign.scene, armed: campaign.activeRunArmed, house: campaign.house, mission: campaign.mission };
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
  let campaign = null;
  for (let i = 1; i <= 32; i += 1) {
    await page.evaluate(() => window.__DUNE_HOST.advanceInstructions(1_600_000));
    await page.keyboard.down('KeyZ'); await page.waitForTimeout(120); await page.keyboard.up('KeyZ');
    campaign = await readCampaign(page);
    if (campaign.armed === 1) break;
  }
  console.log('mission reached:', JSON.stringify(campaign));
  if (campaign?.armed !== 1) note('did not reach an armed mission');

  // Save through the pause sheet.
  const clickDom = (id) => page.evaluate((elementId) => document.getElementById(elementId).click(), id);
  await clickDom('game-menu');
  await page.waitForFunction(() => !document.getElementById('game-sheet').classList.contains('hidden'), null, { timeout: 5000 });
  await clickDom('game-save');
  await page.waitForFunction(() => /Сохранено/.test(document.getElementById('game-sheet-status').textContent), null, { timeout: 10000 });
  const savedStatus = await page.textContent('#game-sheet-status');
  console.log('saved:', savedStatus);
  const savedCampaign = await readCampaign(page);
  await page.screenshot({ path: path.join(OUT, '01-saved.png') });

  // Reload the whole page: the ROM file is gone, so pick it again and rebuild
  // from the OPFS cache; then Continue must restore the mission.
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__SPIKE_READY__ === true, null, { timeout: 60000 });
  await page.setInputFiles('#rom-input', ROM);
  await page.waitForFunction(() => window.__BUILD_RESULTS?.length > 0, null, { timeout: TIMEOUT, polling: 1000 });
  const build = await page.evaluate(() => window.__BUILD_RESULTS?.[0] ?? null);
  console.log('rebuild after reload:', JSON.stringify({ ok: build?.ok, cached: build?.cached }));
  const playLabel = await page.textContent('#play');
  console.log('play label:', JSON.stringify(playLabel.replace(/\s+/g, ' ').trim()));
  if (!/Продолжить/.test(playLabel)) note(`Continue is not offered after reload: "${playLabel.trim()}"`);
  await page.screenshot({ path: path.join(OUT, '02-ready-continue.png') });

  await page.click('#play');
  await page.waitForFunction(() => window.__DUNE_HOST != null, null, { timeout: 120000 });
  await page.waitForFunction(() => (window.__DUNE_HOST.metrics?.renderedFrames ?? 0) >= 3, null, { timeout: 120000, polling: 250 });
  await page.waitForTimeout(900);
  const restored = await readCampaign(page);
  console.log('restored campaign:', JSON.stringify(restored));
  if (restored?.armed !== 1) note('Continue did not restore an armed mission');
  if (savedCampaign?.mission !== restored?.mission) note(`mission changed: ${savedCampaign?.mission} -> ${restored?.mission}`);
  if (savedCampaign?.house !== restored?.house) note(`house changed: ${savedCampaign?.house} -> ${restored?.house}`);

  // Mission map and HUD must work after the restore.
  const box = await page.locator('#game-canvas').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(700);
  const hudVisible = await page.evaluate(() => document.getElementById('game-hud').hidden === false);
  console.log('HUD after restore:', hudVisible);
  if (!hudVisible) note('HUD did not appear after restoring the mission');
  const cameraBefore = await page.evaluate(() => window.__DUNE_HOST.cameraDebug());
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  for (let step = 1; step <= 6; step += 1) {
    await page.mouse.move(box.x + box.width / 2 - step * 10, box.y + box.height / 2, { steps: 1 });
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await page.waitForTimeout(500);
  const cameraAfter = await page.evaluate(() => window.__DUNE_HOST.cameraDebug());
  if (cameraBefore?.cameraX === cameraAfter?.cameraX) note('camera does not pan after Continue');
  await page.screenshot({ path: path.join(OUT, '03-restored.png') });

  const report = { ok: problems.length === 0, problems, savedCampaign, restored };
  fs.writeFileSync(path.join(OUT, 'continue.json'), JSON.stringify(report, null, 2));
  console.log(problems.length === 0 ? 'CONTINUE OK' : 'CONTINUE FAILED');
} catch (error) {
  console.error('CONTINUE FAILED', String(error));
  process.exitCode = 1;
} finally {
  await browser.close();
  server?.kill('SIGKILL');
}
if (problems.length) process.exitCode = 1;
