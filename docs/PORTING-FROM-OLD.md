# Перенос улучшений из старой веб-версии в BYOP `dune-web`

Документ — результат исследования старой рабочей версии
(`…/Dune Sega Web`, встроенное ядро `web/engine/dune_web.js|wasm`) для аккуратного
переноса её улучшений в BYOP-порт. Старая версия не изменялась; здесь только
наблюдения, разбор кода/документации и план.

- Дата исследования: 2026-11-27.
- Что проверено фактически: см. §15 (скриншоты `/tmp/old-shot/`, запуск старой
  версии на `python3 tools/serve.py --port 4174`, `?qa`), плюс отдельная проба
  нового хоста с ROM игрока и обычным v2-сейвом (§5.6, §15.3).
- Важно: параллельно с этим исследованием другие агенты меняют
  `runtime/wasm/`, `web/host/host.mjs`, `web/app.mjs` (тач-камера, Z80/звук).
  Числа по новому рантайму и хосту — снимок на 2026-11-27 ~12:00; API может
  опережать документ, но архитектурные выводы устойчивы.

---

## 0. TL;DR — восемь главных выводов

1. **Нативный слой старой версии уже почти целиком лежит в новом рантайме.**
   Все 20 браузерных адаптеров (`em_web_*.h`) в
   `Dune Sega Web/tools/` и `dune-web/runtime/adapters/` **побайтно совпадают**
   (одинаковые SHA-256). Новый `runtime.wasm` экспортирует те же
   `dune_web_tap_screen / pan / zoom / begin / end / gesture_query /
   camera_debug / minimap_* / screen_route / campaign_* / placement_* /
   building_ui_* / typed_input`, что и старая сборка. Значит, «мозг» тач-камеры,
   выбора/приказов, маршрутов меню и кампании переносить **не нужно** — он уже
   собран из того же MIT-кода. Переносится JavaScript-оболочка и ассеты.
2. **Камера работала «вполовину», но эту половину уже закрыли.** На момент моей
   пробы адаптеры считали камеру/зум/лейаут, а расширенную карту + HUD рисовал
   только SDL-рендерер (`vendor/rearrakis/.../dune_view_sdl.h`), поэтому
   `dune_web_pan/zoom` меняли `cameraX/worldWidth`, но картинка не двигалась.
   Параллельный агент в тот же день добавил `dune_web_expanded_frame_rgba()`:
   `dune_view_build()` + HUD-композиция в память, `host.expandedFrame()` /
   `drawExpandedFrame()` — см. `docs/WASM-TOUCH.md`. Значит, блокер снят;
   оставшаяся работа — **интеграция**: политика перерисовки (1 кадр = 2–4 мс),
   HUD-хотспоты после первого обзора, подключение в `web/app.mjs` и перенос
   JS-жестов. Резервный вариант — path B (SDL-презентация как в старой версии).
3. **JS-часть тач-управления переносится почти бесплатно.** `gestures.mjs`,
   `pan-inertia.mjs`, `map-input.mjs`, `order-input.mjs`, `placement-mode.mjs`,
   `context-action.mjs` не зависят от ассетов и от старого хоста — только от
   вызовов адаптеров. Их суммарный объём ~700 строк, перенос в `web/` — дни,
   не недели.
4. **HUD миссии и меню без ассетов возможны в «нативном фолбэке».** Пока
   ассетного пайплайна нет, пауза/настройки/меню зданий/выбор дома можно водить
   по оригинальному 320×224-кадру через `pad`/`campaign_input`/`screen_route`
   и `building_ui_tap(col,row)` — весь UI будет из оригинальной графики
   автоматически. Это позволяет довести игру до «играбельно» без единого
   извлечённого PNG.
5. **Ассеты — отдельный проект.** `web/ui-assets` ≈ 2,9 МБ / 360 файлов (343 PNG),
   `web/language-assets` ≈ 388 КБ, атлас 294 кропа (420 КБ, 2048×1709).
   Экстракторы — ~2 000 строк Python (`tools/extract_*.py`), часть требует
   промежуточных сырых дампов от нативных C-хелперов. Перенос в Pyodide —
   реально, но это отдельный крупный этап (оценка в §7.3).
6. **RU/EN — юридически асимметричен.** Английский bitmap-шрифт можно извлечь
   из ROM игрока на устройстве. Русский шрифт/графика команд/часть строк — из
   пиратского перевода Shedevr, их **нельзя** ни коммитить, ни поставлять;
   BYOP-вариант: EN по умолчанию, RU — только если игрок сам принесёт RU-ROM
   (или отказаться от RU). Это надо честно написать в UI.
7. **Сохранения уже перенесены** (`web/saves/*`, конверт `dune-sega-web-save` v1,
   payload DSAV v2). Осталось «игровое» поведение: Continue на старте, автосейв
   по 30 с/pagehide, F5/F8 и **гейтинг записи** только на живой вооружённый
   забег (как в старой `saveGame`).
8. **Старые `.state.bin`-фикстуры — тоже данные игры.** `frontend.state.bin`,
   `demo*.state.bin`, `training.state.bin`, `credits/house-*.state.bin` — это
   снимки оригинальной RAM, производные от ROM; их нельзя поставлять. Замена —
   получать состояние на устройстве: прокрутить оригинальную игру до main и
   снять `saveState()` (или ехать нативным маршрутом), а QA-фикстуры не переносить.

---

## 1. Карта старой архитектуры и отличие от новой

### 1.1 Старая версия (`Dune Sega Web`)

```
web/index.html            каркас: canvas, HTML-кнопки, inline-загрузчик (EN/RU font atlas), CSS
web/entry.js              выбор режима: install-gate / offline / ?legacy → shell.js
web/shell.js    (321)     «клей»: Module (Emscripten), все адаптеры, жесты, HUD-кнопки,
                          pollState() каждые 50 мс, автосейв, fullscreen, экранные маршруты
web/engine/dune_web.js    Emscripten-загрузчик (201 338 B) + dune_web.wasm (5 273 530 B) —
                          готовое ядро + браузерные адаптеры + SDL-презентация
web/gestures.mjs  (57)    распознавание pan / pinch / minimap / tap / placement
web/map-input.mjs (54)    один PointerEvent-поток, без compatibility click
web/pan-inertia.mjs (111) инерция камеры для touch/pen
web/order-input.mjs (87)  выбор vs приказ, double-tap, typed-input token
web/placement-mode.mjs    перенос готовой постройки, Palace target
web/native-ui.mjs (142)   NativeArt: PNG-скины кнопок, шрифт, blur, живость кадра
web/game-ui.mjs  (616)    весь HTML-фронтенд: home/houses/missions/story/pause/options/
                          languages/platform/tutorial/completion + переходы
web/building-ui.mjs       адаптивный экран 15 типов зданий из native PNG + живых фрагментов
web/i18n.mjs, locale-ui-ru.mjs, language-assets/*   EN/RU
web/campaign-state.mjs, save-files.mjs, browser-features.mjs   прогресс и сейвы
web/service-worker.js, update.html, install-gate.mjs, viewport.mjs, browser-features.mjs   PWA
web/runtime-atlas.mjs, asset-loader.mjs   загрузка 294 PNG-кропов одним атласом
web/native-audio.mjs, native-audio-worklet.js   AudioWorklet-мост
web/qa.mjs, qa-modern.mjs  dev-only (?qa) — не переносить
```

