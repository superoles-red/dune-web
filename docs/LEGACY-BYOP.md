# Legacy BYOP: старый фронтенд Dune Sega Web на BYOP-ядре

Статус: **рабочий вертикальный срез** (первый этап). Старый фронтенд
(`web/legacy/`) грузится в новом репозитории, собирает `game.wasm` из ROM игрока
в браузере и проходит путь **выбор ROM → сборка → главное меню → New Campaign →
дом → миссия → брифинг → карта → пауза → сохранение/загрузка → возврат в меню**.

Проверка: `node tests/browser/legacy-smoke.mjs` (реальная сборка Pyodide,
~17 с на M-серии, `LEGACY OK`), отчёт `test-results/legacy/legacy.json`,
скриншоты `test-results/legacy/*.png`.

---

## 1. Что лежит в `web/legacy/`

Копия старого `Dune Sega Web/web/` **без** `engine/`, `asset-library/`,
`base-prototype/{app.mjs,index.html,assets}`, `qa*`, `update*`, `entry.js`,
`service-worker.js`, `startup.js`, `input-check.mjs` и без единого `*.state.bin`
(ROM-производные фикстуры не поставляются).

| что | объём | примечание |
|---|---:|---|
| `ui-assets/` | 2.9 МБ | 343 PNG + манифесты + атлас (копия старой версии) |
| `language-assets/` | 388 КБ | EN/RU строки, шрифты, команды |
| `tutorial-assets/` | 308 КБ | 33 кадра туториала |
| `icons/`, `input-feedback/`, `licenses/`, `app.webmanifest`, `CREDITS.txt` | ~64 КБ | PWA-иконки, прицелы, лицензии |
| `*.mjs` (34 модуля) + `shell.js` + `index.html` + 2 CSS | ~1 МБ | старый код как есть, кроме `shell.js`/`index.html` (см. §3) |
| `base-prototype/layout.mjs` | 1 файл | нужен `building-ui.mjs`; остальной `base-prototype` не скопирован |

Всего `web/legacy` ≈ **4.3 МБ** (против ≈ 9 МБ старой папки с движком).

Новых файлов:

- `web/legacy/byop-boot.mjs` — стартовый экран ROM + сборка + загрузка ядра +
  fast-forward до главного меню + `Module`-фасад + запуск старого `shell.js`;
- `web/legacy/index.html` — копия старого, изменена только одна строка
  (`entry.js` → `byop-boot.mjs`) и добавлен favicon;
- `web/legacy/shell.js` — копия старого, изменены `startEngine()` и добавлен
  вызов `window.duneByop.attach(Module)`; остальная логика не тронута.

ROM/engine/`.state.bin` в репозитории нет. `game.wasm` и состояние главного
меню генерируются на устройстве и лежат в OPFS
(`dune-web/rom-<sha>/game.wasm`, `dune-web/legacy/frontend-*.bin`).

---

## 2. Как работает boot → engine → Module

```
index.html  (inline duneStartup остаётся старым, экран ROM — новый)
   └─ byop-boot.mjs
        1. ROM picker (title-logo.png из ui-assets, стиль старого boot-экрана)
        2. SHA-256 = b1bbe731… (USA) → ../recompiler.worker.js
           (Pyodide + py-package.zip + reference.json + vendor/pyodide —
            файлы остаются в корне web/, воркер грузится по ../ и сам
            резолвит свои относительные пути; копий в legacy/ нет)
        3. читает собранный game.wasm из OPFS (та же папка кэша, что у web/app.mjs)
        4. new DuneHost({canvas: #canvas})
           host.init({gameBytes}) → web/runtime/runtime.wasm
           host.loadRomFromBytes(rom) → dune_rt_rom_buffer()
           host.boot()
        5. fast-forward: advanceInstructions(26_000_000) до scene='main',
           saveState() → OPFS fixture (второй запуск: loadState + 120k steps)
        6. перехват fetch('./frontend.state.bin') → сгенерированные байты
        7. host.setPresentation('auto') + host.start()
        8. window.duneByop = {host, attach, frontendState, …}
        9. import('./shell.js')  → старый фронтенд забирает #canvas и память
```

