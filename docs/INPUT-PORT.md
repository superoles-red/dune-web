# Перенос тач/ввода из старой веб-версии в BYOP `dune-web`

Статус: **библиотека готова**, 70 unit-кейсов `node --test 'tests/input/*.test.mjs'` — OK,
`python3 tools/check_no_game_data.py` — OK. В `web/app.mjs` слой ещё **не включён**
(это делает родитель; готовый код вставки — §6). Визуальный HUD/кнопки контекстных
действий — отдельная задача.

Перенесён наш MIT-JS из `Dune Sega Web/web/*.mjs` без игровых ассетов и без
emscripten-обвязки: вместо `Module._dune_web_*` всё идёт через `DuneHost.call(name, …)`
и методы хоста (`beginPan`/`panCamera`/`endPan`/`zoomCamera`/`hoverScreen`/
`drawExpandedFrame`/`refreshPresentation`/`cameraDebug`/`selectionDebug`).

## 1. Файлы

| файл | строк | что это |
|---|---|---|
| `web/input/gestures.mjs` | 192 | `MapGestures`: pan / pinch / minimap / tap / placement; порог 8 CSS px (пересчитывается в единицы окна); `placementEdgeVelocity` |
| `web/input/pan-inertia.mjs` | 259 | `PanInertia`: инерция камеры (tau 220 мс, maxSpeed 1000, maxDistance 220, maxDuration 850 мс, minSpeed 90, stopSpeed 18), только touch/pen, шаг из rAF |
| `web/input/map-input.mjs` | 215 | `bindMapInput`: один PointerEvent-поток (capture, `passive:false`), `pointerdown/move/up/cancel`, hover, ПКМ = command, подавление compatibility mouse/click/touch событий; fallback на mouse-события, если `PointerEvent` нет; `destroy()` |
| `web/input/order-input.mjs` | 183 | `OrderInput`: одиночный tap = select; double-tap 300 мс/slop 24 = token → command; ПКМ = command; deferred selection 100 мс; Palace 300 мс; `flush()` из rAF |
| `web/input/placement-mode.mjs` | 254 | `PlacementMode` + проекции `placementWorldToScreen/placementPointVisible/placementScreenToWorld`: готовая постройка и Palace-цель, привязка к миру, а не к экрану |
| `web/input/context-action.mjs` | 39 | `contextAction(actions)` — дескриптор оригинальной B по `actions_debug` |
| `web/input/index.mjs` | 888 | `createInputLayer({host, canvas, onStatus, onOrder, isInputCaptured})`, конверсия CSS→320×224, вся склейка shell.js: `pendingReadyYard`, Palace, pan/pinch/zoom/инерция, edge-scroll, 20 Гц опрос камеры/действий, `{destroy, cancel, snapshot, confirm, cancelTarget, action, sync}` |
| `tests/input/helpers.mjs` | 448 | фейковый canvas/DuneHost/rAF/часы; ни ROM, ни Chrome |
| `tests/input/gestures.test.mjs` | 264 | распознаватель + инерция |
| `tests/input/order.test.mjs` | 198 | выбор/приказ/ПКМ/deferred/Palace |
| `tests/input/placement.test.mjs` | 200 | проекции и `PlacementMode` |
| `tests/input/map-input.test.mjs` | 150 | pointer-поток, ПКМ, cancel, mouse-fallback |
| `tests/input/input-layer.test.mjs` | 625 | интеграция с фейковым хостом: точные порядок/аргументы вызовов |
| `tests/input/context-action.test.mjs` | 27 | B-дескриптор |

## 2. Координаты: только виртуальное окно 320×224

Адаптеры рантайма (`docs/WASM-TOUCH.md`) говорят **не в CSS-пикселях**, а в координатах
виртуального окна 320×224 (`dune_web_attach_virtual_window`, CSS-мок 320×224). Canvas на
телефоне растянут CSS-ом, поэтому конверсия делается ровно один раз, в `index.mjs`:

```js
x = (clientX - rect.left) * 320 / rect.width;
y = (clientY - rect.top)  * 224 / rect.height;
```

* `toWindowPoint(event, canvas, {fit:'stretch'})` — документированная формула (по умолчанию).
* `fit:'contain'` — если когда-нибудь появится letterbox **внутри** CSS-бокса canvas:
  контент 320:224 масштабируется `min(w/320, h/224)` и центрируется; координаты за
  пределами контента дают значения вне окна, и родные адаптеры их сами отвергают.