Итого ~3 741 строка собственного JS + готовое ядро. UI собирается **только из
оригинальной графики**: PNG-скины кнопок/рамок/шрифты извлекаются из ROM
(`tools/extract_*`, `data/*`, `web/ui-assets/*`).

### 1.2 Новая версия (`dune-web`, path A)

```
web/index.html            ROM → сборка → «Играть» → canvas 320×224 + dpad/A/B/START
web/app.mjs     (707)     BYOP-оболочка: установка ROM, прогресс сборки, сейвы, игра,
                          простые жесты (tap/double-tap/pan/zoom) вручную, лист «Пауза»
web/host/host.mjs (882)   DuneHost: runtime.wasm + game.wasm + ROM, кадры RGB 320×224,
                          pad/tapScreen/hoverScreen/beginPan/panCamera/endPan/zoomCamera,
                          cameraDebug/selectionDebug, saveState/loadState, call(), frameStats
runtime/wasm/runtime.wasm 897 821 B (снимок 2026-11-27), 154 экспорта; 70 адаптеров
runtime/adapters/em_web_*.h   20 заголовков, 1:1 со старой версией
web/py-src/…              ROM → game.wasm в браузере (Pyodide)
web/saves/*               конверт сейвов, совместимый со старой версией
```

Ключевые различия:

| | старая | новая (сейчас) |
|---|---|---|
| ядро игры | вшито в репозиторий/страницу | генерируется из ROM игрока на устройстве |
| рендер | SDL/WebGL-презентация: расширенный мир + HUD | `dune_web_frame_rgb` → `putImageData`, ровно 320×224 |
| ввод | адаптеры + JS-жесты | pad/кнопки + простые жесты в `app.mjs` |
| экраны | HTML-оболочка из оригинальных PNG | оригинальные экраны игры как есть (320×224) |
| ассеты | 360 файлов извлечено | нет (и не должно быть в git) |

### 1.3 Что это значит

Нативные адаптеры — общий знаменатель. Их уже проверяли на идентичность в
старой версии (`docs/native-*.md`), а новый рантайм собран из тех же файлов.
Поэтому план переноса — не «переписать камеру», а:

1. **подключить к UI то, что адаптеры уже считают** (камера + expanded-frame);
2. перенести нетривиальную JS-логику жестов/приказов/HUD;
3. построить UI-слой либо из live-кадра (бесплатно), либо из извлечённых
   ассетов (дорого);
4. оставить ядро/правила игры нетронутыми.

---

## 2. Обозначения способов переноса

| код | смысл |
|---|---|
| **a** | переиспользовать как есть — наш JS без игровых ассетов, почти без изменений |
| **b** | адаптировать к `DuneHost` (вызовы адаптеров вместо `Module`, координаты, кадры 320×224) |
| **c** | требует извлечения данных из ROM игрока на устройстве (порт экстракторов в Pyodide) |
| **d** | переписать / не переносить |

Оценки — в человеко-днях одного разработчика, без учёта ревью и устройств.

---

## 3. Инвентаризация фич и приоритеты

### P0 — без этого нельзя играть

1. Тач-камера миссии: pan, pinch, инерция, колесо/трекпад, миникарта.
2. Выбор/приказ: одиночный тап (select), double-tap (order), ПКМ (order),
   hover (ПК), снятие выделения, отмена.
3. HUD миссии: `MENU`, контекстная `REPEAT/DETONATE/DEPLOY`, `PLACE/ATTACK` +
   `CLEAR`, тост-сообщения, индикация credits/minimap (из live-кадра).
4. Пауза/настройки/маршруты: открыть паузу, вернуться в игру, options,
   main menu, restart, экран здания.
5. Сохранения: импорт/экспорт (готово), Continue на старте, автосейв, F5/F8,
   запись только в живой миссии.
6. Запуск до играбельного меню без ROM-производных `.state.bin`.

### P1 — существенно для продукта

7. RU/EN (см. §8 — юридически ограничено).
8. Полный экран + safe-area/visual viewport.
9. Установка/PWA/офлайн/обновление.
10. Справка «Как играть?», туториал/подсказки.
11. Брифинг/сюжет/результаты/титры в HTML-оболочке (нативные экраны остаются
    источником картинки).
12. Устойчивость: fault/повтор, ошибки хранилища, потеря сети.
13. Меню зданий (без него база не строится) — P0-фолбэк + P1-ассетный UI.

### P2 — полировка

14. Переходы/шторки, order feedback, подсветка цели, звуки интерфейса.
15. Кэши/производительность (frame-serial, canvas_visible, heroPaintKey).
16. Вступительный inline-экран (loading) и атрибуция.
17. QA-инструменты (`?qa`, demo/training) — **не переносить**.

---

## 4. Таблица: фича → файлы старой версии → способ → оценка

