// BYOP boot for the legacy frontend.
//
// The old `web/` (Dune Sega Web) shipped a prebuilt Emscripten engine with the
// game ROM baked in.  This boot screen replaces that engine:
//
//   1. the player picks a ROM (never leaves the browser);
//   2. `./recompiler.worker.js` (the BYOP recompiler that already ships with
//      dune-web) turns that ROM into `game.wasm` inside a Web Worker (Pyodide);
//   3. `DuneHost` (./host/host.mjs) loads our `runtime.wasm` + the generated
//      `game.wasm` and boots the original game on the runtime;
//   4. the machine is fast-forwarded to the original main menu, and that exact
//      DSAV snapshot is kept as the legacy `frontend.state.bin` fixture
//      (generated on device — the repository carries no ROM-derived data);
//   5. a `Module` facade is attached and the unmodified legacy `shell.js` /
//      `game-ui.mjs` take over through it.
//
// Nothing here contains game data: the ROM, `game.wasm` and the generated state
// live in the player's browser only.

import { DuneHost } from './host/host.mjs';

const KNOWN_ROM_SHA256 = 'b1bbe73186e0902fa8b2db0f227bf306e3d6a80fe592f927d1aa9d60c0f335ba';
const ROM_BYTES = 1048576;
const CACHE_ROOT = 'dune-web';
const IGN_SAVE_BYTES = 140056; // sizeof(DuneSaveState) / DSAV v2 base payload
const FAST_FORWARD_INSTRUCTIONS = 26_000_000;

const PHASE_LABELS = {
  pyodide: 'Загружаем инструменты сборки (Pyodide)',
  unpack: 'Распаковываем перекомпилятор',
  validate_rom: 'Проверяем ROM',
  z80_images: 'Проверяем образы Z80',
  entry_discovery: 'Ищем код игры',
  translate_emit: 'Переводим игру в WebAssembly',
  hash_output: 'Проверяем результат сборки',
  cache_read: 'Берём ядро из памяти устройства',
  cache: 'Сохраняем ядро на устройстве',
};

const state = {
  phase: 'idle',
  romBytes: null,
  romSha: null,
  gameBytes: null,
  gameSha: null,
  host: null,
  frontendState: null,
  savedRom: null,
  worker: null,
  building: false,
  error: null,
};

/* ------------------------------------------------------------------ UI ---- */

const ui = {};

