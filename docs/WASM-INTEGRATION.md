# Интеграция: `game.wasm` внутри `runtime.wasm` (Phase 3, шаг 2)

Статус: **связка работает, дифференциал через реальный рантайм — 0 расхождений**.
Компоненты этапа 3 (эмиттер, рантайм, C-оракул) собраны по отдельности; здесь они
соединены: `game.wasm` для реальной страницы ROM генерируется **под ABI, прочитанный
из `runtime.wasm`**, линкуется с ним, и тот же набор состояний, что в
[`WASM-EMITTER.md`](WASM-EMITTER.md), прогоняется через
`dune_rt_translated_step()` → таблицу funcref’ов → сгенерированные обработчики →
хелперы рантайма. Сравнение — с нативным C-оракулом из внешнего `dune-base.c`.

Дизайн модулей: [`WASM-BACKEND.md`](WASM-BACKEND.md); рантайм:
[`WASM-RUNTIME.md`](WASM-RUNTIME.md); эмиттер: [`WASM-EMITTER.md`](WASM-EMITTER.md).

---

## 1. TL;DR — что доказано

| Показатель | Значение |
|---|---|
| `game.wasm` страницы `$013`, ABI = `runtime.wasm` | **7 033 Б** (handlers 5 972 Б = **76,6 Б/инстр**), SHA `9c36d3fc…` |
| Импорты `game.wasm` | `env.memory` + 16 × `env.dune_*` (все — **те же объекты**, что экспортирует `runtime.wasm`, проверено `===`) |
| Связка | runtime 894 968 Б + game 7 033 Б; режим `GAME_MODE_SINGLE`, funcref-слот 741 в `__indirect_function_table` рантайма |
| Дифференциал **через связку** | **78 инструкций × 200 состояний = 15 600 случаев, 0 расхождений** |
| Fault-коды | 1 082/1 082, гистограмма совпала побайтово: privilege 787, address error read 112, write 171, unmapped read 12 |
| Время полного прогона | **16,6–16,9 с** (decode 3,3 с; C-оракул 8,0–8,2 с; runtime+game 4,9–5,1 с = **≈3,1 тыс. случаев/с**; генерация модуля 5 мс) |
| ABI страницы (wasm32, из дескриптора) | `SIZEOF_CPU=391 600`, `pc=64`, `sr=76`, `ram=78`, `fault=391 588`, `instr_cycles=391 576`, `ADDR_CPU=380 056`, `ADDR_ROM=19 205 400` |
| ABI-дескриптор рантайма | 140 слов, `abi_hash = fb47e138…1db5` (= pin из `runtime/wasm/manifest.json`), `dune_abi_selfcheck(1, pin) = 1` |
| Нативный ABI (для контраста) | 64-bit, hash `2e870f72…`, `SIZEOF_CPU=391 624`, `instr_cycles=391 592` — **другие числа**, эмиттер их больше не использует |
| Тесты | `tests/wasm_integration`: **21 тест с ROM, ~21–25 с**; без ROM — зелёный с явными skip для ROM-зависимых; `tests/wasm_emitter` 17/17 (с ROM); без регрессий `check_page.py` |
| `check_page.py` (native-path) после правок | **PASS**, 21 360 случаев, 0 расхождений, 21,4–21,9 с (числа не изменились) |
| Guard | `python3 tools/check_no_game_data.py` → OK; артефакты только в `.local/` |

Расхождений семантики C/WASM не найдено и здесь: тот же C-код хелперов, скомпилированный
emcc в wasm32, исполняет **тот же** сгенерированный код, что раньше гонялся на JS-стабах.
Это и есть проверяемое утверждение: эмиттер layout-agnostic, а ABI берётся из рантайма.

---

## 2. Одна команда

```sh
cd dune-web

python3 tools/wasm_integration/check_integration.py \
  --rom "/path/to/Dune - The Battle for Arrakis (USA).gen" \
  --baseline "/path/to/vendor/rearrakis/build/dune-base.c"
```

Ожидаемый хвост (M1 Pro, Python 3.12, Node 24.16, clang 21):

