# Браузерный хост WASM: `runtime.wasm` + `game.wasm` + ROM → реальный кадр

Статус: **работает**. Headless Chrome доходит от сброса консоли до настоящего кадра
Dune (`DUNE — The Battle for Arrakis`, меню `START GAME / OPTIONS / TUTORIAL`),
кадры уходят в `<canvas>`, сейв/лоад через штатные экспорты, тест зелёный.

Команда:

```sh
DUNE_ROM="/path/to/Dune - The Battle for Arrakis (USA).gen" \
  node tests/host/play.test.mjs
```

Ожидаемый хвост (M1 Pro, Chrome 143 headless, Node 24.16):

```
✔ browser host plays real Dune frames (4143.815875ms)
{
  "runtime_bytes": 894968,
  "game_bytes": 3142822,
  "load_ms": 186,
  "boot_ms": 66,
  "table_mode": 2,
  "table_slots": [741, 742],
  "total_instructions": 29165854,
  "emulated_seconds": 41.23,
  "rendered_frames": 2519,
  "steps_per_second_millions": 32.1,
  "frames": {
    "sega": "2641 px / 10 colours",
    "logos": "16567 px / 27 colours",
    "title": "18121 px / 23 colours",
    "menu": "18177 px / 22 colours"
  },
  "save_bytes": 140056,
  "save_restored": true
}
```

Скриншоты (gitignored, `test-results/`): `01-sega.png`, `02-logos.png`,
`03-title.png`, `04-menu.png`, `05-restored.png`, `canvas-menu.png`, `page-menu.png`,
JSON-отчёт `report.json`.

---

## 1. Выбранный путь: **A** (standalone `runtime.wasm` + JS-моки импортов)

Почему не B (пересборка runtime с emcc-glue/SDL2-портом):

| | A: standalone + моки | B: emcc glue + SDL2 |
|---|---|---|
| Что готово | `runtime/wasm/runtime.wasm` уже STANDALONE_WASM + IMPORTED_MEMORY, `loader.mjs` уже мокает все 228 `env`-импортов | нужен новый артефакт рантайма и его синхронизация с манифестом/ABI-пином |
| Импорты | 227 заглушек (`() => 0`, WASI — нули) + `env.memory` = настоящая память | нужно реализовать/подключить весь SDL2+WebGL+event слой emscripten |
| Часы/цикл | JS владеет памятью и вызывает `dune_rt_machine_step()`; детерминизм сохраняется | C-цикл `em_web_main_loop_iter` через `emscripten_set_main_loop` |
| Рендер | `dune_web_frame_rgb()` — программный VDP-рендерер уже в рантайме, RGB24 320×224 | SDL-текстура/WebGL |
| Риск | нет SDL-окна → тач-адаптеры камеры (`dune_web_tap_screen`/`pan`/`zoom`) возвращают 0 | большой объём нативной интеграции, ломает пин ABI |

Игра **не вызывает** SDL/GL/аудио на пути кадра: `machine_step()` → `vdp_advance()` →
`vdp_render()` пишет `em_cpu.vdp.frame`, а `dune_web_frame_rgb()` отдаёт указатель на него.
Поэтому 227 заглушек честно достаточно для изображения, ввода с геймпада и сейвов.
Это снимает необходимость трогать `runtime/wasm/` (закоммиченный артефакт не менялся).

Ограничение пути A: адаптеры, которым нужны `em_host.window`/`renderer` (SDL-геометрия),
в standalone-сборке не работают — `dune_web_tap_screen`, `dune_web_pan`,
`dune_web_zoom`, `dune_web_hover_screen`, `dune_web_select_screen` возвращают 0.
Ввод, который работает: `dune_web_pad(mask,down)` (крестовина/A/B/C/Start) и
`dune_web_campaign_input(0,128)` (фронтенд-запрос Start). Этого достаточно для меню;
тач/пан/зум — задача следующего шага (§7).

## 2. Файлы

