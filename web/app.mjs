// Dune — BYOP shell: three screens (choose ROM → build → ready), saves sheet,
// and a collapsed "details" block for diagnostics. Built for phones first.

const $ = (id) => document.getElementById(id);
const romInput = $('rom-input');
const dropZone = $('drop');
const ringValue = $('ring-value');
const circumference = 364.4;

const PHASES = {
  pyodide: { target: 0.04, title: 'Загружаем инструменты', step: 0 },
  unpack: { target: 0.08, title: 'Загружаем инструменты', step: 0 },
  validate_rom: { target: 0.12, title: 'Проверяем файл', step: 1 },
  z80_images: { target: 0.15, title: 'Проверяем файл', step: 1 },
  entry_discovery: { target: 0.70, title: 'Ищем код игры', step: 2 },
  translate_emit: { target: 0.96, title: 'Собираем игру', step: 3 },
  hash_output: { target: 0.99, title: 'Проверяем результат', step: 4 },
  cache_read: { target: 1.0, title: 'Берём из памяти устройства', step: 4 },
  cache: { target: 1.0, title: 'Сохраняем на устройстве', step: 4 },
};

const state = {
  romBytes: null,
  romSha: null,
  worker: null,
  building: false,
  result: null,
  reference: null,
  host: null,
  input: null,
  building: null,
  buildingTimer: 0,
  lastBuildingPointer: 0,
  log: [],
};

const KNOWN_ROM_SHA256 = 'b1bbe73186e0902fa8b2db0f227bf306e3d6a80fe592f927d1aa9d60c0f335ba';

// ---------- helpers ----------
function screen(name) {
  for (const id of ['screen-setup', 'screen-progress', 'screen-ready', 'screen-error', 'screen-game']) {
    $(id).classList.toggle('hidden', id !== `screen-${name}`);
  }
  document.body.classList.toggle('playing', name === 'game');
}

function log(line) {
  state.log.push(`[${new Date().toLocaleTimeString('ru-RU')}] ${line}`);
  if (state.log.length > 400) state.log.shift();
  $('detail-log').textContent = state.log.slice(-120).join('\n');
}

let progressCurrent = 0;
let progressTarget = 0;
let progressTimer = null;

function paintPct(value) {
  const pct = Math.max(0, Math.min(1, value));
  ringValue.style.strokeDashoffset = String(circumference * (1 - pct));
  $('pct').textContent = `${Math.round(pct * 100)}%`;
}

function creep() {
  if (progressCurrent < progressTarget) {
    progressCurrent = Math.min(progressTarget, progressCurrent + Math.max(0.003, (progressTarget - progressCurrent) * 0.08));
  }
  paintPct(progressCurrent);
}

function setPct(value) {
  progressTarget = Math.max(0, Math.min(1, value));
  if (progressCurrent > progressTarget) progressCurrent = progressTarget;
  if (progressTimer) return;
  progressTimer = setInterval(() => {
    creep();
    if (Math.abs(progressTarget - progressCurrent) < 0.001) {
      clearInterval(progressTimer);
      progressTimer = null;
    }
  }, 120);
}