```
ABI source: runtime.wasm 205ac655ff189efe (894968 B), descriptor 140 words, hash fb47e1386ee5c802
ABI pinned: YES (matches manifest); dune_abi_selfcheck(pin)=1, hash recomputed=True, ROM buffer=0x1250d18
ABI layout: CPU size 391600, d=0 a=32 pc=64 sr=76 ram=78 fault=391588 instr_cycles=391576 (pointer 32-bit)
page $013: 78 instructions, all supported
game.wasm: 7033 B (handlers 5972 B = 76.6 B/instr), 17 imports, built in 5.0 ms
game.wasm: imports env.dune_read_mem, …, env.dune_fail, env.memory
link:     16 helper imports == runtime exports, memory identity True, mode SINGLE(2), table slot 741
runtime:  15600 cases in 4936 ms (3160 cases/s), faults 1082, codes {"6": 787, "7": 112, "8": 171, "9": 12}
machine:  dune_rt_machine_step() pc=$013002 a7=$e0f004 cycles=8 ok=True
oracle:   15600 cases in 7993 ms, faults 1082, codes {"6": 787, "7": 112, "8": 171, "9": 12}
mismatches: 0
PASS: page $013 differential through runtime.wasm+game.wasm is 15600 cases, 0 mismatches
```

Быстрый режим: `--cases 20` (1 560 случаев, ~5 с). Отдельно только сборка модуля:

```sh
python3 tools/wasm_integration/build_page_module.py \
  --rom "/path/to/Dune (USA).gen" --page 0x13
```

Артефакты — в `.local/wasm-integration/` (gitignored, вне репозитория):
`page_013.wasm`, `page_013.meta.json`, `page_013.cases.bin`, `page_013.oracle.bin`,
`page_013.runtime.bin`, `report.json`, C-оракул.

---

## 3. Файлы пакета

| Файл | Что делает |
|---|---|
| `tools/wasm_integration/runtime_abi_dump.mjs` | Node: `loadRuntime`/`initRuntime` из `runtime/wasm/loader.mjs`, читает `dune_abi_descriptor()`, пересчитывает SHA-256 по структурным словам (`verifyAbiHash`), вызывает `dune_abi_selfcheck(version, pinned_hash)` с хешем из манифеста, печатает дескриптор JSON’ом. Умеет `--tamper NAME=VALUE`/`--rehash` для тестов. |
| `tools/wasm_integration/runtime_abi.py` | Python: запускает дамп, **независимо** пересчитывает `abi_hash`, сверяет поля с `runtime/wasm/manifest.json#abi.actual`, SHA/размер `runtime.wasm`/`loader.mjs`, адресные тождества (`ADDR_RAM == ADDR_CPU+OFF_RAM`, ROM-буфер до/после `dune_rt_init`, таблица, capacity). Строит `abi.CpuAbi`/`abi.MemoryLayout` (wasm32, абсолютные адреса) и карту fail-кодов. |
| `tools/wasm_integration/wasm_inspect.py` | stdlib-парсер структуры wasm: секции, импорты/экспорты, наличие своей memory/data/globals. Не доверяет энкодеру. |
| `tools/wasm_integration/build_page_module.py` | Генерирует `game.wasm` страницы под ABI рантайма (`env.dune_*`, `dune_`-префикс, fail-коды из дескриптора), проверяет структуру модуля и пишет `.wasm`+`.meta.json`. |
| `tools/wasm_integration/link_and_run.mjs` | Инстанцирует `runtime.wasm` (64 МиБ / 512 МиБ, `loader.mjs`), проверяет 140 слов дескриптора против meta, копирует ROM в `dune_rt_rom_buffer()`, инстанцирует `game.wasm` с импортами = **экспортами рантайма**, добавляет `translated_step` в funcref-таблицу (`installGameTable`, `GAME_MODE_SINGLE`), вызывает `warmup_all`, гоняет кейсы через `dune_rt_translated_step()` и пишет те же `DWO1`-записи, что C-оракул. Плюс `dune_rt_machine_step()` smoke. |
| `tools/wasm_integration/check_integration.py` | Одна команда: decode → ABI рантайма → модуль → C-оракул → связка → `compare.py` → PASS/метрики/report.json. |
| `tools/wasm_integration/python_support.py` | Пути, re-exec на Python 3.10+ (вендорный decode). |
| `tests/wasm_integration/` | 4 файла тестов: ABI-источник/подмена дескриптора, линковка без ROM, «нет игровых данных», полный дифференциал одной страницы. |
| `docs/WASM-INTEGRATION.md` | этот документ. |

---