* Порог жеста задан как **8 CSS px**, но распознаватель работает в единицах окна,
  поэтому `createInputLayer` пересчитывает его на каждом `pointerdown`:
  `8 * 320 / rect.width` (для `contain` — `8 / min(rect.w/320, rect.h/224)`).
  На canvas 640×448 это 4 единицы окна, т.е. те же 8 CSS px.
* `wheel`, hover, pan, zoom, minimap, placement — всё получает уже оконные координаты.

Так сохраняется старая математика распознавателя (`threshold`, slop 24, edge-scroll 42/155)
без знания о CSS/DPR.

## 3. API `createInputLayer`

```js
import { createInputLayer } from './input/index.mjs';

const input = createInputLayer({
  host,                      // DuneHost
  canvas,                    // HTMLCanvasElement
  onStatus,                  // (snapshot) — на смену жеста и на опрос 20 Гц
  onOrder,                   // ({type, ...}) — select/command/placement/context
  isInputCaptured,           // () => boolean: HTML-экран владеет вводом
  // необязательные:
  now, requestFrame, cancelFrame,          // тесты/свой rAF
  thresholdCssPx: 8,                       // порог жеста
  pollMs: 50,                              // опрос камеры/действий
  hoverThrottleMs: 40,                     // троттлинг hover_screen
  fit: 'stretch',                          // 'stretch' | 'contain'
  virtualWindow: { width: 320, height: 224 },
  placementEdgeScroll: true,               // авто-скролл у края при переносе
  drawExpandedOnTap: true,                 // host.drawExpandedFrame() перед тапом
  wheelZoom: true,
  inertia: { /* параметры PanInertia или готовый экземпляр */ },
  pointerEvents: undefined,                // тесты: true; в браузере автодетект
});
```

Возвращает:

| метод/поле | назначение |
|---|---|
| `destroy()` | снять все слушатели, отменить rAF, `host.endPan()` |
| `cancel()` | отменить жест/заказ/инерцию + активный placement/Palace target |
| `snapshot()` | полный debug/UI-снимок: `mode`, `points`, `inertia`, `orders`, `placement`, `pendingReadyYard`, `context`, `camera`, `actions`, `counters`, `lastTap`, `lastOrder`, `ready/inputCaptured` |
| `confirm()` | подтвердить активный placement/Palace target (старая кнопка PLACE) |
| `cancelTarget(reason)` | отменить target (старая кнопка CLEAR) |
| `action()` | вызвать оригинальную B (`dune_web_action_b`), если `snapshot().context` не null |
| `sync()` | принудительный опрос камеры/действий/сцены (смена экрана, загрузка сейва) |
| `flush(time)` | коммит deferred selection (обычно не нужен — rAF делает сам) |
| `layer.inertia / gestures / orders / placement / mode / destroyed` | доступ к внутренностям для HUD/тестов |

Типы `onOrder`: `select`, `command`, `placement-drag-begin`, `placement-drag-end`,
`placement-confirm`, `placement-cancel`, `power-command`, `power-confirm`, `power-cancel`,
`context`. Каждому добавляется `at` (время) и результат/координаты.

## 4. Что именно перенесено и чем отличается от старой версии

Классы и их логика скопированы структурно 1:1 (`MapGestures`, `PanInertia`,
`OrderInput`, `PlacementMode`, `contextAction`, `bindMapInput`), отличается только
«проводка» и система координат.

### 4.1 Вызовы: старый `Module` → новый `DuneHost`

| старая версия | новая версия |
|---|---|
| `Module._dune_web_gesture_query(x,y)` | `host.call('dune_web_gesture_query', x, y)` |
| `Module._dune_web_begin(x,y)` | `host.beginPan(x,y)` (fallback `call('dune_web_begin')`) |
| `Module._dune_web_pan(dx,dy)` | `host.panCamera(dx,dy)` |
| `Module._dune_web_end()` | `host.endPan()` |
| `Module._dune_web_zoom(f,x,y)` | `host.zoomCamera(f,x,y)` |
| `Module._dune_web_hover_screen(x,y)` | `host.hoverScreen(x,y)` |
| `Module._dune_web_minimap_begin/move` | `call('dune_web_minimap_begin/move')` |
| `nativeJSON('_dune_web_target_screen',x,y)` | `call('dune_web_target_screen',x,y)` → JSON-строка из `host.memory` (или `host.readCString`) |
| `Module._dune_web_actor_capture()` | `call('dune_web_actor_capture')` |
| `Module._dune_web_select_screen(x,y)` | `call('dune_web_select_screen', x, y)` |
| `Module._dune_web_command_screen(x,y,token)` | `call('dune_web_command_screen', x, y, token)` |
| `Module._dune_web_command_world(wx,wy,token)` | `call('dune_web_command_world', wx, wy, token)` |
| `Module._dune_web_placement_begin_world(wx,wy)` | `call('dune_web_placement_begin_world', wx, wy)` |
| `Module._dune_web_placement_begin/move/end/confirm/cancel` | одноимённые `call(...)` |
| `Module._dune_web_action_b()` | `call('dune_web_action_b')` |
| `Module._dune_web_clear_selection()` | `call('dune_web_clear_selection')` |
| `nativeJSON('_dune_web_camera_debug')` | `host.cameraDebug()` (fallback `call('dune_web_camera_debug')` + JSON) |
| `nativeJSON('_dune_web_actions_debug')` | `host.selectionDebug()` (fallback `call('dune_web_actions_debug')` + JSON) |
| — (не было) | `host.drawExpandedFrame()` перед тапом |
| — (каждый move рисовал вручную) | `host.refreshPresentation()` не чаще раза на rAF-кадр |

