# Тач-камера в миссии (path A): виртуальное SDL-окно

Статус: **работает**. В standalone-рантайме (`runtime/wasm/runtime.wasm` + JS-моки
импортов) адаптеры камеры ожили: `dune_web_tap_screen`, `dune_web_hover_screen`,
`dune_web_begin/pan/end`, `dune_web_zoom`, `dune_web_gesture_query` и
`dune_web_minimap_*` возвращают реальный контекст на кадре миссии, тап доходит до
оригинального игрового кода, панорама и зум меняют состояние камеры, а софтверный
обзор расширенной карты можно отрисовать в canvas. ABI/сейвы не изменились:
`abi_hash = fb47e138…`, DSAV v2 = 140056 B.

```sh
DUNE_ROM="/path/to/Dune - The Battle for Arrakis (USA).gen" \
  node --test tests/host/touch.test.mjs
```

Ожидаемый хвост (M1 Pro, Chrome headless, Node 24.16, emcc 3.1.74):

```json
{
  "reached_map_after_presses": 3,
  "instructions": 461606164,
  "virtual_window": "320x224",
  "tap_context": 1,
  "hover_context": 1,
  "queued_click": "1 -> 0",
  "world": "807,1143",
  "pan": [1, 1, 1],
  "pan_delta": { "dx": -40, "dy": 24 },
  "zoom": [80, 64, 80],
  "minimap": { "tap": 3, "moved": { "dx": 276, "dy": -123 } },
  "frames": {
    "mission": "44684283", "idle": "44684283", "hover": "44684283",
    "tap": "1ee502e4", "pan": "23124ba7", "zoom": "23124ba7", "minimap": "23124ba7"
  },
  "expanded_frames": { "mission": "dc46751f", "pan": "5c7167b3", "zoom": "e3bfee50" },
  "save": { "bytes": 140056, "magic": "DSAV", "version": 2, "totalSize": 140056 }
}
```

Скриншоты и JSON-отчёт: `test-results/touch/` (gitignored, содержит кадры игры):

| файл | что видно |
|---|---|
| `00-mission.png` | нативный кадр миссии (320×224) до тача |
| `03-tap.png` | кадр после `tapScreen(160,112)` — хэш отличается (`44684283 → 1ee502e4`) |
| `04-pan.png` | нативный кадр после панорамы (камера адаптера сдвинута) |
| `05-zoom.png` | нативный кадр после зума |
| `06-minimap.png` | после тапа в мини-карту (камера перецентрована) |
| `10-expanded-mission.png` | софтверный расширенный обзор (зум 100) |
| `11-expanded-pan.png` | обзор после пана — карта сдвинута |
| `12-expanded-zoom.png` | обзор после зума 64% (`worldWidth/worldHeight = 500×350`) |
| `canvas-touch.png`, `page-touch.png` | canvas/страница отладочной страницы |

---

## 1. Почему тач-камера не работала

`em_web_camera_geometry()` (в `runtime/adapters/em_web_camera.h`) — общий вход всех
тач-адаптеров — первой строкой требует:

```c
if (!em_window || !em_host.window || !em_host.renderer ||
    !em_cpu.vdp.frame_width || !em_cpu.vdp.frame_height) return 0;
SDL_GetWindowSize(em_host.window, window_w, window_h);
if (*window_w <= 0 || *window_h <= 0 ||
    SDL_GetRendererOutputSize(em_host.renderer, &w, &h) || w <= 0 || h <= 0) return 0;
```

В path A хост **не вызывает `run_main()`**, а значит и `sdl_host_open()`, поэтому
`em_host` после `dune_rt_init()` нулевой: `window == renderer == NULL`. Каждый
`dune_web_tap_screen`/`_pan`/`_zoom`/`_hover_screen` выходил на первой проверке с
`0`, хотя `em_cpu.vdp` уже рисовал настоящий кадр 320×224.

Дополнительно геометрия читает:

* `SDL_GetWindowSize(window, &w, &h)` — размер окна;
* `SDL_GetRendererOutputSize(renderer, &w, &h)` — размер drawable;
* `emscripten_get_element_css_size("#canvas", &css_w, &css_h)` — CSS-размер
  (при ошибке/нуле берётся размер окна);
* `em_host.dune_view.zoom` (0 → трактуется как 100 в layout);
* `em_host.dune_mouse.enabled` — без `sdl_host_open()` тоже 0, поэтому даже
  валидная геометрия не давала очереди кликов;