## 4. Как ABI-дескриптор рантайма стал единственным источником

`abi.CpuAbi` теперь строится не из нативного `offsetof`, а из слов
`dune_abi_descriptor()` (140 `u32`) после `dune_rt_init()`:

```
OFF_PC=64, OFF_USP=68, OFF_SSP=72, OFF_SR=76, OFF_RAM=78,
OFF_INSTRUCTION_CYCLES=391576, OFF_Z80_DIVIDER=391580,
OFF_HALTED=391584, OFF_FAULT=391588, OFF_FAULT_ADDRESS=391592, OFF_REASON=391596,
OFF_STEPS=391536, OFF_CYCLES=391544, OFF_MASTER_CYCLES=391552, OFF_INTERRUPTS=391560,
OFF_ROM=391524, OFF_ROM_SIZE=391528, SIZEOF_CPU=391600,
OFF_VDP=65640, OFF_Z80_BUS=361880, OFF_Z80_CPU=370088,
ADDR_CPU=380056, ADDR_RAM=380134, ADDR_ROM=19205400, ADDR_GAME_TABLE=789856,
ADDR_SAVE_BUFFER=117904, ROM_CAPACITY=1048576
```

Тонкости, которые пришлось явно обработать (иначе модуль молча получил бы неверные
смещения):

1. **wasm32 vs native.** В `runtime.wasm` указатели/`size_t` — 4 байта, поэтому поля
   после `rom`/`rom_size`/`reason` сдвинуты: `SIZEOF_CPU` 391 600 против 391 624,
   `instruction_cycles` 391 576 против 391 592. `pointer_bits` выводится из
   `OFF_ROM_SIZE - OFF_ROM == 4` (native probe — 8).
2. **Семантика VDP/Z80-слов.** `OFF_VDP_*`/`OFF_Z80_*` в манифесте — **абсолютные**
   смещения от `CPU` (документировано в `WASM-RUNTIME.md` §3), а нативный `--abi`
   отдаёт смещения от вложенной структуры. `runtime_abi._relative_offsets()` определяет
   стиль по базе и переводит в вид, который ожидает `abi.CpuAbi`.
3. **Производные размеры.** `SIZEOF_VDP`/`SIZEOF_Z80BUS` в дескрипторе не хранятся:
   `vdp_size = OFF_Z80_BUS - OFF_VDP = 296 240`, `z80bus_size = OFF_Z80_CPU - OFF_Z80_BUS = 8 208`.
4. **Fail-коды.** Канонические коды C-оракула (`abi.py`: `ADDRESS_ERROR_READ=7`,
   `ADDRESS_ERROR_WRITE=8`, `ILLEGAL=12`, `LINE_A=13`, `LINE_F=14`, …) и коды wasm-рантайма
   (`UNTRANSLATED=1 … ADDRESS_ERROR=7, ILLEGAL_INSTRUCTION=10, DIVISION_BY_ZERO=11,
   Z80_PERIPHERAL=14`) — разные. Карта строится **по именам** из дескриптора:
   `{1,2,3,4,5,6}→{1,2,3,4,5,6}`, `ILLEGAL 12→ILLEGAL_INSTRUCTION 10`,
   `LINE_A/LINE_F 13/14→10` (lossy: у рантайма один код на illegal; сборка страницы с
   такими инструкциями по умолчанию **отказывается** собираться, см. §7).
5. **Адреса.** `MemoryLayout` заполняется из `ADDR_CPU/ADDR_RAM/ADDR_ROM/ADDR_VDP_*/
   ADDR_SAVE_BUFFER` и проверяется на тождества; тестовые адреса `check_page.py`
   (CPU @0x10000, ROM @0x80000) больше не используются.
6. **Хеш = пин.** `load_runtime_abi()` сверяет пересчитанный SHA-256 структурных слов с
   `runtime/wasm/manifest.json#abi.abi_hash`, а `runtime_abi_dump.mjs` дополнительно
   передаёт пин-хеш в `dune_abi_selfcheck(version, pinned_hash)` (с `malloc`-буфером),
   проверяет `dune_abi_hash()`/`dune_abi_word_count()` и что ROM-буфер до `dune_rt_init()`
   нулевой, а после — `ADDR_ROM`. Любое изменение дескриптора (даже с пересчитанным
   хешем, даже адресного слова) отклоняется до чтения ROM:
   `RuntimeAbiError: runtime ABI descriptor rejected …`.

