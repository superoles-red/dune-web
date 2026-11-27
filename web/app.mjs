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
  log: [],
};

const KNOWN_ROM_SHA256 = 'b1bbe73186e0902fa8b2db0f227bf306e3d6a80fe592f927d1aa9d60c0f335ba';

// ---------- helpers ----------
function screen(name) {
  for (const id of ['screen-setup', 'screen-progress', 'screen-ready', 'screen-error']) {
    $(id).classList.toggle('hidden', id !== `screen-${name}`);
  }
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
  $('ready-hint').textContent = 'Теперь её можно запускать. Кнопка «Играть» включится в следующем обновлении.';
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
    };
    refresh();

    $('save-load').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const archive = await savesModule.parseSaveFile(await file.text());
        const transaction = savesModule.commitSaveFile({ store: campaignStore, archive });
        $('saves-status').textContent = `Загружено: ${describe(transaction.progress, transaction.continue)}`;
        log(`Сейв импортирован из ${file.name}`);
        refresh();
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
