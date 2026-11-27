# `runtime.wasm` — предварительно собранный рантайм (Phase 1)

Статус: **собран и проверен**. `runtime.wasm` — настоящий артефакт emcc 3.1.74
(STANDALONE_WASM, импортируемая память), без ROM и без транслированных
инструкций. Игровой слой в Phase 1 — отдельный code-only `stub_game.wasm`
(собирается тут же для тестов). Дизайн: [`WASM-BACKEND.md`](WASM-BACKEND.md);
точный рантайм v2: [`RUNTIME.md`](RUNTIME.md).

```
runtime/wasm/runtime.wasm     894 968 B   sha256 205ac655ff189efeff4da5068add92e4523b888c5df37f1466e4ddacdd965b66
runtime/wasm/stub_game.wasm     1 388 B   sha256 fc8dedc5fb4b02b783cdf88cb80ef3f4dcd6d19d966370a726d3a1bae5d69b14
runtime/wasm/loader.mjs         14 КБ     ES-модуль (память, инстанцирование, ABI, ROM, таблица)
runtime/wasm/manifest.json      44 КБ     SHA/размер/флаги/экспорты/ABI/импорты/проверки
```

Числа выше — текущая сборка; авторитет всегда `runtime/wasm/manifest.json`
(в тестах жёстко проверяется только `emcc 3.1.74`, размерные лимиты и
тождества, а SHA — из манифеста).

---

## 1. Как собрать и проверить

```sh
cd "/path/to/dune-web"
EMSDK="/path/to/emsdk-3.1.74"

# 1. Сборка (stdlib; emcc/em++/clang/wasm-ld запускаются через subprocess с таймаутами)
python3 tools/wasm_runtime/build_runtime.py --emsdk "$EMSDK"

# 2. Тесты (Node 24)
node --test 'tests/wasm_runtime/**/*.test.mjs'

# 3. Правило BYOP: в репозитории нет игровых данных
python3 tools/check_no_game_data.py
```

> **Node ≥ 22:** позиционный аргумент `--test` — это glob по *файлам*, а не
> каталог для рекурсивного поиска. Поэтому `node --test tests/wasm_runtime/`
> на Node 24.16 падает с `MODULE_NOT_FOUND` (это изменение Node, не нашего
> теста). Рабочие формы:
> `node --test 'tests/wasm_runtime/**/*.test.mjs'` (кавычки обязательны) или
> `node --test tests/wasm_runtime/runtime.test.mjs`; без аргументов
> `node --test` находит файл сам по дефолтным glob’ам.

Полезные флаги сборки:

| Флаг | Смысл |
|---|---|
| `--emsdk PATH` | обязателен (или env `EMSDK`); проверяется `emsdk_env.sh` |
| `--build-dir DIR` | staging, по умолчанию `.local/wasm-runtime` (gitignored) |
| `--out-dir DIR` | артефакты, по умолчанию `runtime/wasm` |
| `--node PATH` | node для дампа ABI (по умолчанию из `PATH`) |
| `--skip-abi-dump` | не инстанцировать рантайм в Node при сборке |
| `--allow-emcc-version` | не требовать ровно 3.1.74 |
| `--clean` | удалить предыдущие объекты/артефакты |
| `--verbose` | стримить вывод компиляторов |

Время сборки на M1 Pro: **≈6 с** с прогретым портом SDL2 (первый
`-sUSE_SDL=2` может скачать/собрать порт SDL2 из сети). Все команды и их
вывод — в `.local/wasm-runtime/logs/*.log`. Объекты `.o` остаются в
`.local/wasm-runtime/obj/`, повторный `--clean` удаляет их.

---

## 2. Что именно собирается

`tools/wasm_runtime/build_runtime.py` делает следующее.

1. **Реконструирует точную pinned-преамбулу** в `.local/wasm-runtime/preamble.c`:
   3 строки эмиттера (180 B) + `runtime/dune-runtime-v2.c` + `\n` = 130 103 B.
   SHA-256 сверяется с `runtime/manifest.json` → `4d6181fd…a1f9b306`.
2. **Генерирует ABI-слой** из `tools/wasm_runtime/abi_spec.py`:
   `dune_abi_layout.h` (индексы слов, ожидаемые константы, fail-коды) и
   `dune_abi_fill.inc` (заполнение дескриптора + `_Static_assert` на размеры
   `CPU`/`Z80CPU`/`DuneSaveState`).
