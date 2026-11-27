// Browser end-to-end test for the Dune WASM host (path A).
//
// Proves, in headless Chrome, the full chain the parent UI will use:
//   runtime.wasm (standalone, JS import mocks)
//     + generated full game.wasm (all 48 pages, single funcref dispatcher)
//     + the player's ROM (BYOP: never committed)
//   -> dune_rt_init() -> ROM into dune_rt_rom_buffer() -> dune_rt_set_game_table()
//   -> dune_rt_machine_step() loop -> dune_web_frame_rgb() -> canvas pixels.
//
// Asserts that real, distinct frames are produced (SEGA logo -> publisher logos
// -> DUNE title -> in-game main menu after a programmatic Start press) and that
// dune_save_state_to_buffer()/dune_load_state_from_buffer() round-trip.
//
// Run:
//   DUNE_ROM="/path/to/Dune - The Battle for Arrakis (USA).gen" node tests/host/play.test.mjs
//
// Without a ROM the test is skipped (external game data is never committed).
// The game.wasm module is taken from (in order): $HOST_GAME,
// .local/wasm-full/game.wasm (full-module agent), .local/host-build/game.wasm
// (built by tools/host/build_game_module.py). If none exists, the builder runs.
//
// Screenshots and a JSON report go to test-results/host/ (gitignored).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RESULT_DIR = path.join(ROOT, 'test-results', 'host');
const LOCAL_BUILD = path.join(ROOT, '.local', 'host-build', 'game.wasm');
const FULL_MODULE = path.join(ROOT, '.local', 'wasm-full', 'game.wasm');
const DEFAULT_ROM = '/Users/oleskarpov/Downloads/Dune - The Battle for Arrakis (USA).gen';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function findPython() {
  const candidates = [
    process.env.PYTHON,
    path.join(process.env.HOME || '', '.local/bin/python3.12'),
    '/opt/homebrew/bin/python3.12',
    'python3.12',
    'python3.13',
    'python3',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info >= (3, 10))'], {
      encoding: 'utf8',
    });
    if (result.status === 0 && result.stdout.trim() === 'True') return candidate;
  }
  return null;
}

function resolveRom() {
  const candidate = process.env.DUNE_ROM || DEFAULT_ROM;
  if (!candidate || !existsSync(candidate)) return null;
  return path.resolve(candidate);
}

function resolveGameModule(rom) {
  if (process.env.HOST_GAME) {
    if (!existsSync(process.env.HOST_GAME)) throw new Error(`HOST_GAME not found: ${process.env.HOST_GAME}`);
    return { path: path.resolve(process.env.HOST_GAME), built: false };
  }
  if (existsSync(FULL_MODULE)) return { path: FULL_MODULE, built: false };
  if (existsSync(LOCAL_BUILD)) return { path: LOCAL_BUILD, built: false };
  // Build it from the ROM (emitter tools are read-only imports).
  const python = findPython();
  if (!python) throw new Error('no Python 3.10+ found to build game.wasm (set PYTHON=…)');
  const out = LOCAL_BUILD;
  const result = spawnSync(
    python,
    [path.join(ROOT, 'tools/host/build_game_module.py'), '--rom', rom, '--out', out, '--json'],
    { encoding: 'utf8', cwd: ROOT, timeout: 15 * 60 * 1000 },
  );
  if (result.status !== 0 || !existsSync(out)) {
    throw new Error(
      `game.wasm build failed (exit ${result.status}):\n${result.stderr || result.stdout || ''}`.slice(0, 4000),
    );
  }
  let summary = null;
  try {
    summary = JSON.parse(result.stdout);
  } catch {
    /* the builder's stdout is informational; the artifact is what matters */
  }
  return { path: out, built: true, summary };
}