JSON-хелперы хоста (`cameraDebug`/`selectionDebug`) предпочитаются, если они есть;
иначе слой сам декодирует `char*` из `host.memory` (поддержаны и «строка из call()» —
удобно для тестов). Это снимает зависимость от emscripten `UTF8ToString`.

### 4.2 Координаты и виртуальное окно

* Старая версия: `dune_web_resize(cssW,cssH)` и **CSS-пиксели** во всех жестах; камера
  отдавала `scale`, `left/top` в CSS-системе.
* Новая: окно всегда 320×224 (пока хост не начнёт resize), конверсия CSS→окно один раз
  на входе; всё, что идёт в рантайм/камеру/`placement`, — оконные координаты.
  Проекции `placement*` работают с `cameraDebug()` (`left/top/scale/scaleY/width/height`),
  поэтому они совместимы и с 320×224, и с будущим `resizeViewport` (если хост начнёт
  отдавать CSS-размер — поменять только конверсию в `index.mjs`).
* Порог 8 CSS px пересчитывается в оконные единицы (см. §2) — на телефоне жест не
  становится «ленивее» из-за растяжения canvas.

### 4.3 Поведение, которое пришлось добавить

1. **`drawExpandedFrame()` перед тапом** (`drawExpandedOnTap`, по умолчанию `true`):
   HUD/миникарта распознаются `tap_screen`/`gesture_query` только после построения
   `dune_view.ui` (`docs/WASM-TOUCH.md` §7.2). Сборка кадра 2–4 мс, поэтому вызывается
   только на тап/ПКМ, а не на каждый move. Если родитель уже строит обзор сам —
   `drawExpandedOnTap: false`.
2. **`refreshPresentation()` через rAF-троттлинг**, а не на каждый `pointermove`:
   старый `app.mjs` звал на каждый move; здесь ставится флаг, и один вызов уходит в
   конце кадра (важно для 2–4 мс expanded-кадра).
3. **Инерция сэмплируется в оконных единицах**: `PanInertia` остаётся в «пикселях»
   вызывающего, т.е. 220/1000/220/850/90/18 — это оконные px/мс. На виртуальном окне
   320 px это те же ощущения, что старые CSS-пиксели на 390 px телефоне.
4. **Drag-placement включён** (`placement_begin/move/end`): старый `shell.js` в modern-
   режиме отключал `MapGestures.placementStart` (return false) и использовал только
   persistent placement; здесь перенос с готового Yard работает и перетаскиванием
   (как описано в `PORTING-FROM-OLD.md` §5.5), и через tap-сценарий `pendingReadyYard`
   → `placement_begin_world` → tap цели → `confirm()`/`cancelTarget()`.
5. **Один PointerEvent-поток** даже при наличии compatibility MouseEvents: старый
   `map-input.mjs` уже это делал; добавлен `destroy()` и подавление `touchstart`/
   `touchmove`/`touchend`/`click`/`dblclick`/`auxclick`/`contextmenu` на canvas.
6. **ПКМ = command** не только через `contextmenu`, а на реальном `pointerup`:
   протяжка ПКМ = `cancel()`, без случайного приказа.
7. **20 Гц опрос** `camera_debug`/`actions_debug`/`campaign_json` (как `pollState()` в
   старом `shell.js`) — дорогие JSON-вызовы не каждый кадр. rAF-кадр делает только
   `orders.flush()`, шаг инерции, edge-scroll и один `refreshPresentation()`.
8. **`isInputCaptured()`** вместо старого `gameUI?.capturesInput`: при `true` ввод
   игнорируется, висящие жесты/заказы отменяются (старый `pollState` делал то же для
   HTML-интерфейса).

