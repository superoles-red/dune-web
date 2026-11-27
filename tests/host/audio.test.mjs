// Browser end-to-end test for path-A audio (runtime.wasm + game.wasm + ROM).
//
// Proves in headless Chrome:
//   * the runtime knows the path-A audio exports (dune_rt_set_audio_mode /
//     dune_rt_audio_pop) and the generated game.wasm has a REAL
//     translated_z80_step (not the UNTRANSLATED stub);
//   * after a user-gesture-style enable() the AudioContext is running, the
//     AudioWorklet loaded and the native YM2612/PSG ring produced non-silent
//     PCM (RMS > 0, peak > 0) during the boot/title sequence;
//   * dune_web_audio_levels() independently mutes music+SFX (RMS -> ~0) and
//     restores them;
//   * saving and loading a DSAV v2 state keeps the machine alive and audio
//     flowing (no fault, frames keep increasing).
//
// Run:
//   DUNE_ROM="/path/to/Dune - The Battle for Arrakis (USA).gen" \
//     node --test tests/host/audio.test.mjs
//
// Without the ROM the whole file skips.  The audio runtime is the shipped
// runtime/wasm/runtime.wasm when it exports the audio hooks; otherwise the
// test builds a test-only copy with tools/wasm_integration/build_audio_runtime.py
// (same ABI/hash, extra exports) into .local/.  Nothing game-derived is
// committed; screenshots/report go to test-results/host/audio.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import * as loader from '../../runtime/wasm/loader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RESULT_DIR = path.join(ROOT, 'test-results', 'host', 'audio');
const LOCAL = path.join(ROOT, '.local', 'wasm-z80');
const SERVE = path.join(ROOT, 'tools', 'host', 'serve.mjs');
const RUNTIME_WASM = path.join(ROOT, 'runtime', 'wasm', 'runtime.wasm');
const LOADER = path.join(ROOT, 'runtime', 'wasm', 'loader.mjs');
const MANIFEST = path.join(ROOT, 'runtime', 'wasm', 'manifest.json');
const DEFAULT_AUDIO_RUNTIME = path.join(LOCAL, 'runtime-build', 'runtime-audio.wasm');
const BUILD_AUDIO_RUNTIME = path.join(ROOT, 'tools', 'wasm_integration', 'build_audio_runtime.py');
const BUILD_GAME = path.join(ROOT, 'tools', 'wasm_integration', 'build_full_module.py');
const DEFAULT_ROM = '/Users/oleskarpov/Downloads/Dune - The Battle for Arrakis (USA).gen';
const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const AUDIO_EXPORTS = ['dune_rt_set_audio_mode', 'dune_rt_audio_pop', 'dune_rt_audio_available', 'dune_rt_audio_rate'];

function findPython() {
  const candidates = [
    process.env.PYTHON,
    path.join(process.env.HOME || '', '.local/bin/python3.12'),
    '/opt/homebrew/bin/python3.12',
    'python3.12',
    'python3',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info >= (3, 10))'], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim() === 'True') return candidate;
  }
  return null;
}

function resolveRom() {
  const candidate = process.env.DUNE_ROM || DEFAULT_ROM;
  if (!candidate || !existsSync(candidate)) return null;
  return path.resolve(candidate);
}

async function runtimeHasAudioExports(wasmPath) {
  if (!existsSync(wasmPath)) return false;
  try {
    const module = await WebAssembly.compile(readFileSync(wasmPath));
    const names = new Set(WebAssembly.Module.exports(module).map((entry) => entry.name));
    return AUDIO_EXPORTS.every((name) => names.has(name));
  } catch {
    return false;
  }
}

/**
 * The test-only runtime is linked from the same pinned staging as the shipped
 * one, so the ABI layout must be identical; verify that explicitly (the game
 * module is built against the shipped runtime descriptor, which is the one the
 * manifest pins, and then executed on the audio-enabled copy).
 */