`host.setPresentation('auto')` повторяет старую SDL-презентацию: на карте
рисуется расширенный кадр (`dune_web_expanded_frame_rgba`, как старый
`dune_view_draw`), на меню/нативных экранах — обычный VDP-кадр 320×224.
Старый `game-ui.mjs` при этом читает те же `_dune_web_frame_rgb` /
`frame_serial` из линейной памяти, что и раньше.

### Module-фасад (`window.duneByop.attach(Module)`)

Старый `shell.js` создаёт `window.Module` сам; после этого фасад:

- копирует **все** экспорты `dune_*` рантайма в `Module._dune_*`
  (`_dune_web_frame_rgb`, `_dune_web_campaign_*`, `_dune_web_audio_worklet`,
  `_dune_save_state_to_buffer`, `_dune_get_save_buffer`,
  `_dune_load_state_from_buffer`, `_dune_web_paused`, …) — это ровно те имена,
  которые вызывает старый код;
- `HEAPU8`/`HEAPU32`/`HEAP32` — **геттеры** `new …Array(host.memory.buffer)`
  (память может расти; первый вариант с ошибкой в имени сломал сохранения —
  исправлено и проверено);
- `UTF8ToString(ptr) → host.readCString(ptr)`;
- `_dune_web_resize(w,h)` дополнительно обновляет `host.virtualWindow`, чтобы
  path-A мок `emscripten_get_element_css_size` отдавал реальный CSS-размер
  (как старый Emscripten);
- `_dune_load_state_from_buffer` синхронизирует метрики/аудио после загрузки;
- `_dune_web_audio_levels` пробрасывает MUSIC/SOUND в `DuneAudio`.
- `Module.SDL2` нет → старый `NativeAudioBridge` штатно уходит в silent-SDL
  fallback; звук идёт через наш `host.audio` (`enable()` из жеста выбора ROM,
  `host.start()` качает PCM).

### `shell.js`: две правки

1. `startEngine()` больше не вставляет `<script src="engine/dune_web.js">`, а
   ждёт `window.duneByop.ready` и вызывает `Module.postRun[0]()` — то есть
   ровно то, что старый Emscripten вызывал после инициализации
   (`ready=true`, `_dune_web_native_video`, `_dune_web_set_hidden`,
   `resizeGame`, `_dune_web_rebase`, `nativeAudio.start`, `audioSettings.apply`,
   `resolveEngine`, `pollState`).
2. После создания `GameInterface` добавлен `window.__DUNE_UI__ = gameUI` —
   только для теста/диагностики.

Больше ничего в `shell.js` и `game-ui.mjs` не менялось.

---

## 3. Фикстуры состояния (ROM-derived, генерируются на устройстве)

| файл старой версии | как заменён |
|---|---|
| `frontend.state.bin` (главное меню) | после `advanceInstructions(26M)` игра сама стоит на `scene='main'`, `sceneReady=true`; `dune_save_state_to_buffer()` → 140 056/140 921 Б (DSAV v2, зависит от включённого Z80-аудио) → OPFS + `fetch`-интерсептор |
| `demo.state.bin`, `demo-harkonnen.state.bin`, `training.state.bin`, `credits/house-*.state.bin` | **не копируются и не генерируются** — демо/туториал/кредиты пока недоступны; соответствующие пути возвращают 404, старый код ловит ошибку (`credits`/demo — только из экранов, до которых MVP не доходит) |

Важно: сразу после `loadState` `campaign_json.scene` = `unknown`, через
~120k инструкций (2–3 кадра) снова `main`. Это же поведение у старой
`frontend.state.bin`; поэтому после загрузки фикстуры boot делает
`advanceSteps(120_000)`, а UI-переходы ждут `matchesPending` по `scene='main'`.

