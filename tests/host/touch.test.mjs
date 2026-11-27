// Browser end-to-end test for the path-A touch camera (virtual SDL window).
//
// Proves, in headless Chrome against the real ROM/game.wasm:
//   runtime.wasm + game.wasm + ROM -> boot -> native menu/intro -> mission map
//     -> dune_web_attach_virtual_window(320,224) geometry is valid
//     -> hover/tap/pan/zoom/minimap adapters return non-zero context
//     -> a tapped world click is queued AND consumed by the path-B observers
//     -> presentation frames change, saves stay DSAV v2 / 140056 B.
//
// The test serves the repository root itself but routes /web/runtime/* to the
// freshly built runtime/wasm/* artifacts, so it validates the working tree even
// before tools/bundle_web.py copies them into the deployable web/ bundle.
//
// Run:
//   DUNE_ROM="/path/to/Dune - The Battle for Arrakis (USA).gen" \
//     node --test tests/host/touch.test.mjs
//
// Without a ROM (or game.wasm / Chrome) the test is skipped: external game data
// is never committed. Screenshots/report go to test-results/touch/ (gitignored).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RESULT_DIR = path.join(ROOT, 'test-results', 'touch');
const LOCAL_BUILD = path.join(ROOT, '.local', 'host-build', 'game.wasm');
const FULL_MODULE = path.join(ROOT, '.local', 'wasm-full', 'game.wasm');
const DEFAULT_ROM = '/Users/oleskarpov/Downloads/Dune - The Battle for Arrakis (USA).gen';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const RUNTIME_DIR = path.join(ROOT, 'runtime', 'wasm');

const runtimeManifestPath = path.join(RUNTIME_DIR, 'manifest.json');
const runtimeManifest = existsSync(runtimeManifestPath)
  ? JSON.parse(readFileSync(runtimeManifestPath, 'utf8'))
  : null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8',
};

function resolveRom() {
  const candidate = process.env.DUNE_ROM || DEFAULT_ROM;
  if (!candidate || !existsSync(candidate)) return null;
  return path.resolve(candidate);
}

function resolveGameModule(rom) {
  if (process.env.HOST_GAME) {
    if (!existsSync(process.env.HOST_GAME)) throw new Error(`HOST_GAME not found: ${process.env.HOST_GAME}`);
    return path.resolve(process.env.HOST_GAME);
  }
  if (existsSync(FULL_MODULE)) return FULL_MODULE;
  if (existsSync(LOCAL_BUILD)) return LOCAL_BUILD;
  // Fallback: build the module from the ROM (slow; the artifact is preferable).
  const python = process.env.PYTHON || 'python3';
  const out = LOCAL_BUILD;
  mkdirSync(path.dirname(out), { recursive: true });
  const result = spawnSync(
    python,
    [path.join(ROOT, 'tools/host/build_game_module.py'), '--rom', rom, '--out', out, '--json'],
    { encoding: 'utf8', cwd: ROOT, timeout: 15 * 60 * 1000 },
  );
  if (result.status !== 0 || !existsSync(out)) {
    throw new Error(`game.wasm build failed (exit ${result.status}):\n${result.stderr || result.stdout || ''}`.slice(0, 4000));
  }
  return out;
}

/**
 * Static server for the repo root with a `/web/runtime/*` overlay: the browser
 * host imports `web/runtime/{loader.mjs,runtime.wasm}`, but the test must
 * exercise the freshly built `runtime/wasm/*` artifacts.
 */