function mountBootScreen() {
  const style = document.createElement('style');
  style.textContent = `
    #byop-launch{position:fixed;inset:0;z-index:100;display:flex;flex-direction:column;align-items:center;
      justify-content:center;gap:14px;background:#000;color:#fff;font:14px/1.45 monospace;letter-spacing:1px;
      padding:max(20px,env(safe-area-inset-top)) 20px max(20px,env(safe-area-inset-bottom));text-align:center}
    #byop-launch[hidden]{display:none}
    #byop-launch .byop-logo{width:min(320px,75vw);height:auto;image-rendering:pixelated}
    #byop-launch h1{margin:0;font:bold 18px monospace;letter-spacing:3px}
    #byop-launch p{margin:0;max-width:440px;color:#c8c8d8}
    #byop-launch .byop-small{font-size:11px;color:#808090;letter-spacing:0}
    #byop-pick{display:inline-flex;align-items:center;justify-content:center;min-height:48px;min-width:220px;
      padding:10px 24px;background:#9393b6;border:2px outset #ddd;color:#000;font:bold 15px monospace;cursor:pointer}
    #byop-pick:active{border-style:inset}
    #byop-start-saved,#byop-change{padding:10px 22px;background:#9393b6;border:2px outset #ddd;color:#000;font:bold 15px monospace;cursor:pointer}
    #byop-change{background:#191b1d;color:#e2e2de;border:1px solid #8b8b84}
    #byop-start-saved[hidden],#byop-change[hidden]{display:none}
    #byop-start-saved:active,#byop-change:active{border-style:inset}
    #byop-install{padding:8px 18px;background:#191b1d;color:#e2e2de;border:1px solid #8b8b84;font:13px monospace;cursor:pointer}
    #byop-install:active{border-style:inset}
    #byop-progress{width:min(280px,70vw);height:10px;background:#242442;border:1px solid #9393b6;overflow:hidden}
    #byop-progress[hidden]{display:none}
    #byop-fill{display:block;height:100%;width:0;background:#00b600;transition:width .2s linear}
    #byop-launch .byop-indeterminate #byop-fill{width:32%;animation:byop-progress 1.3s ease-in-out infinite alternate}
    @keyframes byop-progress{from{transform:translateX(-100%)}to{transform:translateX(320%)}}
    #byop-retry{margin:0;padding:12px 24px;background:#9393b6;border:2px outset #ddd;color:#000;font:14px monospace;min-height:48px}
    #byop-retry[hidden]{display:none}
    #byop-text.error{color:#ff9a9a}`;
  document.head.append(style);

  const panel = document.createElement('div');
  panel.id = 'byop-launch';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Dune BYOP — выбор ROM');
  panel.innerHTML = `
    <img class="byop-logo" src="./ui-assets/screen-assets/art/title-logo.png" width="192" height="56"
         alt="Dune — The Battle for Arrakis">
    <h1>DUNE · THE BATTLE FOR ARRAKIS</h1>
    <p id="byop-text">Выберите ROM Sega Genesis (USA) — игра соберётся из него в этом браузере.</p>
    <label id="byop-pick">ВЫБРАТЬ ROM<input id="byop-rom" type="file" accept=".gen,.bin,.md,.rom,application/octet-stream" hidden></label>
    <button id="byop-start-saved" type="button" hidden>ИГРАТЬ С СОХРАНЁННЫМ ROM</button>
    <button id="byop-change" type="button" hidden>СМЕНИТЬ ROM</button>
    <button id="byop-install" type="button" hidden>УСТАНОВИТЬ ИГРУ</button>
    <div id="byop-progress" class="byop-indeterminate" hidden role="progressbar"><span id="byop-fill"></span></div>
    <p id="byop-hint" class="byop-small">ROM не отправляется на сервер: сборка идёт на устройстве.</p>
    <button id="byop-retry" type="button" hidden>ПОВТОРИТЬ</button>`;
  document.body.append(panel);

  ui.panel = panel;
  ui.text = panel.querySelector('#byop-text');
  ui.pick = panel.querySelector('#byop-pick');
  ui.input = panel.querySelector('#byop-rom');
  ui.progress = panel.querySelector('#byop-progress');
  ui.fill = panel.querySelector('#byop-fill');
  ui.hint = panel.querySelector('#byop-hint');
  ui.retry = panel.querySelector('#byop-retry');
  ui.startSaved = panel.querySelector('#byop-start-saved');
  ui.change = panel.querySelector('#byop-change');
  ui.install = panel.querySelector('#byop-install');

  ui.input.addEventListener('change', () => {
    const file = ui.input.files?.[0];
    if (file) chooseRom(file);
  });
  ui.change.addEventListener('click', () => {
    ui.pick.hidden = false;
    ui.startSaved.hidden = true;
    ui.change.hidden = true;
    ui.input.value = '';
    ui.input.click();
  });
  ui.startSaved.addEventListener('click', () => startSavedRom());

  // PWA install: the old version had an install gate; BYOP keeps the game
  // playable immediately and only offers installation when the browser allows it.
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    if (ui.install) ui.install.hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    if (ui.install) ui.install.hidden = true;
  });
  ui.install.addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    try { await installPrompt.userChoice; } catch { /* dismissed */ }
    installPrompt = null;
    ui.install.hidden = true;
  });
  ui.retry.addEventListener('click', () => {
    state.error = null;
    resetUi();
    ui.input.value = '';
    ui.input.click();
  });
}

function resetUi() {
  ui.panel.hidden = false;
  ui.progress.hidden = true;
  ui.retry.hidden = true;
  ui.pick.hidden = false;
  ui.hint.hidden = false;
  ui.text.classList.remove('error');
  ui.text.textContent = 'Выберите ROM Sega Genesis (USA) — игра соберётся из него в этом браузере.';
  ui.hint.textContent = 'ROM не отправляется на сервер: сборка идёт на устройстве.';
  setStatus('idle');
}

function setStatus(phase, detail = '') {
  state.phase = phase;
  window.__BYOP_STATUS__ = { phase, detail };
  const text = detail || PHASE_LABELS[phase] || '';
  if (text) ui.text.textContent = text;
}