Возврат «в главное меню» из паузы проверен и работает через эту фикстуру
(MAIN MENU → подтверждение → `scene='main'`).

---

## 4. Запуск локально

```bash
cd /Users/oleskarpov/Documents/My Gamedev/dune-web
python3 tools/serve.py --port 4550      # отдаёт web/ как корень
# открыть http://127.0.0.1:4550/legacy/
# выбрать /Users/oleskarpov/Downloads/Dune - The Battle for Arrakis (USA).gen
```

Нужен COOP/COEP (его даёт `tools/serve.py`), Pyodide и воркер берутся из
корня `web/`, поэтому просто `python3 -m http.server` без COOP/COEP не подойдёт.

Тест:

```bash
DUNE_ROM="/Users/oleskarpov/Downloads/Dune - The Battle for Arrakis (USA).gen" \
  node tests/browser/legacy-smoke.mjs
# порт по умолчанию 4550, можно LEGACY_PORT / LEGACY_URL / CHROME_PATH
# SEED=1 — быстрый dev-прогон без Pyodide (ядро из .local/wasm-full/game.wasm)
```

Эталон старой версии для сравнения (локальный сервер старого репо):

```bash
python3 -m http.server 4560 --directory "/Users/oleskarpov/Documents/My Gamedev/Dune Sega Web/web"
# http://127.0.0.1:4560/?qa  (иначе всплывает install-gate)
OLD_URL=http://127.0.0.1:4560/?qa node tests/browser/legacy-oldref.mjs
# скриншоты: /tmp/oldref (те, что в test-results/legacy/old/, сняты так же)
```

---

## 5. Результаты прогона (реальная Pyodide-сборка, 390×844, DPR 2)

| шаг | результат |
|---|---|
| boot-экран ROM | title-logo 255 px, кнопка «ВЫБРАТЬ ROM», старый monospace/outset-стиль |
| сборка | `game_sha256=7704de7b…` совпал с `web/reference.json`; **16–17 с** |
| главное меню | `scene='main'`, HTML-экран DUNE + `NEW CAMPAIGN`/`OPTIONS`, live-кадр титула |
| New Campaign → дом → миссия | HTML-сетки старого `game-ui` (ATREIDES/ORDOS/HARKONNEN, 9 миссий, confirm START) |
| брифинг | нативные экраны (ментат+карта, кадры из ROM), HTML PROCEED/ADVICE |
| карта | `camera.map=1`, `cameraX=647`, `cameraY=1031`, zoom 100, `canvas 390×844` = expanded frame; MENU/credits/миникарта как в старой версии |
| сохранение F5 | `dune-sega-continue-v2`, `state.length=187 896` (base64 от 140 921 Б DSAV) |
| загрузка F8 | `scene='map'`, `fault=false`, камера вернулась (647) |
| пауза | `scene='pause'`, кнопки MUSIC/SOUND/LANGUAGES/HOW TO PLAY?/FILES/RESTART/MAIN MENU |
| MAIN MENU → возврат | `scene='main'` через сгенерированную фикстуру |
| reload | 2.8–2.9 с (кэш ядра + кэш фикстуры), `fixture='cached'` |
| звук | `host.audio.enabled=true`, PCM-кадры растут (≈1.5 млн за прогон) |
| ошибки | `problems=[]`, page errors `[]`, HTTP 4xx `[]` |

Скриншоты: `test-results/legacy/01-boot.png`, `02-menu.png`, `03-houses.png`,
`04-missions.png`, `05-confirm.png`, `06-briefing.png`, `07-map.png`,
`08-map-pan.png`, `09-map-after-load.png` (= хороший кадр карты),
`10-pause.png`, `11-main-menu-return.png`, `12-reload-menu.png`.
Эталон старой версии: `test-results/legacy/old/*.png`.

### Отличия от эталона «старой» версии (по скриншотам)

1. **Стартовый экран** — наш BYOP-пикер ROM вместо старого boot-экрана с
   прогрессом загрузки. Стиль/логотип старые, тексты новые (осознанно).