## 5. Порядок вызовов (как в старом `shell.js`)

```text
pointerdown (touch/pen/mouse):
  isInputCaptured? → игнор
  stopPanMotion()                       // новое касание гасит инерцию
  touch/pen → panInertia.begin(kind, now)
  первый палец → host.beginPan(x, y)    // dune_web_begin
  gestures.down(...):
    canPanAt = gesture_query(x,y) === 1
    minimap_begin(x,y) === 1 ? 'minimap' : 'pending'
    второй палец: placementCancel(); обе точки на карте ? 'pinch' : 'blocked'

pointermove:
  pending + >threshold → placement_begin(x,y) ? 'place'
                          : 'pan' (panCamera(dx,dy) + inertia.sample)
  minimap → minimap_move(x,y)
  place   → placement_move(x,y) (+ edge-scroll из rAF)
  pinch   → panCamera(midDx,midDy) + zoomCamera(newDist/oldDist, midX, midY)
  hover   → hover_screen(x,y), троттлинг 40 мс, только mouse/pen

pointerup:
  pending → drawExpandedFrame(); target_screen(); select_screen() / command_screen()
  pan     → panInertia.release(now) ? coast из rAF : endPan()
  place   → placement_end(x,y)
  minimap → endPan() (dune_web_end)

rAF:
  orders.flush() → deferred selection (select_screen)
  inertia.step() → panCamera(dx,dy), при 0 → endPan()
  place: placementEdgeVelocity(42,155) → panCamera + placement_move
  20 Гц: camera_debug + actions_debug + campaign_json
         → targetMode.sync(...) → pendingReadyYard.beginPlacement / Palace.beginPower
  один refreshPresentation(), если был жест/зум/подтверждение
```

## 6. Как интегрировать в `web/app.mjs`

Сейчас в `web/app.mjs` живут «простые жесты» (`pointerState`, `pointerDown/Move/Up`,
wheel, contextmenu — строки ~294–476). Их нужно **удалить/отключить**, иначе canvas
получит два потока и двойные приказы. D-pad, клавиатура, кнопки меню, сейвы —
не трогаются.

Минимальная вставка (5–10 строк):

```js
// 1) в state (web/app.mjs:29) добавить поле
input: null,

// 2) в startPlay(), сразу после `window.__DUNE_HOST = host;` (web/app.mjs:255):
const { createInputLayer } = await import('./input/index.mjs');
state.input = createInputLayer({
  host,
  canvas: $('game-canvas'),
  isInputCaptured: () => !state.host || !$('game-sheet').classList.contains('hidden'),
  onStatus: (snapshot) => { window.__DUNE_INPUT = snapshot; },
  onOrder: (order) => log(`input: ${order.type}`),
});

// 3) в stopPlay(), до `state.host.destroy()` (web/app.mjs:266):
state.input?.destroy();
state.input = null;
```

Что даёт `onStatus`: HUD/оверлей может рисоваться по `snapshot()` — `placement.active/
target/screen/canConfirm/mode`, `pendingReadyYard`, `context` (B), `mode`, `inertia.phase`.
Кнопки оверлея (PLACE/CLEAR/ACTION) вызывают `state.input.confirm()` /
`state.input.cancelTarget()` / `state.input.action()` — это и есть старые
`targetConfirm`/`targetCancel`/`actionButton` из `shell.js`.
На смену экрана/загрузку сейва удобно звать `state.input.cancel()` / `state.input.sync()`.

Если canvas будет с letterbox внутри CSS-бокса (не сейчас), передайте
`fit: 'contain'`; при «растяжении» (текущий `index.html`) оставьте дефолт.

## 7. Тесты

```sh
node --test 'tests/input/*.test.mjs'
# → 70 tests, 70 pass, 0 fail (~80 мс)
python3 tools/check_no_game_data.py     # OK
python3 tools/check_workspace.py        # OK
```

ROM/Chrome/`game.wasm` не нужны: фейковый `DuneHost` пишет **каждый** вызов
`{name, args}` в массив, фейковый canvas хранит слушатели и CSS-бокс, rAF/часы
шагаются вручную. Проверяется точный порядок и аргументы:

* tap → `drawExpandedFrame` → `target_screen` → `select_screen(x,y)`;
  `beginPan`/`endPan`, запрет при `isInputCaptured()`;
* double-tap → `actor_capture` (tap 1, token) → `command_screen(x,y,token)`;
  deferred selection коммитится rAF-`flush()` после 100 мс; граница 300 мс включительно;