| Файл | Роль |
|---|---|
| `web/host/host.mjs` | `DuneHost`: загрузка `runtime.wasm`, линковка `game.wasm`, boot, цикл, RGB→canvas, ввод, сейвы, метрики. Без сборщика, чистые ES-модули. |
| `web/host/play.html` | минимальная отладочная страница: ROM-файл, canvas 320×224, кнопки Start/шаг/сейв, статус с метриками, клавиатура→геймпад. `window.__HOST` для теста. |
| `tools/host/serve.mjs` | статический сервер **корня репозитория** (`/web/host/play.html`, `/runtime/wasm/runtime.wasm`, `/.local/…/game.wasm`) с MIME `application/wasm`, COOP/COEP, no-store. |
| `tools/host/build_game_module.py` | fallback-сборка полного `game.wasm` из эмиттера под ABI рантайма (read-only импорт `tools/wasm_emitter`), пишет `.local/host-build/game.wasm`. |
| `tests/host/play.test.mjs` | e2e-тест: сервер + headless Chrome + ROM → кадры/сейв/ассерты. Без ROM — skip. |
| `test-results/host/` | скриншоты и `report.json` (gitignored). |

Запуск вручную:

```sh
node tools/host/serve.mjs --port 4188
# открыть http://127.0.0.1:4188/web/host/play.html?game=/.local/wasm-full/game.wasm
# выбрать ROM → «Загрузить ROM» → «▶ Играть»
```

Пересобрать полный `game.wasm` самому (если артефакта полного модуля нет):

```sh
python3 tools/host/build_game_module.py \
  --rom "/path/to/Dune (USA).gen" --out .local/host-build/game.wasm
# 48 страниц, 40382 инструкции, 3 142 780 B, decode 3.5 s + emit 0.6 s
```

## 3. Как устроена связка

```
JS (DuneHost / loader.mjs)                    runtime.wasm (894 968 B)          game.wasm (3 142 822 B)
──────────────────────────                    ────────────────────────          ───────────────────────
new WebAssembly.Memory(1024, 8192) ─────────► env.memory  (imported) ◄────────── env.memory (imported)
WebAssembly.instantiate(runtime)              exports dune_rt_init()            imports env.dune_read_mem …
env-импорты: 227 заглушек (SDL/EGL/GL/EM_JS/   exports dune_rt_machine_step()    exports translated_step(c),
WASI `()=>0`, WASI fd_write → console)        exports dune_web_frame_rgb()      translated_z80_step(c), warmup_all,
                                             exports dune_web_pad(), save …    __indirect_function_table
```

Линковка (как в `tools/wasm_integration/link_and_run.mjs`, но в браузере):

1. `runtime/wasm/loader.mjs` → `loadRuntime({wasmBytes})`, `initRuntime(rt)` → ABI-дескриптор
   (140 слов) из `dune_abi_descriptor()`, проверенный пин-хеш `fb47e138…`.
2. `WebAssembly.compile(gameBytes)`; импорты строятся из `WebAssembly.Module.imports()`:
   `env.memory` = память рантайма, каждый `env.dune_*` = **тот же объект**, что экспортирует
   рантайм (`rt.exports[name]`, проверка `typeof === 'function'`) — JS на пути инструкции нет.
3. `appendFunctions(rt, [translated_step, translated_z80_step])` → слоты `741, 742` в
   `__indirect_function_table`; `installGameTable(rt, [741, 742])` →
   `dune_rt_set_game_table(ptr, 2)` → режим `GAME_MODE_SINGLE` (2).
4. ROM: `loadRom(rt, bytes)` → `dune_rt_rom_buffer()` (malloc 1 МиБ внутри рантайма).
   ROM не покидает память и не попадает в репозиторий.
5. Boot (как `main()` в `runtime/dune-runtime-v2.c`):
   `a7 = ssp = ROM[0..3]`, `pc = ROM[4..7] & 0xFFFFFF` (= `$000200`), `sr = 0x2700`,
   `halted = fault = 0`, `dune_rt_set_window(1)` (нужен сейвам/вводу),
   `game.warmup_all(cpu)` — прогрев 48 page-функций (65 мс).