3. **Генерирует `runtime.c`**:
   ```c
   #include "preamble.c"        // точная преамбула
   #include "dune_rt_abi.inc"   // ABI + ROM-буфер + диспетчеризация + helper-экспорты
   ```
   `dune_rt_abi.inc` — единственный новый C-код; включён в тот же TU, поэтому
   видит `static`-хелперы и `em_cpu`/`g_dune_state_buffer` преамбулы.
4. **Пересобирает pinned YM2612-драйвер** (vendor `audio_ymfm.cpp` + патч из
   `runtime/adapters/em_web_audio_levels_cpp.h`) и сверяет его SHA-256 с
   `runtime/manifest.json` → `66413a1c…d74187e`, 8157 B (байт-в-байт как у
   `tools/prepare_source.py`).
5. **Компилирует и линкует** `runtime.wasm` (см. флаги ниже).
6. **Собирает `stub_game.wasm`** freestanding-компилятором:
   `clang --target=wasm32 -nostdlib` + `wasm-ld --no-entry --import-memory`.
   Никакого emscripten-рантайма, libc, data-сегментов и собственной памяти.
7. **Генерирует `loader.mjs`** (из `tools/wasm_runtime/src/loader.mjs.tmpl`).
8. **Инстанцирует рантайм в Node**, вызывает `dune_rt_init()`, читает
   ABI-дескриптор, проверяет константы/selfcheck/пересчёт SHA-256 и только
   затем пишет `manifest.json` с фактическими полями/адресами.
9. **Проверяет детерминизм**: повторный линк из тех же объектов даёт тот же
   SHA-256 (в текущей сборке — да; записано в `wasm.determinism`). Кросс-платформенная
   битовая идентичность не гарантируется: коммит содержит артефакт, собранный emcc 3.1.74
   на macOS arm64; CI (Linux) пересобирает модуль и проверяет **ABI hash, набор экспортов и
   детерминизм линка**, а не побайтовое равенство. Функциональные тесты (Node) гоняются на
   обеих платформах.
   Детерминирован именно `runtime.wasm`; в `manifest.json` поля
   `generated_at_utc` и длительности команд (`commands`) меняются от сборки к
   сборке — это метаданные, а не артефакт.

### Флаги компиляции/линковки

```
# compile (C11)
emcc -O2 -std=c11 -Wno-unused-function \
     -DGENESIS_SDL2 -DGENESIS_AUDIO -D__EMSCRIPTEN__ \
     -Iruntime/adapters -Ivendor/rearrakis/genesis_recompiler \
     -Itools/wasm_runtime/src -I.local/wasm-runtime \
     -sUSE_SDL=2 -c runtime.c -o runtime.o

# compile (C++17, патченный ymfm)
em++ -O2 -std=c++17 -Ivendor/rearrakis/genesis_recompiler -c audio_patched.cpp

# link
em++ -O2 -sUSE_SDL=2 -sSTANDALONE_WASM=1 --no-entry \
     -sIMPORTED_MEMORY=1 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=536870912 \
     -sALLOW_MEMORY_GROWTH=1 -sALLOW_TABLE_GROWTH=1 -sSTACK_SIZE=16777216 \
     runtime.o audio.o -o runtime.wasm
```

### Почему `STANDALONE_WASM=1`, а не `SIDE_MODULE=1`

* `SIDE_MODULE` — это динамическая линковка против главного emscripten-модуля:
  side-модуль импортирует libc/dlmalloc/JS-библиотеки из `env` и требует GOT,
  то есть не самодостаточен и не может быть просто `WebAssembly.instantiate`
  из маленького загрузчика.
* `STANDALONE_WASM` даёт самостоятельный reactor-модуль с `_initialize`,
  импортом памяти (`-sIMPORTED_MEMORY=1`) и обычными wasm-импортами. Его можно
  инстанцировать напрямую, а все импорты — замокать/подставить в
  `loader.mjs`. Цена — 228 `env`-функций (JS-библиотеки emscripten: SDL/EGL/
  EM_JS) и 7 WASI-функций; они не вызываются в Phase 1 и замоканы нулями.
  Реальный браузерный хост подставит SDL/EM_JS-мосты через
  `makeImportObject(..., { overrides })`.