async function startServer(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'tools/host/serve.mjs'), '--port', String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode != null) throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${base}/web/host/play.html`, { cache: 'no-store' });
      if (response.ok) return { child, base };
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill('SIGKILL');
  throw new Error(`server did not start on ${base}`);
}

function decodePng(dataUrl) {
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

const rom = resolveRom();
if (!rom) {
  test('browser host plays real Dune frames', { skip: 'set DUNE_ROM=/path/to/Dune-USA.gen (ROM is never committed)' }, () => {});
} else if (!existsSync(CHROME)) {
  test('browser host plays real Dune frames', { skip: `Chrome not found: ${CHROME}` }, () => {});
} else {
  test('browser host plays real Dune frames', async (t) => {
    mkdirSync(RESULT_DIR, { recursive: true });
    const game = resolveGameModule(rom);
    const moduleRelative = '/' + path.relative(ROOT, game.path).split(path.sep).join('/');
    const romBytes = readFileSync(rom);
    const port = 4400 + Math.floor(Math.random() * 400);
    const { child, base } = await startServer(port);
    const logs = [];
    let browser = null;
    try {
      browser = await chromium.launch({
        executablePath: CHROME,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
      });
      const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
      page.on('console', (message) => logs.push(`[console.${message.type()}] ${message.text()}`));
      page.on('pageerror', (error) => logs.push(`[pageerror] ${error.message}`));

      const pageUrl = `${base}/web/host/play.html?game=${encodeURIComponent(moduleRelative)}`;
      const navigateStart = Date.now();
      await page.goto(pageUrl, { waitUntil: 'load', timeout: 60_000 });

      // runtime.wasm + game.wasm must be linked before the ROM is selected
      await page.waitForFunction(
        () => window.__HOST && window.__HOST.game && window.__HOST.metrics.gameBytes > 0,
        null,
        { timeout: 120_000, polling: 100 },
      );
      const loadMetrics = await page.evaluate(() => window.__HOST.snapshot());
      const loadMs = Date.now() - navigateStart;

      await page.setInputFiles('#rom-input', rom);
      await page.click('#load');
      await page.waitForFunction(() => window.__HOST && window.__HOST.booted === true, null, {
        timeout: 60_000,
        polling: 100,
      });
      const bootMetrics = await page.evaluate(() => window.__HOST.snapshot());

      // Deterministic drive: absolute CPU instruction counts from the real ROM.
      const drive = await page.evaluate(async () => {
        const h = window.__HOST;
        const frames = {};
        const capture = (tag) => {
          h.drawFrame();
          const stats = h.frameStats();
          frames[tag] = {
            stats,
            png: h.canvasDataUrl(),
            metrics: {
              instructions: h.metrics.instructions,
              renderedFrames: h.metrics.renderedFrames,
              emulatedSeconds: h.metrics.emulatedSeconds,
              stepsPerSecond: h.metrics.stepsPerSecond,
              lastRunMs: h.metrics.lastRunMs,
            },
          };
          return frames[tag];
        };
        const t0 = performance.now();
        h.waitForFirstFrame({ maxSteps: 8_000_000 });
        h.advanceToInstructions(2_000_000); // SEGA logo is up around here
        capture('01-sega');
        h.advanceToInstructions(8_000_000);
        capture('02-logos');
        h.advanceToInstructions(24_000_000);
        capture('03-title');
        const titleHash = frames['03-title'].stats.hash;
        // Programmatic Start press (pad path works without an SDL window).
        h.pressStart({ holdSteps: 150_000 });
        h.advanceToInstructions(h.metrics.instructions + 5_000_000);
        capture('04-menu');
        // Save/load round-trip through the shipped exports.
        const saved = h.saveState();
        const savedInstructions = h.metrics.instructions;
        h.advanceToInstructions(h.metrics.instructions + 2_000_000);
        const advancedInstructions = h.metrics.instructions;
        const loaded = h.loadState(saved);
        const restoredInstructions = h.metrics.instructions;
        capture('05-restored');
        return {
          frames,
          titleHash,
          save: {
            bytes: saved.byteLength,
            savedInstructions,
            advancedInstructions,
            loaded,
            restoredInstructions,
          },
          totalMs: performance.now() - t0,
          metrics: h.snapshot(),
        };
      });
      await page.screenshot({ path: path.join(RESULT_DIR, 'page-menu.png'), fullPage: true });
      await page.locator('#screen').screenshot({ path: path.join(RESULT_DIR, 'canvas-menu.png') });

      // Persist native 320×224 frames as PNG (they contain game imagery; the
      // whole test-results/ tree is gitignored and never committed).
      for (const [tag, frame] of Object.entries(drive.frames)) {
        writeFileSync(path.join(RESULT_DIR, `${tag}.png`), decodePng(frame.png));
      }

      const report = {
        format: 'dune-host-browser-test/1',
        ok: true,
        generated_at_utc: new Date().toISOString(),
        rom: { path: rom, bytes: romBytes.byteLength, sha256_note: 'not hashed here; BYOP' },
        game: { path: game.path, relative: moduleRelative, built_for_test: game.built, bytes: loadMetrics.gameBytes },
        runtime: { bytes: loadMetrics.runtimeBytes, url: '/runtime/wasm/runtime.wasm' },
        chrome: { executable: CHROME, headless: true },
        timings: {
          navigate_ms: loadMs,
          runtime_load_ms: Math.round(loadMetrics.timings.runtimeLoadMs),
          game_compile_ms: Math.round(loadMetrics.timings.gameCompileMs),
          link_ms: Math.round(loadMetrics.timings.linkMs),
          boot_ms: Math.round(bootMetrics.bootMs),
          drive_ms: Math.round(drive.totalMs),
        },
        frames: Object.fromEntries(Object.entries(drive.frames).map(([tag, frame]) => [tag, frame.stats])),
        frame_metrics: Object.fromEntries(
          Object.entries(drive.frames).map(([tag, frame]) => [tag, frame.metrics]),
        ),
        save: drive.save,
        metrics: {
          instructions: drive.metrics.instructions,
          emulatedSeconds: drive.metrics.emulatedSeconds,
          renderedFrames: drive.metrics.renderedFrames,
          stepsPerSecond: drive.metrics.stepsPerSecond,
          lastRunMs: drive.metrics.lastRunMs,
          mode: drive.metrics.gameMode,
          tableSlots: drive.metrics.tableSlots,
          faulted: drive.metrics.faulted,
          fault: drive.metrics.fault,
        },
        logs,
      };
      writeFileSync(path.join(RESULT_DIR, 'report.json'), JSON.stringify(report, null, 2) + '\n');

      // ------------------------------------------------------------ asserts --
      assert.equal(bootMetrics.faulted, false, `emulator faulted: ${JSON.stringify(bootMetrics.fault)}`);
      assert.equal(drive.metrics.faulted, false, `emulator faulted: ${JSON.stringify(drive.metrics.fault)}`);
      assert.equal(drive.metrics.gameMode, 2, 'game table must be installed in GAME_MODE_SINGLE');
      assert.ok(loadMetrics.gameBytes > 500_000, `game.wasm too small: ${loadMetrics.gameBytes}`);
      assert.ok(loadMetrics.runtimeBytes > 500_000, `runtime.wasm too small: ${loadMetrics.runtimeBytes}`);

      const sega = drive.frames['01-sega'].stats;
      const logos = drive.frames['02-logos'].stats;
      const title = drive.frames['03-title'].stats;
      const menu = drive.frames['04-menu'].stats;

      assert.equal(sega.width, 320);
      assert.equal(sega.height, 224);
      assert.ok(sega.nonzero > 400, `first frame is (almost) empty: ${sega.nonzero} non-zero pixels`);
      assert.ok(sega.unique >= 3, `first frame has too few colours: ${sega.unique}`);
      assert.ok(logos.nonzero > 4_000, `publisher-logo frame is too empty: ${logos.nonzero}`);
      assert.ok(logos.unique >= 10, `publisher-logo frame has too few colours: ${logos.unique}`);
      assert.ok(title.nonzero > 8_000, `title frame is too empty: ${title.nonzero}`);
      assert.ok(title.unique >= 10, `title frame has too few colours: ${title.unique}`);
      assert.notEqual(menu.hash, drive.titleHash, 'frame did not change after the Start press');
      assert.ok(menu.serial > drive.frames['03-title'].stats.serial, 'no new rendered frames after input');
      assert.ok(menu.nonzero > 8_000, `menu frame is too empty: ${menu.nonzero}`);

      assert.ok(drive.save.bytes > 100_000, `save state too small: ${drive.save.bytes}`);
      assert.equal(drive.save.loaded, true, 'dune_load_state_from_buffer() rejected the state');
      assert.equal(
        drive.save.restoredInstructions,
        drive.save.savedInstructions,
        'save/load did not restore the CPU instruction counter',
      );
      assert.ok(drive.save.advancedInstructions > drive.save.savedInstructions);

      // Visible metrics for the operator.
      console.log(
        JSON.stringify(
          {
            runtime_bytes: loadMetrics.runtimeBytes,
            game_bytes: loadMetrics.gameBytes,
            load_ms: loadMs,
            game_compile_ms: Math.round(loadMetrics.timings.gameCompileMs),
            link_ms: Math.round(loadMetrics.timings.linkMs),
            boot_ms: Math.round(bootMetrics.bootMs),
            table_mode: drive.metrics.gameMode,
            table_slots: drive.metrics.tableSlots,
            total_instructions: drive.metrics.instructions,
            emulated_seconds: Number(drive.metrics.emulatedSeconds.toFixed(2)),
            rendered_frames: drive.metrics.renderedFrames,
            steps_per_second_millions: Number((drive.metrics.stepsPerSecond / 1e6).toFixed(1)),
            frames: {
              sega: sega.nonzero + ' px / ' + sega.unique + ' colours',
              logos: logos.nonzero + ' px / ' + logos.unique + ' colours',
              title: title.nonzero + ' px / ' + title.unique + ' colours',
              menu: menu.nonzero + ' px / ' + menu.unique + ' colours',
            },
            save_bytes: drive.save.bytes,
            save_restored: drive.save.loaded,
            screenshots: Object.keys(drive.frames).map((tag) => `test-results/host/${tag}.png`),
          },
          null,
          2,
        ),
      );
    } finally {
      if (browser) await browser.close();
      child.kill('SIGKILL');
    }
  });
}