Проверки, которые падают при подмене (тесты `test_tampered_descriptor_is_rejected`,
`test_build_refuses_descriptor_with_wrong_pinned_hash`, `test_link`):

| Подмена | Где ломается |
|---|---|
| `OFF_PC=68` без пересчёта хеша | `verifyAbiHash` в Node → dump `ok=false`; Python отклоняет |
| `OFF_PC=68` + `--rehash` | пересчитанный хеш ≠ pin манифеста → Python отклоняет |
| `ADDR_ROM=1234` + `--rehash` | адрес ≠ `dune_rt_rom_buffer()` → Python отклоняет |
| `UNTRANSLATED=99` + `--rehash` | хеш ≠ pin → отклоняет |
| правка `meta.json` (`runtime_abi.fields`) | `link_and_run.mjs` сравнивает 140 слов дескриптора с meta → отказ |
| `meta.module.sha256` ≠ файл | `link_and_run.mjs` → отказ |
| `abi_hash` в `RuntimeAbi` ≠ pin | `build_page_module.py` → `BuildError` (до ROM) |

---

## 5. Правки эмиттера (минимальные, обратно совместимые)

Эмиттер остался layout-agnostic; добавлены только две «точки подключения»:

1. `translate.Translator(fail_code_map=…)` — `fail(code)` теперь может отобразить
   канонический код в код рантайма и запоминает использованные коды
   (`fail_codes_used`). По умолчанию карта пуста → код не меняется.
2. `game_module.ModuleBuilder(..., helper_prefix="", fail_code_map=None)` и
   `build_module`/`build_page_module(..., helper_prefix=…, fail_code_map=…)` —
   префикс имени импорта (`""` → `env.read_mem` как раньше; `"dune_"` →
   `env.dune_read_mem`) и карта fail-кодов. `game_module.fail()`/`fail_with_pc()`
   тоже проходят через карту (иначе коды диспетчера 1–5 не были бы из дескриптора).
   В `meta["build"]` добавлены `helper_prefix`, `fail_code_map`, `fail_codes_used`.

Значения по умолчанию воспроизводят прежний native-target модуль **байт-в-байт**:
`check_page.py` после правок по-прежнему PASS с теми же числами (страница 6 953 Б,
21 360 случаев, 0 расхождений, 21,4 с). `runtime/dune-runtime-v2.c`, `runtime/wasm/*`,
`vendor/`, `web/`, CI не менялись.

---

## 6. Что именно проверяет связка

1. **Одна память.** `env.memory` `game.wasm` — это тот же объект `WebAssembly.Memory`
   (64 МиБ initial / 512 МиБ max из `loader.mjs`), что владеет `runtime.wasm`;
   проверяется `env.memory === rt.memory`.
2. **Импорты = экспорты.** Все 16 функций — `rt.exports.dune_*` (сравнение `===`, не
   JS-обёртки). JS на пути инструкции отсутствует. `runtime_abi.verify_game_module()`
   дополнительно доказывает структурно: ровно `env.memory` + 16 `env.dune_*`, нет своей
   memory/data/globals, экспорты — ровно четыре документированных символа.
3. **call_indirect.** `appendFunctions(rt, [game.translated_step])` →
   `dune_rt_set_game_table(ptr, 2)` → `GAME_MODE_SINGLE`; рантайм вызывает
   `g_page_slots[0]` через `call_indirect` своей таблицы. Проверено: mode = 2,
   `table[0] == slot`, `game.__indirect_function_table[0] == translated_step`,
   `warmup_all` выполняется внутри рантайма (0,2 мс), а внутренний
   `translated_step_via_table()` (call_indirect через собственную таблицу игры)
   исполняет `$013000` → `pc=$013002`, `a7=$e0f004`, без fault.
4. **ROM в буфере рантайма.** `loadRom()` → `dune_rt_rom_buffer()`, обратное чтение
   побайтово совпадает; `ADDR_ROM` из дескриптора = `dune_rt_rom_buffer()`.
5. **Диспетчеризация.** Каждый кейс: состояние пишется в `CPU` по смещениям дескриптора
   + RAM 64 КиБ, вызов `dune_rt_translated_step(ADDR_CPU)` → рантайм проверяет PC →
   `call_indirect` → `game.translated_step` → `br_table` страницы → обработчик →
   хелперы `dune_*` рантайма. Результат сравнивается с C-оракулом побайтово.