`IMPORTED_MEMORY=1` + `ALLOW_MEMORY_GROWTH=1`: памятью владеет JS
(`new WebAssembly.Memory({initial:1024, maximum:8192})` = 64 МиБ / 512 МиБ);
рантайм и будущий `game.wasm` импортируют один и тот же экземпляр.
`ALLOW_TABLE_GROWTH=1` нужен, чтобы JS мог дописывать funcref’ы `game.wasm`
в `__indirect_function_table` рантайма.

### Проверки, которые падают при сборке

* SHA `runtime/dune-runtime-v2.c`, полной преамбулы, патченного аудио-драйвера
  и всех 20 адаптеров — против `runtime/manifest.json`/`runtime/adapters/manifest.json`;
* `runtime.wasm` **не определяет собственную memory** (только импортирует
  `env.memory`), экспортирует `_initialize` и `__indirect_function_table`;
* все ожидаемые экспорты на месте (5 preamble + 70 адаптеров + 4 save + 63 ABI
  + `run_main`/`sdl_host_service`);
* data-сегменты ≤ 512 КиБ суммарно и < 256 КиБ каждый (это инициализированные
  константы/строки компилятора, не ROM; крупнейший — 39 841 B);
* размер < 4 МиБ (сейчас 894 968 B);
* **ROM-буфер до `dune_rt_init()` нулевой**, после — непустой, 1 МиБ, и второй
  `dune_rt_init()` его не переаллоцирует;
* ABI-константы в собранном дескрипторе совпадают с `runtime/manifest.json`
  (`DuneSaveState` = 140 056 B, `ram_offset` = 94, house/mission и т.д.);
* `abi_hash` пересчитывается и совпадает с `dune_abi_selfcheck`;
* детерминизм повторного линка.

---

## 3. ABI-дескриптор (`dune_abi_descriptor()`)

Экспорт `dune_abi_descriptor() -> i32` возвращает указатель на `uint32_t[140]`
в линейной памяти рантайма. Порядок слов — единый источник истины
`tools/wasm_runtime/abi_spec.py`; JS-загрузчик получает тот же список имён
(`loader.ABI_FIELDS`) и `manifest.abi.fields`.

Раскладка (140 слов, `layout_end` = 129, далее 11 адресов):

| Слова | Содержимое |
|---|---|
| 0–2 | `MAGIC = 0x31424144` («DAB1»), `VERSION = 1`, `SIZE = 140` |
| 3–10 | `ABI_HASH_0..7` — 8 слов SHA-256 |
| 11 | `HELPER_ABI_VERSION = 1` |
| 12–45 | layout `CPU`: `SIZEOF_CPU`, `OFF_D/A/PC/USP/SSP/SR/RAM/IO_*/TMSS/PAD_BUTTONS/FAULT/FAULT_ADDRESS/REASON/INSTRUCTION_CYCLES/Z80_DIVIDER/STEPS/CYCLES/MASTER_CYCLES/INTERRUPTS/HALTED/ROM/ROM_SIZE/VDP*/VDP_FRAME*` |
| 46–69 | `Z80CPU`: `SIZEOF_Z80CPU`, `OFF_Z80_CPU` (база вложенной структуры) и **абсолютные от `CPU`** смещения `OFF_Z80_R8/ALTERNATE/A/F/A_ALT/F_ALT/I/R/IFF1/IFF2/IM/HALTED/IRQ_LINE/EI_DELAY/PC/SP/IX/IY/WZ/DEBT/STEPS/CYCLES/INTERRUPTS` |
| 70–74 | `Z80Bus`: `OFF_Z80_BUS`, `OFF_Z80_RAM`, `REQUESTED`, `RESET_RELEASED`, `BANK` |
| 75–82 | `DuneSaveState`: `SIZEOF_SAVESTATE = 140056`, `SAVESTATE_RAM_OFFSET = 94`, `HOUSE_OFFSET = 49874`, `MISSION_OFFSET = 49326`, `YM_SIZE_FIELD_OFFSET = 8`, `TOTAL_SIZE_FIELD_OFFSET = 12`, `SAVESTATE_MAGIC = 0x56415344`, `SAVESTATE_VERSION = 2` |
| 83–93 | размеры/режимы: `SAVE_BUFFER_BYTES = 262144`, `ROM_CAPACITY = 1048576`, `PAGE_SHIFT = 12`, `PAGE_SIZE = 4096`, `PAGE_SLOTS = 4096`, `ROM_PAGES = 256`, `RAM_PAGE_FIRST = 4080 (0xFF0)`, `RAM_PAGE_COUNT = 16`, `GAME_MODE_NONE/PAGES/SINGLE = 0/1/2` |
| 94–127 | enum’ы: `F_*`, `Z_*`, `SHIFT_KIND_*`, `SIZE_*` и 14 кодов `DUNE_FAIL_*` (`UNTRANSLATED=1 … Z80_PERIPHERAL=14`) |
| 128–139 | адреса: `ADDR_CPU`, `ADDR_RAM`, `ADDR_Z80_RAM`, `ADDR_ROM`, `ADDR_SAVE_BUFFER`, `ADDR_VDP_VRAM/CRAM/VSRAM/FRAME`, `ADDR_GAME_TABLE`, `ADDR_ABI` |