| # | Фича | Файлы старой версии | Механика | Способ | Оценка |
|---|---|---|---|---|---|
| 1 | Распознавание жестов | `web/gestures.mjs` | порог 8 CSS px, pan/pinch/minimap/place/tap | **a/b** | 0,5 |
| 2 | Инерция камеры | `web/pan-inertia.mjs` | tau 220 мс, v≤1000 px/s, ≤220 px, ≤850 мс; только touch/pen | **a/b** | 0,5 |
| 3 | Pointer-поток | `web/map-input.mjs` | capture-фаза, `preventDefault`/`stopImmediatePropagation`, tap на pointerup, ПКМ-command | **b** | 1 |
| 4 | Выбор/приказ/typed input | `web/order-input.mjs`, `shell.js` (`mapTap`, `beginPointer`, `orders`) | double-tap 300 мс / slop 24, `dune_web_actor_capture` → `command_screen`, deferred selection 100 мс | **b** | 1–2 |
| 5 | Готовое размещение | `web/placement-mode.mjs`, `shell.js` (`targetMode`, `pendingReadyYard`) | drag от Yard (>8 px), edge-scroll 42 px/155 px/s, `placement_*` | **b** | 2–3 |
| 6 | Palace target | там же + `context-action.mjs` | двойное касание цели, identity, 300 мс окно | **b** | 1 |
| 7 | HUD-кнопки миссии | `shell.js` (`pollState`, `renderTargetActions`), `context-action.mjs`, `native-ui.mjs`, CSS в `index.html` | poll 50 мс `actions_debug`/`camera_debug`/`campaign_json`; декор PNG-скинами | **b** + **c** (скины) или live-frame | 2–3 (P0-фолбэк) / +3–4 (ассеты) |
| 8 | Пауза/options/route | `game-ui.mjs`, `campaign`-адаптеры в рантайме, `confirm-dialog.mjs`, `options-layout.mjs`, `screen-transition.mjs` | `screen_route(3/4/1/0)`, `campaign_input`, `scene/sceneReady/inputReady` | **b** + **c** (фон/рамки/шрифт) | 3–5 |
| 9 | Home/houses/missions/campaign | `game-ui.mjs` (showHome/showHouses/showMissions/startMission), `campaign-state.mjs` | `campaign_start(house,mission)`, прогресс | **b** (логика) + **c** (кресты/логотип) | 2–3 без ассетов |
| 10 | Сохранения | `shell.js` (`saveGame`, `loadPayload`), `campaign-state.mjs`, `save-files.mjs` | DSAV v2 + гейтинг; формат уже перенесён | **a** (формат) + **b** (гейтинг/UX) | 1–2 |
| 11 | Продолжение на старте | `shell.js`, `campaign-state.mjs` (`resumable`) | `CONTINUE` из localStorage, диалог дом/миссия | **b** | 0,5 |
| 12 | Автосейв | `shell.js` | 30 с + `visibilitychange`/`pagehide`, F5/F8 | **b** | 0,5 |
| 13 | Запуск до main без фикстуры | `game-ui.mjs` (`frontendState`), `frontend.state.bin` | старый грузит 140 921-байтный снимок | **b** (снять состояние на устройстве) | 1–2 |
| 14 | Меню здания (фолбэк) | `building_ui_*` в рантайме, `building-ui.mjs` | `building_ui_json` + `building_ui_tap(col,row)` по 320×224 | **b** | 1–2 |
| 15 | Меню здания (HTML UI) | `building-ui.mjs`, `data/shop-layout-kit`, `data/building-assets` | адаптивная сетка 6×3/4×3 из PNG + live-фрагменты | **b** + **c** | 8–12 |
| 16 | RU/EN | `i18n.mjs`, `locale-ui-ru.mjs`, `language-assets/*`, `tools/extract_language_assets.py` | 259 строк EN/RU, 111 сюжетных реплик, RU-команды EXIT/FIX/STOP | **a** (логика) + **c** (EN шрифт) / **d** (RU ассеты) | 2–3 (EN) |
| 17 | Локализация результатов/титров | `localized-results.mjs`, `_dune_web_results_frame_rgb`, `localized_scene_frame_rgb` | read-only overlay по завершённому кадру | **b** | 1–2 |
| 18 | Полный экран/safe-area | `viewport.mjs`, `browser-features.mjs` | `visualViewport`, iPhone standalone inset, `--app-map-hud-top` | **a/b** | 0,5–1 |
| 19 | Установка/офлайн/PWA | `install-gate.mjs`, `service-worker.js`, `update.html`, `build_publication.py` | precache + SHA, verified offline, update page | **b/d** (модель обновлений иная) | 2–4 |
| 20 | Справка/туториал | `controls-guide.mjs`, `tutorial.mjs`, `web/tutorial-assets` | рамки/стрелки из PNG, 33 кадра | **a** (тексты) + **c** (рамки/кадры) | 1 / +2–3 |
| 21 | Переходы/шторки | `screen-transition.mjs`, `scene-flow.css` | cover 240 мс, только готовый кадр | **a** (логика) + **c** (детали рамки) | 1–2 |
| 22 | Order feedback | `order-feedback.mjs`, `extract_input_feedback.py`, `extract_target_feedback.py` | 2 мигания прицела, PNG-ассеты | **d**/**c** (не критично) | 2–3 |
| 23 | Производительность | `shell.js`, `game-ui.mjs` (`LiveNativeFrame`, `frameReadKey`, `heroPaintKey`), runtime (`frame_serial`, `canvas_visible`, single-present) | грязные кэши кадра/раскладки, один SDL-вызов/кадр | **a/b** | 1–2 |
| 24 | Boot/loading-экран | inline-скрипт в `index.html`, `build_startup.py` | EN/RU glyph atlas в первом HTML-ответе | **a** (код) ; шрифт игрока — **c**/заменить системным | 0,5 |
| 25 | Ошибки/fault | `shell.js` (`onAbort`), `install-gate.mjs`, startup `fail()` | retry, текст ошибки, отказ хранилища | **a/b** | 1 |
| 26 | QA/фикстуры | `qa.mjs`, `qa-modern.mjs`, `demo*.state.bin`, `training.state.bin` | dev-only | **d** | — |
| 27 | Звук | `native-audio.mjs`, `native-audio-worklet.js`, `em_web_audio_levels.h` | AudioWorklet-мост, уровни | **b** (после Z80) | вне этой задачи |

«Почти бесплатно» (a/b без ассетов, вместе ~1 200 строк): пункты 1–4, 10–13,
18, 21 (логика), 23, 24 (код), 25.

---

## 5. Тач-управление и камера — конкретный план

### 5.1 Две системы координат (важно не перепутать)

В старой версии `dune_web_resize(cssW, cssH)` сообщает SDL/адаптерам CSS-размер
окна, и **все** координаты жестов передаются в CSS-пикселях относительно canvas.
Внутри `camera_debug`:

- `cssWidth/cssHeight` — CSS-размер;
- `outputWidth/outputHeight` — физический (×DPR);
- `scale = world→CSS` (например 390/320 = 1,21875);
- `left/top` — мировой пиксель левого верхнего угла вида;
- `worldWidth/worldHeight` — размер вида в **нативных мировых** пикселях
  (портрет 320×693, ландшафт 485×224 — т.е. вид всегда заполняет экран);
- `uiX/uiY/uiScale` — куда ложится нативный 320×224 (для HUD/оверлеев);
- `minimap.{x,y,width,height,viewX,viewY}` — положение и видимая область
  миникарты в CSS-пикселях.

В новой path A (текущий `app.mjs`) виртуальное окно прикреплено как 320×224, а
canvas в CSS выставлен с сохранением пропорции 320:224, поэтому координаты
считаются так:

```js
const r = canvas.getBoundingClientRect();
const x = (event.clientX - r.left) * 320 / r.width;   // в кадр 320×224
const y = (event.clientY - r.top)  * 224 / r.height;
```

Это верно, пока canvas-элемент не имеет letterbox внутри себя (сейчас так и есть).
Если позже рантайм будет презентовать расширенный вид (рекомендуемый путь), то
надо переключиться на старую схему: `dune_web_resize(cssW, cssH)` +
`dune_web_set_map_hud_top(inset/height)` и передавать **CSS-координаты**;
letterbox/центрирование уже учтены в `uiX/uiY/uiScale` (в старой версии это
решено — `dune_view_layout()` в `vendor/rearrakis/.../dune_view.h`).

### 5.2 Обязательный порядок вызовов (как в `shell.js`)