* `em_cpu.vdp.frame_width/height` и `dune_mouse_context()` — обычный кадр миссии.

## 2. Решение: виртуальное окно + линкерные обёртки SDL

Ключевой момент: `runtime.wasm` собран с `-sUSE_SDL=2`, то есть **SDL2 скомпилирован
внутрь wasm**, а не импортируется из JS. `SDL_GetWindowSize`/`SDL_SetWindowSize` —
обычные wasm-функции; из `loader.mjs` их «замокать» нельзя (в отличие от
`emscripten_get_element_css_size`, который действительно `env`-импорт). Поэтому:

1. Линкуем рантайм с `-Wl,--wrap=` для геометрических SDL-символов
   (`tools/wasm_runtime/build_runtime.py`, `LINK_WRAP_FLAGS`):

   ```text
   -Wl,--wrap=SDL_GetWindowSize
   -Wl,--wrap=SDL_GetWindowSizeInPixels
   -Wl,--wrap=SDL_GetWindowPosition
   -Wl,--wrap=SDL_GetRendererOutputSize
   -Wl,--wrap=SDL_SetWindowSize
   ```

   Ссылки из `runtime.o` (включая закреплённые адаптеры) уходят в `__wrap_*` из
   `tools/wasm_runtime/src/dune_rt_virtual_window.inc`; пока окно не привязано,
   обёртки вызывают настоящие `__real_*` (путь B не затронут).
   `dune_web_attach_virtual_window` переключает их на виртуальный размер
   **без создания** SDL-окна, рендерера, текстуры или GL-контекста.

2. `dune_web_attach_virtual_window(320, 224)` (новый экспорт, там же):

   ```c
   em_window = 1;
   em_host.window   = (SDL_Window *)&static_token;   /* только non-NULL */
   em_host.renderer = (SDL_Renderer *)&static_token; /* обёртки не разыменовывают */
   em_host.stopped = em_host.error = 0;
   em_host.dune_mouse.enabled = 1;                   /* как sdl_host_open() */
   if (!em_host.dune_view.zoom) em_host.dune_view.zoom = 100;
   em_host.dune_view.frame = UINT64_MAX;
   em_host.dune_view.camera_valid = 0;               /* перечитать камеру игры */
   em_host.last_frame = UINT64_MAX;
   dune_web_resize(width, height);                   /* идёт через __wrap_SDL_SetWindowSize */
   ```

   Функция вызывается в `DuneHost.boot()` после `warmup_all()`; повторный вызов
   просто обновляет размер. Отдельные геттеры: `dune_web_virtual_window_width/
   height/attached`.

3. `loader.mjs` при `loadRuntime({ virtualWindow: { width, height } })` подменяет
   `env.emscripten_get_element_css_size` на мок, который пишет два `double` и
   возвращает 0 (успех). Без него адаптер переходил на размер окна — тоже
   корректно, но теперь CSS/window-размеры явные и совпадают с виртуальным окном.

4. Чтобы тап реально доходил до оригинального кода, добавлен экспорт
   **`dune_rt_web_step()`**: один `machine_step()` с теми же наблюдателями ввода,
   что и `em_web_main_loop_work()` в пути B:

   ```c
   em_web_campaign_observe()
     ?  : em_web_selection_observe(); em_web_menus_observe() / em_web_menu_select_observe()
          / dune_mouse_observe();
   machine_step();
   ```

   `DuneHost.advanceSteps()/start()` используют его, пока виртуальное окно
   привязано (`touchStepping: true` по умолчанию). Чистая эмуляция
   (`dune_rt_machine_step()`, дифференциальные тесты) не изменена.

5. Для видимого результата пана/зума добавлен **софтверный обзор**:
   `dune_web_expanded_frame_rgba()` вызывает уже существующий в преамбуле
   `dune_view_build()` (обход мира на shadow-CPU, без записи в игровое состояние),
   масштабирует мир по `layout.world_scale` и альфа-компонует HUD 320×224 точно
   как `dune_view_draw()`, но в память, без SDL-текстур. Хост:
   `host.expandedFrame()` (RGBA-вью) / `host.drawExpandedFrame()` (в canvas).
   В тесте один такой кадр строится 2–4 мс, поэтому это on-demand API, а не
   rAF-цикл.

## 3. Что изменено (файлы)