### `abi_hash`

`abi_hash` = SHA-256 по **структурным** словам дескриптора:

```
words [0, 3)    — magic, version, size
words [11, 129) — layout, enum’ы, fail-коды, размеры, DSAV-числа
```

Адреса (слова 129–139) в хеш **не входят**: они зависят от сборки emcc, а
`game.wasm` зависит только от layout/ABI. При изменении C-раскладки (например,
перестановки полей `CPU`) меняется `abi_hash` → ключ кэша `game.wasm`
инвалидируется. Текущий: `fb47e1386ee5c802a2cb2a58b98ec29367db79e00c7f32b355020abbc4be1db5`.

### Как JS читает дескриптор

```js
import { loadRuntime, initRuntime, ABI_FIELDS } from "./runtime/wasm/loader.mjs";

const rt = await loadRuntime({ url: new URL("./runtime/wasm/runtime.wasm", import.meta.url) });
const abi = initRuntime(rt);            // вызывает dune_rt_init(), читает дескриптор
abi.fields.OFF_PC;                      // 64
abi.fields.ADDR_ROM;                    // указатель на 1 МиБ ROM-буфер
abi.words;                              // Uint32Array(140) — снимок
await verifyAbiHash(abi);               // true — пересчитанный SHA-256 совпал
```

`dune_abi_selfcheck(version, hash_ptr)` возвращает 1, если `version` и 8 слов
хеша совпали. `readAbi()` доступен и до `dune_rt_init()`, но `ADDR_ROM` будет 0.

---

## 4. ROM игрока

ROM **не** встроен в модуль. `dune_rt_init()` делает
`malloc(1 048 576)` и обнуляет буфер; указатель отдаётся
`dune_rt_rom_buffer()` / `dune_rom_ptr()`, ёмкость — `dune_rt_rom_capacity()`.
`em_cpu.rom`/`em_cpu.rom_size` указывают на этот буфер, поэтому обычный
`read_mem` читает ROM без специальных веток.

```js
import { loadRom, readRom, romView } from "./runtime/wasm/loader.mjs";
loadRom(rt, romBytes);                  // Uint8Array длиной ≤ 1 МиБ, один memcpy
readRom(rt, 0x1000, 16);                // обратное чтение
```

Проверка «ROM не в wasm»: в модуле нет memory-секции, data-сегменты < 512 КиБ,
`runtime.wasm` (894 968 B) меньше 1 МиБ, а `dune_rt_rom_buffer()` до
инициализации возвращает 0.

---

## 5. Связка с игровым модулем

Рантайм вызывает сгенерированный код через `translated_step(CPU*)` (и
`translated_z80_step(CPU*) -> u32`), которые заменяют forward-объявления
преамбулы. Сами функции берутся из таблицы funcref’ов — JS дописывает функции
`game.wasm` в экспортированную `__indirect_function_table` рантайма и передаёт
индексы слотов.

Поддерживаются **два режима** (оба проверены тестами):

| Режим | `dune_rt_set_game_table(ptr, count)` | Как вызывается |
|---|---|---|
| `GAME_MODE_PAGES` = 1 | `count = 4096` (или 256 ROM-страниц) | рантайм сам диспетчеризует `pc >> 12`: `g_page_slots[page]`, затем `call_indirect`; слот `0` → `FAIL_UNTRANSLATED` |
| `GAME_MODE_SINGLE` = 2 | `count = 2`: `[translated_step, translated_z80_step]` | так, как в `WASM-BACKEND.md §5.1`: `translated_step` игры делает свой `br_table`; z80-слот отдельно |