```
pointerdown (touch/pen/mouse):
  если HTML-экран захватывает ввод → игнор
  stopPanMotion()                     // новое касание гасит инерцию
  if kind === touch/pen → panInertia.begin(kind, now)
  если точек ещё нет → Module._dune_web_begin(x, y)
  gestures.down({id,x,y,kind})

  gestures.down:
    можно ли панорамировать здесь: canPanAt = Module._dune_web_gesture_query(x,y) === 1
    if _dune_web_minimap_begin(x,y) === 1 → mode='minimap'
    else mode='pending'
    второй палец: cancel placement; если обе точки на карте → mode='pinch';
                  иначе 'blocked'

pointermove:
  1 палец: если mode='pending' и сдвиг > 8 px:
             если !canPanAt(origin) → blocked
             иначе (готовый Yard) placementStart(origin) ? 'place' : 'pan'
           если 'pan'     → Module._dune_web_pan(dx, dy)         (+ panInertia.sample)
           если 'minimap' → Module._dune_web_minimap_move(x,y)
           если 'place'   → Module._dune_web_placement_move(x,y)
  2 пальца ('pinch'):
           Module._dune_web_pan(dMidX, dMidY)
           Module._dune_web_zoom(ratio, midX, midY)   // ratio = newDist/oldDist
  hover (мышь, вне нажатия): Module._dune_web_hover_screen(x,y)  (троттлинг ~40 мс)

pointerup:
  'pending' → orderInput.tap(x,y,kind)     // без таймера, коммит на отпускании
  'pan'     → inertialCameraHeld = panInertia.release(now);
              если не инерция → Module._dune_web_end()
  'place'   → Module._dune_web_placement_end(x,y)
  'minimap' → Module._dune_web_end()

wheel (ПК): Module._dune_web_zoom(exp(-clamp(deltaY*k)), x, y)
ПКМ:        token = Module._dune_web_actor_capture();
            token && Module._dune_web_command_screen(x,y,token)
RAF (инерция): пока panInertia.active → Module._dune_web_pan(dx,dy); при возврате 0 — стоп.
```

Почему это работает «из коробки»: адаптеры в новом рантайме те же; проба
(§15.3) подтвердила `gesture_query=1`, `tap_screen=1`, `begin=1`, `pan=1`
(cameraX 1402→1442), `zoom(0.8)=80` (world 320×224→400×280).

### 5.3 Инерция

`PanInertia` — чистый JS, ассеты не нужны. Параметры по умолчанию уже
отлажены: `tauMs=220`, `maxSpeed=1000`, `maxDistance=220`, `maxDurationMs=850`,
`minSpeed=90`, `stopSpeed=18`. Ключевые правила:

- включается только для `touch`/`pen`;
- сэмплы только во время `mode === 'pan'`;
- одно касание/pan/pinch/placement/minimap/меню/изменение размера/уход
  страницы — `cancel()`;
- шаг выполняется из существующего RAF, а не из таймера;
- новый ввод сначала останавливает камеру, затем обычный выбор.

### 5.4 Выбор и приказ (typed input)

`OrderInput` (87 строк + логика в `shell.js`) — переносить целиком:

- одиночный тап = `select` (`dune_web_select_screen`), пустое место снимает выбор;
- повторный одиночный тап по выбранному *зданию* открывает его меню;
- double-tap (300 мс, slop 24) = `dune_web_actor_capture()` →
  `dune_web_command_screen(x,y,token)`;
- ПКМ = сразу command;
- «deferred selection» 100 мс нужен, чтобы одинарный тап по цели не мешал
  немедленному двойному приказу; у Palace окно 300 мс;
- при pan/pinch/placement/minimap/смене экрана/скрытии вкладки — `cancel()`.

Контекстные действия/HUD читают `dune_web_actions_debug`:
`selected.kind`, `bAvailable/bKind`, `placementActive`, `special.armed`,
`lastOrder`, `readyYard`. Кнопка B вызывает `dune_web_action_b()`, снятие —
`dune_web_clear_selection()`, подтверждение размещения —
`dune_web_placement_confirm()`, атака Palace — `dune_web_command_world(wx,wy,token)`.

### 5.5 Готовое размещение и Palace

Правила старой версии (реализованы в `placement-mode.mjs` + `shell.js`):

- тянуть надо от своего Construction Yard с готовым оплаченным продуктом,
  когда не выбран юнит; короткий клик не начинает перенос;
- показ цветной сетки — только во время удержания; отпускание = одна попытка
  `placement_end`, отказ — родной звук и сброс;
- edge-scroll только в этом режиме: `placementEdgeVelocity(pos, size, 42, 155)`;
- Palace: при активном прицеле виден неподвижный маркер в центре вида;
  двойное касание цели отдаёт приказ; первый тап по своему зданию ждёт 300 мс.

### 5.6 Чего не хватает в новом рантайме/хосте для камеры

Факты моей пробы (§15.3, сборка рантайма до появления expanded-frame):
`host.frameSize()` был `320×224`, `dune_web_frame_rgb()` = кадр VDP;
`dune_web_pan/zoom` меняли `cameraX/zoom`, но `nativeCameraX` не менялся, и
нативный кадр не двигался — расширенный мир+HUD рисовал только SDL-рендерер.

**Актуальное состояние (закрыто параллельным агентом, см. `docs/WASM-TOUCH.md`):**
в рантайм добавлен `dune_web_expanded_frame_rgba()` — вызывает существующий
`dune_view_build()` (обходит мир на shadow-CPU, не пишет игровое состояние),
масштабирует мир по `layout.world_scale` и альфа-компонует HUD 320×224 «точно
как `dune_view_draw()`, но в память». В хосте — `expandedFrame()` (RGBA-вью) и
`drawExpandedFrame()` (в canvas); один кадр 2–4 мс. Ограничения из того же
документа, которые надо учесть в UI:

- это **on-demand** API, не rAF-цикл; политику «когда строить обзор»
  (на pan/zoom — чаще, в покое — по требованию) решает UI-слой;
- HUD-хотспоты (`context=2`, мини-карта `context=3`) распознаются только после
  первого построенного `expandedFrame`/`drawExpandedFrame` (иначе тап = world);
- `drawFrame()` остаётся нативным 320×224; для отображения пана/зума нужен
  `drawExpandedFrame()`; canvas на время обзора имеет размер виртуального окна;
- `zoom` клампится в [50,100] %, первый `zoom(1.2)` вернёт 100.

Что осталось по презентации (оценка):

1. **Интеграция expanded-frame в `app.mjs` + политика перерисовки** — 1–2 дня:
   переключение нативный кадр ↔ расширенный обзор, запрет двойной сборки за
   кадр, HUD-кнопки поверх, hit-test мини-карты по `camera_debug.minimap`.
2. **Резерв: path B** (рантайм с emcc-glue/SDL-презентацией, как старая
   версия) — дороже (новый артефакт/ABI-пин), но 1:1 со старой картинкой и
   SDL-событиями; рассматривать, если on-demand обзора не хватит по
   плавности/латентности.
3. **Фолбэк без расширенного обзора** — нативный 320×224-кадр + тап/выбор/
   приказ (работает), pan/zoom скрыть, камеру двигать краем/pad. Играбельнее
   текущего, но хуже старой версии.

### 5.7 Что добавить в `DuneHost` (API-эскиз)

```js
resizeViewport(cssW, cssH)         // call('dune_web_resize'); плюс setMapHudTop(insetRatio)
setMapHudTop(ratio)                // call('dune_web_set_map_hud_top', ratio)
gestureQuery(x, y)                 // call('dune_web_gesture_query') → 0/1/2
actorCapture()                     // call('dune_web_actor_capture')
commandScreen(x, y, token)         // call('dune_web_command_screen')
selectScreen(x, y)                 // call('dune_web_select_screen')
clearSelection(), actionB(), actionSelf()
placementBegin/Move/End/Confirm/Cancel
minimapBegin/Move
screenRoute(target)                // 0 main, 1 options, 2 tutorial, 3 pause, 4 resume
campaignStart(house, mission), campaignInput(action, value), uiSound()
targetScreen(x, y)                 // JSON: hit.inputActor/target/context
expandedFrame()/drawExpandedFrame()// уже есть: расширенный мир + HUD (docs/WASM-TOUCH.md)
```