| файл | изменение |
|---|---|
| `tools/wasm_runtime/src/dune_rt_virtual_window.inc` | **новый**: SDL-обёртки, `dune_web_attach_virtual_window`, геттеры, `dune_rt_web_step`, софтверный expanded-frame |
| `tools/wasm_runtime/src/dune_rt_abi.inc` | `#include "dune_rt_virtual_window.inc"` в конце (после преамбулы и адаптеров) |
| `tools/wasm_runtime/build_runtime.py` | `LINK_WRAP_FLAGS`, 8 новых экспортов в контракт, SHA нового include в манифесте |
| `tools/wasm_runtime/src/loader.mjs.tmpl` | опция `virtualWindow`, мок `emscripten_get_element_css_size`, helper `attachVirtualWindow()` |
| `runtime/wasm/runtime.wasm` | пересобран (emcc 3.1.74, standalone, imported memory) |
| `runtime/wasm/{loader.mjs,manifest.json,abi.json}` | перегенерированы |
| `web/host/host.mjs` | attach в `boot()`, `stepFunction()`, `tapScreen/hoverScreen/beginPan/panCamera/endPan/pan/zoomCamera`, `cameraDebug/selectionDebug/touchInfo`, `expandedFrame/drawExpandedFrame` |
| `web/host/play.html` | кнопки «Тап в центр / Пан +40 / Зум ×0.8 / Обзор», строка `touch` в статусе |
| `tests/host/touch.test.mjs` | **новый** e2e: ROM → миссия → тач/пан/зум/мини-карта/сейв |
| `docs/WASM-TOUCH.md` | этот документ |

Закреплённые `runtime/dune-runtime-v2.c`, `runtime/adapters/*`, `vendor/` **не
менялись** — вся логика добавлена после преамбулы.

### Артефакты

| артефакт | значение |
|---|---|
| `runtime/wasm/runtime.wasm` | **897821 B**, SHA-256 `f33554dce6a9e7e194e21af993178b6d2bd87cad5fd7e334f3da45b5442ddb0d` |
| `runtime/wasm/loader.mjs` | SHA-256 `aab2023165625cf7051d250bcc86106113274f4975267b59bc29473c6697ec30` |
| `runtime/wasm/abi.json` | SHA-256 `dcb0a450210fc8284eca88ca2e52389cf812d5516308ac5cd801dfe93570ab4d` |
| `tools/wasm_runtime/src/dune_rt_virtual_window.inc` | SHA-256 `5834707719bdc53919ecb472e3c62839467b74bc4a6e01d84f82a31cce1e9424` |
| ABI descriptor | `abi_hash fb47e1386ee5c802a2cb2a58b98ec29367db79e00c7f32b355020abbc4be1db5` — **не изменился** |
| DSAV v2 | 140056 B, magic `DSAV`, version 2 — **не изменился** |
| экспортов | 146 → 154 (`+8`, ни один старый не удалён) |
| импортов | 236 → 236 (228 `env` + WASI): новых импортов нет, мокировать нечего |
| data-сегменты | 104165 B (как и было), ROM не встроен |

Новые экспорты: `dune_web_attach_virtual_window`,
`dune_web_virtual_window_{attached,width,height}`,
`dune_web_expanded_frame_{rgba,width,height}`, `dune_rt_web_step`.

## 4. Какие SDL/EM_JS «моки» понадобились

| символ | где решается | поведение |
|---|---|---|
| `SDL_GetWindowSize` | линкерный `--wrap` → C-обёртка | виртуальные 320×224 |
| `SDL_GetWindowSizeInPixels` | `--wrap` | 320×224 (high-DPI честно) |
| `SDL_GetWindowPosition` | `--wrap` | 0,0 |
| `SDL_GetRendererOutputSize` | `--wrap` | 0 (успех), 320×224 |
| `SDL_SetWindowSize` | `--wrap` | обновляет виртуальный размер, 0 ошибок |
| `emscripten_get_element_css_size` | JS-мок в `loader.mjs` (`virtualWindow`) | пишет `double` 320/224, возвращает `EMSCRIPTEN_RESULT_SUCCESS` (0) |

Больше **ничего** мокать не пришлось: `SDL_Init`, `SDL_CreateWindow`,
`SDL_Render*`, `SDL_*Texture`, `egl*`/`gl*` на пути тача не вызываются. Обёртки
вызывают реальные функции, если виртуальное окно не привязано, поэтому путь B
(`run_main` + настоящий SDL) не ломается.

## 5. Как пользоваться из host / app.mjs

`boot()` сам привязывает виртуальное окно 320×224. Координаты всех методов —
**в системе виртуального окна** (по умолчанию 320×224), а не CSS-пиксели.