Режим по умолчанию — `GAME_MODE_NONE` (любой `translated_step` даёт
`FAIL_UNTRANSLATED`). Переключение: `dune_rt_set_game_table`, `dune_set_game_steps(step, z80)`,
`dune_rt_set_z80_step(slot)`, сброс — `dune_rt_clear_game_table()`.
`dune_rt_machine_step()` — тестовый/хост-хук, один `machine_step(&em_cpu)`
(начисляет `instruction_cycles`, VDP/Z80-тайминг, `steps++`).

Перед `pc`-диспетчеризацией проверяются `pc > 0xFFFFFF` → `FAIL_BAD_PC` и
`pc & 1` → `FAIL_ODD_PC`. Неизвестные страницы/слоты → `FAIL_UNTRANSLATED`
(`dune_rt_last_fail_code()`, строка через `dune_rt_fail_reason(code)`).

### `stub_game.wasm` — «игровая» сторона для тестов

Собран из `tools/wasm_runtime/src/stub_game.c` freestanding-компилятором:
ровно один импорт памяти `env.memory` и два хелпера — `env.dune_read_mem`,
`env.dune_write_mem` (прямые ссылки на экспорты рантайма, без JS-прослоек).
Своих data-сегментов/стека в общей памяти не имеет; статик (указатель на
дескриптор) размещён по `--global-base=56 МиБ` (тестовый артефакт; реальный
`game.wasm` от эмиттера вообще не имеет статиков).

| Обработчик | Поведение |
|---|---|
| `stub_page_00` | no-op: `instruction_cycles = 4`, `pc += 2` |
| `stub_page_01` | RAM write `[0xFF0010] = 0xA5` через `dune_write_mem`, `pc += 2` |
| `stub_page_ff0` | RAM-страница: `instruction_cycles = 6`, `pc += 4` |
| `stub_translated_step` | single-режим: `RAM[0x20] = read_mem(ROM[0x200])`, `pc += 2` |
| `stub_translated_z80_step` | возвращает 8 циклов Z80 |
| `stub_warmup_all` | no-op для прогрева страниц (как в дизайне) |
| `stub_game_init(abi_ptr)` | запоминает указатель на дескриптор |

Пример связки (см. `tests/wasm_runtime/runtime.test.mjs`):

```js
const stub = await WebAssembly.instantiate(stubModule, {
  env: { memory: rt.memory,
         dune_read_mem: rt.exports.dune_read_mem,
         dune_write_mem: rt.exports.dune_write_mem },
});
stub.exports.stub_game_init(abi.pointer);
const slots = appendFunctions(rt, [
  stub.exports.stub_page_00, stub.exports.stub_page_01, stub.exports.stub_page_ff0,
]);
const table = new Array(4096).fill(0);
table[0x00] = slots[0]; table[0x01] = slots[1]; table[0xFF0] = slots[2];
installGameTable(rt, table);                    // mode PAGES
rt.exports.dune_rt_translated_step(abi.fields.ADDR_CPU);
```

---

## 6. Экспорты рантайма

146 экспортов (145 функций + `__indirect_function_table`), включая служебные
emscripten-экспорты (`_initialize`, `malloc`, stack-хелперы). Смысловые группы:

* **preamble (5):** `dune_get_save_buffer`, `dune_save_state_to_buffer`,
  `dune_load_state_from_buffer`, `dune_mouse_leave`, `dune_web_audio_levels`;
* **адаптеры (70 `dune_web_*`)**: кадр/презентация, ввод, выделение/приказы,
  меню/здания/кампания, звук/служебное — полный список в
  `manifest.exports.adapters` (он же повторяет `runtime/manifest.json`);
* **хост-точки:** `run_main`, `sdl_host_service`;
* **ABI (63):** дескриптор/selfcheck/инициализация/ROM/таблица/диспетчеризация
  (`dune_abi_*`, `dune_rt_*`), `dune_fail` и helper-ABI для `game.wasm` —
  16 базовых 68000-хелперов (`dune_read_mem`, `dune_write_mem`, `dune_push32`,
  `dune_pop32`, `dune_movem`, `dune_set_sr`, `dune_logic_flags`,
  `dune_arithmetic`, `dune_extended_arithmetic`, `dune_bcd_arithmetic`,
  `dune_bcd_negate`, `dune_shift_value`, `dune_divide_value`, `dune_condition`,
  `dune_index_value`, `dune_fail`) и 21 Z80-хелпер (`dune_z80_*`).
  Точные сигнатуры — `tools/wasm_runtime/src/dune_rt_abi.inc`;
