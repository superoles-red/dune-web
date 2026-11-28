// Recompiles the player's ROM into the game core inside a Web Worker.
// Only MIT recompiler code and the pinned runtime ship with the page; the ROM
// arrives from the player and never leaves this browser (memory + private OPFS).

import { loadPyodide } from './vendor/pyodide/pyodide.mjs';

const PYODIDE_BASE = new URL('./vendor/pyodide/', self.location.href).href;
const CACHE_ROOT = 'dune-web';
const PHASES = new Set([
  'pyodide', 'unpack', 'validate_rom', 'z80_images', 'entry_discovery',
  'translate_emit', 'hash_output', 'cache', 'cache_read',
]);
let pyodide = null;
let reference = null;

const post = (type, payload = {}, transfer = []) => self.postMessage({ type, ...payload }, transfer);
const progress = (phase, fraction, label) => post('state', { phase, fraction, label });

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function loadReference() {
  if (!reference) {
    const response = await fetch('./reference.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`reference.json: HTTP ${response.status}`);
    reference = await response.json();
  }
  return reference;
}

async function cacheDirectory(romSha, { create = false } = {}) {
  const root = await navigator.storage.getDirectory();
  const rootDir = await root.getDirectoryHandle(CACHE_ROOT, { create });
  return rootDir.getDirectoryHandle(`rom-${romSha}`, { create });
}

async function readCachedCore(romSha) {
  try {
    const dir = await cacheDirectory(romSha, { create: false });
    const meta = JSON.parse(await (await dir.getFileHandle('meta.json')).getFile().then((f) => f.text()));
    if (meta.abi_hash !== reference.abi_hash || meta.recompiler !== reference.recompiler) {
      return null;
    }
    return meta;
  } catch {
    return null;
  }
}

async function writeCachedCore(romSha, meta, coreBytes) {
  try {
    progress('cache', 0.995, 'Кэширование игры');
    const dir = await cacheDirectory(romSha, { create: true });
    const handle = await dir.getFileHandle('game.wasm', { create: true });
    const writable = await handle.createWritable();
    await writable.write(coreBytes);
    await writable.close();
    const metaHandle = await dir.getFileHandle('meta.json', { create: true });
    const metaWritable = await metaHandle.createWritable();
    await metaWritable.write(JSON.stringify(meta, null, 2) + '\n');
    await metaWritable.close();
  } catch (error) {
    // A cache failure must not break the build: report and continue.
    post('log', { line: `cache: ${error}` });
  }
}

async function ensurePyodide() {
  if (pyodide) return pyodide;
  progress('pyodide', 0.01, 'Загрузка Pyodide (CPython → WebAssembly)');
  pyodide = await loadPyodide({ indexURL: PYODIDE_BASE });
  progress('unpack', 0.05, 'Распаковка перекомпилятора (MIT, ReArrakis)');
  const response = await fetch('./py-package.zip', { cache: 'no-store' });
  if (!response.ok) throw new Error(`py-package.zip: HTTP ${response.status}`);
  pyodide.unpackArchive(new Uint8Array(await response.arrayBuffer()), 'zip', { extractDir: '/work/py' });
  pyodide.FS.mkdirTree('/work/build');
  pyodide.runPython("import sys; sys.path.insert(0, '/work/py')");
  pyodide.setStdout({
    batched: (line) => {
      const match = /^PROGRESS (\w+) ([\d.]+)$/.exec(line.trim());
      if (match && PHASES.has(match[1])) post('state', { phase: match[1], fraction: Number(match[2]) });
      else post('log', { line });
    },
  });
  return pyodide;
}

async function build({ romBytes, force = false }) {
  await loadReference();
  const romSha = await sha256Hex(romBytes);
  post('rom', { romSha256: romSha, romBytes: romBytes.length });

  const cached = force ? null : await readCachedCore(romSha);
  if (cached) {
    progress('cache_read', 1, 'Найдено собранное ядро в кэше');
    post('result', {
      result: {
        ok: cached.matches_shipped_core,
        cached: true,
        rom_sha256: romSha,
        game_sha256: cached.game_sha256,
        game_bytes: cached.game_bytes,
        output_sha256: cached.game_sha256,
        output_bytes: cached.game_bytes,
        expected_output_sha256: reference.expected_game_sha256,
        expected_output_bytes: reference.expected_game_bytes,
        matches_shipped_core: cached.matches_shipped_core,
        timings: {},
        total_seconds: 0,
      },
    });
    return;
  }

  const py = await ensurePyodide();
  py.FS.writeFile('/work/rom.gen', romBytes);
  const json = await py.runPythonAsync('import driver; driver.run()');
  const result = JSON.parse(json);

  if (result.ok) {
    progress('cache', 0.99, 'Сохранение игры в память устройства');
    const game = py.FS.readFile('/work/build/game.wasm');
    const meta = {
      rom_sha256: romSha,
      abi_hash: reference.abi_hash,
      recompiler: reference.recompiler,
      game_sha256: result.game_sha256,
      game_bytes: result.game_bytes,
      matches_shipped_core: result.matches_shipped_core,
      built_at: new Date().toISOString(),
    };
    await writeCachedCore(romSha, meta, game);
  }
  // Always hand the built core back to the page. Some WebKit/iOS builds have no
  // usable OPFS (createWritable fails with UnknownError), and without this the
  // page could not start the game even though the build succeeded.
  if (result.ok) {
    const game = py.FS.readFile('/work/build/game.wasm');
    result.core_bytes = game;
    post('result', { result }, [game.buffer]);
  } else {
    post('result', { result });
  }
}

self.onmessage = async (event) => {
  const message = event.data;
  if (message?.type !== 'build') return;
  try {
    await build(message);
  } catch (error) {
    post('error', { message: String((error && error.stack) || error) });
  }
};