async function compareRuntimeLayouts(audioRuntimePath) {
  const loadFields = async (wasmPath) => {
    const rt = await loader.loadRuntime({ wasmBytes: readFileSync(wasmPath) });
    const abi = loader.initRuntime(rt);
    return { fields: abi.fields, hash: rt.exports.dune_abi_hash() };
  };
  const shipped = await loadFields(RUNTIME_WASM);
  const audio = await loadFields(audioRuntimePath);
  const keys = [
    'SIZEOF_CPU', 'SIZEOF_Z80CPU', 'OFF_PC', 'OFF_RAM', 'OFF_FAULT',
    'OFF_Z80_CPU', 'OFF_Z80_R8', 'OFF_Z80_PC', 'OFF_Z80_BUS_RAM',
    'OFF_Z80_BUS_BANK', 'ADDR_CPU', 'ADDR_RAM', 'ADDR_ROM', 'ADDR_Z80_RAM',
    'ADDR_SAVE_BUFFER', 'ADDR_GAME_TABLE',
  ];
  const mismatched = keys.filter((key) => shipped.fields[key] !== audio.fields[key]);
  if (mismatched.length) {
    throw new Error(`test-only audio runtime ABI differs from the shipped runtime (${mismatched.join(', ')}); ` +
      'rerun tools/wasm_integration/build_audio_runtime.py --force');
  }
  return { shippedHash: shipped.hash, audioHash: audio.hash, keys: keys.length };
}

