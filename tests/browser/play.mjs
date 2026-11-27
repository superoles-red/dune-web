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

  const pressA = async (label) => {
    await page.keyboard.down('KeyZ');
    await page.waitForTimeout(120);
    await page.keyboard.up('KeyZ');
    await page.waitForTimeout(450);
    if (label) await page.screenshot({ path: path.join(OUT, label) });
  };
  stats = await frameStats(page);
  console.log('menu frame:', JSON.stringify(stats));

  // The shell fast-forwards to the house select. Confirm the house, the
  // prologue question and the mission briefings by pressing A; the map appears
  // after roughly twenty confirmations. Advance the emulator between presses so
  // the test does not wait for real time.
  await page.screenshot({ path: path.join(OUT, '02-house.png') });
  let reachedMission = false;
  for (let i = 1; i <= 32; i += 1) {
    await pressA(i === 4 ? '03-prologue.png' : i === 12 ? '04-briefing.png' : null);
    await page.evaluate(() => window.__DUNE_HOST.advanceInstructions(1_600_000));
    await page.waitForTimeout(120);
    const state = await page.evaluate(() => {
      const host = window.__DUNE_HOST;
      const memory = host.memory;
      const bytes = new Uint8Array(memory.buffer, host.exports.dune_web_campaign_json());
      let end = 0;
      while (end < bytes.length && bytes[end] !== 0) end += 1;
      const json = JSON.parse(new TextDecoder().decode(bytes.subarray(0, end)));
      return { scene: json.scene, armed: json.activeRunArmed };
    });
    if (state.armed === 1) {
      reachedMission = true;
      break;
    }
  }
  if (!reachedMission) note('did not reach an armed mission through the menu');
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, '05-map.png') });
  stats = await frameStats(page);
  console.log('map frame:', JSON.stringify(stats));
  const audio = await page.evaluate(() => {
    const host = window.__DUNE_HOST;
    return {
      enabled: !!host.audio?.enabled,
      supported: !!host.audio?.supported,
      stats: host.audio?.stats?.() ?? null,
    };
  });
  console.log('audio:', JSON.stringify({ enabled: audio.enabled, supported: audio.supported, frames: audio.stats?.frames, peak: audio.stats?.peak, rms: audio.stats?.rms, sampleRate: audio.stats?.sampleRate }));
  if (!audio.enabled) note('audio was not enabled by the play button');
  if (audio.enabled && !(audio.stats?.frames > 0)) note('audio pipeline produced no frames');
  if (!(stats.canvasNonBlack > 5000)) note('mission map frame looks blank');

  // In-game HUD: selecting an own building exposes the original context action
  // (REPEAT here) and CLEAR; pressing it must reach the native B handler.
  const hudBox = await page.locator('#game-canvas').boundingBox();
  await page.mouse.click(hudBox.x + hudBox.width / 2, hudBox.y + hudBox.height / 2);
  await page.waitForTimeout(700);
  const hud = await page.evaluate(() => {
    const host = window.__DUNE_HOST;
    const read = (name) => { const p = host.call(name); const b = new Uint8Array(host.memory.buffer, p); let e = 0; while (e < b.length && b[e]) e += 1; return JSON.parse(new TextDecoder().decode(b.subarray(0, e))); };
    const actions = read('dune_web_actions_debug');
    return {
      hidden: document.getElementById('game-hud').hidden,
      label: document.getElementById('hud-b').textContent,
      bHidden: document.getElementById('hud-b').hidden,
      selected: actions.selected?.kind,
      bKind: actions.bKind,
      nativeBCount: actions.nativeBCount,
    };
  });
  console.log('hud:', JSON.stringify(hud));
  await page.screenshot({ path: path.join(OUT, '05a-hud.png') });
  if (hud.hidden || hud.bHidden) note('context HUD buttons did not appear for a selected building');
  if (!hud.bKind || hud.label !== 'REPEAT') note(`unexpected HUD action label: ${hud.label}/${hud.bKind}`);
  await page.evaluate(() => document.getElementById('hud-b').click());
  await page.waitForTimeout(500);
  const hudAfter = await page.evaluate(() => {
    const host = window.__DUNE_HOST;
    const p = host.call('dune_web_actions_debug'); const b = new Uint8Array(host.memory.buffer, p); let e = 0; while (e < b.length && b[e]) e += 1;
    const a = JSON.parse(new TextDecoder().decode(b.subarray(0, e)));
    return { nativeBCount: a.nativeBCount, selected: a.selected?.kind };
  });
  console.log('hud after REPEAT:', JSON.stringify(hudAfter));
  if (!(hudAfter.nativeBCount > hud.nativeBCount)) note('HUD action did not reach the native B handler');
  await page.evaluate(() => document.getElementById('hud-clear').click());
  await page.waitForTimeout(400);
  const hudCleared = await page.evaluate(() => document.getElementById('game-hud').hidden);
  if (!hudCleared) note('CLEAR did not hide the context HUD');

  // Building menu: a double tap on an own building opens the native console
  // (EXIT/FIX/STOP + purchase grid). The overlay routes taps into
  // building_ui_tap(col,row); EXIT closes it.
  const menuVisible = () => page.evaluate(() => document.getElementById('building-cells').hidden === false);
  const tryOpenMenu = async (label, action) => {
    await action();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await page.waitForTimeout(250);
      if (await menuVisible()) return label;
    }
    return null;
  };
  let openedBy = await tryOpenMenu('dblclick', () => page.mouse.dblclick(hudBox.x + hudBox.width / 2, hudBox.y + hudBox.height / 2, { delay: 90 }));
  if (!openedBy) {
    openedBy = await tryOpenMenu('select+dblclick', async () => {
      await page.mouse.click(hudBox.x + hudBox.width / 2, hudBox.y + hudBox.height / 2);
      await page.waitForTimeout(600);
      await page.mouse.dblclick(hudBox.x + hudBox.width / 2, hudBox.y + hudBox.height / 2, { delay: 90 });
    });
  }
  if (!openedBy) {
    openedBy = await tryOpenMenu('native taps', async () => {
      await page.evaluate(() => {
        const host = window.__DUNE_HOST;
        host.tapScreen(160, 346);
        host.advanceInstructions(700_000);
        host.tapScreen(160, 346);
        host.advanceInstructions(700_000);
      });
    });
  }
  console.log('building menu opened by:', openedBy);
  if (!openedBy) note('building menu did not open after a double tap');
  const building = await page.evaluate(() => {
    const h = window.__DUNE_HOST;
    const ui = h.buildingUi?.();
    return {
      active: !!ui?.active,
      rows: ui?.rows,
      buttons: document.querySelectorAll('#building-cells button').length,
      canvas: [document.getElementById('game-canvas').width, document.getElementById('game-canvas').height],
      exitIndex: Array.isArray(ui?.cells) ? ui.cells.findIndex((cell) => cell.key === 'exit') : -1,
      selectedIndex: ui?.selectedIndex,
    };
  });
  console.log('building menu:', JSON.stringify(building));
  await page.screenshot({ path: path.join(OUT, '05d-building.png') });
  if (!building.active) note('building_ui_json is not active after the menu tap');
  if (building.buttons !== (building.rows || 0) * 3) note(`building grid buttons ${building.buttons} != rows*3`);
  if (building.canvas[0] !== 320 || building.canvas[1] !== 224) note('building menu canvas is not 320x224');
  if (building.buttons > 1) {
    await page.locator('#building-cells button').nth(1).click();
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => window.__DUNE_HOST.buildingUi?.() ?? null);
    console.log('building menu after cell:', JSON.stringify({ selectedIndex: after?.selectedIndex, active: after?.active }));
  }
  if (building.exitIndex >= 0) {
    await page.locator('#building-cells button').nth(building.exitIndex).click();
    const menuClosed = await page.waitForFunction(
      () => document.getElementById('building-cells').hidden === true,
      null, { timeout: 15000 },
    ).then(() => true).catch(() => false);
    if (!menuClosed) note('building menu did not close through the EXIT cell');
    await page.waitForTimeout(700);
  }

  // Orientation: the map must reframe itself like the old port — portrait fills
  // the screen vertically, landscape horizontally. Then go back to portrait.
  const portraitBox = await page.locator('#game-canvas').boundingBox();
  console.log('portrait canvas:', JSON.stringify({ w: Math.round(portraitBox.width), h: Math.round(portraitBox.height), vw: 390, vh: 844 }));
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, '05b-landscape.png') });
  const landscape = await page.evaluate(() => {
    const canvas = document.getElementById('game-canvas');
    const rect = canvas.getBoundingClientRect();
    return { w: Math.round(rect.width), h: Math.round(rect.height), win: { w: window.innerWidth, h: window.innerHeight }, camera: window.__DUNE_HOST.cameraDebug() };
  });
  console.log('landscape canvas:', JSON.stringify(landscape));
  if (landscape.w < landscape.win.w * 0.9 && landscape.h < landscape.win.h * 0.9) note('landscape map does not fill the viewport');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(700);
  const portraitAfter = await page.evaluate(() => {
    const rect = document.getElementById('game-canvas').getBoundingClientRect();
    return { w: Math.round(rect.width), h: Math.round(rect.height) };
  });
  if (portraitAfter.h < 844 * 0.9 && portraitAfter.w < 390 * 0.9) note('portrait map does not fill the viewport');

  // Touch/mouse camera: drag pans, wheel zooms, click selects; the expanded
  // mission overview must visibly change.
  const box = await page.locator('#game-canvas').boundingBox();
  const cameraBefore = await page.evaluate(() => window.__DUNE_HOST.cameraDebug());
  const dragOnce = async () => {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(box.x + box.width / 2 - step * 8, box.y + box.height / 2, { steps: 1 });
      await page.waitForTimeout(30);
    }
    await page.mouse.up();
    await page.waitForTimeout(500);
  };
  await dragOnce();
  let cameraAfterPan = await page.evaluate(() => window.__DUNE_HOST.cameraDebug());
  if (cameraAfterPan?.cameraX === cameraBefore?.cameraX) {
    console.log('pan retry');
    await dragOnce();
    cameraAfterPan = await page.evaluate(() => window.__DUNE_HOST.cameraDebug());
  }
  await page.screenshot({ path: path.join(OUT, '06-pan.png') });
  console.log('camera pan:', JSON.stringify({ before: cameraBefore?.cameraX, after: cameraAfterPan?.cameraX, input: await page.evaluate(() => window.__DUNE_INPUT ?? null) }));
  if (cameraAfterPan?.cameraX === cameraBefore?.cameraX) note('camera did not pan after a drag');

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 240);
  await page.waitForTimeout(500);
  let cameraAfterZoom = await page.evaluate(() => window.__DUNE_HOST.cameraDebug());
  if (cameraAfterZoom?.zoom === cameraAfterPan?.zoom) {
    await page.evaluate(() => { window.__DUNE_HOST.zoomCamera(0.8, 160, 346); window.__DUNE_HOST.refreshPresentation(); });
    await page.waitForTimeout(300);
    cameraAfterZoom = await page.evaluate(() => window.__DUNE_HOST.cameraDebug());
  }
  await page.screenshot({ path: path.join(OUT, '07-zoom.png') });
  console.log('camera zoom:', JSON.stringify({ before: cameraAfterPan?.zoom, after: cameraAfterZoom?.zoom }));
  if (cameraAfterZoom?.zoom === cameraAfterPan?.zoom) note('camera did not zoom after the wheel');

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '08-tap.png') });

  // In-game menu: save the mission, advance, load it back.
  const clickDom = (id) => page.evaluate((elementId) => document.getElementById(elementId).click(), id);
  const openGameSheet = async () => {
    await clickDom('game-menu');
    await page.waitForFunction(
      () => !document.getElementById('game-sheet').classList.contains('hidden'),
      null, { timeout: 5000 },
    );
    await page.waitForTimeout(250);
  };
  await openGameSheet();
  await clickDom('game-save');
  await page.waitForTimeout(400);
  const saveStatus = await page.textContent('#game-sheet-status');
  console.log('save status:', saveStatus);
  await clickDom('game-sheet-close');
  // Change the camera after saving, then load the saved state back.
  const before = await page.evaluate(() => window.__DUNE_HOST.cameraDebug());
  await page.evaluate(() => {
    const host = window.__DUNE_HOST;
    host.beginPan(160, 112);
    host.panCamera(20, 0);
    host.endPan();
  });
  await page.waitForTimeout(400);
  const changed = await page.evaluate(() => window.__DUNE_HOST.cameraDebug());
  await openGameSheet();
  await page.evaluate(() => document.getElementById('game-load').click());
  await page.waitForTimeout(600);
  const loadStatus = await page.textContent('#game-sheet-status');
  await page.screenshot({ path: path.join(OUT, '09-after-load.png') });
  const afterLoad = await page.evaluate(() => {
    const host = window.__DUNE_HOST;
    host.advanceInstructions(400_000);
    return {
      instructions: host.metrics.instructions,
      fault: host.metrics.fault,
      frames: host.metrics.renderedFrames,
      status: document.getElementById('game-sheet-status').textContent,
    };
  });
  console.log('save/load:', JSON.stringify({ changed: changed?.cameraX, before: before?.cameraX, afterLoad, loadStatus }));
  if (changed?.cameraX === before?.cameraX) note('camera did not change after the save');
  if (!/Сохранение загружено/.test(loadStatus)) note(`load status: ${loadStatus}`);
  if (afterLoad.fault) note('game faulted after loading the save');
  if (!(afterLoad.instructions > 0)) note('game did not advance after loading the save');

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