Координаты в этих вызовах — **виртуального окна** (сейчас 320×224; после
`resizeViewport` — CSS-пиксели). `capabilities()` уже показывает, какие
экспорты есть.

### 5.8 Функциональная проверка жестов (реальные числа)

- Старая версия, портрет 390×844, карта миссии 1 Atreides:
  – drag 12 сэмплов → 12 `panEvents`, `cameraX 647→727`, `cameraY 1031→1077`;
  – pinch **к центру** → `zoom 100→50`, world view `320×693 → 355×768`,
  `minimap.viewWidth` уменьшился (скриншот `portrait-21-map-zoomout.png`);
  – pinch **от центра** упирается в потолок 100 % (это максимум, не баг);
  – `taps`/`selectRequests` инкрементируются только на отпускании; drag не
  отправляет приказ.
- Ландшафт 844×390: те же 12 `panEvents`, `worldWidth 485`, `uiScale 1,741`,
  те же 21 вызов `zoom` (проверка зума 50–100 % — в портрете).
- Новый хост (path A, виртуальное окно 320×224): `pan` принимается, камера
  адаптера меняется, но кадр 320×224 не двигается (§5.6).

---

## 6. HUD/меню/навигация

### 6.1 Что уже есть в рантайме (общее с старой версией)

`em_web_campaign.h` — это фактически весь бэкенд меню/маршрутов/кампании:

- `dune_web_screen_route(target)`: 0 main, 1 startup options, 2 tutorial,
  3 pause, 4 resume map; глобальные маршруты отклоняются в бою;
- `dune_web_campaign_start(house, mission)` — оригинальный путь
  NewHouse → выбор дома → briefing → загрузка сценария;
- `dune_web_campaign_input(action,value)`:
  0 raw pad mask, 1 строка options, 2 Right в options, 3 строка main,
  4 house id, 5 первый/второй выбор подтверждения;
- `dune_web_campaign_json()`: `scene`, `sceneReady`, `inputReady`,
  `presentationReady/Phase`, `messageText/visibleMessageText`,
  `choiceLabels`, `confirmStyle`, `continueMask`, `houseId/mission`,
  `activeRunArmed`, `outcome/outcomeSeq`, `rows`, `statsDisplay` и т.д.;
- `dune_web_ui_sound()` — родной звук интерфейса через `$2DDB6`;
- `dune_web_frontend_hold/audio`, `dune_web_route_hold`,
  `dune_web_transition_covered` — синхронизация фронтенда с оригиналом;
- `dune_web_building_ui_json()/building_ui_tap(col,row)/building_ui_frame_rgb()`;
- `dune_web_actions_debug/selection_debug/placement_*`;
- `dune_web_set_hidden`, `dune_web_pause`, `dune_web_rebase`,
  `dune_web_reset_clock`, `dune_web_frame_serial`, `dune_web_canvas_visible`.

Всё это уже экспортируется новым `runtime.wasm`. Поэтому навигацию можно
поднимать слоями, не трогая игру.

### 6.2 Что переиспользуется без ассетов (a/b)

- Машина состояний `game-ui.mjs`: `view` (home/houses/missions/controls/
  languages/platform/completion/native), `pendingScreen`, `curtain`,
  `matchesPending`, `capturesInput`, `canAdvanceDialog`, таблица `SEQUENCE`,
  `TITLE`, обработка `back()`, дебаунс повторных запросов.
- Доказавшие себя правила:
  – экран считается готовым только по `sceneReady`/`presentationReady` и
  границе завершённого кадра, не по таймеру;
  – переход закрывается шторкой, пока не готов кадр; никаких PNG-превью;
  – пауза — это `screen_route(3)`, назад — `screen_route(4)` (маршрут, не
  toggle Start);
  – `frontend_hold(1)` на HTML-экранах, чтобы оригинал не ушёл в attract;
  – `ui_sound()` для обратной связи;
  – `presentationPhase` различает briefing_exit/strategic_map/
  battle_loading/flyover/results/finale/credits.
- Подтверждающий диалог (`confirm-dialog.mjs`) — тонкий DOM-слой:
  текст, кнопки, inert-фон, фокус; рамку можно заменить CSS/живым кропом.
- Раскладка `modern-ui.css` + `scene-flow.css`: сетка `head/hero/message/
  actions/footer`, портрет/ландшафт-медиазапросы, `safe-area`, цели ≥44 px,
  прокрутка только области действий. Это «бесплатный» UX-опыт; зависит от
  ассетов только визуал (фон/скины/шрифт).
- `controls-guide.mjs` — строки подсказок и перенос текста (без ассетов);
  рамка/стрелки — PNG.

### 6.3 Что требует ассетов (c)

| элемент | откуда | объём |
|---|---|---|
| скины HTML-кнопок (`command-skin-*`, focus/pressed) | `data/shop-layout-kit` → `web/ui-assets` | 50 частей, 6 модулей |
| шрифт UI EN | `screen-assets/fonts` (ui/mask/shadow) | 6 шрифтов |
| рамки/фоны экранов | `data/screen-assets` | 218 частей, 26 экранов |
| кресты домов, логотип/планета | `screen-assets` + `campaign` | — |
| атлас для быстрой загрузки | `build_runtime_atlas.py` | 294 кропа, 420 КБ |
| меню зданий | `data/building-assets`, `data/shop-ui-assets`, `merge_starport_ui_assets.py` | 19+19 + 66 PNG |
| справка/туториал | `data/modern-tutorial` | 33 полных 320×224 кадра |
| RU-команды EXIT/FIX/STOP | `language-assets/commands` (Shedevr) | 12 PNG |

### 6.4 P0-оболочка без единого ассета (рекомендуемый первый шаг)

1. Миссия: оставить нативный 320×224-кадр на canvas; сверху HTML: `≡MENU`,
   `A`-контекст, `REPEAT/DETONATE/DEPLOY`, `PLACE/CLEAR`, тост. Скины —
   временные CSS-панели или **кропы live-кадра** (рамка меню/кнопка из
   текущего VDP-кадра — это оригинальная графика и не является ассетом
   в git). Это закрывает «играбельно и понятно».
2. Пауза/options/main: водить оригинальный экран 320×224 тапами
   (`campaign_input`) и показывать HTML-кнопки поверх, пока не появится
   ассетный HTML-UI. Ориентиры — `rows`/`choiceLabels`/`optionsInGame`.
3. Меню здания: если `building_ui_json()` активен, рисовать нативный кадр и
   отправлять тап в ячейку `building_ui_tap(col,row)`; сетка 6×3/4×3
   известна из JSON.
4. Выбор дома/миссии: до ассетов — нативный экран (он в игре и так есть);
   HTML-каталог с крестами — после ассетов.

### 6.5 Что требует переписывания (d)

- `install-gate.mjs` как отдельный «гейт установки» не нужен: у BYOP уже есть
  экран ROM/сборки. Тексты и определение платформы — переиспользовать.
- `service-worker.js`/`update.html` старой модели (кэш всего сайта вместе с
  игровыми ассетами) не подходит: в BYOP в CacheStorage лежит только наш код,
  а ядро/ассеты — в OPFS у игрока. Нужна переработка.