```js
import { DuneHost } from './host/host.mjs';

const host = new DuneHost({ canvas, runtimeUrl: './runtime/runtime.wasm' });
await host.init({ gameBytes });
await host.loadRomFromBytes(romBytes);
host.boot();                    // внутри: dune_rt_set_window(1), warmup, attach(320,224)
host.start();                   // цикл сам использует dune_rt_web_step()

// DOM pointer -> window coords (canvas растянут CSS-ом на телефоне):
function toWindow(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) * 320) / rect.width,
    y: ((event.clientY - rect.top) * 224) / rect.height,
  };
}

canvas.addEventListener('pointerdown', (e) => {
  const { x, y } = toWindow(e);
  host.drawExpandedFrame();     // один раз: заполняет HUD/миникарту для hit-теста
  host.tapScreen(x, y);         // 1 world, 2 native UI, 3 minimap, 0 вне
});

// Жест панорамы (drag): begin -> pan -> end
canvas.addEventListener('pointerdown', (e) => { const p = toWindow(e); host.beginPan(p.x, p.y); });
canvas.addEventListener('pointermove', (e) => {
  if (!host.touch.dragging) return;
  const dx = (e.movementX * 320) / canvas.getBoundingClientRect().width;
  const dy = (e.movementY * 224) / canvas.getBoundingClientRect().height;
  host.panCamera(dx, dy);
});
canvas.addEventListener('pointerup', () => host.endPan());

// Зум колесом/пинчем:
host.zoomCamera(0.8, 160, 112);  // 100% -> 80%; клампится в [50,100]

// Диагностика:
host.touchInfo();       // { attached, width, height, dragging, camera, selection }
host.cameraDebug();     // JSON адаптера: cameraX/Y, zoom, worldWidth/Height, context, minimap
host.selectionDebug();  // выбранный юнит/здание, placement, lastOrder
host.expandedFrame();   // { width, height, rgba } для собственной отрисовки
```

`host.drawFrame()` по-прежнему рисует **нативный** кадр 320×224 из
`dune_web_frame_rgb()`. Чтобы показать расширенный обзор (результат пана/зума),
используйте `host.drawExpandedFrame()`; на время обзора canvas может иметь размер
виртуального окна (320×224).

Алиасы для старых вызовов: `host.tap(x,y)`, `host.pan(dx,dy)` (one-shot
begin/pan/end), `host.zoom(f)`.

## 6. Что проверено (числа из `test-results/touch/report.json`)

* ROM → `game.wasm` (3 142 822 B) → boot → 3 нажатия A после Start → кадр миссии на
  **461 606 164** инструкциях; `dune_web_camera_debug()`: `map=1, context=1`,
  `camera=647,1031`, кадр 320×224, fault=0.
* `hoverScreen(120,140) → 1`.
* `tapScreen(160,112) → 1` (world), `queuedClicks` **1 → 0** после 4 кадров —
  клик положился в нативную очередь и был съеден наблюдателями на реальном кадре
  миссии.
* `dune_web_gesture_query(160,112) → 1`, `dune_web_world_x/y = 807,1143`.
* `beginPan(160,112) → 1`; `panCamera(40,0) → 1`; `panCamera(0,-24) → 1`;
  камера `647,1031 → 607,1055` (`Δ = -40,+24`); one-shot `pan(0,16) → 1`.
* `zoomCamera(0.8) → 80`, ещё раз `→ 64`, `zoomCamera(1.25) → 80`;
  на 64% `worldWidth×worldHeight = 500×350`.
* `tapScreen(272,176) → 3` (мини-карта): камера перецентрована
  (`+276,-123`), контекст 3.
* Нативные кадры: `mission=44684283`, после тапа `1ee502e4` (кадр изменился);
  `pan=23124ba7`, `zoom=23124ba7`, `minimap=23124ba7` (нативная 320×224-картинка
  не меняется от пана/зума — это делает expanded-обзор).
* Expanded-обзор: `dc46751f` (зум 100) → `5c7167b3` (после пана) →
  `e3bfee50` (зум 64), 320×224, 45544 / 45339 / 30081 ненулевых пикселей,
  сборка 4.4 / 2.3 / 2.1 мс.
* Сейв: `saveState()` → 140056 B, magic `DSAV`, version 2, totalSize 140056.
* Скорость: 461.8 млн инструкций за ~51 с теста (≈8.8 млн шагов/с с
  `dune_rt_web_step`; без наблюдателей в старом тесте было ≈15–16 млн/с).