2. **Холодный старт**: старая версия показывает SEGA/Virgin-интро 30–40 с,
   у нас fast-forward 26M инструкций → сразу главное меню (как и `web/app.mjs`).
3. **Главное меню** после fast-forward показывает кадр титула/меню; у старой
   версии на холодном старте в этот момент может быть чёрный кадр/интро.
4. **Карта**: expanded-кадр 1:1 по композиции (мир, HUD MENU/credits, миникарта,
   рамка вида). На нашем скриншоте в миникарте не видно уголков рамки вида,
   которые рисует SDL-слой старой версии (`dune_view_draw`); это presentation-only
   расхождение path A, не влияет на ввод/игру.
5. **`cameraDebug` до первого жеста** отдаёт `0/0`: path A не вызывает
   `em_web_camera_sync` каждый кадр (в старой версии это делал SDL-draw). После
   первого pan/тапа значения синхронизируются и совпадают со старой версией
   (647/1031). Влияет только на HUD-хелперы, читающие камеру до первого касания;
   в тесте делаем первый «nudge»-жест.
6. **Звук** идёт через наш `DuneAudio` (AudioWorklet `dune-pcm`); старый
   `NativeAudioBridge` в path A не активируется (нет `Module.SDL2`), поэтому
   его метрики/переключение эпох не участвуют — на звук это не влияет.
7. **Демо/туториал/кредиты** недоступны (ROM-derived фикстуры не генерируются),
   экраны «HOW TO PLAY/TUTORIAL» открывают старый HTML-гайд, но практика
   туториала/демо не грузится.

---

## 6. Что осталось для «неотличимо»

- **Генерация ассетов из ROM вместо копирования** (`ui-assets`,
  `language-assets`, `tutorial-assets`) — отдельный крупный этап (Pyodide-порт
  `tools/extract_*.py`); сейчас ассеты скопированы из старой версии.
- **Демо/туториал/кредиты**: генерировать `demo-harkonnen.state.bin`,
  `training.state.bin`, `credits/house-*.state.bin` на устройстве (сейчас 404).
- **Камера в `cameraDebug` до первого жеста** — синхронизировать `camera_x/y`
  из RAM при старте карты (нужен небольшой экспорт/хук в рантайме, общий файл
  не меняли).
- **Миникарта: рамка вида** в expanded-кадре (presentation-only, как в старом
  `dune_view_draw`) — расширить `dune_web_expanded_frame_rgba`.
- **PWA/service worker** старой модели не переносили: в BYOP кэш ядра/ассетов
  живёт в OPFS; нужна новая модель офлайна/обновлений.
- **Сохранения старого формата**: конверт `dune-sega-continue-v2` и DSAV v2
  работают; проверить импорт старых `*.dune-save.json` через старый UI
  (функция есть, отдельным прогоном не тестировали).
- **Интеграция в корень сайта** (`web/index.html`/`web/app.mjs` — их правят
  другие): сейчас legacy — отдельная страница `/legacy/`. Для «старой версии
  по умолчанию» нужно решение владельца: ссылка/редирект/встраивание, общий
  кэш ядра (уже общий) и общий `web/runtime`.

---

## 7. Что нужно от владельца для интеграции в корень

1. Решить точку входа: `/legacy/` как есть, ссылка «старый интерфейс» из
   BYOP-экрана `web/app.mjs`, или замена корневого UI на legacy (тогда
   `web/app.mjs`/`web/index.html` — зона владельца, я их не трогал).
2. Порт/URL для тестов (по умолчанию 4550) и место хранения скриншотов
   (`test-results/legacy/` уже).
3. Разрешение на общий кэш `dune-web` в OPFS (уже используется: legacy читает
   `game.wasm` из `dune-web/rom-<sha>/` и пишет `dune-web/legacy/frontend-*.bin`)
   — конфликтов с `web/app.mjs` нет.
4. Решение по демо/кредитам и PWA (переносить или выпилить из legacy UI).