- `qa.mjs`, `qa-modern.mjs`, `demo*/training/credits .state.bin`,
  история `?legacy` — dev-only.
- `web/engine/dune_web.js` (Emscripten-glue) — заменяется `runtime/loader.mjs`.
- `base-prototype/`, `asset-library/`, `_site`-экспорт — отдельные
  исследовательские артефакты.

---

## 7. Ассеты и легальность

### 7.1 Инвентарь старой версии

| каталог | файлов | размер | что |
|---|---:|---:|---|
| `web/ui-assets` | 360 (343 PNG) | ≈ 2 968 КБ | экраны/части/шрифты/иконки/юниты/кампания, атлас 294 кропов |
| `web/language-assets` | — | ≈ 388 КБ | `manifest`, `en.json` (259 строк), `ru.json` (259), RU-команды 12 PNG, шрифты mask/shadow EN/RU |
| `web/tutorial-assets` | — | ≈ 308 КБ | 33 кадра туториала |
| `web/icons` | — | ≈ 32 КБ | PWA-иконки |
| `web/engine` | 2 | 5 474 868 B | встроенное ядро + glue |

Источники: `data/*` (`screen-assets` 1,5 МБ, `language-assets` 2,8 МБ,
`shop-layout-kit` 424 КБ, `building-assets` 244 КБ, `unit-assets` 288 КБ и т.д.),
сборка — `tools/build_ui_assets.py` (детерминированный манифест, 343 файла,
1 126 325 байт), `tools/build_runtime_atlas.py`, `tools/build_startup.py`.

### 7.2 Как извлекали

- `tools/extract_screen_assets.py` (543) + `extract_screen_assets_native.c`
  (нужен clang, сырые дампы в `.local`);
- `tools/extract_shop_layout.py` (289, тоже нативный шаг), `extract_shop_ui.py`
  (162, LCW/палитры), `extract_building_assets.py` (162),
  `extract_unit_assets.py` (87), `extract_language_assets.py` (242 — **чистый
  Python**: шрифт из ROM по адресу `0x4f6c8`, строки, RU-команды),
  `extract_campaign_manifest.py` (94), `merge_starport_ui_assets.py`,
  `build_ui_assets.py`, `build_runtime_atlas.py`, `build_startup.py`.
- Всё сверяется с ROM SHA (`b1bbe731…`) и исходниками (`docs/source-identity.json`).

### 7.3 Перенос экстракторов на устройство (c)

- **Просто (1–3 дня):** `extract_language_assets.py` — чистый Python, читает
  ROM, пишет PNG через `zlib/struct`; в Pyodide работает без изменений.
  Даёт EN-шрифт (и RU, если игрок принесёт RU-ROM), строки, команды.
- **Средне (3–5 дней):** `extract_campaign_manifest.py`, `extract_building_assets.py`
  (иконки/монитор, LCW), `extract_shop_ui.py`, `build_runtime_atlas.py`,
  `build_ui_assets.py` — чистый Python, но нужны проверки/манифесты.
- **Сложно (1–2 недели):** `extract_screen_assets.py`,
  `extract_shop_layout.py`, `extract_unit_assets.py` — многошаговые: нативные
  C-хелперы дают сырые дампы, Python собирает PNG. Нативные шаги придётся
  либо переписать на Python (LCW/палитры/наложение), либо вынести в отдельный
  лёгкий WASM-модуль на устройстве.
- Юридически: **всё, что получено из ROM/перевода, генерируется на устройстве
  игрока и не коммитится**; проверка — `tools/check_no_game_data.py`,
  `.gitignore` (`.local/`, `web/vendor/`, `runtime/`).

### 7.4 Что нельзя переносить как данные

- ROM, `web/engine/*`, любые `.state.bin` (включая `frontend/demo/training/
  credits`), извлечённые PNG/JSON-строки сюжета, RU-шрифт/команды Shedevr,
  QA-фикстуры.
- Правило «интерфейс из ОРИГИНАЛЬНОЙ графики, не отсебятина» означает: наши
  новые панели/тексты допустимы только как сервисная оболочка; игровые
  кнопки/рамки/шрифты — либо из live-кадра, либо из ROM игрока.
  Пока ассетов нет, лучший компромисс — live-кропы кадра и CSS-рамки
  минимальной толщины, без «нарисованных» игровых панелей.

---

## 8. RU/EN

Старая версия:

- два шрифта (EN из USA-ROM, RU из перевода Shedevr) — `language-assets/fonts/*`;
- `i18n.mjs`: `GameLanguage` с lookup по нормализованному тексту, каталоги
  `en.json`/`ru.json` (259 строк), `locale-ui-ru.mjs` (UI-строки), story
  `locale-story-ru.json` (111 реплик, 95 `bySourceText`, 224 записи в `sentences`);
- переключение на лету, запоминается в `localStorage` (`dune-sega-language-v1`),
  независимо от прогресса; речь/музыка — оригинальные;
- результаты/титры переводятся read-only overlay поверх завершённого кадра
  (`localized-results.mjs`, `_dune_web_results_frame_rgb`,
  `_dune_web_localized_scene_frame_rgb` — **эти адаптеры уже в новом рантайме**).

Что переносимо:

- **a:** логика `GameLanguage` (lookup, `displayText`, нормализация) и сами
  UI-строки нашей оболочки (это MIT-код адаптации, не игровые данные).
- **c:** EN bitmap-шрифт и подписи из ROM — извлечь на устройстве
  (`extract_language_assets.py`).
- **d:** RU-шрифт, RU-команды и перевод Shedevr — нельзя ни коммитить, ни
  поставлять. Варианты для BYOP: (1) EN-only и честная строка «RU недоступен,
  потому что это фанатский перевод»; (2) опционально — игрок приносит
  RU-ROM/перевод, и экстрактор повторяет путь Shedevr (юридическая
  ответственность на игроке, в git ничего); (3) собственная кириллица
  запрещена правилом «только оригинальная графика».

Рекомендация: **P1 — EN-интерфейс из ROM + наши UI-строки; RU не обещать.**

---

## 9. Сохранения, Continue, автосейв

Уже готово в `dune-web`:

- `web/saves/save-files.mjs` — конверт `dune-sega-web-save` v1, канонический
  JSON, SHA-256, `validateNativeSave`, `parseSaveFile/createSaveFile/commitSaveFile`;
- `web/saves/campaign-state.mjs` — прогресс домов, миграция старых ключей;
- импорт старого `*.dune-save.json` проверен; новый порт принимает старые
  `engineSha256`.

Осталось перенести из старой (b, 1–2 дня):

- `saveGame()` из `shell.js`: писать только если `campaign_json` говорит
  `activeRunArmed`, `scene ∈ {map,building,pause}`, `sceneReady`, нет
  `fault/pending/routePending/uiCallActive` и валидны house/mission;
  размер 1..256 КБ; `store.saveSlot(house, mission, base64)`;
- `loadPayload()`: сброс жестов/оверлеев, `selection_reset`,
  `menu_select_reset`, `rebase`, восстановление аудио-настроек, инвалидация
  кадровых кэшей;