* сохранения: `dune_save_state_to_buffer()` → 140 056 B (`DSAV v2`, при
  `em_window`; строки/порядок полей не менялись).

Импорты (host-контракт): **228** функций `env.*` (JS-библиотеки emscripten:
EGL/GL, SDL gamepad/mouse/touch, `emscripten_*`, три `EM_JS` аудио-моста) и
**7** функций `wasi_snapshot_preview1` (`fd_write`, `fd_read`, `fd_close`,
`fd_seek`, `clock_time_get`, `environ_sizes_get`, `environ_get`) плюс
`env.memory`. Полные списки — `manifest.imports`.

---

## 7. `loader.mjs`

Генерируется из `tools/wasm_runtime/src/loader.mjs.tmpl`, встраивает
`ABI_FIELDS` и `ABI` (версия, размеры, ranges хеша, режимы, память). Экспорты:

| Функция | Назначение |
|---|---|
| `createMemory(opts)` | 64 МиБ initial / 512 МиБ maximum |
| `makeImportObject(module, {memory, overrides})` | моки всех импортов: memory, нулевые env-функции, WASI (с `fd_write` в stderr), `overrides` для реального хоста |
| `loadRuntime({url, wasmBytes, wasmModule, memory, importOverrides})` | compile + instantiate + `_initialize()` |
| `initRuntime(rt)` | `dune_rt_init()` + `readAbi()` |
| `readAbi(rt)` | `{pointer, words, fields, addresses}` |
| `computeAbiHash` / `verifyAbiHash` / `abiHashHex` | SHA-256 по структурным словам (WebCrypto) |
| `romView` / `loadRom` / `readRom` | 1 МиБ ROM-буфер |
| `gameTableView` / `appendFunctions` / `installGameTable` | funcref-таблица и режимы |
| `cString(rt, ptr)` | чтение NUL-строк (fail reason) |
| `setWindow(rt, enabled)` | хост-хук для `em_window` (в проде его ставит `run_main`) |

---

## 8. Что реально проверено в Node и какие моки понадобились

`tests/wasm_runtime/runtime.test.mjs` — 9 тестов, все зелёные. Рантайм
инстанцируется с **импортируемой памятью** и замоканным окружением:

* **моки:** все 228 `env`-функций и 7 WASI-функций возвращают 0
  (`fd_write` пишет в stderr, `fd_read`/`environ_*`/`clock_time_get` —
  минимальная WASI-заглушка); `env.memory` — реальный
  `WebAssembly.Memory`; `EM_JS`-глобалы не понадобились (в standalone-модуле
  они экспортируются, а не импортируются). SDL/EGL-функции не вызываются,
  поэтому их моки — нули. C++/libc-инициализация — `_initialize()`.
* **проверено:** SHA/размер/лимиты артефактов; отсутствие game data
  (нет memory-секции, data-сегменты < 512 КиБ, ROM-буфер до init = 0);
  полный список экспортов и импортов; ABI-дескриптор 1:1 с манифестом
  (140 слов, константы, enum’ы, fail-коды, `DuneSaveState` = 140 056/offset 94,
  house/mission, `ROM_CAPACITY`, page-константы), структурные тождества
  смещений `CPU`/`Z80CPU`, адреса = `ADDR_CPU + OFF_*`; независимый пересчёт
  `abi_hash` через `node:crypto` + `dune_abi_selfcheck` + отказ на
  подделанном хеше; `dune_rt_init()` (идемпотентность, ROM-буфер, флаги
  по умолчанию); запись/чтение 1 МиБ ROM через буфер и через `dune_read_mem`;
  диспетчеризация по page-таблице (no-op/increment PC/RAM write/RAM-страница),
  `FAIL_UNTRANSLATED`/`ODD_PC`/`BAD_PC`, `dune_rt_machine_step` (циклы/шаги);
  single-режим `dune_set_game_steps` + `installGameTable([step, z80])`,
  z80-циклы и fault без слота; helper-ABI (`read/write_mem`, флаги,
  `arithmetic`, `shift`, `bcd`, `push/pop32`, `z80_*`, `dune_fail`);
  `DSAV v2` save/load round-trip и строгая валидация размеров/магии.

**Чего в Node намеренно нет:** `run_main()` со SDL-окном (`SDL_Init`,
`emscripten_set_main_loop`), реальные SDL/EGL/EM_JS-мосты, звук
(`dune_rt_init()` ставит `AUDIO_STUB`; боевой хост поднимает `AUDIO_ON` через
`run_main`), браузерный воркер/OPFS, реальный `game.wasm` от эмиттера.

