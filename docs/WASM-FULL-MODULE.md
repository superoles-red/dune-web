# Полный `game.wasm`: все 48 страниц 68000

Статус: **готово и проверено**. Один модуль на весь декодированный код Dune
(Sega Genesis, USA) собирается одной командой, линкуется в `runtime.wasm` через
`GAME_MODE_SINGLE` и даёт **0 расхождений** с нативным C-оракулом на 7 680
детерминированных случаях, покрывающих все 48 страниц.

Это следующий шаг после [WASM-INTEGRATION.md](WASM-INTEGRATION.md), где был
продемонстрирован один page-модуль (`$013`, 78 инструкций). Здесь тот же эмиттер
и тот же ABI, но артефакт — один на всю игру.

---

## 1. Что сделано

| Файл | Назначение |
|---|---|
| `tools/wasm_integration/build_full_module.py` | CLI + API: ROM → **один** `game.wasm` всех страниц + `meta.json` |
| `tools/wasm_integration/check_full_integration.py` | дифференциал полного модуля: C-оракул ↔ `runtime.wasm`+`game.wasm` |
| `tools/wasm_integration/link_and_run.mjs` | расширен: принимает full-meta (`instruction_count`), ставит z80-слот, смоук z80-стаба |
| `tools/wasm_emitter/game_module.py` | `build_module(..., z80_stub=True, instruction_meta=False)`; стаб `translated_z80_step` |
| `tools/wasm_integration/runtime_abi.py` | `verify_game_module(..., expected_exports=...)` — полный модуль экспортирует 5 символов |
| `tests/wasm_full/test_full_module.py` | 13 тестов: структура, линковка, размеры, отсутствие game data, смоук-дифференциал |
| `docs/WASM-FULL-MODULE.md` | этот документ |

Артефакты (gitignored, game data не покидает `.local/`):

```
.local/wasm-full/game.wasm       3 142 822 B
.local/wasm-full/meta.json          29 470 B   (link-контракт: ABI, SHA, страницы, fail-коды)
.local/wasm-full/differential.json              (отчёт дифференциала)
```

---

## 2. Одна команда

```bash
# Сборка полного модуля (ROM — внешний вход, в git не попадает)
python3.12 tools/wasm_integration/build_full_module.py \
    --rom "/path/to/Dune - The Battle for Arrakis (USA).gen"

# Дифференциал полного модуля через связку runtime.wasm + game.wasm
python3.12 tools/wasm_integration/check_full_integration.py \
    --rom "/path/to/Dune - The Battle for Arrakis (USA).gen" \
    --baseline "/path/to/vendor/rearrakis/build/dune-base.c"
```

Хвост вывода сборки на M1 Pro:

```
game.wasm: 3142822 B (3132306 handlers, 77.6 B/instr), 48 functions, built in 529 ms
game.wasm: SHA-256 06ecc2226b5ba1bd1220097b752c680cad0430b278690672427dc806cac7ef93
timing:   ABI 48 ms + decode 3444 ms + build 529 ms = 4030 ms
PASS: one game.wasm covers all 48 pages
```

Хвост дифференциала:

```
select:   480 instructions across 48 pages (10..10 per page), 16 states each = 7680 cases, 40 distinct ops
runtime:  7680 cases in 2591 ms (2964 cases/s), faults 232, codes {"6":46,"7":103,"8":23,"9":30,"10":12,"11":2,"12":16}
oracle:   7680 cases in 4216 ms, faults 232
mismatches: 0
PASS: full module: 48 pages, 480 instructions x 16 states = 7680 cases, 0 mismatches
```

Полный прогон (decode + ABI + сборка + C-оракул + связка + сравнение) —
**11–15 с** на M1 Pro; чистая генерация модуля — **~0,53 с** (decode ROM ~3,4 с
отдельно).

---

## 3. Архитектура модуля

`game.wasm` — чистый код (BYOP): **нет** data-сегментов, своей памяти, глобалов
и встроенного ROM. Всё состояние — в CPU-структуре рантайма.

