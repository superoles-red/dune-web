/* Wrapper localization (RU default, EN for non-Russian browsers).
 *
 * Only the shell (this page, buttons, statuses) is translated. The in-game text
 * always comes from the player's ROM: the shipped USA ROM is English, and a
 * Russian in-game language is only possible if the player brings a RU ROM.
 * Switching reloads the page so no partially translated screen can remain.
 */

const STORAGE_KEY = 'dune.lang';

// Source strings are the Russian UI text; the dictionary maps them to English.
const EN = {
  // shell
  'BYOP · бета': 'BYOP · beta',
  'Добавьте свою игру': 'Bring your own game',
  'Нужен ROM Sega Genesis версии Dune (USA). Файл останется на этом устройстве.':
    'You need the Sega Genesis ROM of Dune (USA). The file stays on this device.',
  'Выбрать ROM': 'Choose ROM',
  'или перетащите файл сюда': 'or drop the file here',
  'Как играть': 'How to play',
  'Что нужно': 'What you need',
  'Свой ROM Dune — The Battle for Arrakis (Sega Genesis, USA). Это дамп 1 МиБ; никуда не загружается и не входит в сборку — игра собирается на вашем устройстве.':
    'Your own Dune — The Battle for Arrakis ROM (Sega Genesis, USA), a 1 MiB dump. It is never uploaded nor shipped: the game is built on your device.',
  'Управление': 'Controls',
  'Меню и вступление: кнопки A / START и стрелки (или D-pad на экране).':
    'Menus and intro: A / START and arrow buttons (or the on-screen D-pad).',
  'Карта: тап — выбрать, двойной тап — приказ, перетаскивание — прокрутка карты, щипок — масштаб.':
    'Map: tap to select, double tap to order, drag to scroll the map, pinch to zoom.',
  'Свой завод: коснитесь ещё раз (двойной тап) — откроется оригинальное меню здания.':
    'Own building: tap it again (double tap) to open the original building menu.',
  'Кнопка ☰ — пауза, сохранение, звук, полный экран. Игра сама сохраняется каждые 20 секунд.':
    'The ☰ button pauses: save, load, sound, fullscreen. The game autosaves every 20 seconds.',
  'Понятно': 'Got it',
  'Сохранения': 'Saves',
  'Загрузить файл': 'Load file',
  'Скачать файл': 'Download file',
  'Закрыть': 'Close',
  'Подробности': 'Details',
  'Версия:': 'Version:',
  'ROM:': 'ROM:',
  'Ядро:': 'Core:',
  'Время:': 'Time:',
  'Скачать отчёт': 'Download report',
  'Игра не поставляется: ROM приносит игрок.': 'No game data is shipped: you bring your own ROM.',
  'Исходники': 'Source code',
  // progress
  'Готовим игру…': 'Preparing the game…',
  'Не закрывайте вкладку — сборка идёт на этом устройстве.':
    'Do not close the tab — the build runs on this device.',
  'Загружаем инструменты': 'Loading tools',
  'Проверяем файл': 'Checking the file',
  'Ищем код игры': 'Finding the game code',
  'Собираем игру': 'Building the game',
  'Проверяем результат': 'Verifying the result',
  'Берём из памяти устройства': 'Reading the device cache',
  'Сохраняем на устройстве': 'Saving on the device',
  'Готовим игру': 'Preparing the game',
  // ready
  'Игра собрана': 'The game is built',
  'Игра уже собрана': 'The game is already built',
  'Нажмите «Играть» — запустится оригинальная игра с вашего ROM.':
    'Press Play: the original game starts from your ROM.',
  'Играть': 'Play',
  'Продолжить': 'Resume',
  'Новая игра': 'New game',
  'Установить на телефон': 'Install on phone',
  'Собрать заново': 'Rebuild',
  // errors
  'Не получилось': 'Could not build',
  'Что-то пошло не так.': 'Something went wrong.',
  'Попробовать другой ROM': 'Try another ROM',
  // game
  'Запускаем игру…': 'Starting the game…',
  'Выйти': 'Exit',
  'Меню': 'Menu',
  'Вверх': 'Up',
  'Влево': 'Left',
  'Вниз': 'Down',
  'Вправо': 'Right',
  // pause sheet
  'Пауза': 'Paused',
  'Сохранить': 'Save',
  'Загрузить': 'Load',
  'Звук: вкл': 'Sound: on',
  'Звук: выкл': 'Sound: off',
  'На весь экран': 'Fullscreen',
  'Выйти из игры': 'Quit game',
  'Справка': 'Help',
  'Можно сохранить текущую миссию.': 'You can save the current mission.',
  'Сохранение станет доступно в миссии.': 'Saving becomes available in a mission.',
  // save messages
  'Файл сохранения скачан.': 'The save file was downloaded.',
  'Не удалось скачать сохранение.': 'Could not download the save.',
  'Сохранения пока недоступны.': 'Saves are not available yet.',
  'Сохранено': 'Saved',
  'Сохранение загружено': 'Save loaded',
  'Не удалось сохранить': 'Could not save',
  'Не удалось загрузить': 'Could not load',
  'Не удалось запустить игру': 'Could not start the game',
  'миссия': 'mission',
  'прогресс': 'progress',
  'миссий': 'missions',
  'сохранений пока нет': 'no saves yet',
  'В браузере': 'In this browser',
  'Здесь можно перенести сохранение из старой версии.': 'You can import a save from the old version here.',
  'Загружено': 'Loaded',
  'Файл от другой сборки игры.': 'The file belongs to a different build.',
  'Файл повреждён или не подходит.': 'The file is damaged or not compatible.',
  'Отменить размещение': 'Cancel placement',
  'Снять выбор': 'Clear selection',
};

const LANG_LABEL = { ru: 'EN', en: 'RU' };

export function currentLanguage() {
  const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
  if (stored === 'ru' || stored === 'en') return stored;
  const browser = (globalThis.navigator?.language || 'ru').toLowerCase();
  return browser.startsWith('ru') ? 'ru' : 'en';
}

export function initLanguage() {
  const language = currentLanguage();
  document.documentElement.lang = language;
  return language;
}

export function setLanguage(language) {
  globalThis.localStorage?.setItem(STORAGE_KEY, language === 'en' ? 'en' : 'ru');
}

export function nextLanguage() {
  return currentLanguage() === 'ru' ? 'en' : 'ru';
}

export function languageLabel() {
  return LANG_LABEL[currentLanguage()];
}

/** Translate one Russian UI string (dynamic text); unknown strings pass through. */
export function t(text) {
  if (currentLanguage() === 'ru' || typeof text !== 'string') return text;
  return EN[text] ?? text;
}

function translateString(value) {
  if (currentLanguage() === 'ru') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  const translated = EN[trimmed];
  if (!translated) return value;
  return value.replace(trimmed, translated);
}

/** Translate every text node and human-facing attribute under `root`. */
export function translateDom(root = document.body) {
  if (currentLanguage() === 'ru' || !root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const next = translateString(node.nodeValue);
    if (next !== node.nodeValue) node.nodeValue = next;
  }
  for (const element of root.querySelectorAll('[title], [aria-label], [placeholder], [alt]')) {
    for (const attribute of ['title', 'aria-label', 'placeholder', 'alt']) {
      const value = element.getAttribute(attribute);
      if (!value) continue;
      const next = translateString(value);
      if (next !== value) element.setAttribute(attribute, next);
    }
  }
  if (document.title) document.title = translateString(document.title);
}