---

## 9. Ограничения Phase 1 и следующий шаг

1. **`dune_rt_init()` ≠ `run_main()`.** Инициализация для тестов/ABI ставит
   `em_cpu` напрямую (`audio_mode = AUDIO_STUB`, `em_window = 0`), не поднимая
   SDL. Боевой хост вызывает `run_main(...)` (он в сборке есть), который сам
   открывает окно/аудио и копирует `em_cpu`/`em_host`. Для сохранений в тестах
   используется хук `dune_rt_set_window(1)`.
2. **`game.wasm` ещё нет.** `stub_game.wasm` показывает обе стороны связки, но
   реальный модуль должен генерировать `tools/wasm_emitter` (другой агент).
   Требования к нему: code-only wasm (без memory/data/стека/libc), импорт
   `env.memory` + `dune_*` хелперов, экспорт page-функций (page-режим) или
   `translated_step`/`translated_z80_step` (single-режим), прогрев
   `warmup_all`.
3. **Импорты хоста.** В браузере нужен реальный слой для 228 `env`-функций
   (SDL/EGL/EM_JS) и WASI. Пока `loader.mjs` даёт моки; следующий шаг —
   либо (а) переиспользовать emcc JS-glue отдельной сборкой
   (`-sMODULARIZE`), либо (б) реализовать мосты в воркере и передавать их
   через `overrides`.
4. **ABI hash fallback.** `runtime/abi/runtime-abi-v1.json` из дизайна не
   создавался: самодостаточный `manifest.abi` + `dune_abi_selfcheck()` уже
   дают проверку. Для кэша `game.wasm` ключ:
   `sha256(rom_sha256 | abi_hash | generator_version)`.
5. **Производительность** не замерялась: тесты проверяют корректность
   ABI/диспетчеризации, не скорость. Оценки — в `WASM-BACKEND.md §0.1`.

Следующий шаг (Phase 2): подключить `game.wasm` от эмиттера через
`appendFunctions` + `installGameTable`, проверить `call_indirect` в браузере,
интегрировать в web-worker (Pyodide → bytes → OPFS-кэш), затем — дифференциальные
тесты против C-оракула.

---

## 10. Отклонения от `WASM-BACKEND.md` (осознанные)

1. **Диспетчеризация.** Дизайн §5.1: рантайм зовёт один `translated_step`
   игры по 2-слот-таблице. Phase 1 (по заданию) дополнительно реализует
   page-диспетчеризацию в рантайме (`pc >> 12` → слот таблицы); single-режим
   тоже поддержан, так что оба варианта совместимы.
2. **ABI hash.** В приложении B — одно слово; здесь 8 слов (полный SHA-256) и
   явно определённые ranges, чтобы JS мог пересчитать хеш без C-кода.
3. **Дескриптор расширен** DSAV-полями (`SIZEOF_SAVESTATE`, offsets house/
   mission, offsets полей) и константами диспетчеризации/страниц, чтобы
   тесты/эмиттер не хардкодили числа.
4. **Z80-смещения абсолютные от `CPU`** (плюс `OFF_Z80_CPU` как база), а не
   «от Z80CPU»: game.wasm получает `c + offset` одной операцией.
5. **Мелкие расхождения helper-ABI с приложением A** (по фактическому коду
   преамбулы): `z80_add_pair` возвращает `void` (не u16),
   `z80_alu16(c, rhs, subtract)`, `z80_block(c, direction, repeat)`,
   `z80_szxy(value)` без `CPU*`. Зафиксировано в `dune_rt_abi.inc`; при
   необходимости `HELPER_ABI_VERSION` повышается.
6. **`stub_game.wasm`** компилируется freestanding (clang wasm32 + wasm-ld), а
   не emcc: emcc-модуль получил бы собственные stack/data в общей памяти и
   поломал бы статики рантайма. Это же требование распространяется на
   боевой `game.wasm` (эмиттер генерирует raw wasm без статиков).
7. **Артефакты в git.** `runtime/wasm/*` — маленькие (≈0.9 МБ wasm), не
   содержат игровых данных и проверяются `tools/check_no_game_data.py`.
   `.local/wasm-runtime/` (объекты, логи, сгенерированные исходники) —
   gitignored.