6. Цикл: `for (;;) dune_rt_machine_step()` — один шаг = одна транслированная инструкция
   68000 + `machine_advance()` (VDP/Z80-тики), `vdp_render()` пишет кадр.
   `audio_mode = AUDIO_STUB` из `dune_rt_init()`, поэтому `z80_tick()` сразу выходит и
   z80-стаб не даёт `UNTRANSLATED`.
7. Кадр: `dune_web_frame_width/height` (320×224) + `dune_web_frame_rgb()` → RGB24 →
   `ImageData` (RGB→RGBA, альфа 255) → `putImageData` в canvas. Номер кадра —
   `dune_web_frame_serial()` (`vdp.rendered_frames`), по нему же пропускается отрисовка.

## 4. Цикл и реальное время

`host.start()` повторяет логику `em_web_main_loop_work` из C-фронтенда, но из JS:

* `credit = elapsed_ms × masterHz / 1000`, `masterHz = 53 693 175` (берётся из
  `dune_web_debug()`), потолок догонки — 100 мс (≈4 кадра);
* шагаем блоками по 16…512 инструкций, пока `master_cycles < lastCycles + credit`;
  на каждом блоке читается `master_cycles`/`vdp.rendered_frames` из памяти;
* кадр перерисовывается только при смене `dune_web_frame_serial()`.

Замер в headless Chrome на титульном экране (6×1 с):

| metric | значение |
|---|---|
| FPS (rAF) | **60.0** |
| мс на кадр (шаги) | **0.98–1.05 мс** |
| шагов/с | **13.0 млн** |
| эмуляция | **1.0 с эмуляции за 1.0 с реального времени** (реальный темп) |
| кадров/с от VDP | 61 |

То есть запас по производительности большой: на 60 fps нужно ≈15 тыс. инструкций
на кадр, реально исполняется ≈13 млн/с (в 14× быстрее реального времени).

Сквозные цифры теста: `runtime.wasm` 894 968 B, `game.wasm` 3 142 822 B
(у host-билдера 3 142 780 B), загрузка страницы 94 мс, load runtime+game 186 мс,
boot+warmup 66 мс, прогон 29.2 млн инструкций (41.2 с эмуляции) за ≈2 с драйва.

## 5. Что на скриншотах (реальные кадры из ROM)

| файл | что видно | инструкций | эмуляции | ненулевых px | цветов |
|---|---|---|---|---|---|
| `01-sega.png` | логотип SEGA (стартовый экран) | 2.0 млн | ~2.2 с | 2 641 | 10 |
| `02-logos.png` | Virgin Interactive + Westwood Studios, © 1994 | 8.0 млн | ~10.8 с | 16 567 | 27 |
| `03-title.png` | титул **DUNE — The Battle for Arrakis**, планета, «LICENSED BY SEGA ENTERPRISES, LTD.» | 24.0 млн | ~33.8 с | 18 121 | 23 |
| `04-menu.png` | титул + меню **START GAME / OPTIONS / TUTORIAL** (после программного Start) | 29.0 млн | ~41.2 с | 18 177 | 22 |

Первый видимый кадр появляется на **≈1.8 млн инструкций** (VDP-регистр 1, бит 6);
«долгий» титул — это оригинальная последовательность заставок игры (SEGA → издатели →
титул), машина всё это время идёт в реальном темпе.

## 6. Ввод и сейвы

* `dune_web_pad(mask, down)` — маска Sega-пада (`U=1,D=2,L=4,R=8,B=16,C=32,A=64,Start=128`).
  Работает без SDL-окна (пишет `em_cpu.pad_buttons[0]`), проверено: Start на титуле →
  меню; повторный Start/крестовина двигают меню.
* `dune_web_campaign_input(action, value)` — фронтенд-запрос (0,128 = Start), тоже без окна;
  доставляется на «родном» гейте сцены (задержка в несколько кадров).
