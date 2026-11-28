// Legacy BYOP end-to-end test: ROM picker -> in-browser recompile -> runtime.wasm
// -> legacy `web/legacy/` frontend (home -> house -> mission -> briefing -> map),
// in-game pause, legacy save/load (F5/F8) and "return to main menu" (which uses
// the on-device generated `frontend.state.bin` fixture).
//
//   DUNE_ROM="/path/to/Dune (USA).gen" node tests/browser/legacy-smoke.mjs
//
// Env:
//   LEGACY_PORT   local server port (default 4550)
//   LEGACY_URL    use an already running URL instead of spawning tools/serve.py
//   SEED=1        dev shortcut: pre-seed the worker's OPFS core cache from
//                 .local/wasm-full/game.wasm instead of running Pyodide
//   CHROME_PATH   system Chrome binary
//
// Screenshots go to test-results/legacy/ and a JSON report next to them.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.LEGACY_PORT || 4550);
const LIVE_URL = process.env.LEGACY_URL || null;
const URL = LIVE_URL || `http://127.0.0.1:${PORT}/`;
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROM = process.env.DUNE_ROM || '/Users/oleskarpov/Downloads/Dune - The Battle for Arrakis (USA).gen';
const SEED = process.env.SEED === '1';
const OUT = path.join(ROOT, 'test-results', 'legacy');
const TIMEOUT = 25 * 60 * 1000;
const KNOWN_ROM_SHA = 'b1bbe73186e0902fa8b2db0f227bf306e3d6a80fe592f927d1aa9d60c0f335ba';

if (!fs.existsSync(ROM)) {
  console.log('legacy test SKIPPED: set DUNE_ROM=/path/to/Dune-USA.gen');
  process.exit(0);
}
fs.mkdirSync(OUT, { recursive: true });
const PREFIX = URL.replace(/^https?:\/\/[^/]+/, '').includes('/legacy/') ? 'web/legacy/' : 'web/';
for (const required of [`${PREFIX}index.html`, `${PREFIX}byop-boot.mjs`, `${PREFIX}shell.js`, 'web/recompiler.worker.js', 'web/reference.json', 'web/runtime/runtime.wasm', 'web/host/host.mjs']) {
  if (!fs.existsSync(path.join(ROOT, required))) {
    console.error(`missing ${required}`);
    process.exit(1);
  }
}

const problems = [];
const note = (message) => { problems.push(message); console.log(`LEGACY PROBLEM: ${message}`); };
const screenshots = [];
const shot = async (page, name) => {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file });
  screenshots.push(name);
  return file;
};

const server = LIVE_URL ? null : spawn('/usr/bin/python3', [path.join(ROOT, 'tools/serve.py'), '--port', String(PORT)], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'],
});