async function startOverlayServer() {
  const server = createServer(async (request, response) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent((request.url || '/').split('?')[0]);
    } catch {
      response.writeHead(400).end('bad request');
      return;
    }
    if (urlPath === '/') urlPath = '/web/host/play.html';
    const file = urlPath.startsWith('/web/runtime/')
      ? path.join(RUNTIME_DIR, path.basename(urlPath))
      : path.join(ROOT, urlPath.replace(/^\/+/, ''));
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
      response.writeHead(403).end('forbidden');
      return;
    }
    let data;
    try {
      data = await (await import('node:fs/promises')).readFile(file);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain' }).end(`not found: ${urlPath}`);
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    response.end(data);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

function decodePng(dataUrl) {
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

const rom = resolveRom();
const game = rom ? resolveGameModule(rom) : null;
if (!rom) {
  test('path-A touch camera works on the real mission map', { skip: 'set DUNE_ROM=/path/to/Dune-USA.gen (ROM is never committed)' }, () => {});
} else if (!existsSync(CHROME)) {
  test('path-A touch camera works on the real mission map', { skip: `Chrome not found: ${CHROME}` }, () => {});
} else {
  test('path-A touch camera works on the real mission map', async (t) => {
    mkdirSync(RESULT_DIR, { recursive: true });
    assert.ok(existsSync(path.join(RUNTIME_DIR, 'runtime.wasm')), 'runtime/wasm/runtime.wasm missing');
    assert.ok(existsSync(path.join(RUNTIME_DIR, 'loader.mjs')), 'runtime/wasm/loader.mjs missing');
    const moduleRelative = '/' + path.relative(ROOT, game).split(path.sep).join('/');
    const romBytes = readFileSync(rom);
    const { server, base } = await startOverlayServer();
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

      await page.goto(`${base}/web/host/play.html?game=${encodeURIComponent(moduleRelative)}`, {
        waitUntil: 'load',
        timeout: 60_000,
      });
      await page.waitForFunction(
        () => window.__HOST && window.__HOST.game && window.__HOST.metrics.gameBytes > 0,
        null,
        { timeout: 120_000, polling: 100 },
      );
      await page.setInputFiles('#rom-input', rom);
      await page.click('#load');
      await page.waitForFunction(() => window.__HOST?.booted === true, null, { timeout: 60_000, polling: 100 });

      const boot = await page.evaluate(() => {
        const h = window.__HOST;
        return {
          touch: h.touchInfo ? { attached: h.touch.attached, width: h.touch.width, height: h.touch.height } : null,
          capabilities: h.capabilities(),
          metrics: h.snapshot(),
        };
      });
      assert.equal(boot.touch?.attached, true, `virtual window not attached: ${JSON.stringify(boot.touch)}`);
      assert.equal(boot.capabilities.virtualWindow, true);
      assert.equal(boot.capabilities.webStep, true, 'runtime.wasm lacks dune_rt_web_step');
      assert.equal(boot.metrics.faulted, false, `emulator faulted: ${JSON.stringify(boot.metrics.fault)}`);

      // Deterministic drive: title -> START -> START GAME -> house intro -> map.
      const arrival = await page.evaluate(() => {
        const h = window.__HOST;
        h.advanceInstructions(26_000_000);
        h.pressStart({ holdSteps: 200_000, settleSteps: 100_000 });
        h.advanceInstructions(h.metrics.instructions + 2_000_000);
        for (let press = 0; press < 10; press += 1) {
          h.pressPad(64, { holdSteps: 200_000, settleSteps: 80_000 }); // A
          h.advanceInstructions(h.metrics.instructions + 3_000_000);
          const camera = h.cameraDebug();
          if (camera && camera.map === 1) {
            return { press: press + 1, instructions: h.metrics.instructions, camera, faulted: !!h.fault };
          }
        }
        return null;
      });
      assert.ok(arrival, 'did not reach the mission map with 10 A presses');
      assert.equal(arrival.faulted, false);
      assert.equal(arrival.camera.context, 1, 'mission frame is not a world/map context');

      // Touch probe on the live mission frame.
      const probe = await page.evaluate(() => {
        const h = window.__HOST;
        const screenshots = {};
        const captures = [];
        const fnv = (bytes) => {
          let hash = 2166136261 >>> 0;
          for (let i = 0; i < bytes.length; i += 1) {
            hash ^= bytes[i];
            hash = Math.imul(hash, 16777619) >>> 0;
          }
          return hash.toString(16).padStart(8, '0');
        };
        const capture = (tag) => {
          captures.push({ tag, png: h.canvasDataUrl() });
        };
        const snap = (tag) => {
          h.drawFrame();
          const camera = h.cameraDebug();
          const selection = h.selectionDebug();
          const stats = h.frameStats();
          screenshots[tag] = { hash: stats.hash, nonzero: stats.nonzero, unique: stats.unique, serial: stats.serial, camera, selection };
          capture(tag);
          return screenshots[tag];
        };
        const expanded = (tag) => {
          const startedAt = performance.now();
          const frame = h.expandedFrame();
          if (!frame) return null;
          let nonzero = 0;
          for (let i = 0; i < frame.rgba.length; i += 4) {
            if (frame.rgba[i] || frame.rgba[i + 1] || frame.rgba[i + 2]) nonzero += 1;
          }
          const result = {
            width: frame.width,
            height: frame.height,
            hash: fnv(frame.rgba),
            nonzero,
            buildMs: Math.round((performance.now() - startedAt) * 10) / 10,
          };
          h.drawExpandedFrame();
          capture(tag);
          return result;
        };

        const out = { captures };
        out.base = h.cameraDebug();
        out.expandedMission = expanded('10-expanded-mission');
        out.frameBefore = snap('00-mission');
        out.drawing = { left: out.base.left, top: out.base.top, scale: out.base.scale };
        h.advanceFrames(3);
        out.frameIdle = snap('01-idle');

        out.hover = h.hoverScreen(120, 140);
        out.frameHover = snap('02-hover');

        out.tap = h.tapScreen(160, 112);
        out.queuedAfterTap = h.cameraDebug().queuedClicks;
        h.advanceFrames(4);
        out.queuedAfterTapFrames = h.cameraDebug().queuedClicks;
        out.frameTap = snap('03-tap');

        out.gesture = h.call('dune_web_gesture_query', 160, 112);
        out.worldX = h.call('dune_web_world_x');
        out.worldY = h.call('dune_web_world_y');

        const panBefore = h.cameraDebug();
        out.begin = h.beginPan(160, 112);
        out.pan1 = h.panCamera(40, 0);
        out.pan2 = h.panCamera(0, -24);
        const panAfter = h.cameraDebug();
        h.endPan();
        h.advanceFrames(2);
        out.framePan = snap('04-pan');
        out.expandedPan = expanded('11-expanded-pan');
        out.panDelta = { dx: panAfter.cameraX - panBefore.cameraX, dy: panAfter.cameraY - panBefore.cameraY };

        out.panShot = h.pan(0, 16);
        out.afterPanShot = h.cameraDebug();

        const zoomStart = h.cameraDebug().zoom;
        out.zoomOut1 = h.zoomCamera(0.8, 160, 112);
        out.zoomOut2 = h.zoomCamera(0.8, 160, 112);
        const zoomed = h.cameraDebug();
        out.zoomIn = h.zoomCamera(1.25, 100, 100);
        h.advanceFrames(2);
        out.frameZoom = snap('05-zoom');
        out.expandedZoom = expanded('12-expanded-zoom');
        out.zoom = {
          start: zoomStart,
          afterOut: zoomed.zoom,
          worldWidth: zoomed.worldWidth,
          worldHeight: zoomed.worldHeight,
          current: h.cameraDebug().zoom,
        };

        const minimapBefore = h.cameraDebug();
        out.minimapTap = h.tapScreen(272, 176);
        out.minimapMoved = {
          dx: h.cameraDebug().cameraX - minimapBefore.cameraX,
          dy: h.cameraDebug().cameraY - minimapBefore.cameraY,
        };
        h.advanceFrames(2);
        out.frameMinimap = snap('06-minimap');

        // Save contract must stay DSAV v2 / 140056 B.
        const save = h.saveState();
        const view = new DataView(save.buffer, save.byteOffset, save.byteLength);
        out.save = {
          bytes: save.byteLength,
          magic: String.fromCharCode(save[0], save[1], save[2], save[3]),
          version: view.getUint32(4, true),
          totalSize: view.getUint32(12, true),
        };
        out.finalCamera = h.cameraDebug();
        out.faulted = !!h.fault;
        out.fault = h.fault;
        out.metrics = {
          instructions: h.metrics.instructions,
          emulatedSeconds: h.metrics.emulatedSeconds,
          renderedFrames: h.metrics.renderedFrames,
          stepsPerSecond: h.metrics.stepsPerSecond,
          frameWidth: h.metrics.frameWidth,
          frameHeight: h.metrics.frameHeight,
        };
        return out;
      });

      // Persist screenshots (native 320x224 frames, gitignored tree).
      const shotFiles = [];
      for (const capture of probe.captures) {
        const file = path.join(RESULT_DIR, `${capture.tag}.png`);
        writeFileSync(file, decodePng(capture.png));
        shotFiles.push(path.relative(ROOT, file).split(path.sep).join('/'));
      }
      await page.locator('#screen').screenshot({ path: path.join(RESULT_DIR, 'canvas-touch.png') });
      await page.screenshot({ path: path.join(RESULT_DIR, 'page-touch.png'), fullPage: true });

      const report = {
        format: 'dune-touch-camera-test/1',
        ok: true,
        generated_at_utc: new Date().toISOString(),
        rom: { path: rom, bytes: romBytes.byteLength, sha256_note: 'not hashed; BYOP' },
        game: { path: game, relative: moduleRelative, bytes: boot.metrics.gameBytes },
        runtime: {
          dir: 'runtime/wasm',
          bytes: boot.metrics.runtimeBytes,
          sha256: runtimeManifest?.wasm?.sha256 ?? null,
          abi_hash: runtimeManifest?.abi?.abi_hash ?? null,
          exports: runtimeManifest?.exports?.all?.length ?? null,
        },
        chrome: { executable: CHROME, headless: true },
        virtualWindow: boot.touch,
        arrival,
        probe: {
          drawing: probe.drawing,
          context: probe.base.context,
          map: probe.base.map,
          hover: probe.hover,
          tap: probe.tap,
          queuedClicksAfterTap: probe.queuedAfterTap,
          queuedClicksAfterFrames: probe.queuedAfterTapFrames,
          gesture: probe.gesture,
          world: { x: probe.worldX, y: probe.worldY },
          begin: probe.begin,
          pan: [probe.pan1, probe.pan2, probe.panShot],
          panDelta: probe.panDelta,
          zoomReturns: [probe.zoomOut1, probe.zoomOut2, probe.zoomIn],
          zoom: probe.zoom,
          minimapTap: probe.minimapTap,
          minimapMoved: probe.minimapMoved,
          frames: Object.fromEntries(
            Object.entries({
              mission: probe.frameBefore,
              idle: probe.frameIdle,
              hover: probe.frameHover,
              tap: probe.frameTap,
              pan: probe.framePan,
              zoom: probe.frameZoom,
              minimap: probe.frameMinimap,
            }).map(([tag, value]) => [tag, { hash: value.hash, nonzero: value.nonzero, unique: value.unique, serial: value.serial }]),
          ),
          expanded: {
            mission: probe.expandedMission,
            pan: probe.expandedPan,
            zoom: probe.expandedZoom,
          },
          save: probe.save,
          faulted: probe.faulted,
          metrics: probe.metrics,
        },
        screenshots: shotFiles,
        logs,
      };
      writeFileSync(path.join(RESULT_DIR, 'report.json'), JSON.stringify(report, null, 2) + '\n');

      const { probe: p } = report;
      assert.ok(String(p.queuedClicksAfterTap) !== 'undefined');
      assert.equal(p.context, 1, 'world/map context expected');
      assert.ok(p.tap > 0, `dune_web_tap_screen returned ${p.tap}`);
      assert.ok(p.hover > 0, `dune_web_hover_screen returned ${p.hover}`);
      assert.ok(p.queuedClicksAfterTap >= 1, 'tap did not queue a native world click');
      assert.equal(p.queuedClicksAfterFrames, 0, 'queued tap was not consumed by the input observers');
      assert.equal(p.gesture, 1, 'dune_web_gesture_query did not classify the frame as world');
      assert.ok(p.world.x >= 0 && p.world.y >= 0, `world coords invalid: ${p.world.x},${p.world.y}`);
      assert.equal(p.begin, 1, 'dune_web_begin rejected the mission map');
      assert.equal(p.pan[0], 1, 'dune_web_pan rejected the drag');
      assert.equal(p.pan[1], 1, 'second dune_web_pan rejected the drag');
      assert.equal(p.pan[2], 1, 'one-shot pan() did not begin/pan/end');
      assert.ok(p.panDelta.dx !== 0 || p.panDelta.dy !== 0, 'pan did not move the camera');
      assert.equal(p.zoomReturns[0], 80, 'first 0.8 zoom should clamp 100 -> 80');
      assert.equal(p.zoomReturns[1], 64, 'second 0.8 zoom should reach 64');
      assert.ok(p.zoomReturns[2] > p.zoomReturns[1], 'zoom-in did not increase the zoom');
      assert.equal(p.zoom.afterOut, 64);
      assert.ok(p.zoom.worldWidth > 320 && p.zoom.worldHeight > 224, 'zoom-out did not widen the overview');
      assert.equal(p.minimapTap, 3, 'minimap tap did not return the minimap context (3)');
      assert.ok(p.minimapMoved.dx !== 0 || p.minimapMoved.dy !== 0, 'minimap tap did not recentre the camera');
      assert.notEqual(p.frames.tap.hash, p.frames.mission.hash, 'presentation frame did not change after tap');
      assert.ok(p.expanded.mission && p.expanded.pan && p.expanded.zoom, 'expanded overview frame unavailable');
      assert.equal(p.expanded.mission.width, 320);
      assert.equal(p.expanded.mission.height, 224);
      assert.ok(p.expanded.mission.nonzero > 10_000, 'expanded overview is (almost) empty');
      assert.notEqual(p.expanded.pan.hash, p.expanded.mission.hash, 'expanded overview did not change after pan');
      assert.notEqual(p.expanded.zoom.hash, p.expanded.pan.hash, 'expanded overview did not change after zoom');
      assert.equal(p.save.bytes, 140056, 'save state size drifted from DSAV v2 140056 B');
      assert.equal(p.save.magic, 'DSAV');
      assert.equal(p.save.version, 2);
      assert.equal(p.save.totalSize, 140056);
      assert.equal(p.faulted, false, `emulator faulted: ${JSON.stringify(probe.fault)}`);
      assert.ok(p.metrics.frameWidth === 320 && p.metrics.frameHeight === 224);

      console.log(
        JSON.stringify(
          {
            reached_map_after_presses: arrival.press,
            instructions: arrival.instructions,
            virtual_window: `${boot.touch.width}x${boot.touch.height}`,
            tap_context: p.tap,
            hover_context: p.hover,
            queued_click: `${p.queuedClicksAfterTap} -> ${p.queuedClicksAfterFrames}`,
            world: `${p.world.x},${p.world.y}`,
            pan: p.pan,
            pan_delta: p.panDelta,
            zoom: p.zoomReturns,
            minimap: { tap: p.minimapTap, moved: p.minimapMoved },
            frames: Object.fromEntries(Object.entries(p.frames).map(([tag, value]) => [tag, value.hash])),
            expanded_frames: {
              mission: p.expanded.mission.hash,
              pan: p.expanded.pan.hash,
              zoom: p.expanded.zoom.hash,
            },
            save: p.save,
            screenshots: shotFiles,
          },
          null,
          2,
        ),
      );
    } finally {
      if (browser) await browser.close();
      server.close();
    }
  });
}
