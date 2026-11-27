// BYOP shell for Dune: The Battle for Arrakis (Sega Genesis, USA).
// Flow: player ROM -> local SHA check -> recompile in a worker -> verify against
// the shipped game core -> private OPFS cache. Saves stay compatible with the
// old port (import old *.dune-save.json).

const $ = (id) => document.getElementById(id);
const romInput = $('rom-input');
const buildButton = $('build');
const statusEl = $('status');
const progressWrap = $('progress-wrap');
const progressBar = $('progress');
const dumpBody = document.querySelector('#dump-table tbody');
const resultCard = $('result-card');
const resultBody = document.querySelector('#result-table tbody');
const logEl = $('log');

const KNOWN_ROM_SHA256 = 'b1bbe73186e0902fa8b2db0f227bf306e3d6a80fe592f927d1aa9d60c0f335ba';
const PHASE_LABELS = {
  pyodide: 'Загрузка Pyodide',
  unpack: 'Распаковка перекомпилятора',
  validate_rom: 'Проверка ROM',
  z80_images: 'Подготовка Z80-образов',
  entry_discovery: 'Поиск точек входа (68000)',
  translate_emit: 'Трансляция и генерация ядра',
  hash_output: 'Проверка SHA-256',
  cache: 'Кэширование',
  cache_read: 'Чтение кэша',
};
// Overall progress: each phase occupies [from, to) of the bar.
const PHASE_SPAN = {
  pyodide: [0.0, 0.06], unpack: [0.06, 0.10], validate_rom: [0.10, 0.12],
  z80_images: [0.12, 0.135], entry_discovery: [0.135, 0.68], translate_emit: [0.68, 0.97],
  hash_output: [0.97, 0.99], cache: [0.99, 1.0], cache_read: [0.0, 1.0],
};

const state = { romBytes: null, romSha: null, worker: null, building: false, result: null, reference: null };

function log(line) {
  const stamp = new Date().toLocaleTimeString('ru-RU');
  logEl.textContent = `[${stamp}] ${line}\n` + logEl.textContent;
  if (logEl.textContent.length > 60000) logEl.textContent = logEl.textContent.slice(0, 60000);
}

function setStatus(text) { statusEl.textContent = text; }

async function loadBuildInfo() {
  try {
    const response = await fetch('./reference.json', { cache: 'no-store' });
    if (!response.ok) return;
    state.reference = await response.json();
    const short = (value) => (value ? value.slice(0, 16) + '…' : '—');
    $('build-info').textContent =
      `Версия сборки: runtime ${short(state.reference.runtime_sha256)} · ` +
      `core ${short(state.reference.expected_output_sha256)} · ` +
      `recompiler ${state.reference.recompiler || '—'}`;
  } catch {
    // The bundle metadata is optional for the saves panel; ignore failures.
  }
}

async function clearCache() {
  if (!state.romSha) return;
  try {
    const root = await navigator.storage.getDirectory();
    const rootDir = await root.getDirectoryHandle('dune-web', { create: false });
    await rootDir.removeEntry(`rom-${state.romSha}`, { recursive: true });
    setStatus('Собранное ядро удалено из кэша. Следующая сборка начнётся заново.');
    log(`Кэш для ROM ${state.romSha.slice(0, 16)}… удалён`);
  } catch (error) {
    setStatus(`Не удалось очистить кэш: ${error.message}`);
  }
}

function row(table, label, value, className) {
  const tr = document.createElement('tr');
  const th = document.createElement('td');
  th.textContent = label;
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = value;
  tr.append(th, td);
  table.append(tr);
}

function fmtBytes(bytes) {
  if (bytes == null) return '—';
  return `${bytes} Б (${(bytes / 1048576).toFixed(1)} МиБ)`;
}