6. **`machine_step`.** Дополнительно один `dune_rt_machine_step()` (после
   дифференциала, чтобы не влиять на состояния): страница `$013` начинается с
   `ADDQ.L #4, A7`; получено `pc=$013002`, `a7=$e0f004`, `cycles=8`, `fault=0`.
7. **Fault-коды.** На хосте причины fault’ов классифицируются по строке `c->reason`:
   для fault’ов внутри C-хелперов — по префиксам C (`"address error on read"` → 7,
   `"write to ROM"` → 11, …), для явных `dune_fail(code)` — по имени кода рантайма и
   обратной карте из дескриптора. Поэтому коды сравнимы с C-оракулом, хотя численно
   ABI-коды рантайма другие.

Сравниваются: D0–D7, A0–A7, PC, USP/SSP, SR (включая флаги), `instruction_cycles`,
`halted`, `fault`, `fault_address`, код причины, два 32-битных дайджеста RAM
(initial/final) — 64 бита. Формат записей — общий с `check_page.py`
(`oracle/format.py`, `compare.py`), сравнение — байтовое.

---

## 7. Тесты

```sh
# без внешних ROM/baseline (ABI, линковка, «нет игровых данных»):
python3 -m unittest discover -s tests/wasm_integration -v
# → зелёный; ROM-зависимые тесты skip с сообщением (нужны DUNE_ROM/DUNE_BASELINE)

# полный дифференциал через связку (200 состояний на инструкцию):
DUNE_ROM="/…/Dune ….gen" DUNE_BASELINE="/…/dune-base.c" \
  python3.12 -m unittest discover -s tests/wasm_integration -v
# → 21 тест OK, ~21–25 с

# быстрый режим (20 состояний):
DUNE_WASM_FAST=1 DUNE_ROM=… DUNE_BASELINE=… \
  python3.12 -m unittest discover -s tests/wasm_integration -v
```

| Тест | Что доказывает | ROM |
|---|---|---|
| `test_runtime_abi.py` (8) | дескриптор = манифест; wasm32-производные смещения/адреса; fail-карта по именам; подмена дескриптора ломает сборку; смещения реально попадают в код; модуль без data/memory/globals | нет |
| `test_link.py` (3) | `game.wasm` линкуется в рантайм: импорты = экспорты (`===`), общая память, mode SINGLE, funcref, `warmup_all`; подмена meta-дескриптора/хеша модуля отклоняется | нет |
| `test_no_game_data.py` (5 + 3 с ROM) | guard-script OK; в git нет `.gen`/ROM-размерных файлов/`.local`; в модуле нет data-секций; артефакт не содержит 16-байтных окон ROM; артефакты gitignored | частично |
| `test_page_differential.py` (1) | полный e2e: 78×N случаев через runtime+game, 0 расхождений, fault-гистограммы, ABI source = runtime.wasm | да |

Регрессия эмиттера: `DUNE_ROM=… DUNE_BASELINE=… python3.12 -m unittest discover
-s tests/wasm_emitter -v` → **17/17 OK (~5 с)**, включая smoke `check_page.py`.

---

## 8. Ограничения (честно)

1. **Одна страница.** Дифференцирован `$013` (78 инструкций) — так же, как в
   `check_page.py`. Остальные 40 382 инструкции/48 страниц ещё не прогонялись; команда
   уже принимает `--page`, но цена — decode (~3,3 с) + оракул + рантайм на страницу.
2. **Только `GAME_MODE_SINGLE`.** Рантайм умеет и page-режим (`pc>>12` → слот), но
   сгенерированные page-функции имеют сигнатуру `(CPU*, pc)`, а page-режим рантайма
   вызывает `void (*)(CPU*)`. Нужны тонкие экспортируемые шимы `(c) -> page(c, c->pc)`
   (или переход на 4096-слотовую таблицу с сигнатурой `(i32)->()`); сейчас используется
   single-диспетчер (`translated_step` игры делает свой `br_table`) — это ровно
   дизайн `WASM-BACKEND.md §5.1`.
3. **Z80 не подключён.** `translated_z80_step` в `game.wasm` нет; слот z80 = 0
   (`FAIL_UNTRANSLATED`), как и в Phase 1. 21 Z80-хелпер рантайма готов, но эмиттера
   Z80 пока нет.