- автосейв 30 с + на `visibilitychange`/`pagehide` (только не в `?qa`);
- F5/F8 как ярлыки (или убрать: на телефоне не нужны);
- Continue на старте: дом/миссия в подтверждении, затем `loadState`;
- не забыть «сменить миссию = заменить Continue» (диалог старой версии).

Формат DSAV v2 не менять: `sizeof(DuneSaveState)=140056` (см. `docs/SAVES.md`).

---

## 10. Полный экран, PWA, установка, офлайн

- `viewport.mjs` (a/b): `measureAppViewport` — `visualViewport`, safe-area,
  iPhone standalone (докоррекция высоты), `--app-map-hud-top`; передаётся в
  `dune_web_set_map_hud_top(ratio)`, чтобы нативный HUD не уезжал под статус-бар.
  В новой версии `bindAppViewport` нужен из-за `resizeViewport` (§5.7).
- `browser-features.mjs` (a/b): определение iPhone/Samsung/Android, install
  prompt, fullscreen, download/share сейва (iOS `navigator.share`), pick file.
- `service-worker.js` (d/b): старая модель кэширует весь сайт вместе с
  ассетами и ядром. В BYOP: CacheStorage — только наш код; ядро и ассеты —
  OPFS игрока (OPFS уже используется для `game.wasm`). Нужны: версия пакета,
  проверка целостности, «не подменять работающую миссию», update-страница.
  Оценка 2–4 дня.
- `install-gate.mjs` (a тексты): экран установки уже есть в BYOP (ROM/сборка) —
  встроить инструкции по платформам.
- PWA-иконки: `build_pwa_icons.py` — наши иконки (не игровые) или оригинальный
  логотип из live-кадра; на первом этапе можно оставить текущие.

---

## 11. Производительность: приёмы старой версии

Что уже есть в рантайме (одинаковые адаптеры/`em_web_host.h`):

- один SDL-сервис на входе/выходе callback вместо каждого модельного мс;
- `em_web_canvas_presentable()` — не рисовать скрытый canvas под HTML;
- один растер расширенного мира за callback (иначе двойной);
- `dune_web_frame_serial()` — дешёвый dirty-чек без копирования пикселей;
- ограничение PCM-очереди, `hostAudio*` метрики;
- точные кэши тайлов/палитр в `em_web_world_raster.h`/`em_web_tile_row.h`.

Что перенести из JS (a/b, 1–2 дня):

- `LiveNativeFrame` — 320×224 ImageData с проверкой изменений и `revision`;
- `updateFrame()`-кэш по `[frame_serial, textless, ...]`;
- `heroPaintKey`/`paintKey` — не перерисовывать canvas, если ключ не менялся;
- атлас вместо 294 отдельных PNG (после ассетов) и `ImageBitmap`-кропы;
- `image-rendering: pixelated`, backing store 320×224, CSS-скейл браузером;
- не публиковать QA-диагностику каждые 50 мс в обычном режиме (в старой —
  только под `?qa`).

Чего старая версия не доказала (важно не переоценить): длинный тяжёлый бой,
нагрев/энергопотребление, физические iPhone/Android, 120 Гц. В отчётах старой
версии это явно помечено как непроверенное.

---

## 12. Ошибки и устойчивость

Перенести (a/b):

- boot-экран с «TRY AGAIN» и настоящим прогрессом (`window.duneStartup`);
- `onAbort`/fault → текст, не пустой чёрный экран;
- ошибки хранилища (QuotaExceeded) при сейве — не терять существующий сейв;
- повреждённый/несовместимый файл сейва — коды `wrong-game`,
  `incompatible-version`, `invalid-format`, `too-large` (уже в `save-files`);
- запрет перехода, если не удалось сохранить перед Main Menu;
- «не подменять работающую миссию» при обновлении;
- аудио-восстановление после прерывания (worklet/SDL fallback) — после Z80.

---

## 13. Риски и чек-лист проверки на устройстве

**Риски**

1. **Интеграция расширенного обзора**: сам буфер уже есть, но политика
   перерисовки/латентность на телефоне и `1 кадр = 2–4 мс` не измерены;
   без аккуратной интеграции камера будет «дёргаться» или жечь батарею.
2. **Стоимость world-raster**: в старой версии широкий демо-экран давал ~44 %
   duty одного потока; на телефоне камера и зум могут стать главным
   ограничителем. Нужны замеры, не обещания.
3. **Ассетный пайплайн**: 2 000 строк экстракторов + нативные шаги; основная
   оценка неопределённости проекта.
4. **RU**: юридически заблокирован (Shedevr) — обещать нельзя.
5. **ROM-производные `.state.bin`** нельзя поставлять; замена на устройстве.
6. **Двойная работа**: параллельные изменения рантайма/хоста могут поменять
   API; координировать `expandedFrame`/`resizeViewport` с владельцем тач-камеры.
7. **Сейвы**: старый `engineSha256` в файлах — не ломать совместимость при
   новом ядре (`compatibility` уже это учитывает).
8. **UI-легальность**: временные CSS-панели не должны маскироваться под
   оригинальные игровые панели; лучше live-кропы.

**Проверить на устройстве (iPhone Safari + Home Screen, Android Chrome)**

- портрет 390×844 и ландшафт 844×390 (и 800×300, 1280×720 на десктопе);
- safe-area: статус-бар/чёрная полоса, `topInset` для нативного HUD;
- тап/двойной тап/долгое удержание/ПКМ/колесо; выбор → приказ;
- перетаскивание карты и инерция; pinch-зум 50–100 % с сохранением точки;
- миникарта: тап и drag, «мёртвое» чёрное поле не ловит пальцы;
- drag от Yard, edge-scroll, отказ размещения, Palace-прицел;
- пауза из миссии и возврат; Music/Sound; рестарт; выход в main с сейвом;
- Continue после перезагрузки/установки; импорт/экспорт файла сейва;
- офлайн после установки; обновление не ломает сейв;
- звук после фона/прерывания (когда будет Z80);
- длинный бой с большим числом спрайтов, нагрев/батарея.

---

## 14. Приоритетный план (первые шаги с оценками)

| шаг | что | результат | оценка |
|---|---|---|---|
| 1 | **Интеграция уже готового expanded-frame** (`host.expandedFrame()/drawExpandedFrame()`, `docs/WASM-TOUCH.md`) в `web/app.mjs`: переключение нативный кадр ↔ расширенный обзор, политика on-demand, HUD/мини-карта, `resizeViewport/setMapHudTop` в `DuneHost` | двигается камера, работает зум, HUD-полосы как в старой версии | 1–2 д |
| 2 | **Перенос тач-слоя**: `gestures.mjs`, `pan-inertia.mjs`, `map-input.mjs`, `order-input.mjs`, `placement-mode.mjs`, `context-action.mjs` → `web/`; заменить самописные жесты в `app.mjs` | тап/двойной/ПКМ/pan/pinch/инерция/миникарта/размещение | 2–3 д |
| 3 | **HUD миссии без ассетов**: `≡MENU`, `A`, `REPEAT/DETONATE/DEPLOY`, `PLACE/CLEAR`, тост, poll 50 мс (`actions_debug`/`camera_debug`/`campaign_json`) | играбельный экран миссии | 2–3 д |
| 4 | **Пауза/options/main через адаптеры**: `screen_route(3/4/1/0)`, подтверждения, restart, main-menu с сейвом; нативный фолбэк + HTML-обёртка | можно выйти/вернуться/настроить звук | 2–3 д |
| 5 | **Сейвы в игре**: гейтинг `saveGame`, Continue на старте, автосейв 30 с/pagehide, обработка ошибок | прогресс не теряется | 1–2 д |
| 6 | **Убрать ROM-фикстуры**: состояние main menu получать на устройстве (`advance` + `pressStart` + `saveState`) или ехать нативным маршрутом; убрать привязку к `frontend.state.bin` | BYOP без скрытых данных | 1–2 д |
| 7 | **Меню здания (фолбэк)**: native frame + `building_ui_tap(col,row)` по сетке из `building_ui_json` | можно строить/покупать | 1–2 д |
| 8 | **P1-старт**: EN-шрифт из ROM (Pyodide-экстрактор), fullscreen/safe-area, справка «Как играть», экран установки/офлайн | продукт, а не демо | 4–6 д |