async function resolveAudioRuntime(python) {
  for (const candidate of [process.env.DUNE_AUDIO_RUNTIME, RUNTIME_WASM, DEFAULT_AUDIO_RUNTIME]) {
    if (candidate && await runtimeHasAudioExports(candidate)) {
      return { path: path.resolve(candidate), built: false };
    }
  }
  if (!python) throw new Error('no Python 3.10+ and no runtime with path-A audio exports');
  const result = spawnSync(python, [BUILD_AUDIO_RUNTIME, '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 10 * 60 * 1000 });
  if (result.status !== 0 || !existsSync(DEFAULT_AUDIO_RUNTIME)) {
    throw new Error(`cannot build test-only audio runtime (exit ${result.status}):\n${result.stderr || result.stdout}`);
  }
  return { path: DEFAULT_AUDIO_RUNTIME, built: true };
}

function buildGameModule(python, rom, runtimePath, outPath) {
  const result = spawnSync(python, [
    BUILD_GAME, '--rom', rom, '--z80', '--runtime', runtimePath,
    '--loader', LOADER, '--manifest', MANIFEST, '--out', path.dirname(outPath), '--json',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 20 * 60 * 1000 });
  if (result.status !== 0) {
    throw new Error(`game.wasm --z80 build failed (exit ${result.status}):\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

async function startServer() {
  const child = spawn(process.execPath, [SERVE, '--port', '0'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '';
  child.stderr.on('data', (chunk) => process.stderr.write(`[audio-server] ${chunk}`));
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('serve.mjs did not start')), 15000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/listening (http:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1].replace(/\/$/, '')); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`serve.mjs exited ${code}`)); });
  });
  return { child, base };
}

function pageHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>dune audio e2e</title></head>
<body><script type="module">
import { DuneHost } from '/web/host/host.mjs';
import { DuneAudio } from '/web/host/audio.mjs';

const params = new URLSearchParams(location.search);
const logs = [];
const log = (...args) => { logs.push(args.join(' ')); if (logs.length > 200) logs.shift(); };

window.__audioTest = async () => {
  const started = performance.now();
  const rom = new Uint8Array(await (await fetch(params.get('rom'))).arrayBuffer());
  const host = new DuneHost({
    runtimeUrl: params.get('runtime'),
    gameUrl: params.get('game'),
    log,
  });
  await host.init();
  await host.loadRomFromBytes(rom);
  host.boot();
  const audio = new DuneAudio({ host, chunkFrames: 2048, log });
  const yieldToLoop = () => new Promise((resolve) => setTimeout(resolve, 0));
  const enabled = await audio.enable();
  // AudioWorkletProcessor messages ('ready'/'stats') are delivered on the main
  // thread; let the event loop run or they stay queued behind a tight step loop.
  for (let i = 0; i < 100 && !audio.workletReady; i += 1) await yieldToLoop();
  const phases = {};
  const runUntil = async (instructions, limitMs = 90000) => {
    const until = performance.now() + limitMs;
    let iteration = 0;
    while (host.metrics.instructions < instructions && performance.now() < until && !host.fault) {
      host.advanceSteps(16384);
      audio.pump({ maxChunks: 64 });
      if (++iteration % 32 === 0) await yieldToLoop();
    }
    await yieldToLoop();
    return audio.stats();
  };
  // Boot logos -> title -> main menu (~30M 68000 instructions in the ROM).
  const title = await runUntil(30_000_000);
  phases.title = title;
  // Save / load round-trip must not break the machine or the audio path.
  const save = host.saveState();
  const faultBefore = host.fault;
  await runUntil(host.metrics.instructions + 2_000_000);
  const afterLoadPoint = audio.stats();
  const loaded = host.loadState(save);
  audio.flush();
  audio.resetPeak();
  const afterLoad = await runUntil(host.metrics.instructions + 2_000_000);
  phases.afterLoad = afterLoad;
  // Independent music/SFX levels: 0 mutes both, 100 restores.
  audio.setLevels(0, 0);
  audio.resetPeak();
  const muted = await runUntil(host.metrics.instructions + 2_000_000);
  phases.muted = muted;
  audio.setLevels(100, 100);
  audio.resetPeak();
  const restored = await runUntil(host.metrics.instructions + 2_000_000);
  phases.restored = restored;
  audio.setLevels(100, 100);
  return {
    enabled,
    title, afterLoadPoint, afterLoad, muted, restored,
    saveBytes: save ? save.byteLength : 0,
    loaded,
    fault: host.fault,
    faultBefore,
    instructions: host.metrics.instructions,
    renderedFrames: host.metrics.renderedFrames,
    elapsedMs: performance.now() - started,
    levels: { music: audio.music, sound: audio.sound },
    logs: logs.slice(-40),
  };
};
window.__ready = true;
</script></body></html>`;
}

const rom = resolveRom();
if (!rom) {
  test('audio path-A end-to-end (skipped: set DUNE_ROM)', { skip: 'DUNE_ROM not set or file missing' }, () => {});
} else if (!existsSync(CHROME)) {
  test('audio path-A end-to-end (skipped: no Chrome)', { skip: `Chrome not found: ${CHROME}` }, () => {});
} else {
  test('audio path-A end-to-end: Z80 + YM2612/PSG -> AudioWorklet', async (t) => {
    const python = findPython();
    assert.ok(python, 'Python 3.10+ is required to build the Z80 game module');
    mkdirSync(RESULT_DIR, { recursive: true });
    const httpDir = path.join(LOCAL, 'http');
    mkdirSync(httpDir, { recursive: true });
    const runtime = await resolveAudioRuntime(python);
    const layout = await compareRuntimeLayouts(runtime.path);
    const gameOut = path.join(httpDir, 'game.wasm');
    // Build against the shipped runtime descriptor (pinned manifest SHA); the
    // audio-enabled copy has the identical ABI layout (checked above).
    const build = buildGameModule(python, rom, RUNTIME_WASM, gameOut);
    assert.equal(build.ok, true, JSON.stringify(build).slice(0, 2000));
    assert.equal(build.z80.variants, 3095, 'game.wasm must carry the real Z80 program');
    cpSync(runtime.path, path.join(httpDir, 'runtime.wasm'));
    // game.wasm was built directly into httpDir; copy the ROM next to it.
    cpSync(rom, path.join(httpDir, 'rom.gen'));
    const pagePath = path.join(httpDir, 'audio-test.html');
    writeFileSync(pagePath, pageHtml());
    writeFileSync(path.join(RESULT_DIR, 'audio-test.page.html'), pageHtml());
    writeFileSync(path.join(RESULT_DIR, 'game-build.json'), JSON.stringify(build, null, 1));
    writeFileSync(path.join(RESULT_DIR, 'runtime-layout.json'), JSON.stringify(layout, null, 1));

    const server = await startServer();
    const browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling'],
    });
    try {
      const page = await browser.newPage();
      page.on('console', (message) => {
        if (message.type() === 'error') process.stderr.write(`[page] ${message.text()}\n`);
      });
      page.on('pageerror', (error) => process.stderr.write(`[pageerror] ${error.message}\n`));
      const base = server.base;
      await page.goto(`${base}/${path.relative(ROOT, pagePath).split(path.sep).join('/')}`
        + `?runtime=${encodeURIComponent(`/${path.relative(ROOT, path.join(httpDir, 'runtime.wasm')).split(path.sep).join('/')}`)}`
        + `&game=${encodeURIComponent(`/${path.relative(ROOT, gameOut).split(path.sep).join('/')}`)}`
        + `&rom=${encodeURIComponent(`/${path.relative(ROOT, path.join(httpDir, 'rom.gen')).split(path.sep).join('/')}`)}`,
      { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
      const report = await page.evaluate(() => window.__audioTest());
      writeFileSync(path.join(RESULT_DIR, 'audio-report.json'), JSON.stringify(report, null, 1));
      await page.screenshot({ path: path.join(RESULT_DIR, 'audio-final.png') });

      // ---- assertions -------------------------------------------------
      assert.equal(report.enabled.supported, true, JSON.stringify(report.enabled));
      assert.equal(report.enabled.enabled, true);
      assert.equal(report.enabled.contextState, 'running', 'AudioContext must be running');
      assert.equal(report.title.workletReady, true, 'AudioWorklet must be loaded');
      assert.equal(report.fault, null, `host faulted: ${JSON.stringify(report.fault)}`);
      assert.ok(report.instructions >= 30_000_000, `only ${report.instructions} instructions`);
      assert.ok(report.renderedFrames > 100, `only ${report.renderedFrames} video frames`);

      const title = report.title;
      assert.ok(title.frames > 48000, `only ${title.frames} audio frames on title`);
      assert.ok(title.peak > 0, 'title audio peak must be > 0');
      assert.ok(title.rms > 1, `title audio RMS too low: ${title.rms}`);
      assert.ok(title.worklet.frames > 0, 'worklet never consumed PCM');
      assert.ok(title.packets > 10, 'too few PCM packets posted');
      assert.ok(report.saveBytes >= 140056, `save state is ${report.saveBytes} B`);

      // Save/load keeps the machine healthy and audio flowing.
      assert.equal(report.loaded, true);
      assert.equal(report.afterLoad.contextState, 'running');
      assert.ok(report.afterLoad.frames > 0, 'no audio after load');
      assert.ok(report.afterLoad.peak > 0, 'silent after load');

      // Independent levels: 0 mutes, 100 restores.  The mute is not a hard
      // digital zero (DC-filter tails / physical release), so compare ratios.
      assert.ok(report.muted.rms < report.title.rms / 20,
        `muted RMS ${report.muted.rms} vs title ${report.title.rms}`);
      assert.ok(report.restored.rms > report.muted.rms * 5,
        `restored RMS ${report.restored.rms} vs muted ${report.muted.rms}`);
      assert.ok(report.restored.peak > 0);

      t.diagnostic(`audio title: frames=${title.frames} peak=${title.peak} rms=${title.rms} ` +
        `worklet=${JSON.stringify(title.worklet)}`);
      t.diagnostic(`after load: frames=${report.afterLoad.frames} ` +
        `peak=${report.afterLoad.peak} rms=${report.afterLoad.rms}`);
      t.diagnostic(`levels: muted rms=${report.muted.rms}, restored rms=${report.restored.rms}`);
      t.diagnostic(`wall: ${(report.elapsedMs / 1000).toFixed(1)} s for ${report.instructions} instructions`);
    } finally {
      await browser.close();
      server.child.kill('SIGKILL');
    }
  });
}