async function waitForServer() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { if ((await fetch(URL, { cache: 'no-store' })).ok) return; } catch { /* wait */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start on ${URL}`);
}

const campaign = (page) => page.evaluate(() => {
  const host = window.__DUNE_HOST;
  if (!host) return null;
  const pointer = host.exports.dune_web_campaign_json();
  const bytes = new Uint8Array(host.memory.buffer, pointer);
  let end = 0;
  while (end < bytes.length && bytes[end]) end += 1;
  return JSON.parse(new TextDecoder().decode(bytes.subarray(0, end)));
});

const camera = (page) => page.evaluate(() => window.__DUNE_HOST?.cameraDebug() ?? null);

const visibleButtonIds = (page) => page.evaluate(() => [...document.querySelectorAll('#scene-ui button')]
  .filter((button) => button.offsetParent !== null)
  .map((button) => button.id)
  .filter(Boolean));

const hostSnapshot = (page) => page.evaluate(() => {
  const host = window.__DUNE_HOST;
  const canvas = document.getElementById('canvas');
  const expanded = host?.expandedFrame?.();
  return {
    scene: (() => {
      try {
        const pointer = host.exports.dune_web_campaign_json();
        const bytes = new Uint8Array(host.memory.buffer, pointer);
        let end = 0;
        while (end < bytes.length && bytes[end]) end += 1;
        return JSON.parse(new TextDecoder().decode(bytes.subarray(0, end))).scene;
      } catch { return null; }
    })(),
    fault: host?.metrics?.fault ?? null,
    instructions: host?.metrics?.instructions ?? 0,
    frames: host?.metrics?.renderedFrames ?? 0,
    canvas: canvas ? { width: canvas.width, height: canvas.height, rect: canvas.getBoundingClientRect().toJSON() } : null,
    expanded: expanded ? { width: expanded.width, height: expanded.height } : null,
    presentation: host?.presentation ?? null,
    fixture: window.__BYOP_FIXTURE__ || null,
    ui: window.__DUNE_UI__ ? {
      view: window.__DUNE_UI__.view,
      displayed: window.__DUNE_UI__.displayed,
      stateScene: window.__DUNE_UI__.state?.scene,
      pending: window.__DUNE_UI__.pendingScreen?.kind ?? null,
    } : null,
    audio: host?.audio ? { enabled: !!host.audio.enabled, frames: host.audio.stats?.().frames ?? 0 } : null,
  };
});

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
try {
  if (!LIVE_URL) await waitForServer();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ru-RU',
  });
  const page = await context.newPage();
  const errors = [];
  const httpErrors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text()); });
  page.on('response', (response) => { if (response.status() >= 400) httpErrors.push(`${response.status()} ${response.url()}`); });
  const t0 = Date.now();
  await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__BYOP_STATUS__ != null, null, { timeout: 30000 });
  await page.waitForTimeout(600);
  await shot(page, '01-boot.png');
  const boot = await page.evaluate(() => ({
    overlay: !document.getElementById('byop-launch')?.hidden,
    logo: (() => { const image = document.querySelector('#byop-launch .byop-logo'); return image ? { complete: image.complete, width: image.naturalWidth } : null; })(),
    status: window.__BYOP_STATUS__,
  }));
  if (!boot.overlay) note('BYOP ROM picker is not visible on first load');
  if (!boot.logo?.complete || boot.logo.width < 1) note('title-logo.png did not load on the BYOP screen');

  if (SEED) {
    const gameUrl = path.join(ROOT, '.local/wasm-full/game.wasm');
    if (!fs.existsSync(gameUrl)) throw new Error('SEED=1 needs .local/wasm-full/game.wasm');
    const game = fs.readFileSync(gameUrl);
    const reference = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/reference.json'), 'utf8'));
    const meta = {
      rom_sha256: KNOWN_ROM_SHA, abi_hash: reference.abi_hash, recompiler: reference.recompiler,
      game_sha256: reference.expected_game_sha256, game_bytes: reference.expected_game_bytes,
      matches_shipped_core: true, built_at: new Date().toISOString(),
    };
    await page.evaluate(async ({ b64, romSha, meta }) => {
      const bytes = Uint8Array.from(atob(b64), (char) => char.charCodeAt(0));
      const root = await navigator.storage.getDirectory();
      const rootDir = await root.getDirectoryHandle('dune-web', { create: true });
      const dir = await rootDir.getDirectoryHandle(`rom-${romSha}`, { create: true });
      for (const [name, data] of [['game.wasm', bytes], ['meta.json', new TextEncoder().encode(JSON.stringify(meta))]]) {
        const handle = await dir.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        await writable.write(data);
        await writable.close();
      }
    }, { b64: game.toString('base64'), romSha: KNOWN_ROM_SHA, meta });
    console.log('SEED=1: pre-seeded the OPFS core cache (Pyodide build skipped)');
  }

  await page.setInputFiles('#byop-rom', ROM);
  await page.waitForFunction(() => window.__BYOP_READY__ === true || window.__BYOP_ERROR__, null, { timeout: TIMEOUT, polling: 500 });
  const buildSeconds = (Date.now() - t0) / 1000;
  const byop = await page.evaluate(() => ({
    status: window.__BYOP_STATUS__, error: window.__BYOP_ERROR__ || null,
    fixture: window.__BYOP_FIXTURE__ || null, sha: window.duneByop?.gameSha || null,
  }));
  console.log('boot:', JSON.stringify({ buildSeconds: Number(buildSeconds.toFixed(1)), ...byop }));
  if (byop.error) throw new Error(byop.error);
  if (console) { /* noop */ }

  await page.waitForTimeout(2500);
  await shot(page, '02-menu.png');
  let status = await hostSnapshot(page);
  console.log('menu:', JSON.stringify(status));
  if (!status.ui) note('legacy GameInterface was not created (window.__DUNE_UI__ missing)');
  if (status.scene !== 'main') note(`expected the original main menu, got scene=${status.scene}`);
  let ids = await visibleButtonIds(page);
  const homeButtons = ids.slice();
  console.log('home buttons:', JSON.stringify(homeButtons));
  if (!ids.includes('new-campaign') || !ids.includes('open-options')) note('home screen is missing NEW CAMPAIGN/OPTIONS');
  if (!(status.frames > 30)) note('native frames are not advancing');

  // ---------- house / mission selection ----------
  await page.locator('#new-campaign').click({ force: true });
  await page.waitForTimeout(1200);
  await shot(page, '03-houses.png');
  ids = await visibleButtonIds(page);
  if (!ids.includes('house-1')) note('CHOOSE YOUR HOUSE is missing the ATREIDES card');
  await page.locator('#house-1').click({ force: true });
  await page.waitForTimeout(1000);
  await shot(page, '04-missions.png');
  ids = await visibleButtonIds(page);
  if (!ids.includes('mission-1')) note('mission grid is missing mission 1');
  await page.locator('#mission-1').click({ force: true });
  await page.waitForTimeout(900);
  await shot(page, '05-confirm.png');
  const confirmVisible = await page.locator('#native-confirmation').isVisible().catch(() => false);
  if (!confirmVisible) note('START MISSION confirmation did not open');
  await page.locator('#native-confirmation button[aria-label="START"]').click({ force: true });

  // ---------- native briefings -> interactive mission map ----------
  let reachedMap = false;
  let sawBriefing = false;
  for (let step = 0; step < 110; step += 1) {
    const state = await page.evaluate(() => {
      const host = window.__DUNE_HOST;
      const pointer = host.exports.dune_web_campaign_json();
      const bytes = new Uint8Array(host.memory.buffer, pointer);
      let end = 0;
      while (end < bytes.length && bytes[end]) end += 1;
      const campaign = JSON.parse(new TextDecoder().decode(bytes.subarray(0, end)));
      const ids = [...document.querySelectorAll('#scene-ui button')].filter((button) => button.offsetParent !== null).map((button) => button.id).filter(Boolean);
      const camera = host.cameraDebug();
      return { scene: campaign.scene, ready: campaign.sceneReady, phase: campaign.presentationPhase, ids, map: camera?.map ? 1 : 0, cameraX: camera?.cameraX ?? 0, fault: campaign.fault };
    });
    if (state.phase === 'briefing' && !sawBriefing) { sawBriefing = true; await shot(page, '06-briefing.png'); }
    if (state.fault) { note('native fault while advancing the campaign'); break; }
    if (state.map === 1 && state.scene === 'map' && state.ready) { reachedMap = true; break; }
    if (state.ids.includes('native-yes')) await page.locator('#native-yes').click({ force: true });
    else if (state.ids.includes('next-mission')) await page.locator('#next-mission').click({ force: true });
    else {
      const box = await page.locator('#scene-ui').boundingBox();
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.6);
    }
    await page.waitForTimeout(650);
  }
  if (!reachedMap) note('did not reach the interactive mission map');

  await page.waitForTimeout(2000);
  // First pointer gesture: apart from moving the camera it makes the runtime
  // publish the native camera word (path A has no SDL draw loop doing it), so
  // the first map frame is composed with the real camera position.
  const mapBox = await page.evaluate(() => document.getElementById('canvas').getBoundingClientRect().toJSON());
  const nudge = async (dx) => {
    await page.mouse.move(mapBox.x + mapBox.width / 2, mapBox.y + mapBox.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 6; step += 1) {
      await page.mouse.move(mapBox.x + mapBox.width / 2 + dx * step / 6, mapBox.y + mapBox.height / 2, { steps: 1 });
      await page.waitForTimeout(30);
    }
    await page.mouse.up();
    await page.waitForTimeout(600);
  };
  await nudge(6);
  await page.waitForTimeout(700);
  await shot(page, '07-map.png');
  const mapStatus = await hostSnapshot(page);
  const mapCamera = await camera(page);
  console.log('map:', JSON.stringify({ ...mapStatus, camera: mapCamera && { map: mapCamera.map, x: mapCamera.cameraX, y: mapCamera.cameraY, zoom: mapCamera.zoom } }));
  if (!mapCamera?.map) note('camera adapter does not report the mission map');
  if (!mapStatus.expanded) note('expanded mission frame is unavailable');
  else if (mapStatus.canvas.width !== mapStatus.expanded.width) note('canvas is not presenting the expanded mission frame');
  if (!(mapStatus.audio?.enabled)) note('BYOP audio was not enabled (no in-game sound)');
  else if (!(mapStatus.audio.frames > 0)) note('BYOP audio produced no PCM frames');
  const canvasBox = await page.locator('#canvas').boundingBox();

  // ---------- drag the mission camera (legacy touch/mouse code path) ----------
  const beforePan = await camera(page);
  await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(canvasBox.x + canvasBox.width / 2 - step * 9, canvasBox.y + canvasBox.height / 2, { steps: 1 });
    await page.waitForTimeout(35);
  }
  await page.mouse.up();
  await page.waitForTimeout(700);
  const afterPan = await camera(page);
  console.log('pan:', JSON.stringify({ before: beforePan?.cameraX, after: afterPan?.cameraX }));
  if (afterPan?.cameraX === beforePan?.cameraX) note('mission camera did not pan');
  if (!(afterPan?.cameraX > 0)) note('mission camera was not placed at the base after the first gesture');
  await shot(page, '08-map-pan.png');

  // ---------- legacy save (F5) / load (F8) ----------
  await page.keyboard.press('F5');
  await page.waitForTimeout(700);
  const saveSlot = await page.evaluate(() => {
    try { return localStorage.getItem('dune-sega-continue-v2'); } catch { return null; }
  });
  let saveInfo = null;
  if (saveSlot) {
    try {
      const parsed = JSON.parse(saveSlot);
      const state = parsed.state || parsed.payload || parsed.base64 || '';
      saveInfo = { keys: Object.keys(parsed), stateLength: String(state).length, house: parsed.house, mission: parsed.mission };
    } catch { saveInfo = { raw: String(saveSlot).slice(0, 80) }; }
  }
  console.log('save slot:', JSON.stringify(saveInfo));
  if (!saveSlot) note('F5 did not write a legacy CONTINUE save');
  else if (!(saveInfo?.stateLength > 100000)) note('legacy save payload looks too small');
  // Move the camera again, then load the save back.
  await page.evaluate(() => {
    const host = window.__DUNE_HOST;
    host.beginPan?.(195, 400);
    host.panCamera?.(60, 0);
    host.endPan?.();
    host.advanceInstructions?.(200_000);
  });
  await page.waitForTimeout(500);
  const movedCamera = await camera(page);
  await page.keyboard.press('F8');
  await page.waitForTimeout(1500);
  const loadedStatus = await hostSnapshot(page);
  const loadedCamera = await camera(page);
  console.log('load:', JSON.stringify({ moved: movedCamera?.cameraX, loaded: loadedCamera?.cameraX, scene: loadedStatus.scene, fault: loadedStatus.fault }));
  await shot(page, '09-map-after-load.png');
  if (loadedStatus.fault) note('game faulted after loading the legacy save');
  if (loadedStatus.scene !== 'map') note(`legacy save/load did not return to the map (scene=${loadedStatus.scene})`);

  // ---------- pause menu -> MAIN MENU (uses the generated frontend fixture) ----------
  await page.locator('#native-menu').click({ force: true });
  await page.waitForTimeout(1500);
  const pauseStatus = await hostSnapshot(page);
  ids = await visibleButtonIds(page);
  console.log('pause:', JSON.stringify({ scene: pauseStatus.scene, ids }));
  await shot(page, '10-pause.png');
  if (pauseStatus.scene !== 'pause') note(`MENU button did not open the pause screen (scene=${pauseStatus.scene})`);
  if (!ids.includes('main-menu')) note('pause screen is missing MAIN MENU');
  await page.locator('#main-menu').click({ force: true });
  await page.waitForTimeout(600);
  const mainMenuDialog = await page.locator('#native-confirmation button[aria-label="MAIN MENU"]');
  if (await mainMenuDialog.count()) await mainMenuDialog.first().click({ force: true });
  else note('MAIN MENU confirmation did not open');
  let restoredMain = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(400);
    const state = await campaign(page);
    if (state?.scene === 'main' && state.sceneReady === true) { restoredMain = true; break; }
  }
  const fixtureStatus = await hostSnapshot(page);
  console.log('return to main:', JSON.stringify({ restoredMain, scene: fixtureStatus.scene, fixture: fixtureStatus.fixture, homeButtons: await visibleButtonIds(page) }));
  await shot(page, '11-main-menu-return.png');
  if (!restoredMain) note('could not return to the original main menu through the generated frontend.state.bin fixture');
  if (fixtureStatus.fixture !== 'generated') note(`expected the on-device fixture, got ${fixtureStatus.fixture}`);

  // ---------- reload: cached core + cached fixture ----------
  const reloadStart = Date.now();
  await page.reload({ waitUntil: 'load' });
  await page.setInputFiles('#byop-rom', ROM);
  await page.waitForFunction(() => window.__BYOP_READY__ === true || window.__BYOP_ERROR__, null, { timeout: TIMEOUT, polling: 400 });
  const reloadSeconds = (Date.now() - reloadStart) / 1000;
  await page.waitForTimeout(1200);
  const reloadStatus = await hostSnapshot(page);
  console.log('reload:', JSON.stringify({ reloadSeconds: Number(reloadSeconds.toFixed(1)), scene: reloadStatus.scene, fixture: reloadStatus.fixture }));
  await shot(page, '12-reload-menu.png');
  if (reloadStatus.scene !== 'main') note(`reload did not land on the main menu (scene=${reloadStatus.scene})`);
  if (reloadStatus.fixture !== 'cached') note(`reload did not reuse the generated fixture (${reloadStatus.fixture})`);
  if (!(reloadSeconds < buildSeconds)) note(`reload (${reloadSeconds}s) was not faster than the first build (${buildSeconds}s)`);

  const report = {
    url: URL,
    rom: path.basename(ROM),
    seed: SEED,
    buildSeconds: Number(buildSeconds.toFixed(1)),
    reloadSeconds: Number(reloadSeconds.toFixed(1)),
    gameSha256: byop.sha,
    bootScreen: boot,
    menu: { scene: status.scene, buttons: homeButtons },
    map: { scene: mapStatus.scene, camera: mapCamera && { x: mapCamera.cameraX, y: mapCamera.cameraY, zoom: mapCamera.zoom, worldWidth: mapCamera.worldWidth, worldHeight: mapCamera.worldHeight }, afterPan: afterPan && { x: afterPan.cameraX, y: afterPan.cameraY }, canvas: mapStatus.canvas, expanded: mapStatus.expanded },
    save: saveInfo,
    audio: mapStatus.audio,
    returnToMainMenu: { ok: restoredMain, fixture: fixtureStatus.fixture },
    reload: { scene: reloadStatus.scene, fixture: reloadStatus.fixture },
    httpErrors,
    errors,
    problems,
    screenshots,
  };
  fs.writeFileSync(path.join(OUT, 'legacy.json'), JSON.stringify(report, null, 2) + '\n');
  if (errors.length) note(`console errors: ${errors.slice(0, 3).join(' | ')}`);
  console.log(JSON.stringify({ problems, httpErrors, errors: errors.slice(0, 5) }, null, 2));
  console.log(problems.length ? 'LEGACY FAILED' : 'LEGACY OK');
  process.exitCode = problems.length ? 1 : 0;
} catch (error) {
  console.error('LEGACY FAILED', error);
  fs.writeFileSync(path.join(OUT, 'legacy.json'), JSON.stringify({ fatal: String(error), problems }, null, 2) + '\n');
  process.exitCode = 1;
} finally {
  await browser.close();
  if (server) server.kill('SIGKILL');
}