* `dune_web_tap_screen(x,y)`, `dune_web_pan(dx,dy)`, `dune_web_zoom(f,ax,ay)` — обёрнуты в
  `DuneHost`, но в path A требуют `em_host.window`/`renderer` (SDL-геометрия) и возвращают 0;
  кнопка «Тап в центр» в отладочной странице это честно показывает.
* Сейв: `dune_save_state_to_buffer()` → 140 056 B (DSAV v2, magic `DSAV`), указатель —
  `dune_get_save_buffer()`; загрузка — копия в тот же буфер + `dune_load_state_from_buffer(n)`.
  Тест проверяет round-trip: счётчик инструкций после загрузки возвращается к сохранённому.
  Кадр после загрузки обновится на следующем рендере (в сейв входит VDP-состояние, но не
  `rendered_frames`/пиксельный буфер — это штатное поведение рантайма).

## 7. Что осталось до «поиграть»

1. **Меню → миссия.** Сейчас доказано до главного меню. Дальше: house select →
   mission select → briefing → карта. Всё это уже исполняется (48 страниц, 40 382
   инструкции, 0 неподдерживаемых op’ов), но нужен e2e-тест навигации до первого
   игрового кадра (проверить, что 68000-код доходит до `scene=map`/`campaign`).
2. **Тач/пан/зум.** Адаптеры камеры завязаны на SDL-окно. Варианты: (a) дать рантайму
   «виртуальное окно» — пересобрать в `.local/host-build/` с патчем геометрии под
   canvas-CSS-размеры (C-код адаптеров, не наш runtime-артефакт); (b) реализовать
   tap/pan/zoom в хосте поверх `dune_web_gesture_query`/`dune_mouse_*` — но они тоже
   требуют проекции окна; (c) parent UI может слать `dune_web_campaign_input` для меню и
   `dune_web_pad` для карты уже сейчас.
3. **Звук.** `dune_rt_init()` ставит `AUDIO_STUB` → Z80 не исполняется, YM2612/PSG молчат.
   Для звука нужны: перевод Z80-кода в game.wasm (сейчас z80-стаб), реальный
   `AUDIO_ON`, мост PCM в `AudioWorklet` (`dune_web_audio_worklet`/`em_web_audio_push`
   уже есть в адаптерах, но EM_JS-импорт замокан нулём — нужен настоящий мост).
4. **Полный модуль.** Артефакт full-module (`/.local/wasm-full/game.wasm`, 48 страниц)
   уже подхватывается тестом/хостом; fallback — `tools/host/build_game_module.py`.
   PC, попавший на нетранслированную страницу, даёт fault `UNTRANSLATED(1)` — на
   реальном прохождении пока не встречался.
5. **Интеграция с UI родителя.** `web/app.mjs` может импортировать `DuneHost` из
   `web/host/host.mjs`; важно, чтобы сервер отдавал `/runtime/wasm/runtime.wasm`
   (текущий `tools/serve.py` рутит только `web/`, поэтому либо `tools/host/serve.mjs`,
   либо копия runtime.wasm в `web/vendor/` при сборке). ROM — только через `<input type=file>`
   или OPFS, в git не кладём.
6. **Сейв-файлы/кампания.** `web/saves/*` оперируют байтами `dune_get_save_buffer()`;
   мост уже есть через `DuneHost.saveState()/loadState()`.

## 8. Ограничения и честные оговорки

* Путь A не запускает SDL2/WebGL: `em_host.window/renderer` = NULL, поэтому
  SDL-зависимые адаптеры (камера/тач/меню-селект по экранным координатам) не работают.
  Кадр, геймпад, сейвы, кампания — работают.
* 227 `env`-импортов замоканы нулями (`loader.mjs`); это безопасно, пока игра не зовёт
  SDL/GL/audio. Если вызвать `run_main()` (вход C-фронтенда), он ожидаемо упрётся в
  заглушки — хост использует `dune_rt_machine_step()`, а не `run_main()`.
* Скриншоты и `game.wasm` лежат в `test-results/`/`.local/` (gitignored): игровые данные
  в репозиторий не попадают, `python3 tools/check_no_game_data.py` — OK.