* ПКМ → `actor_capture` → `command_screen(...,2)`; протяжка ПКМ = cancel;
* pan → `beginPan` → `panCamera` дельты → `endPan`; touch-инерция даёт лишние
  `panCamera` из rAF, mouse — нет; долгая пауза не «прыгает» камерой;
* pinch → `panCamera` середины + `zoomCamera(ratio, midX, midY)`;
* minimap → `minimap_begin`/`minimap_move`, без `panCamera`, `endPan` на отпускании;
* второй палец во время переноса → `placement_cancel`, затем pinch;
* placement drag → `placement_begin(x,y)` → `placement_move` → `placement_end(x,y)`;
* готовый Yard: tap → `pendingReadyYard` → `placement_begin_world(wx,wy)` →
  tap цели → `placement_move` → `confirm`/`cancelTarget` (`placement_confirm`/
  `placement_cancel`);
* Palace: armed → `beginPower` → tap цели → `confirm()` → `actor_capture` →
  `command_world(wx,wy,token)`; `cancelTarget()` → `clear_selection`;
* контекст B: `snapshot().context` из `actions_debug`, `action()` → `action_b`,
  при `placementActive` — null;
* hover троттлится 40 мс; wheel → `zoomCamera(exp(-dY*0.002), x, y)` только на карте;
* конверсия CSS→окно для `stretch` и `contain`/letterbox; порог «8 CSS px» на
  canvas 640×448; подавление compatibility-событий; `cancel()`/`destroy()`.

## 8. Известные ограничения и что осталось

1. **HUD-хотспоты только после `expandedFrame`.** `drawExpandedFrame()` перед тапом
   решает это для тапа, но политика «когда строить обзор» (на pan/zoom чаще, в покое
   по требованию) остаётся за родителем: библиотека лишь помечает `refreshPending` и
   раз в кадр зовёт `host.refreshPresentation()`. Каждый такой кадр 2–4 мс.
2. **Зум клампится адаптером в [50,100] %.** `zoomCamera` возвращает новое значение;
   первый `factor>1` упирается в 100 — это не баг. Пинч передаёт отношение расстояний
   как есть, рантайм сам клампит.
3. **Инерция только touch/pen** (как в старой версии); mouse-протяжка камеру не
   «докатывает». Шаг — из rAF, таймеров нет; любой новый ввод/overflow/смена
   `isInputCaptured` отменяет.
4. **Edge-scroll переноса** работает в оконных единицах окна 320×224 (зона 42,
   скорость 155 ед/с) — визуально это те же ~13 % края, что и старые CSS-пиксели.
   `placementEdgeScroll:false` отключает.
5. **Letterbox**: по умолчанию `stretch` (документированная схема нового хоста).
   `contain` поддержан и покрыт тестами, но рантайм/адаптеры по-прежнему ожидают
   CSS-размер 320×224 (`virtualWindow`); если появится реальный presentation с
   письмами, нужен `dune_web_resize(cssW,cssH)` (его пока нет в `DuneHost`) и
   переключение на старую CSS-схему координат.
6. **Визуального HUD/кнопок нет** — это отдельная задача: индикатор placement
   (`snapshot().placement`), кнопки PLACE/CLEAR/ACTION (`confirm()`/`cancelTarget()`/
   `action()`), маркер Palace, подсветка B. Библиотека отдаёт состояние, не рисует.
7. **`web/app.mjs` пока не тронут**: там живут старые простые жесты. До интеграции
   (§6) включение библиотеки даст двойной ввод; интеграцию делает родитель.
8. **`host.drawFrame()`/нативная картинка vs expanded-обзор**: панорама/зум меняют
   камеру `dune_view`, которую видно только через `drawExpandedFrame()`; политика
   переключения кадров — на стороне `app.mjs`.
9. **Звук/вибро/фуллскрин** не входят в слой: старый `shell.js` звал `resumeAudio()`
   из `beginPointer`; новый слой намеренно не трогает аудио — это делает хост/страница
   на `pointerdown` (см. `web/host/audio.mjs`).
10. **`pointerEvents:false`** (fallback на mouse-события) покрыт тестами, но в браузере
    всегда используется PointerEvent-ветка; fallback оставлен для старых WebView.
11. **Сейвы/сцена**: после `loadState()`/смены дома-миссии нужно `input.cancel()` и
    желательно `input.sync()`, иначе `pendingReadyYard`/Palace могут ссылаться на
    старый run (в `PlacementMode.sync` есть авто-очистка по `runId/outcomeSeq`, но
    она ждёт следующего 20 Гц опроса).