function setPhase(phase, fraction) {
  const meta = PHASES[phase] || { target: 0.5, title: 'Готовим игру', step: 2 };
  const target = Math.max(progressTarget, meta.target);
  setPct(target);
  $('progress-title').textContent = meta.title;
  const steps = $('steps').children;
  for (let i = 0; i < steps.length; i += 1) steps[i].classList.toggle('on', i <= meta.step);
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function short(value) {
  return value ? `${value.slice(0, 16)}…` : '—';
}

function fmtSeconds(seconds) {
  if (seconds == null) return '—';
  if (seconds < 1) return `${Math.round(seconds * 1000)} мс`;
  return `${seconds.toFixed(seconds < 10 ? 1 : 0)} с`;
}

function bytesLabel(bytes) {
  if (bytes == null) return '—';
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} МиБ` : `${bytes} Б`;
}

// ---------- choosing a ROM ----------
async function chooseRom(file) {
  if (!file) return;
  if (state.building) return;
  if (file.size !== 1048576) {
    showError(`Это не тот файл: нужно ровно 1 048 576 байт, а у вас ${file.size.toLocaleString('ru-RU')}.`);
    return;
  }
  state.romBytes = new Uint8Array(await file.arrayBuffer());
  state.romSha = await sha256Hex(state.romBytes);
  $('detail-rom').textContent = `${short(state.romSha)} · ${bytesLabel(state.romBytes.length)} · ${file.name}`;
  log(`ROM: ${file.name}, ${state.romBytes.length} Б, SHA-256 ${state.romSha}`);
  if (state.romSha !== KNOWN_ROM_SHA256) {
    showError('Этот дамп не поддерживается. Нужна USA-версия Dune: The Battle for Arrakis.');
    return;
  }
  startBuild(false);
}

dropZone.addEventListener('dragenter', (event) => { event.preventDefault(); dropZone.classList.add('over'); });
dropZone.addEventListener('dragover', (event) => event.preventDefault());
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
dropZone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropZone.classList.remove('over');
  chooseRom(event.dataTransfer?.files?.[0]);
});
romInput.addEventListener('change', () => chooseRom(romInput.files?.[0]));

// ---------- worker ----------
function ensureWorker() {
  if (state.worker) return state.worker;
  const worker = new Worker('./recompiler.worker.js', { type: 'module' });
  worker.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'state') {
      setPhase(message.phase, message.fraction);
    } else if (message.type === 'log') {
      log(message.line);
    } else if (message.type === 'result') {
      onResult(message.result);
    } else if (message.type === 'error') {
      log(message.message);
      showError('Сборка не удалась. Попробуйте другой ROM.');
    }
  });
  state.worker = worker;
  return worker;
}

function startBuild(force) {
  if (!state.romBytes || state.building) return;
  state.building = true;
  state.result = null;
  progressCurrent = 0;
  progressTarget = 0;
  paintPct(0);
  screen('progress');
  setPhase('pyodide', 0.01);
  $('progress-hint').textContent = 'Не закрывайте вкладку — сборка идёт на этом устройстве.';
  const copy = state.romBytes.slice();
  ensureWorker().postMessage({ type: 'build', romBytes: copy, force }, [copy.buffer]);
}

// ---------- result ----------
function onResult(result) {
  state.building = false;
  state.result = result;
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
  progressCurrent = 1;
  paintPct(1);
  (window.__BUILD_RESULTS ||= []).push(result);
  if (!result.ok) {
    log(`Результат: ${result.error || 'ошибка'} ${result.output_sha256 || ''}`);
    showError(result.output_sha256
      ? 'Собранное ядро не совпало с эталоном — подробности в «Подробностях».'
      : 'Не удалось собрать игру. Попробуйте другой ROM.');
    return;
  }
  $('detail-core').textContent = `${short(result.output_sha256)} · ${bytesLabel(result.output_bytes)}${result.cached ? ' · из кэша' : ''}`;
  $('detail-time').textContent = result.cached ? 'из памяти устройства' : fmtSeconds(result.total_seconds);
  log(`Готово: ${result.output_sha256} (${result.output_bytes} Б)${result.cached ? ' [кэш]' : ''}`);
  $('ready-title').textContent = result.cached ? 'Игра уже собрана' : 'Игра собрана';
  $('ready-hint').textContent = 'Нажмите «Играть» — запустится оригинальная игра с вашего ROM.';
  const play = $('play');
  play.disabled = false;
  screen('ready');
}

function showError(text) {
  state.building = false;
  $('error-text').textContent = text;
  screen('error');
  log(`Ошибка: ${text}`);
}

$('error-retry').addEventListener('click', () => {
  screen('setup');
  romInput.value = '';
  romInput.click();
});

$('rebuild').addEventListener('click', () => startBuild(true));

// ---------- playing ----------
async function readCachedGame() {
  const root = await navigator.storage.getDirectory();
  const rootDir = await root.getDirectoryHandle('dune-web', { create: false });
  const romDir = await rootDir.getDirectoryHandle(`rom-${state.romSha}`, { create: false });
  const file = await (await romDir.getFileHandle('game.wasm')).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

function gameVirtualWindow() {
  const stage = document.querySelector('.game-stage');
  const width = stage?.clientWidth || window.innerWidth;
  const height = stage?.clientHeight || window.innerHeight;
  if (!(width > 0) || !(height > 0)) return null;
  // Same framing as the old port: portrait grows the world vertically, landscape
  // grows it horizontally; the native 320x224 screens stay intact elsewhere.
  if (height >= width) return { width: 320, height: Math.round((320 * height) / width) };
  return { width: Math.round((224 * width) / height), height: 224 };
}

let viewportFrame = 0;
function syncGameViewport() {
  if (!state.host) return;
  const virtual = gameVirtualWindow();
  if (!virtual) return;
  state.host.attachVirtualWindow?.(virtual);
  state.input?.setVirtualWindow?.(virtual.width, virtual.height);
  state.host.refreshPresentation?.();
  log(`Окно игры: ${virtual.width}x${virtual.height}`);
}

// A resize event reports the *previous* layout; wait two animation frames so
// the stage has its final size before the virtual window is recomputed.
function scheduleGameViewportSync() {
  if (viewportFrame) cancelAnimationFrame(viewportFrame);
  viewportFrame = requestAnimationFrame(() => {
    viewportFrame = requestAnimationFrame(() => {
      viewportFrame = 0;
      syncGameViewport();
    });
  });
}

function gameLoading(visible, text) {
  $('game-loading').classList.toggle('hidden', !visible);
  $('game-loading-text').textContent = text || 'Запускаем игру…';
}

async function startPlay({ resume = false } = {}) {
  if (state.host || !state.romBytes) return;
  screen('game');
  gameLoading(true, 'Запускаем игру…');
  try {
    const gameBytes = await readCachedGame();
    const { DuneHost } = await import('./host/host.mjs');
    const host = new DuneHost({
      canvas: $('game-canvas'),
      runtimeUrl: './runtime/runtime.wasm',
      log: (line) => log(`host: ${line}`),
    });
    state.host = host;
    await host.init({ gameBytes });
    await host.loadRomFromBytes(state.romBytes);
    host.boot();
    const saved = resume ? campaignStore?.resumable?.() : null;
    if (saved?.state) {
      // Continue exactly where the player stopped: the native save carries the
      // whole machine state, so no intro fast-forward is needed.
      try {
        if (!host.loadState(base64ToBytes(saved.state))) throw new Error('load rejected');
        host.drawFrame?.();
        log('Продолжаем сохранённую миссию');
      } catch (error) {
        log(`Продолжение недоступно: ${error.message}`);
      }
    }
    if (!saved?.state) {
      // Fast-forward the SEGA/Virgin title sequence and open the main menu, so the
      // player lands on something interactive within a second instead of waiting
      // through the 40-second intro at real time.
      try {
        host.advanceInstructions(26_000_000, { maxSteps: 300_000_000 });
        host.pressStart({ holdSteps: 200_000, settleSteps: 100_000 });
        host.drawFrame?.();
      } catch (error) {
        log(`fast-forward skipped: ${error.message}`);
      }
    }
    host.start();
    host.setPresentation?.('auto');
    // Audio requires a user gesture: this call runs from the Играть click chain.
    host.audio?.enable?.().then((state) => {
      if (state) log(`Звук включён (${host.audio.stats?.().sampleRate || 48000} Гц)`);
      updateSoundButton();
    }).catch((error) => log(`Звук недоступен: ${error.message}`));
    host.refreshPresentation?.();
    window.__DUNE_HOST = host;
    const { createInputLayer } = await import('./input/index.mjs');
    state.input = createInputLayer({
      host,
      canvas: $('game-canvas'),
      isInputCaptured: () => !state.host || !$('game-sheet').classList.contains('hidden') || Boolean(state.building?.active),
      onStatus: (snapshot) => {
        window.__DUNE_INPUT = snapshot;
        updateHud(snapshot);
      },
      onOrder: (order) => {
        log(`input: ${order.type}`);
        // A double tap on an own building should always reach the native menu.
        // From an unselected state the two taps only select; nudge once more.
        if (order.type === 'select' && order.hit?.target?.kind === 'building' && order.hit.target.own) {
          // Tapping an already selected own building opens its native console.
          if (state.lastBuildingPointer === order.hit.target.pointer) {
            setTimeout(() => {
              if (state.host && !state.host.buildingUi?.()?.active) {
                state.host.call('dune_web_select_screen', order.x, order.y);
                setTimeout(refreshBuildingMenu, 300);
              }
            }, 160);
          }
          state.lastBuildingPointer = order.hit.target.pointer;
        } else if (order.type !== 'building-menu') {
          state.lastBuildingPointer = 0;
        }
        if (order.type === 'building-menu') {
          setTimeout(() => {
            if (state.host && !state.host.buildingUi?.()?.active) {
              state.host.call('dune_web_select_screen', order.x, order.y);
              setTimeout(refreshBuildingMenu, 350);
            }
          }, 240);
        }
      },
    });
    syncGameViewport();
    window.__DUNE_APP = { refreshBuildingMenu, state };
    state.buildingTimer = setInterval(refreshBuildingMenu, 160);
    window.addEventListener('resize', scheduleGameViewportSync);
    window.addEventListener('orientationchange', scheduleGameViewportSync);
    gameLoading(false);
    log(`Игра запущена: ${host.metrics?.instructions ?? 0} инструкций, кадры ${host.metrics?.renderedFrames ?? 0}`);
    // Keep the screen awake during play where the API exists.
    try { await navigator.wakeLock?.request?.('screen'); } catch { /* optional */ }
  } catch (error) {
    state.host = null;
    gameLoading(true, 'Не удалось запустить игру');
    log(`Ошибка запуска: ${error && error.stack ? error.stack : error}`);
    setTimeout(() => {
      screen('ready');
      $('ready-hint').textContent = 'Запуск не удался на этом устройстве — подробности в «Подробностях».';
    }, 1500);
  }
}

function stopPlay() {
  $('game-hud').hidden = true;
  if (state.buildingTimer) clearInterval(state.buildingTimer);
  state.buildingTimer = 0;
  state.building = null;
  $('building-cells').hidden = true;
  document.body.classList.remove('building-mode');
  state.input?.destroy?.();
  state.input = null;
  if (state.host) {
    try { state.host.destroy(); } catch { /* ignore */ }
    state.host = null;
  }
  window.__DUNE_HOST = null;
  screen('ready');
}

$('play').addEventListener('click', () => startPlay({ resume: !!campaignStore?.resumable?.() }));
$('new-game').addEventListener('click', () => startPlay({ resume: false }));
$('hud-b').addEventListener('click', () => hudAction('confirm'));
$('hud-place').addEventListener('click', () => hudAction('confirm'));
$('hud-clear').addEventListener('click', () => hudAction('clear'));

// On-screen pad: press on pointerdown, release on pointerup/cancel/leave.
for (const button of document.querySelectorAll('[data-pad]')) {
  const mask = Number(button.dataset.pad);
  const press = (event) => { event.preventDefault(); state.host?.pad(mask, true); };
  const release = (event) => { event.preventDefault(); state.host?.pad(mask, false); };
  button.addEventListener('pointerdown', press);
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('pointerleave', release);
}

// Keyboard: arrows + Z/X/C + Enter/Space map to the Sega pad.
const KEY_MASKS = {
  ArrowUp: 1, ArrowDown: 2, ArrowLeft: 4, ArrowRight: 8,
  KeyZ: 64, KeyX: 16, KeyC: 32, Enter: 128, Space: 32,
};
window.addEventListener('keydown', (event) => {
  const mask = KEY_MASKS[event.code];
  if (!mask || !state.host) return;
  event.preventDefault();
  state.host.pad(mask, true);
});
window.addEventListener('keyup', (event) => {
  const mask = KEY_MASKS[event.code];
  if (!mask || !state.host) return;
  event.preventDefault();
  state.host.pad(mask, false);
});

// ---------- in-game menu and saves ----------
function readCString(memory, pointer) {
  if (!memory || !pointer) return '';
  const bytes = new Uint8Array(memory.buffer, pointer);
  let end = 0;
  while (end < bytes.length && bytes[end] !== 0) end += 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

function campaignJson() {
  const host = state.host;
  try {
    if (!host?.exports?.dune_web_campaign_json) return null;
    return JSON.parse(readCString(host.memory, host.exports.dune_web_campaign_json()));
  } catch {
    return null;
  }
}

function currentRun() {
  const json = campaignJson();
  if (!json || json.activeRunArmed !== 1) return null;
  const house = json.activeRunHouse;
  const mission = json.activeRunMission;
  if (!Number.isInteger(house) || !Number.isInteger(mission)) return null;
  if (house < 0 || house > 2 || mission < 1 || mission > 9) return null;
  return { house, mission };
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function setGameStatus(text) {
  $('game-sheet-status').textContent = text;
}

function openGameMenu() {
  $('game-sheet').classList.remove('hidden');
  const run = currentRun();
  setGameStatus(run ? 'Можно сохранить текущую миссию.' : 'Сохранение станет доступно в миссии.');
  $('game-save').disabled = !run;
  if (campaignStore?.current) saveGame(false);
}

function closeGameMenu() {
  $('game-sheet').classList.add('hidden');
}

function saveGame(manual = true) {
  const host = state.host;
  const run = currentRun();
  if (!host || !run || !campaignStore) {
    if (manual) setGameStatus('Сохранение станет доступно в миссии.');
    return false;
  }
  try {
    const bytes = host.saveState();
    if (!bytes || !bytes.length) throw new Error('empty save');
    if (!campaignStore.saveSlot(run.house, run.mission, bytesToBase64(bytes))) throw new Error('storage');
    if (!manual) return true;
    const names = ['HARKONNEN', 'ATREIDES', 'ORDOS'];
    setGameStatus(`Сохранено: ${names[run.house]}, миссия ${run.mission}.`);
    return true;
  } catch (error) {
    if (manual) setGameStatus('Не удалось сохранить на этом устройстве.');
    log(`save failed: ${error.message}`);
    return false;
  }
}

function loadGame() {
  const host = state.host;
  if (!host || !campaignStore) return false;
  const slot = campaignStore.resumable();
  if (!slot) {
    setGameStatus('Сохранений пока нет.');
    return false;
  }
  try {
    if (!host.loadState(base64ToBytes(slot.state))) throw new Error('load rejected');
    host.drawFrame?.();
    setGameStatus('Сохранение загружено.');
    return true;
  } catch (error) {
    setGameStatus('Сохранение не подошло к этой сборке.');
    log(`load failed: ${error.message}`);
    return false;
  }
}

function updateContinueButtons() {
  const saved = campaignStore?.resumable?.();
  const play = $('play');
  if (!play) return;
  if (saved) {
    play.disabled = false;
    play.childNodes[play.childNodes.length - 1].textContent = ' Продолжить';
    $('new-game').classList.remove('hidden');
  } else {
    $('new-game').classList.add('hidden');
  }
}

const HUD_LABELS = {
  repeat: 'REPEAT',
  'confirm-devastator': 'DETONATE',
  'confirm-mcv': 'DEPLOY',
  'confirm-native': 'CONFIRM',
};

// The native building menu is drawn from its own completed 320x224 frame; the
// transparent grid over it routes taps to building_ui_tap(col,row), so the
// player sees the original graphics and the original guards stay in charge.
// Exposed for diagnostics/tests only (same pattern as window.__DUNE_INPUT).
window.__DUNE_APP = null;

function refreshBuildingMenu() {
  if (!state.host) return;
  const ui = state.host.buildingUi?.();
  const active = Boolean(ui?.active);
  if (active) {
    state.building = ui;
    // The building menu is the native UI overlay composited over the world; the
    // expanded presenter at exactly 320x224 gives the original console picture.
    state.host.attachVirtualWindow?.({ width: 320, height: 224 });
    state.host.setPresentation?.('expanded');
    renderBuildingMenu(ui);
    return;
  }
  if (state.building) {
    state.building = null;
    $('building-cells').hidden = true;
    $('building-cells').replaceChildren();
    document.body.classList.remove('building-mode');
    state.host.setPresentation?.('auto');
    syncGameViewport();
    updateHud(window.__DUNE_INPUT ?? null);
  }
}

function renderBuildingMenu(ui) {
  const canvas = $('game-canvas');
  document.body.classList.add('building-mode');
  $('game-hud').hidden = true;
  const overlay = $('building-cells');
  const stage = document.querySelector('.game-stage');
  const canvasBox = canvas.getBoundingClientRect();
  const stageBox = stage.getBoundingClientRect();
  overlay.hidden = false;
  overlay.style.left = `${Math.round(canvasBox.left - stageBox.left)}px`;
  overlay.style.top = `${Math.round(canvasBox.top - stageBox.top)}px`;
  overlay.style.width = `${Math.round(canvasBox.width)}px`;
  overlay.style.height = `${Math.round(canvasBox.height)}px`;
  const cells = Array.isArray(ui.cells) ? ui.cells : [];
  const width = ui.frame?.width || 320;
  const height = ui.frame?.height || 224;
  overlay.replaceChildren(...cells.map((cell) => {
    const button = document.createElement('button');
    const rect = cell.sourceRect || {};
    button.style.left = `${((rect.x || 0) / width) * 100}%`;
    button.style.top = `${((rect.y || 0) / height) * 100}%`;
    button.style.width = `${((rect.w || 32) / width) * 100}%`;
    button.style.height = `${((rect.h || 24) / height) * 100}%`;
    button.setAttribute('aria-label', cell.label || `${cell.key || 'cell'}`);
    button.title = cell.label || '';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const accepted = state.host?.tapBuildingCell?.(cell.col, cell.row) ?? 0;
      log(`Меню здания: ${cell.key || `${cell.col},${cell.row}`} → ${accepted ? 'принято' : 'отклонено'}`);
      setTimeout(refreshBuildingMenu, 140);
      setTimeout(refreshBuildingMenu, 420);
    });
    return button;
  }));
}

function updateHud(snapshot) {
  const hud = $('game-hud');
  if (!hud) return;
  const active = Boolean(state.host) && Boolean(currentRun());
  const actions = snapshot?.actions ?? {};
  const selected = actions.selected ?? {};
  const placing = Boolean(actions.placementActive);
  const hasSelection = selected.kind && selected.kind !== 'none';
  const bLabel = HUD_LABELS[actions.bKind] || null;
  const show = active && (placing || hasSelection || actions.bAvailable);
  hud.hidden = !show;
  if (!show) return;
  const b = $('hud-b');
  const place = $('hud-place');
  const clear = $('hud-clear');
  place.hidden = !placing;
  b.hidden = placing || !actions.bAvailable;
  b.textContent = bLabel || 'ACTION';
  b.title = bLabel ? `Оригинальное действие B: ${bLabel}` : '';
  clear.hidden = !(placing || hasSelection);
  clear.title = placing ? 'Отменить размещение' : 'Снять выбор';
}

function hudAction(kind) {
  const snapshot = window.__DUNE_INPUT ?? {};
  const placing = Boolean(snapshot.actions?.placementActive);
  if (kind === 'confirm') {
    if (placing) state.input?.confirm?.();
    else state.input?.action?.();
    return;
  }
  if (placing) state.input?.cancelTarget?.();
  else state.host?.call?.('dune_web_clear_selection');
}

function updateSoundButton() {
  const audio = state.host?.audio;
  const button = $('game-sound');
  if (!button) return;
  button.textContent = audio?.enabled ? 'Звук: вкл' : 'Звук: выкл';
  button.disabled = !audio?.supported;
}

async function toggleSound() {
  const audio = state.host?.audio;
  if (!audio) return;
  try {
    if (audio.enabled) await audio.disable();
    else await audio.enable();
  } catch (error) {
    log(`Звук: ${error.message}`);
  }
  updateSoundButton();
}

function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  else document.exitFullscreen?.().catch(() => {});
}

$('game-back').addEventListener('click', () => {
  if (state.building?.active) {
    const cells = state.building.cells || [];
    const exit = cells.find((cell) => cell.key === 'exit') || cells.find((cell) => cell.row === (state.building.rows || 1) - 1 && cell.col === 2);
    if (exit) state.host?.tapBuildingCell?.(exit.col, exit.row);
    setTimeout(refreshBuildingMenu, 200);
    return;
  }
  stopPlay();
});
$('game-menu').addEventListener('click', openGameMenu);
$('game-sheet-close').addEventListener('click', closeGameMenu);
$('game-exit').addEventListener('click', () => { closeGameMenu(); stopPlay(); });
$('game-save').addEventListener('click', () => saveGame(true));
$('game-load').addEventListener('click', loadGame);
$('game-fullscreen').addEventListener('click', toggleFullscreen);
$('game-sound').addEventListener('click', toggleSound);

// Save on background/exit, like the old port (best effort, mission only).
const flushSave = () => { if (state.host && currentRun()) saveGame(false); };
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
window.addEventListener('pagehide', flushSave);

// Periodic autosave while a mission is actually running.
setInterval(() => {
  if (state.host && !$('game-sheet').classList.contains('hidden')) return;
  if (state.host && currentRun()) saveGame(false);
}, 20000);

// ---------- details ----------
async function loadBuildInfo() {
  try {
    const response = await fetch('./reference.json', { cache: 'no-store' });
    if (!response.ok) return;
    state.reference = await response.json();
    $('detail-version').textContent =
      `runtime ${short(state.reference.runtime_sha256)} · recompiler ${state.reference.recompiler || '—'}`;
  } catch {
    // metadata is optional for the fallback pages
  }
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function downloadReport() {
  const report = {
    generatedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    platform: navigator.platform || '',
    deviceMemory: navigator.deviceMemory ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    crossOriginIsolated: self.crossOriginIsolated,
    reference: state.reference,
    romSha256: state.romSha,
    results: window.__BUILD_RESULTS ?? [],
    errors: window.__BUILD_ERRORS ?? [],
    lines: state.log,
  };
  downloadText('dune-report.json', JSON.stringify(report, null, 2) + '\n');
}
$('download-log').addEventListener('click', downloadReport);

// ---------- saves ----------
let savesModule = null;
let campaignStore = null;

async function initSaves() {
  const fileInput = $('save-file');
  $('open-saves').addEventListener('click', () => $('saves-sheet').classList.remove('hidden'));
  $('saves-close').addEventListener('click', () => $('saves-sheet').classList.add('hidden'));
  $('saves-sheet').addEventListener('click', (event) => {
    if (event.target === $('saves-sheet')) $('saves-sheet').classList.add('hidden');
  });
  try {
    savesModule = await import('./saves/save-files.mjs');
    const campaign = await import('./saves/campaign-state.mjs');
    const files = await import('./saves/browser-files.mjs');
    campaignStore = new campaign.CampaignStore(localStorage);

    const describe = (progress, current) => {
      const houses = ['HARKONNEN', 'ATREIDES', 'ORDOS'];
      if (current) return `${houses[current.house]} · миссия ${current.mission}`;
      const played = progress.houses.reduce((acc, h) => acc + h.completed.length, 0);
      return played ? `прогресс: ${played} миссий` : 'сохранений пока нет';
    };
    const refresh = () => {
      $('saves-status').textContent = campaignStore.current
        ? `В браузере: ${describe(campaignStore.progress, campaignStore.current)}`
        : 'Здесь можно перенести сохранение из старой версии.';
      $('save-download').disabled = !campaignStore.current;
    updateContinueButtons();
    };
    refresh();

    $('save-load').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const archive = await savesModule.parseSaveFile(await file.text());
        const transaction = savesModule.commitSaveFile({ store: campaignStore, archive });
        refresh();
        $('saves-status').textContent = `Загружено: ${describe(transaction.progress, transaction.continue)}`;
        log(`Сейв импортирован из ${file.name}`);
      } catch (error) {
        $('saves-status').textContent = error.code === 'incompatible-engine'
          ? 'Файл от другой сборки игры.'
          : 'Файл повреждён или не подходит.';
        log(`Ошибка импорта сейва: ${error.code || error.message}`);
      } finally {
        fileInput.value = '';
      }
    });
    $('save-download').addEventListener('click', async () => {
      try {
        const save = await savesModule.createSaveFile({ store: campaignStore, language: 'ru' });
        await files.downloadSave(save);
        $('saves-status').textContent = 'Файл сохранения скачан.';
      } catch (error) {
        $('saves-status').textContent = 'Не удалось скачать сохранение.';
      }
    });
  } catch (error) {
    $('saves-status').textContent = 'Сохранения пока недоступны.';
    log(`Saves module unavailable: ${error.message}`);
  }
}

// ---------- start ----------
for (let i = 0; i < 5; i += 1) $('steps').append(document.createElement('i'));
loadBuildInfo();
initSaves();
log(`Платформа: ${navigator.userAgent}`);
window.__SPIKE_READY__ = true;