function fmtSeconds(seconds) {
  if (seconds == null) return '—';
  return seconds >= 10 ? `${seconds.toFixed(1)} с` : `${seconds.toFixed(2)} с`;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function setProgress(phase, fraction) {
  const span = PHASE_SPAN[phase] || [0, 1];
  const overall = Math.max(0, Math.min(1, span[0] + (span[1] - span[0]) * fraction));
  progressWrap.hidden = false;
  progressBar.style.width = `${(overall * 100).toFixed(1)}%`;
}

function showDump() {
  dumpBody.replaceChildren();
  if (!state.romBytes) return;
  row(dumpBody, 'Файл', romInput.files[0]?.name || '—');
  row(dumpBody, 'Размер', fmtBytes(state.romBytes.length));
  row(dumpBody, 'SHA-256', state.romSha);
  const known = state.romSha === KNOWN_ROM_SHA256;
  row(dumpBody, 'Паспорт дампа', known
    ? 'Dune: The Battle for Arrakis (USA) — поддерживается, полный режим'
    : 'Не совпадает с эталонным USA-дампом — сборка остановится', known ? 'ok' : 'bad');
}

romInput.addEventListener('change', async () => {
  const file = romInput.files?.[0];
  if (!file) return;
  state.romBytes = new Uint8Array(await file.arrayBuffer());
  state.romSha = await sha256Hex(state.romBytes);
  state.result = null;
  resultCard.hidden = true;
  showDump();
  const known = state.romSha === KNOWN_ROM_SHA256;
  buildButton.disabled = state.building || !known;
  setStatus(known ? 'ROM принят. Нажмите «Собрать ядро».' : 'Этот дамп не поддерживается: нужен USA 1 048 576 байт.');
  log(`ROM: ${file.name}, ${state.romBytes.length} Б, SHA-256 ${state.romSha}`);
});

function ensureWorker() {
  if (state.worker) return state.worker;
  const worker = new Worker('./recompiler.worker.js', { type: 'module' });
  worker.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'state') {
      setProgress(message.phase, message.fraction);
      setStatus(`${PHASE_LABELS[message.phase] || message.phase}…`);
    } else if (message.type === 'log') {
      log(message.line);
    } else if (message.type === 'rom') {
      log(`Worker подтвердил ROM SHA-256 ${message.romSha256}`);
    } else if (message.type === 'result') {
      onResult(message.result);
    } else if (message.type === 'error') {
      onBuildError(message.message);
    }
  });
  state.worker = worker;
  return worker;
}

function build() {
  if (!state.romBytes || state.building) return;
  state.building = true;
  buildButton.disabled = true;
  resultCard.hidden = true;
  progressWrap.hidden = false;
  progressBar.style.width = '0%';
  setStatus('Запуск перекомпилятора…');
  ensureWorker();
  const copy = state.romBytes.slice();
  state.worker.postMessage({ type: 'build', romBytes: copy }, [copy.buffer]);
}

async function measureMemory() {
  if (!(self.crossOriginIsolated && performance.measureUserAgentSpecificMemory)) return null;
  try {
    return (await performance.measureUserAgentSpecificMemory()).bytes;
  } catch {
    return null;
  }
}

async function onResult(result) {
  state.building = false;
  buildButton.disabled = false;
  state.result = result;
  (window.__BUILD_RESULTS ||= []).push(result);
  progressBar.style.width = '100%';
  resultCard.hidden = false;
  resultBody.replaceChildren();
  const verdict = result.matches_shipped_core
    ? (result.cached ? 'СОВПАДАЕТ с эталонным ядром (из кэша)' : 'СОВПАДАЕТ с эталонным ядром')
    : 'НЕ СОВПАЛО с эталоном';
  row(resultBody, 'Вердикт', verdict, result.matches_shipped_core ? 'ok' : 'bad');
  row(resultBody, 'SHA-256 ядра', result.output_sha256 || result.error || '—');
  row(resultBody, 'SHA-256 эталона', result.expected_output_sha256 || '—');
  row(resultBody, 'Размер ядра', result.output_bytes != null ? fmtBytes(result.output_bytes) : '—');
  row(resultBody, 'ROM SHA-256', result.rom_sha256 || state.romSha || '—');
  for (const [name, seconds] of Object.entries(result.timings || {})) {
    row(resultBody, `Фаза: ${name}`, fmtSeconds(seconds));
  }
  row(resultBody, 'Всего', result.cached ? 'из кэша' : fmtSeconds(result.total_seconds));
  const memory = await measureMemory();
  if (memory != null) row(resultBody, 'Память страницы', fmtBytes(memory));
  setStatus(result.matches_shipped_core
    ? 'Готово: ядро собрано из вашего ROM и совпало с эталоном. Копия сохранена на устройстве.'
    : 'Сборка завершилась, но SHA не совпал с эталоном — подробности ниже.');
  log(`Результат: ${result.output_sha256} (${result.output_bytes} Б)`);
}