```
imports (17):  env.memory + env.dune_read_mem, dune_write_mem, dune_push32,
               dune_pop32, dune_movem, dune_set_sr, dune_logic_flags,
               dune_arithmetic, dune_extended_arithmetic, dune_bcd_arithmetic,
               dune_bcd_negate, dune_shift_value, dune_divide_value,
               dune_condition, dune_index_value, dune_fail
exports (5):   translated_step, translated_step_via_table, translated_z80_step,
               warmup_all, __indirect_function_table
```

### 3.1 Страничные функции и `br_table`

48 страниц (`0x00..0xC7`) → 48 функций. В каждой:

* `slot = (pc & 0xfff) >> 1` — 2048 слотов по 2 байта;
* уровень 1: 32 блока, `br_table` по `slot >> 6` (64 слота в чанке);
* уровень 2: 64 блока, `br_table` по `slot & 63`;
* обработчики инструкций инлайнятся в тела блоков; отсутствующий слот уходит в
  `FAIL_UNTRANSLATED`.

Это ровно структура page-модуля; отличается только число страничных функций
(48 вместо 1) и наличие общего диспетчера.

### 3.2 `translated_step(c)`

1. `pc = c->pc`; `pc >= 0x1000000` → `FAIL_BAD_PC`; `pc & 1` → `FAIL_ODD_PC`;
2. `page = pc >> 12`;
3. `page < 0x100` → двухуровневый `br_table` 16×16 по группам страниц
   (`FAIL_UNTRANSLATED` для пустых);
4. `page >= 0xFF0` → `br_table` на 16 RAM-страниц (в Dune USA таких инструкций
   нет, слоты пустые);
5. иначе (страницы `0x100..0xFEF`) → `FAIL_UNMAPPED`;
6. найденная страничная функция вызывается как `page(c, pc)`.

### 3.3 `translated_z80_step(c) -> i32` — честный стаб

Z80-реэмиттер пока вне задачи. Полный модуль экспортирует стаб, который:

* вызывает `dune_fail(c, UNTRANSLATED, c->z80_cpu.pc)` (канонический код 1,
  адрес — PC Z80), т.е. **честно сообщает об отсутствии трансляции**;
* всегда возвращает 0 циклов.

Рантайм ставит его в слот `table[1]` при `GAME_MODE_SINGLE`. Важно:
`dune_rt_init()` устанавливает `audio_mode = AUDIO_STUB`, поэтому `z80_tick()`
выходит раньше, чем вызовет z80-шаг, — `dune_rt_machine_step()` при дефолтном
инициализированном рантайме стаб не дёргает и не фейлится. Смоук в
`link_and_run.mjs` доказывает поведение стаба прямым вызовом
`dune_rt_translated_z80_step`: `cycles=0`, `fault=1`, `fault_code=1`
(`UNTRANSLATED`), Z80 PC не изменился.

### 3.4 `warmup_all(c)` и funcref-таблица

* `warmup_all` вызывает все 48 страничных функций с `pc = 0xFFFFFFFE` — каждая
  сразу возвращается, но V8/Liftoff компилирует тела под загрузочным экраном
  (~92 мс на весь модуль);
* `__indirect_function_table` инициализируется `translated_step` в слоте 0, чтобы
  `translated_step_via_table` (game → собственная таблица) работал без JS;
* рантайм `appendFunctions(rt, [translated_step, translated_z80_step])` +
  `installGameTable(rt, [step, z80])` → `GAME_MODE_SINGLE(2)`,
  слоты `[741, 742]`, все 16 импортов — собственные exports `runtime.wasm`
  (проверяется по идентичности `===`).

---

## 4. Метрики артефакта