Дальше: ассетный HTML-UI (экраны/кресты/скины, c) — 2–4 недели; меню зданий
HTML (c) — 8–12 дней; RU — по решению о легальности.

---

## 15. Фактически проверено

### 15.1 Скриншоты старой версии (`/tmp/old-shot/`, не в git)

Запуск: `python3 tools/serve.py --port 4174` из старой папки, `http://127.0.0.1:4174/?qa`;
Playwright-core + системный Chrome, DPR 3/2, `hasTouch`.

Портрет 390×844:

| файл | экран |
|---|---|
| `portrait-00-boot.png`, `portrait-01-home.png` | загрузка, титул (SEGA/логотип, live-кадр) + `NEW CAMPAIGN/OPTIONS`, fullscreen, `SUPPORT` |
| `portrait-02-options.png` | OPTIONS: оригинальный арт + `MUSIC/SOUND/LANGUAGES/HOW TO PLAY?/FILES & OFFLINE/BACK` |
| `portrait-03-controls.png` | HOW TO PLAY?: рамка, 4 строки touch-справки, `TUTORIAL` |
| `portrait-04-languages.png`, `portrait-05-platform.png` | EN/RU, файлы/офлайн |
| `portrait-06-houses.png`, `portrait-07-missions.png` | CHOOSE YOUR HOUSE (кресты, 0/9), сетка 9 миссий (названия, locked) |
| `portrait-08-confirm-dialog.png`, `portrait-09-story.png` | START MISSION? (рамка, `START/CANCEL`), сюжетный экран |
| `portrait-10-briefing-0/1/3.png` | брифинг: ментат+карта, HTML-подпись, текст, `BACK` |
| `portrait-11-map.png` | карта миссии 1: `MENU`, credits, миникарта; масштаб 100 % |
| `portrait-12-map-pan-during.png`, `-13-pan-after.png` | drag камеры (12 pan-событий) |
| `portrait-14-map-pinch-after.png` | pinch (21 zoom-вызов) |
| `portrait-15-map-tap.png`, `-16-map-selected.png` | тап по карте (выбор/пусто) |
| `portrait-17-pause.png` | PAUSE + «ATREIDES - MISSION 1», 2-колоночная сетка, `RESTART/MAIN MENU/BACK` |
| `portrait-18-back-to-map.png` | возврат в игру |
| `portrait-19-map-doubletap.png` | двойной тап |
| `portrait-20-pinch-in-during.png`, `-21-map-zoomout.png` | pinch к центру: зум 100→50 %, миникарта пересчитала рамку |

Ландшафт 844×390: те же экраны `landscape-00…19` — титул (арт слева, кнопки
справа), options (2 колонки ≤720 px, BACK слева снизу), карта, пауза, брифинг;
`landscape-11-map.png` — полный экран карты, `MENU`, credits, миникарта.

Проверенные жесты (числа из `#gesture-state`/`#camera-state`):
одиночный тап/двойной/перетаскивание/пинч/миникарта; drag не отправляет приказ;
pinch меняет зум 50–100 с сохранением точки; панель HUD и миникарта не зависят
от зума; экраны меню управляются HTML-кнопками (pointer/touch).

### 15.2 Что в старой версии не проверялось этим прогоном

Меню здания (нужен второй тап по своему зданию — не попал координатами),
полный проход кампании, звук, физические телефоны, установка/PWA — по этим
пунктам опираемся на документацию старой версии (`docs/*.md`, QA-JSON),
а не на новый прогон.

### 15.3 Проба нового хоста (path A)

Скрипт: `web/host/play.html` + ROM игрока (USA, 1 048 576 B) +
`.local/wasm-full/game.wasm`; загружен старый
`demo.state.bin` (140 921 B, оригинальный v2-сейв) → сцена `map`,
`mapContext=1`, `fault=0`.

Факты:

- сейв старой версии принимается новым рантаймом;
- `gesture_query(160,112)=1`, `tap_screen=1`, `begin=1`, `pan=1`
  (`cameraX 1402→1442`), `zoomCamera(0.8)=80` (world `320×224→400×280`),
  `dune_web_resize(485,224)=1` (`output 485×224`, `worldWidth 607`,
  `uiScale 0.66`);
- `host.frameSize()` остаётся `320×224`, `nativeCameraX` не меняется →
  расширенная презентация в этой сборке ещё не была подключена (§5.6);
  в тот же день параллельный агент добавил `dune_web_expanded_frame_rgba()` +
  `host.expandedFrame()/drawExpandedFrame()` (см. `docs/WASM-TOUCH.md`);
- скриншоты: `/tmp/old-shot/new-map-canvas.png` (оригинальный кадр карты
  320×224 с credits и миникартой), `new-map-fullpage.png`,
  `new-map-after-gestures.png`.

### 15.4 Снимок API нового рантайма/хоста (2026-11-27 ~12:00)

- `runtime/wasm/runtime.wasm` ≈ 897 821 B, 154 экспорта; 70 адаптеров;
  20/20 `runtime/adapters/em_web_*.h` ≡ `Dune Sega Web/tools/em_web_*.h`.
- `DuneHost`: `pad/pressPad/pressStart/campaignInput/tapScreen/hoverScreen/
  beginPan/panCamera/endPan/pan/zoomCamera/cameraDebug/selectionDebug/
  saveState/loadState/call(name,…)/frameStats/frameRgb/frameSize/drawFrame/
  expandedFrame/drawExpandedFrame/debugJson/capabilities/touchInfo/
  attachVirtualWindow`.
- Чего нет (обёртки; всё вызывается через `call()`): `resizeViewport`,
  `setMapHudTop`, `gestureQuery`, `actorCapture`, `commandScreen`,
  `screenRoute`, `campaignStart`, `uiSound`.
- У `app.mjs` уже есть: простые жесты, dpad/A/B/START, лист «Пауза», сейв/лоад,
  автосейв 20 с, fullscreen, fast-forward интро (`advanceInstructions` +
  `pressStart`); `expandedFrame` ещё не подключён — то есть «скелет» уже
  совпадает с P0-каркасом старой версии, но жесты и обзор ещё «сырые».