function setProgress(fraction) {
  ui.progress.hidden = false;
  ui.progress.classList.remove('byop-indeterminate');
  ui.fill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

function fail(error) {
  state.error = error;
  state.building = false;
  console.error('[byop]', error);
  ui.panel.hidden = false;
  ui.pick.hidden = true;
  ui.progress.hidden = true;
  ui.retry.hidden = false;
  ui.text.classList.add('error');
  ui.text.textContent = `Не удалось запустить игру: ${error?.message || error}`;
  ui.hint.textContent = 'Проверьте файл ROM (USA-версия, 1 048 576 байт) и повторите попытку.';
  setStatus('error', String(error?.message || error));
  window.__BYOP_ERROR__ = String(error?.message || error);
}

/* --------------------------------------------------------------- helpers -- */

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function cacheDir(name, { create = false } = {}) {
  const root = await navigator.storage.getDirectory();
  const rootDir = await root.getDirectoryHandle(CACHE_ROOT, { create });
  return rootDir.getDirectoryHandle(name, { create });
}

/** The built core cached by the worker (`web/app.mjs` uses the same location). */
async function readCachedGame(romSha) {
  const dir = await cacheDir(`rom-${romSha}`, { create: false });
  const file = await (await dir.getFileHandle('game.wasm')).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

/** Legacy `frontend.state.bin` generated on this device for this exact core. */
async function readCachedFrontendState(romSha, gameSha) {
  try {
    const dir = await cacheDir('legacy', { create: false });
    const file = await (await dir.getFileHandle(`frontend-${romSha.slice(0, 16)}-${gameSha.slice(0, 16)}.bin`)).getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    return bytes.length >= IGN_SAVE_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

async function writeCachedFrontendState(romSha, gameSha, bytes) {
  try {
    const dir = await cacheDir('legacy', { create: true });
    const handle = await dir.getFileHandle(`frontend-${romSha.slice(0, 16)}-${gameSha.slice(0, 16)}.bin`, { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
  } catch (error) {
    console.warn('[byop] cannot cache the generated frontend state:', error.message);
  }
}

/* ---------------------------------------------- IndexedDB fallback cache -- */
// WebKit/iOS can expose OPFS but fail every write with UnknownError. IndexedDB
// is a second, widely available cache so those devices do not rebuild forever.

const IDB_NAME = 'dune-byop-cache';
const IDB_STORE = 'blobs';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(IDB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(key) {
  try {
    const db = await idbOpen();
    return await new Promise((resolve, reject) => {
      const request = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
      request.onsuccess = () => resolve(request.result ? new Uint8Array(request.result) : null);
      request.onerror = () => reject(request.error);
    });
  } catch { return null; }
}

async function idbPut(key, bytes) {
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(bytes, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* cache is best effort */ }
}

/* -------------------------------------------------------- saved ROM ----- */

/** Remember the validated ROM in OPFS so a reload does not ask for the file.
 *  It is stored on this device only and is never uploaded/cached by the SW. */
async function saveRomInput(romBytes, name) {
  try {
    const rootDir = await (await navigator.storage.getDirectory()).getDirectoryHandle(CACHE_ROOT, { create: true });
    const dir = await rootDir.getDirectoryHandle('rom-input', { create: true });
    const file = await dir.getFileHandle('rom.bin', { create: true });
    const writable = await file.createWritable();
    await writable.write(romBytes);
    await writable.close();
    const meta = await dir.getFileHandle('rom.json', { create: true });
    const metaWriter = await meta.createWritable();
    await metaWriter.write(new TextEncoder().encode(JSON.stringify({ name: name || 'Dune (USA).gen', sha256: KNOWN_ROM_SHA256, savedAt: Date.now() })));
    await metaWriter.close();
  } catch (error) {
    console.warn('[byop] cannot remember the ROM in OPFS, using IndexedDB:', error.message);
    await idbPut('rom', romBytes);
    try { localStorage.setItem('dune-byop-rom-name', name || 'Dune (USA).gen'); } catch { /* ignore */ }
  }
}

async function readSavedRom() {
  try {
    const rootDir = await (await navigator.storage.getDirectory()).getDirectoryHandle(CACHE_ROOT, { create: false });
    const dir = await rootDir.getDirectoryHandle('rom-input', { create: false });
    const bytes = new Uint8Array(await (await (await dir.getFileHandle('rom.bin')).getFile()).arrayBuffer());
    let name = 'Dune (USA).gen';
    try {
      const meta = JSON.parse(new TextDecoder().decode(await (await (await dir.getFileHandle('rom.json')).getFile()).arrayBuffer()));
      if (meta?.name) name = meta.name;
    } catch { /* name is optional */ }
    if (bytes.length !== ROM_BYTES) return null;
    const digest = await sha256Hex(bytes);
    if (digest !== KNOWN_ROM_SHA256) return null;
    return { bytes, name };
  } catch {
    const bytes = await idbGet('rom');
    if (!bytes || bytes.length !== ROM_BYTES) return null;
    const digest = await sha256Hex(bytes);
    if (digest !== KNOWN_ROM_SHA256) return null;
    let name = 'Dune (USA).gen';
    try { name = localStorage.getItem('dune-byop-rom-name') || name; } catch { /* ignore */ }
    return { bytes, name };
  }
}

async function offerSavedRom() {
  const saved = await readSavedRom();
  if (!saved) return false;
  state.savedRom = saved;
  ui.text.textContent = `Найден сохранённый ROM (${saved.name}). Запускаем игру из памяти устройства…`;
  ui.pick.hidden = true;
  ui.startSaved.hidden = false;
  ui.change.hidden = false;
  setTimeout(() => { if (!state.building && !state.host) startSavedRom(); }, 300);
  return true;
}

function startSavedRom() {
  if (!state.savedRom || state.building || state.host) return;
  ui.startSaved.hidden = true;
  startRom(state.savedRom.bytes, state.savedRom.name, { saved: true });
}

/* ---------------------------------------------------------------- build --- */

function ensureWorker() {
  if (state.worker) return state.worker;
  // The recompiler worker lives at the BYOP root; its relative fetches
  // (reference.json, py-package.zip, vendor/pyodide/) then resolve there too.
  const worker = new Worker('./recompiler.worker.js', { type: 'module' });
  worker.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'state') {
      if (message.label) setStatus(message.phase, message.label);
      else setStatus(message.phase);
      if (Number.isFinite(message.fraction)) setProgress(message.fraction);
    } else if (message.type === 'log') {
      console.log('[recompiler]', message.line);
    } else if (message.type === 'rom') {
      if (Number.isFinite(message.romBytes)) ui.hint.textContent = `ROM ${message.romBytes} байт · SHA-256 ${String(message.romSha256).slice(0, 16)}…`;
    }
  });
  state.worker = worker;
  return worker;
}

function buildCore(romBytes) {
  return new Promise((resolve, reject) => {
    const worker = ensureWorker();
    const onMessage = (event) => {
      const message = event.data;
      if (message.type === 'result') {
        worker.removeEventListener('message', onMessage);
        if (message.result?.ok) resolve(message.result);
        else reject(new Error(message.result?.error || 'сборка не удалась'));
      } else if (message.type === 'error') {
        worker.removeEventListener('message', onMessage);
        reject(new Error(message.message || 'сборка не удалась'));
      }
    };
    worker.addEventListener('message', onMessage);
    const copy = romBytes.slice();
    worker.postMessage({ type: 'build', romBytes: copy, force: false }, [copy.buffer]);
  });
}

/* ----------------------------------------------------------------- host --- */

async function bootHost(romBytes, gameBytes) {
  const canvas = document.getElementById('canvas');
  const host = new DuneHost({
    canvas,
    log: (line) => console.log('[host]', line),
  });
  await host.init({ gameBytes });
  await host.loadRomFromBytes(romBytes);
  host.boot();
  state.host = host;
  return host;
}

async function prepareFrontendState(host, romSha, gameSha) {
  const cached = await readCachedFrontendState(romSha, gameSha);
  window.__BYOP_FIXTURE__ = cached ? 'cached' : 'generated';
  if (cached) {
    if (!host.loadState(cached)) throw new Error('сохранённое состояние главного меню не принято ядром');
    // A fresh load reports the native scene as "unknown" until the game runs its
    // next poll (~100k instructions, a few frames); then it is back on "main".
    host.advanceSteps(120_000);
    setStatus('state', 'Состояние главного меню взято из памяти устройства');
    return cached;
  }
  setStatus('fast-forward', 'Прокручиваем оригинальное интро до главного меню');
  // Chunked on purpose: iPhone Safari kills the tab on a single very long
  // synchronous task, and the first launch (no cached fixture yet) used to do
  // all ~26M instructions in one go. Yielding keeps the boot screen alive.
  const chunk = 1_000_000;
  for (let done = 0; done < FAST_FORWARD_INSTRUCTIONS; done += chunk) {
    host.advanceInstructions(chunk, { maxSteps: 300_000_000 });
    const percent = Math.min(99, Math.round(((done + chunk) / FAST_FORWARD_INSTRUCTIONS) * 100));
    setStatus('fast-forward', `Прокручиваем оригинальное интро… ${percent}%`);
    if (done % (chunk * 4) === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const readCampaign = () => {
    const pointer = host.exports.dune_web_campaign_json();
    const bytes = new Uint8Array(host.memory.buffer, pointer);
    let end = 0;
    while (end < bytes.length && bytes[end]) end += 1;
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, end)));
  };
  const campaign = readCampaign();
  if (campaign.scene !== 'main' || campaign.sceneReady !== true) {
    throw new Error(`интро не дошло до главного меню (scene=${campaign.scene})`);
  }
  const bytes = host.saveState();
  if (!bytes || bytes.length < IGN_SAVE_BYTES) throw new Error('ядро не отдало состояние главного меню');
  await writeCachedFrontendState(romSha, gameSha, bytes);
  setStatus('state', `Состояние главного меню снято (${bytes.length} Б)`);
  return bytes;
}

/* --------------------------------------------------------------- facade --- */

/**
 * Attach the old Emscripten `Module` surface to the BYOP runtime.
 *
 * Every `dune_*` runtime export becomes `Module._dune_*`, which is exactly what
 * the legacy frontend calls (`_dune_web_frame_rgb`, `_dune_save_state_to_buffer`,
 * `_dune_web_audio_worklet`, …).  The few APIs that also need host bookkeeping
 * are wrapped explicitly.
 */
function attachFacade(Module, host) {
  if (!Module || Module.__byopAttached) return Module;
  Module.__byopAttached = true;
  const exports = host.exports;
  for (const name of Object.keys(exports)) {
    if (!name.startsWith('dune_')) continue;
    const value = exports[name];
    if (typeof value !== 'function') continue;
    Module[`_${name}`] = (...args) => value(...args);
  }

  // Linear memory can grow, so views must be created on every access.
  const memoryView = (name, Ctor) => Object.defineProperty(Module, name, {
    configurable: true,
    get: () => new Ctor(host.memory.buffer),
  });
  memoryView('HEAPU8', Uint8Array);
  memoryView('HEAPU32', Uint32Array);
  memoryView('HEAP32', Int32Array);
  Module.UTF8ToString = (pointer) => host.readCString(pointer);

  // Keep the path-A virtual SDL surface in sync with the CSS size the legacy
  // shell reports (the old Emscripten `emscripten_get_element_css_size` did the
  // same); camera/tap adapters then see real CSS pixels.
  Module._dune_web_resize = (width, height) => {
    if (host.virtualWindow) {
      host.virtualWindow.width = Math.max(1, Math.round(width));
      host.virtualWindow.height = Math.max(1, Math.round(height));
    }
    return exports.dune_web_resize(width, height);
  };

  // Saving/loading goes through the host so metrics and the audio bridge stay in
  // sync (the legacy frontend writes the payload into HEAPU8 first, which is the
  // same linear memory the host reads).
  Module._dune_save_state_to_buffer = () => exports.dune_save_state_to_buffer();
  Module._dune_get_save_buffer = () => exports.dune_get_save_buffer();
  Module._dune_load_state_from_buffer = (size) => {
    const ok = exports.dune_load_state_from_buffer(size);
    if (ok) {
      host.advanceSteps(0);
      try { host.audio?.flush?.(); } catch { /* audio is optional */ }
    }
    return ok;
  };

  // The legacy AudioWorklet bridge needs the Emscripten `SDL2` object; path A
  // has no SDL, so the bridge falls back to silent SDL output.  Expose the
  // native level setter so the frontend's MUSIC/SOUND controls still reach the
  // synth, and let our DuneAudio bridge own the actual PCM output.
  Module._dune_web_audio_levels = (music, sound) => {
    try { host.audio?.setLevels?.(music, sound); } catch { /* ignore */ }
    return exports.dune_web_audio_levels(music, sound);
  };
  return Module;
}

/* -------------------------------------------------------------- plumbing -- */

function installFetchFixture(frontendState) {
  const original = window.fetch.bind(window);
  const blob = new Blob([frontendState], { type: 'application/octet-stream' });
  // The old site published a few ROM-derived native snapshots (credits/demo)
  // that BYOP must not commit. They are served from the same origin by the old
  // deployment, so credits replay can still use them when that site is online;
  // locally/offline the fetch fails and the old frontend shows its own error.
  const LEGACY_FIXTURE = /(^|\/)(credits\/house-[012]\.state\.bin|demo-harkonnen\.state\.bin|demo\.state\.bin)(?:[?#]|$)/;
  const legacyFetch = async (raw, input, init) => {
    let response = null;
    try { response = await original(input, init); } catch (error) { if (!LEGACY_FIXTURE.test(raw)) throw error; }
    if (response?.ok || !LEGACY_FIXTURE.test(raw)) return response;
    try {
      const path = raw.replace(/^\.\//, '').replace(/^\/+/, '');
      const fallback = await original(new URL(`../dune-sega-web/${path}`, location.href).href, { cache: 'force-cache' });
      if (fallback.ok) return fallback;
    } catch { /* old site unavailable: keep the original 404 */ }
    return response;
  };
  window.fetch = (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (typeof raw === 'string' && /(^|\/)frontend\.state\.bin(?:[?#]|$)/.test(raw)) {
      return Promise.resolve(new Response(blob, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }));
    }
    return legacyFetch(raw, input, init);
  };
}

function installStartupHooks() {
  const startup = window.duneStartup;
  if (!startup) return;
  const finish = startup.finish.bind(startup);
  startup.finish = () => {
    finish();
    hideBootScreen();
  };
  const fail = startup.fail.bind(startup);
  startup.fail = () => {
    fail();
    failScreen('Не удалось подготовить интерфейс');
  };
}

function hideBootScreen() {
  ui.panel.hidden = true;
  window.__BYOP_READY__ = true;
}

function failScreen(message) {
  ui.panel.hidden = false;
  ui.pick.hidden = true;
  ui.progress.hidden = true;
  ui.retry.hidden = false;
  ui.text.classList.add('error');
  ui.text.textContent = message;
}

/* ------------------------------------------------------------------ main -- */

async function chooseRom(file) {
  if (state.building) return;
  if (file.size !== ROM_BYTES) {
    fail(new Error(`нужно ровно ${ROM_BYTES} байт, а у файла ${file.size}`));
    return;
  }
  const romBytes = new Uint8Array(await file.arrayBuffer());
  startRom(romBytes, file.name);
}

async function startRom(romBytes, name, { saved = false } = {}) {
  if (state.building || state.host) return;
  state.building = true;
  state.error = null;
  ui.pick.hidden = true;
  ui.startSaved.hidden = true;
  ui.change.hidden = true;
  ui.retry.hidden = true;
  ui.progress.hidden = false;
  ui.progress.classList.add('byop-indeterminate');
  try {
    state.romBytes = romBytes;
    state.romSha = await sha256Hex(romBytes);
    if (state.romSha !== KNOWN_ROM_SHA256) {
      throw new Error('этот дамп не поддерживается — нужна USA-версия Dune: The Battle for Arrakis');
    }
    ui.hint.textContent = `ROM ${romBytes.length} байт · SHA-256 ${state.romSha.slice(0, 16)}…`;
    window.__BYOP_ROM_SHA__ = state.romSha;
    saveRomInput(romBytes, name);
    // If this ROM was built before, use the cached core directly: no Worker,
    // no Pyodide, no network. This makes repeat launches instant and lets the
    // game start fully offline.
    try {
      const cached = await readCachedGame(state.romSha);
      if (cached && cached.length > 1024) {
        state.gameBytes = cached;
        state.gameSha = await sha256Hex(cached);
        setStatus('cache_read', 'Игра уже собрана — запускаем из памяти устройства');
      }
    } catch { /* no OPFS cache yet */ }
    if (!state.gameBytes) {
      const idbCore = await idbGet(`core-${state.romSha}`);
      if (idbCore && idbCore.length > 1024) {
        state.gameBytes = idbCore;
        state.gameSha = await sha256Hex(idbCore);
        setStatus('cache_read', 'Игра уже собрана — запускаем из памяти устройства');
      }
    }

    if (!state.gameBytes) {
      setStatus('build', 'Собираем игру из ROM…');
      const result = await buildCore(romBytes);
      state.gameSha = result.output_sha256 || result.game_sha256;
      // The worker transfers the built core back, so the game can start even if
      // this browser's OPFS is unusable (WebKit/iOS may fail createWritable).
      if (result.core_bytes && result.core_bytes.length > 1024) {
        state.gameBytes = result.core_bytes instanceof Uint8Array ? result.core_bytes : new Uint8Array(result.core_bytes);
      }
      // Release Pyodide and the worker as soon as the core is available: on an
      // iPhone the ~100 MB recompiler heap is exactly what pushes Safari into
      // killing the tab right after the first boot/music.
      try { state.worker?.terminate?.(); } catch { /* ignore */ }
      state.worker = null;
      console.log('[byop] recompiler worker released');
      if (!state.gameBytes) {
        setStatus('load', 'Загружаем ядро игры…');
        state.gameBytes = await readCachedGame(state.romSha);
      }
    }
    const gameBytes = state.gameBytes;
    if (!saved && gameBytes && gameBytes.length > 1024) idbPut(`core-${state.romSha}`, gameBytes);

    const host = await bootHost(romBytes, gameBytes);
    setStatus('boot', 'Запускаем оригинальную игру…');
    const frontendState = await prepareFrontendState(host, state.romSha, state.gameSha);
    state.frontendState = frontendState;
    installFetchFixture(frontendState);

    // The legacy frontend owns the #canvas now: the host keeps emulating and
    // re-frames the native 320x224 screen (expanded overview on the mission map)
    // like the old SDL presentation did.
    host.setPresentation?.('auto');
    host.expandedIntervalMs = 16; // old SDL presentation ran at display refresh
    host.start();

    // A gesture already happened (file picker click), so bring up audio once.
    host.audio?.enable?.({ music: 100, sound: 100 }).then(
      () => console.log('[byop] audio enabled'),
      (error) => console.warn('[byop] audio unavailable:', error.message),
    );
    // Chrome/Safari may keep the context suspended when the build took longer
    // than the user activation window: resume it on the first real gesture.
    const resumeAudioOnGesture = () => {
      try {
        host.audio?.resume?.()?.catch?.(() => {});
        host.audio?.enable?.({ music: 100, sound: 100 }).catch(() => {});
      } catch { /* audio is optional */ }
    };
    window.addEventListener('pointerdown', resumeAudioOnGesture, { capture: true, once: true });
    window.addEventListener('keydown', resumeAudioOnGesture, { capture: true, once: true });

    // Minimising the app must not leave a backlog: pause the device clock while
    // hidden, then drop queued PCM and restart cleanly on return (otherwise the
    // first seconds after resume sound delayed/garbled).
    const onVisibility = () => {
      try {
        if (document.hidden) {
          host.audio?.suspend?.();
          host.audio?.flush?.();
        } else {
          host.audio?.flush?.();
          host.audio?.resume?.()?.catch?.(() => {});
          setTimeout(() => host.audio?.pump?.(), 60);
        }
      } catch { /* audio is optional */ }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', () => { try { host.audio?.suspend?.(); } catch { /* ignore */ } });
    window.addEventListener('pageshow', () => { try { host.audio?.flush?.(); host.audio?.resume?.()?.catch?.(() => {}); } catch { /* ignore */ } });

    // The old engine received keyboard input through SDL; the BYOP runtime has no
    // SDL event pipe, so forward the original Sega pad bits ourselves. This is
    // what lets a desktop player advance the native intro/briefing with A/Start.
    const KEY_PAD = { KeyZ: 64, KeyX: 16, KeyC: 32, Enter: 128, NumpadEnter: 128 };
    const inNativeStoryScene = () => {
      const ui = window.__DUNE_UI__;
      const scene = ui?.state?.scene;
      if (!ui || ui.view !== 'native' || !scene) return false;
      return !['main', 'house', 'options', 'map', 'pause', 'building'].includes(scene);
    };
    const forwardPadKey = (event, down) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (!inNativeStoryScene()) return;
      const bit = KEY_PAD[event.code];
      if (!bit) return;
      try {
        host.exports.dune_web_pad(bit, down ? 1 : 0);
      } catch { /* runtime without the pad export */ }
    };
    window.addEventListener('keydown', (event) => forwardPadKey(event, true), true);
    window.addEventListener('keyup', (event) => forwardPadKey(event, false), true);
    window.addEventListener('blur', () => {
      for (const bit of Object.values(KEY_PAD)) {
        try { host.exports.dune_web_pad(bit, 0); } catch { /* ignore */ }
      }
    });

    // Native briefing/cutscene screens have no HTML controls until their last
    // page, so a first-time player may think the game is stuck. Show a small
    // hint like the old touch UX did.
    const hint = document.createElement('div');
    hint.id = 'byop-native-hint';
    hint.textContent = 'ТАП / КЛИК — ДАЛЕЕ';
    hint.style.cssText = 'position:fixed;z-index:8;right:12px;bottom:calc(env(safe-area-inset-bottom) + 14px);padding:6px 10px;background:#191b1de0;border:1px solid #8b8b8488;color:#e2e2de;font:12px/1 monospace;letter-spacing:.08em;pointer-events:none;opacity:0;transition:opacity .3s';
    if (document.body) document.body.append(hint);
    else document.addEventListener('DOMContentLoaded', () => document.body.append(hint));
    let hintTimer = 0;
    const updateNativeHint = () => {
      const ui = window.__DUNE_UI__;
      const scene = ui?.state?.scene;
      const show = !!ui && ui.view === 'native' && typeof scene === 'string' && scene.includes('briefing');
      hint.style.opacity = show ? '1' : '0';
    };
    hintTimer = window.setInterval(updateNativeHint, 800);

    window.duneByop = {
      ready: true,
      host,
      romBytes,
      romSha: state.romSha,
      gameSha: state.gameSha,
      frontendState,
      attach: (Module) => attachFacade(Module, host),
      status: () => ({ ...state, host: undefined, worker: undefined }),
    };
    window.__DUNE_HOST = host;
    window.__BYOP_HOST__ = host;

    window.__BYOP_TIMINGS__ = { ...(window.__BYOP_TIMINGS__ || {}), shellAt: Date.now() };
    setStatus('shell', 'Передаём управление старому интерфейсу…');
    installStartupHooks();
    const shellWatchdog = setTimeout(() => {
      if (window.__DUNE_UI__) return;
      ui.panel.hidden = false;
      ui.pick.hidden = true;
      ui.startSaved.hidden = true;
      ui.change.hidden = false;
      ui.progress.hidden = true;
      ui.retry.hidden = false;
      ui.text.classList.add('error');
      ui.text.textContent = 'Интерфейс игры не запустился. Перезагрузите страницу или пришлите отчёт диагностики (?diag=1).';
      setStatus('error', 'shell import did not finish');
      window.__BYOP_ERROR__ = 'shell import did not finish';
    }, 45000);
    await import('./shell.js');
    clearTimeout(shellWatchdog);
    // The shell can import successfully and still leave a blank home screen
    // (asset/layout failure on a phone). Surface that instead of a black page.
    const health = setInterval(() => {
      if (!window.__DUNE_UI__) return;
      clearInterval(health);
      setTimeout(() => {
        if (!window.__DUNE_UI__) return;
        const ui = window.__DUNE_UI__;
        const visible = [...document.querySelectorAll('button, [role="button"]')].some((element) => element.offsetWidth > 0 && element.offsetHeight > 0);
        if (ui.view === 'home' && !visible) {
          ui.panel.hidden = false;
          ui.pick.hidden = true;
          ui.startSaved.hidden = true;
          ui.change.hidden = false;
          ui.progress.hidden = true;
          ui.retry.hidden = false;
          ui.text.classList.add('error');
          ui.text.textContent = 'Интерфейс загрузился, но главный экран не отрисовался. Нажмите «Перезагрузить» или пришлите отчёт (?diag=1).';
          setStatus('error', 'home screen has no visible controls');
          window.__BYOP_ERROR__ = 'home screen has no visible controls';
        }
      }, 3000);
    }, 400);
    window.__BYOP_SHELL_IMPORTED__ = true;
    // shell.js hides the old boot screen through startup.finish(); keep ours up
    // until the legacy interface reports ready (or 30 s pass on a slow device).
    setTimeout(() => { if (!window.__BYOP_READY__) hideBootScreen(); }, 30_000);
  } catch (error) {
    fail(error);
  } finally {
    state.building = false;
  }
}

mountBootScreen();
window.__BYOP_BOOT__ = { state, chooseRom };
if (typeof window.__BYOP_STATUS__ === 'undefined') setStatus('idle');
// A previously validated ROM stays on this device, so a reload should not ask
// for the file again; ?rom=pick forces the picker (e.g. to switch dumps).
if (new URLSearchParams(location.search).get('rom') !== 'pick') {
  offerSavedRom().catch((error) => console.warn('[byop] saved ROM unavailable:', error.message));
}