| Метрика | Значение |
|---|---|
| ROM | `b1bbe731…f335ba`, 1 048 576 B |
| `runtime.wasm` | `205ac655…189efe`, 894 968 B |
| ABI | 140 слов, hash `fb47e138…c802`, 32-bit, пинован манифестом |
| Инструкций | **40 382**, ошибок декодера 0 |
| Страниц | **48** (`0,1,2,4,…,73,199`) |
| RAM-вариантов | 0 (в USA-ревизии) |
| `game.wasm` | **3 142 822 B** = 3,0 MiB |
| handlers | 3 132 306 B; skeleton 10 516 B |
| Плотность | **77,6 B/инструкция** |
| SHA-256 | **`06ecc2226b5ba1bd1220097b752c680cad0430b278690672427dc806cac7ef93`** |
| Данные | 0 data-сегментов, 0 своих memory, 0 глобалов, 0 embedded ROM |
| Генерация | **529 мс** (decode ROM отдельно 3 444 мс; ABI 48 мс) |
| `meta.json` | 29 470 B (без 40k дизассемблера) |

Сборка детерминирована: два независимых прогона дают один и тот же SHA-256
(это же проверяет `test_cli_builds_the_same_artifact`).

---

## 5. Дифференциал: 7 680 случаев, 0 расхождений

`check_full_integration.py`:

1. читает ABI из `runtime.wasm` (`dune_abi_descriptor()`), сверяет hash с
   пинованным манифестом;
2. декодирует ROM один раз (тот же декодер/профиль, что `check_page.py`);
3. собирает полный `game.wasm` (`build_full_game_module`) и проверяет его
   структуру до записи на диск;
4. выбирает **детерминированно** до 10 равномерно разнесённых инструкций с
   каждой страницы: **480 инструкций × 48 страниц**, 40 различных op-семейств
   (`MOVE`, `BCC`, `JSR`, `RTS`, `LEA`, `MOVEM_*`, `ILLEGAL`, `LINK`, …);
5. генерирует по **16 начальных состояний** на инструкцию (seed `0xD00E5EED`):
   случайные D/A, SR в user/supervisor + trace, USP/SSP, `instruction_cycles`,
   `halted`, 64 KiB RAM из seed; A-регистры указывают в `0xE00000`, часть —
   нечётные (address error);
6. прогоняет **те же** состояния:
   * нативный C-оракул из внешнего `dune-base.c` (clang, кэш в `.local`);
   * связанные `runtime.wasm` + полный `game.wasm` через
     `link_and_run.mjs`: `dune_rt_translated_step(CPU)` → рантайм-диспетчер →
     `call_indirect` → `game.translated_step` → страничный `br_table`;
7. сравнивает побайтово: D0–D7, A0–A7, PC, USP, SSP, SR, `instruction_cycles`,
   `halted`, `fault`, `fault_address`, канонический `fault_code` и **оба
   64 KiB RAM-дайджеста**.

Результат:

```
cases 7680 (480 инструкций × 16 состояний)
mismatch_cases 0           mismatches []
oracle_faults 232 == wasm_faults 232
fault codes: {6:46, 7:103, 8:23, 9:30, 10:12, 11:2, 12:16}
coverage 48/48 страниц, по 10 инструкций с каждой
```

То есть проверены и успешные пути, и ошибки: privilege violation (6),
address error read/write (7/8), unmapped read/write (9/10), write-to-ROM (11),
illegal instruction (12). Коды мапятся канонически через дескриптор
(`FAIL_ILLEGAL` 12 → runtime `ILLEGAL_INSTRUCTION` 10).

Уменьшенный смоук (используется тестами): `--per-page 1 --cases 2
--min-instructions 48` → 96 случаев, 0 расхождений, ~8 с.

---

## 6. Тесты

```bash
# без ROM: 6 тестов, ROM-зависимые 2 класса skip
python3.12 -m unittest discover -s tests/wasm_full -v

# с ROM: 13/13 OK (~17 с)
DUNE_ROM="/path/to/Dune (USA).gen" \
DUNE_BASELINE="/path/to/vendor/rearrakis/build/dune-base.c" \
python3.12 -m unittest discover -s tests/wasm_full -v
```

Что доказывают:

* ROM-free: full-shaped модуль (synthetic code) — только код, без data/memory/
  globals, ровно 5 экспортов, принимается `verify_game_module`, линкуется в
  рантайм (`GAME_MODE_SINGLE`, z80-слот), стаб даёт канонический
  `UNTRANSLATED`; сборка без ROM отклоняется.
* С ROM: 48 страниц / 40 382 инструкции в одном модуле, размер 3–4,5 МБ,
  генерация < 10 с, SHA совпадает с meta, нет 16-байтных окон ROM внутри
  артефакта, линковка и `warmup_all`, CLI даёт тот же SHA, смоук-дифференциал
  по всем 48 страницам (96 случаев, 0 расхождений).
* Артефакты `.local/wasm-full/*` gitignored и не в индексе.

Регрессия соседних наборов после изменений: `tests/wasm_emitter` **17/17 OK**,
`tests/wasm_integration` **21/21 OK** (включая page-differential `$013`),
`python3 tools/check_no_game_data.py` → **OK**.

---

## 7. Ограничения (честно)

1. **Z80 не транслирован.** `translated_z80_step` — стаб с `UNTRANSLATED`.
   При дефолтном `AUDIO_STUB` он не вызывается; при включённом audio mode
   `machine_step` на первом z80-шаге уйдёт в fault. Звука нет по построению.
2. **Только 48 страниц с кодом.** Страницы без декодированных инструкций
   дают `FAIL_UNTRANSLATED`; `pc >= 0x1000000` → `FAIL_BAD_PC`, нечётный →
   `FAIL_ODD_PC`, ROM/RAM-дыры → `FAIL_UNMAPPED`. Это не «тихий» пропуск.
3. **RAM-варианты не проверены** — в Dune USA их 0; поддержка в эмиттере есть,
   но mutable absolute address по-прежнему не реализован.
4. **IO/VDP-состояние не нормализовано.** C-оракул стартует с `memset(0)`,
   рантайм — с `io_tx=ff/ff/fb`, `audio_mode=AUDIO_STUB`. На выбранной выборке
   (A-регистры в RAM, 0 расхождений) это не проявляется; для страниц, читающих
   serial/audio-регистры, понадобится хост-хук нормализации.
5. **Дифференциал выборочный, не исчерпывающий:** 480 инструкций × 16 состояний
   из 40 382. Полный прогон 40 382 × 16 ≈ 646k случаев — ~4 мин только рантайма
   (плюс ~7 мин C-оракул).
6. **Page-режим рантайма не используется.** Только `GAME_MODE_SINGLE`:
   сигнатура страничных функций `(CPU*, pc)`, а page-режим ждёт `(CPU*)`.
7. **Boot-экспорта нет и не нужно:** хост сам ставит CPU как C-база (RAM,
   `a7 = ROM[0..3]`, `pc = ROM[4..7] & 0xffffff`, `sr = 0x2700`, fault/halted=0)
   и крутит `dune_rt_machine_step()` / `dune_rt_translated_step()`.
8. **Save/load, RTC/EEPROM, VDP-кадры** живут в рантайме (готовы), но в этом
   дифференциале не участвуют.

---

## 8. Следующий шаг

1. **Z80**: перенести `z80.py` в WASM-эмиттер, заменить стаб настоящим
   `translated_z80_step`, дифференциал против C `translated_z80_step`;
   слот 1 уже подготовлен.
2. **Браузерный хост**: Pyodide собирает `game.wasm` (bytes) → тот же
   `appendFunctions` + `installGameTable`, ROM в `dune_rt_rom_buffer()`,
   `warmup_all`, затем `dune_rt_machine_step()` и
   `dune_web_frame_rgb` для реального кадра. Путь артефакта и контракт
   экспортов зафиксированы в §3.
3. **Нормализация состояния** (хост-хук «сбросить CPU как C-база») — чтобы
   дифференциал стал корректен и для страниц с IO/VDP/audio.
4. **Полный дифференциал** 40 382 × N без выборки (или page-режим рантайма с
   4096-слотовой таблицей) — как только появятся Z80 и нормализация.