Быстрый Node-тест без ROM/Chrome (`tests/host/virtual-window.test.mjs`) проверяет
геометрию attach/resize и то, что адаптер перестал возвращать 0: `node --test
tests/host/virtual-window.test.mjs` — OK.

Регрессии: `node --test 'tests/wasm_runtime/**/*.test.mjs'` — 9/9 OK,
`python3 tools/check_no_game_data.py` — OK, `python3 tools/check_workspace.py` — OK,
`node --test tests/host/play.test.mjs` (с ROM) — OK (29.1 млн инструкций,
сейв 140056 B).

## 7. Ограничения и что осталось

1. **Нативная картинка и расширенный обзор — разные вещи.** `drawFrame()` рисует
   нативный кадр 320×224; `dune_view_pan/zoom` меняют независимую камеру
   `em_host.dune_view`, которую путь B рисует через SDL-текстуры. В path A её
   результат виден через `drawExpandedFrame()` / `expandedFrame()`. В
   `web/app.mjs` эти методы ещё не подключены (файл вне зоны этой задачи):
   live-цикл по умолчанию показывает нативную картинку.
2. **HUD/миникарта как точки тапа.** `dune_view_mouse()` распознаёт HUD-хотспоты
   только при заполненном `dune_view.ui`; его строит `dune_view_build()`, то есть
   после первого `expandedFrame()`/`drawExpandedFrame()` (или пути B). Пока
   `ui == NULL`, тап классифицируется как world (context 1), а не 2/3. В тесте
   обзор строится до тапов, поэтому мини-карта даёт 3. Если HUD-тапы нужны
   постоянно — стройте обзор после входа в миссию и после смены кадра.
3. **Жесты.** Реализованы только примитивы (`beginPan/panCamera/endPan`,
   `zoomCamera`); нет распознавателя pinch/double-tap/inertia, нет инерционного
   «доезда» камеры, нет мультитача. Это задача UI-слоя (`web/app.mjs`).
4. **Зум/скейл.** Клампится адаптером в [50,100]%, начальный виртуальный зум
   100%; первый `zoomCamera(1.2)` вернёт 100 (кламп), для отдаления используйте
   коэффициент < 1. Экранный масштаб/letterbox для expanded-обзора на телефоне
   считает canvas CSS, а не адаптер.
5. **Цена `dune_rt_web_step`.** Наблюдатели на каждой инструкции стоят ~1.5–2×
   по сравнению с чистой эмуляцией; для live-игры это ок (60 fps с большим
   запасом), для длинных программных прогонов можно передать
   `new DuneHost({ touchStepping: false })`.
6. **Деплой.** `runtime/wasm/*` пересобран, но `web/runtime/*` — это копия из
   `tools/bundle_web.py`. Перед публикацией/страницей игры выполните
   `python3 tools/bundle_web.py` (иначе браузер возьмёт старый рантайм без
   `dune_web_attach_virtual_window`; host это переживёт, но тач будет выключен).
7. **Сейвы/ABI.** `dune_web_attach_virtual_window` выставляет `em_window = 1`
   (как `dune_rt_set_window(1)` в `boot()`), но не трогает `DuneSaveState`,
   дескриптор ABI и формат сейва. После `loadState()` привязка окна сохраняется
   (`dune_load_state_from_buffer()` не обнуляет `em_host`), камера перечитывается
   из игры (`camera_valid = 0`).

## 8. Пересборка

```sh
# 1. рантайм (emsdk 3.1.74, путь к локальному emsdk)
python3 tools/wasm_runtime/build_runtime.py \
  --emsdk "/path/to/emsdk"

# 2. ABI-контракт для браузерного эмиттера (ROM нужен только для memory-layout)
python3 tools/wasm_browser/export_abi.py --rom "/path/to/Dune (USA).gen"

# 3. тесты
node --test 'tests/wasm_runtime/**/*.test.mjs'
node --test tests/host/virtual-window.test.mjs
DUNE_ROM="/path/to/Dune (USA).gen" node --test tests/host/touch.test.mjs
DUNE_ROM="/path/to/Dune (USA).gen" node --test tests/host/play.test.mjs
python3 tools/check_no_game_data.py
```

CI-джоба `wasm-runtime` пересобирает рантайм и сверяет `abi_hash` и полный набор
экспортов с закоммиченным `runtime/wasm/manifest.json`; оба значения обновлены
согласованно. Игровые данные в репозиторий не попадают: ROM читается только из
`.local/`/пользовательского файла, скриншоты — в gitignored `test-results/`.