function onBuildError(message) {
  state.building = false;
  buildButton.disabled = false;
  setStatus('Сборка не удалась.');
  (window.__BUILD_ERRORS ||= []).push(message);
  log(message);
}

buildButton.addEventListener('click', build);
$('clear-cache').addEventListener('click', clearCache);
loadBuildInfo();

// --- Saves: old port (<dune-sega-web>) file import/export -------------------
async function initSaves() {
  const fileInput = $('save-file');
  const importButton = $('save-import');
  const exportButton = $('save-export');
  const saveStatus = $('save-status');
  try {
    const saves = await import('./saves/save-files.mjs');
    const campaign = await import('./saves/campaign-state.mjs');
    const files = await import('./saves/browser-files.mjs');
    const store = new campaign.CampaignStore(localStorage);

    function describe(progress, current) {
      const houses = ['HARKONNEN', 'ATREIDES', 'ORDOS'];
      const parts = [];
      if (current) parts.push(`текущая миссия: ${houses[current.house]} ${current.mission}`);
      for (let h = 0; h < 3; h += 1) {
        const p = progress.houses[h];
        if (p.unlocked > 1 || p.completed.length) parts.push(`${houses[h]}: открыто ${p.unlocked}/9, пройдено ${p.completed.length}`);
      }
      return parts.length ? parts.join(' · ') : 'прогресс пуст';
    }

    const legacy = store.legacy();
    if (store.current || store.progress.houses.some((h) => h.unlocked > 1 || h.completed.length)) {
      saveStatus.textContent = `В браузере уже есть сохранение: ${describe(store.progress, store.current)}`;
      exportButton.disabled = false;
    } else if (legacy) {
      saveStatus.textContent = 'Найден старый формат сохранения в localStorage — импортируйте файл или продолжите в старой версии.';
    } else {
      saveStatus.textContent = 'Сохранений в этом браузере нет. Можно импортировать файл из старой версии.';
    }

    fileInput.addEventListener('change', () => {
      importButton.disabled = !fileInput.files?.[0];
    });

    importButton.addEventListener('click', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const archive = await saves.parseSaveFile(await file.text());
        const transaction = saves.commitSaveFile({ store, archive });
        saveStatus.textContent = `Импортировано: ${describe(transaction.progress, transaction.continue)}. Язык: ${transaction.language}.`;
        exportButton.disabled = false;
        log(`Сейв импортирован из ${file.name}`);
      } catch (error) {
        saveStatus.textContent = `Импорт не удался: ${error.code || error.message}`;
        log(`Ошибка импорта сейва: ${error.code || error.message}`);
      }
    });

    exportButton.addEventListener('click', async () => {
      try {
        const file = await saves.createSaveFile({ store, language: 'ru' });
        await files.downloadSave(file);
        saveStatus.textContent = `Экспортировано: ${file.filename}`;
      } catch (error) {
        saveStatus.textContent = `Экспорт не удался: ${error.code || error.message}`;
      }
    });
  } catch (error) {
    saveStatus.textContent = `Подсистема сохранений пока не собрана (${error.message}).`;
  }
}

initSaves();