4. **VDP/IO/IPL — стабы.** Страница `$013` не обращается к устройствам; если инструкция
   тронет IO/VDP/Z80/EEPROM, C-хелперы рантайма уйдут в настоящие ветки (в отличие от
   JS-стабов `check_page.py`, которые на таких адресах падали). Это расширяет покрытие,
   но дифференциал страницы этого не проверяет.
5. **Состояние рантайма ≠ `memset`-база C-оракула.** `dune_rt_init()` ставит
   `sr=0x2700`, `io_tx=0xff/0xff/0xfb`, `audio_mode=AUDIO_STUB`; нативный оракул
   обнуляет `CPU` и ставит `sr=0x2700`. Дифференциал перезаписывает те же поля, что и
   оракул (D/A/PC/USP/SSP/SR/cycles/halted/fault/RAM), а страница `$013` не читает
   io/audio/VDP — поэтому 0 расхождений; для страниц с IO/VDP это надо будет
   нормализовать (например, обнулять `CPU` через новый хост-хук).
6. **`LINE_A`/`LINE_F` lossy.** У рантайма один `ILLEGAL_INSTRUCTION`; такие
   инструкции в странице по умолчанию запрещены (`--allow-lossy-fail-codes` — только
   для отладки, дифференциал по этим кейсам будет расходиться). В Dune USA реальных
   `LINE_A/LINE_F/ILLEGAL` в выборке нет.
7. **RAM-варианты** не проверены (в Dune USA их 0); guard-код использует абсолютный
   `ADDR_RAM` из дескриптора и готов, mutable absolute address по-прежнему не
   реализован.
8. **Тайминг.** Сравнивается `instruction_cycles`, а не VDP/шина/Z80; `machine_step`
   проверен только smoke’ом (pc/a7/cycles/fault), не дифференциалом тайминга.
9. **Память/производительность.** 64 МиБ/512 МиБ, `ALLOW_MEMORY_GROWTH`; рост памяти во
   время инструкций не моделируется (в наших прогонах его нет). Скорость: 3,2 тыс.
   случаев/с на M1 Pro — для 0,8 млн кейсов всех страниц это ~4 мин только рантайма
   (плюс C-оракул ~7 мин).

---

## 9. Следующий шаг

1. **Все 48 страниц 68000**: прогонять `check_integration.py --page N` (или
   батч-режим со списком страниц), после `--cases 20` для всех и `--cases 200` для
   рисковых. Оценка размера: 76,6 Б/инстр → **3,1–6,0 МБ** `game.wasm`, генерация
   ~2,5–3 с на M1; время дифференциала 40 382 × 20 ≈ 0,8 млн кейсов — **~10–15 мин**
   оракул+рантайм.
2. **Page-режим рантайма** (или документировать single как единственный): экспортировать
   шимы `(c) -> page(c, c->pc)` и устанавливать 256/4096-слотовую таблицу; проверить
   `dune_rt_game_mode()==GAME_MODE_PAGES` на реальном модуле.
3. **Z80**: перенести `z80.py` в WASM, экспорт `translated_z80_step`, дифференциал
   против C `translated_z80_step`; слот 1 в `installGameTable`.
4. **Браузерный воркер**: Pyodide генерирует `game.wasm` (bytes) → `appendFunctions` +
   `installGameTable` в том же `runtime.wasm`; кэш OPFS по
   `sha256(rom | runtime abi_hash | generator_version)`; проверить `call_indirect` и
   `warmup_all` в реальном браузере (не только Node).
5. **Нормализация состояния**: добавить хост-хук «сбросить CPU как C-база»
   (или `memset`-совместимый init), чтобы дифференциал страниц с IO/VDP сравнивал
   кумулятивное состояние, а не только поля, которые перезаписывает harness.

---

## 10. Данные и лицензии

ROM и `dune-base.c` — внешние входы пользователя; они не копируются и не коммитятся.
`game.wasm`, `.meta.json` (содержит байты/дизассемблер инструкций страницы), кейсы,
результаты и `report.json` лежат **только** в `.local/wasm-integration/` (gitignored).
В репозитории — только наш MIT-код (`tools/wasm_integration/`,
`tests/wasm_integration/`, этот документ, плюс две небольшие правки в
`tools/wasm_emitter/`). `python3 tools/check_no_game_data.py` проходит.
