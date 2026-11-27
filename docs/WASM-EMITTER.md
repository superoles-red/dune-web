# WASM-эмиттер: первая рабочая страница (Phase 3)

Статус: **минимально жизнеспособный шаг Phase 2 дизайна** ([WASM-BACKEND.md](WASM-BACKEND.md) §15):
из реального ROM генерируется валидный `game.wasm` **одной 4 КиБ страницы**, и его
поведение побайтно совпадает с C-оракулом `dune-base.c` на детерминированных состояниях.
`runtime.wasm`, Z80 и полный модуль 40 382 обработчиков — следующие шаги (см. §10).

PoC-кодировщик из `prototype/wasm/` **не является зависимостью**: его идеи и низкоуровневый
энкодер перенесены в `tools/wasm_emitter/encoder.py` и развиты (секция `element`,
`i32.rem_u/div_u`, стабильные сигнатуры импортов). Продакшн-пакет — только stdlib Python.

---

## 1. TL;DR — что получено

| Показатель | Значение |
|---|---|
| Дифференциал реальной страницы `$013` (4 КиБ, 0x013000–0x013FFF) | **78 инструкций × 200 состояний = 15 600 случаев, 0 расхождений** |
| Покрытие обязательных операций на реальных инструкциях ROM | **240 инструкций из 21 страницы × 24 состояния = 5 760 случаев, 0 расхождений**, 35/35 op-семейств; все размеры и режимы MOVE/MOVEA |
| Всего сверенных случаев | **21 360**, побайтово: D0–D7, A0–A7, PC, USP/SSP, SR (включая флаги), `instruction_cycles`, `halted`, `fault`, `fault_address`, код причины fail, два 64-битных дайджеста RAM (initial/final) |
| Размер `game.wasm` страницы `$013` | **6 953 Б** (обработчики 5 972 Б = **76,6 Б/инструкция**, диспетчер/ABI/таблица 981 Б) |
| Генерация страницы (Python 3.12, M1 Pro) | **4,5–4,8 мс** |
| Покрывающий модуль (240 инструкций, 21 страница) | 40 959 Б, обработчики 35 896 Б = 149,6 Б/инструкция |
| C-оракул: 15 600 страничных случаев | 8,0–8,2 с (полный цикл, включая RAM-дайджесты); WASM/Node — 4,8–5,0 с |
| Полный `check_page.py` | **≈21–26 с** на M1 Pro (включая decode 40 382 инструкций за 3,4 с) |
| ABI hash (native C oracle, 64-bit pointers) | `2e870f72c64d96cf…` |
| Guard | `python3 tools/check_no_game_data.py` → OK |

Расхождений семантики на выбранных операциях **не найдено**. Единственные найденные
ошибки были ошибками эмиттера (стек WASM/локальные), а не различием C/WASM-семантики:
неверное имя локальной переменной адреса, потерянный `push_c` перед `i32.store` PC,
двойной `c` в `DBCC`/`CCR_*`, порядок операндов `MOVEM`. Все они пойманы дифференциалом и
исправлены; C-эталон не менялся.

---

## 2. Файлы пакета

| Файл | Что делает |
|---|---|
| `tools/wasm_emitter/encoder.py` | минимальный кодировщик WASM MVP: LEB128, секции type/import/function/table/memory/export/element/code, `i32`/`i64` load/store, арифметика, `block`/`loop`/`if`/`br`/`br_if`/`br_table`/`call`/`call_indirect`, `return`, `local.*`. stdlib, Python 3.9+. |
| `tools/wasm_emitter/abi.py` | ABI-дескриптор: смещения `CPU`/`Z80CPU`/`VDP`, абсолютные адреса RAM/ROM/Z80 RAM/фрейма, флаги SR, коды `fail`, 16 сигнатур хелперов, `abi_hash`, статические проверки контракта `runtime/manifest.json` + `docs/RUNTIME.md`, `MemoryLayout` для тестовой линейной памяти. |
| `tools/wasm_emitter/translate.py` | `Instruction`/`EA` → тело WASM-обработчика. Семантика — прямой порт `genesis_recompiler/emit.py` и `runtime.h`: размеры, маски, post-increment, `address/prepare/read/write/post`, `sign_extend`, `movem`, флаги, ранние `return` после fault-способных хелперов, ручной CSE `condition` для `BCC/DBCC/SCC`. |
| `tools/wasm_emitter/game_module.py` | сборка модуля: 16 импортов хелперов + память, функции страниц с двухуровневым `br_table` (32×64 слота), `translated_step` (16×16 ROM-диспетчер + RAM 0xFF0–0xFFF), `warmup_all`, экспорт таблицы и `translated_step_via_table`; метрики размера. |
| `tools/wasm_emitter/coverage.py` | выбор 240 реальных инструкций из ROM по группам `(op, size, EA источника, EA назначения)`; отбрасывает кандидатов с абсолютными адресами в IO/VDP/Z80/EEPROM. |
| `tools/wasm_emitter/check_page.py` | одна команда: ROM + baseline → decode → C-оракул → `game.wasm` → дифференциал страницы и покрытия → отчёт. |
| `tools/wasm_emitter/oracle/dune_oracle_main.c` | C-драйвер: включается после `dune-base.c` (с `GENESIS_NO_MAIN`), печатает измеренный ABI, считает RAM-дайджесты и гоняет кейсы через настоящий `translated_step`. |
| `tools/wasm_emitter/oracle/build.py` | сборка/кэширование C-оракула через `/usr/bin/clang`; генерация `fail_map.inc` из `abi.py`. |
| `tools/wasm_emitter/oracle/format.py` | единый бинарный формат кейсов/результатов + Python-реализация xorshift32 RAM fill и дайджестов. |
| `tools/wasm_emitter/oracle/cases.py` | детерминированные начальные состояния. |
| `tools/wasm_emitter/oracle/run_wasm.mjs` | Node 24, без npm: инстанцирует `game.wasm` с `WebAssembly.Memory`, JS-стабами 16 хелперов (порт `runtime.h`), гоняет кейсы, пишет те же result-записи. |
| `tools/wasm_emitter/oracle/compare.py` | побайтовое сравнение result-файлов C и WASM с разбором первых расхождений. |
| `tests/wasm_emitter/` | unit/дифференциальные тесты; без ROM тесты структуры/ABI/энкодера проходят, ROM-дифференциал skip’ается с сообщением. |
| `docs/WASM-EMITTER.md` | этот документ. |

---

## 3. ABI-дескриптор

### 3.1. Что отдаёт дескриптор

`abi.CpuAbi` — единственный источник чисел для генератора. Поля:

* `d`, `a`, `pc`, `usp`, `ssp`, `sr`, `ram`, `steps`, `cycles`, `master_cycles`,
  `instruction_cycles`, `z80_divider`, `halted`, `fault`, `fault_address`;
* `z80_cpu`, `z80_bus`, `vdp`, `rom`, `rom_size` и `VDP`-смещения
  (`registers/vram/cram/vsram/frame/frame_width/frame_height`);
* `sizeof(CPU/Z80CPU/VDP/Z80Bus)`, `pointer_bits`;
* флаги `F_C=1, F_V=2, F_Z=4, F_N=8, F_X=16`, `SR_SUPERVISOR=0x2000`, маска SR `0xA71F`;
* 17 кодов `fail` (untranslated/bad_pc/odd_pc/unmapped/ram_variant/privilege/
  address_error_read/write/unmapped_read/write/write_rom/illegal/line_a/line_f/
  divide_by_zero/device/z80);
* 16 сигнатур импортов (`read_mem`, `write_mem`, `push32`, `pop32`, `movem`, `set_sr`,
  `logic_flags`, `arithmetic`, `extended_arithmetic`, `bcd_arithmetic`, `bcd_negate`,
  `shift_value`, `divide_value`, `condition`, `index_value`, `fail`);
* контракт `DSAV v2` (magic/version/размеры/смещения) из `runtime/manifest.json`.

`abi_hash = sha256(canonical JSON)` — ключ кэша `game.wasm` в браузере
(`sha256(rom | abi_hash | generator_version)`).

### 3.2. Откуда числа сейчас

`runtime.wasm` ещё не собран, поэтому `check_page.py` строит **нативный C-оракул** из
`dune-base.c` (`clang -std=c11 -O0`) и читает раскладку самим компилятором:
`offsetof(CPU, …)`, `sizeof(CPU)`, `offsetof(VDP, frame)` и т.д. (`oracle --abi`).
На M1 Pro получено:

```
sizeof(CPU)=391 624, d=0 a=32 pc=64 usp=68 ssp=72 sr=76 ram=78
instruction_cycles=391 592, halted=391 600, fault=391 604, fault_address=391 608
VDP: vram=24, cram=65 560, vsram=65 688, frame=65 824, frame=+230 400 Б
```

Это **64-bit pointer layout native-оракула** (`pointer_bits=64`). В будущем wasm32
`runtime.wasm` отдаст свой дескриптор (`dune_abi_descriptor()`), в котором поля после
указателей (`rom`, `steps`, `cycles`, `instruction_cycles`, `halted`, `fault`) сдвинуты:
эмиттер layout-agnostic, он подставляет числа из переданного дескриптора. Поэтому
`REFERENCE_NATIVE_ABI` — эталон для дифференциала, а не «навсегда зашитый layout».

### 3.3. Статические проверки (без ROM)

`abi.check_runtime_contract(ROOT, REFERENCE_NATIVE_ABI)` проверяет:

1. `runtime/dune-runtime-v2.c` совпадает по SHA-256/размеру с `runtime/manifest.json`;
2. `runtime_version == 2`, есть `#define DUNE_SAVESTATE_VERSION 2` и объявление
   `static void translated_step(CPU *c);`;
3. `manifest.savestate` совпадает с контрактом `DSAV v2` (140 056 Б, `ram_offset=94`,
   `house_offset=49 874`, `mission_offset=49 326`, max 262 144);
4. `docs/RUNTIME.md` всё ещё документирует `sizeof(DuneSaveState) == 140 056` и
   `offsetof(ram) == 94`;
5. нормализованный `typedef struct { … } CPU;` в runtime v2 **побайтово равен**
   `vendor/rearrakis/genesis_recompiler/runtime.h` (значит поля/порядок/типы не разъехались).

`abi.validate_cpu_abi` проверяет внутренние соотношения (`a=d+32`, `pc=a+32`,
`ram+64K ≤ sizeof CPU`, `vram`/`cram`/`vsram`/`frame`, границы Z80CPU/VDP, уникальность
кодов fail). `abi.check_probe` сверяет дескриптор с фактическим `--abi` C-компилятора;
`check_page.py` печатает `matches the pinned native reference ABI` и использует
измеренный probe.

---

## 4. Что реализовано в трансляции

`translate.py` реализует **все семейства C-эмиттера** для 68000 (не только обязательный
минимум):

* `MOVE`/`MOVEA` (B/W/L, режимы 0–7 включая immediate, PC-relative, indexed, pre/post
  increment, absolute short/long), `MOVEQ`;
* `CLR`, `TST`, `ADDQ`, `SUBQ`, `ADD`, `SUB`, `CMP`, `CMPI`, `ADDI`, `SUBI`, `ADDA`,
  `SUBA`, `CMPA`, `ORI`, `ANDI`, `EORI`, `OR`, `AND`, `EOR`, `NOT`, `NEG`, `NEGX`,
  `ADDX`, `SUBX`, `ABCD`, `SBCD`, `NBCD`;
* `BRA/BCC` (все 16 условий), `BSR`, `DBCC`, `SCC`, `JMP`, `JSR`, `RTS`, `RTE`, `RTR`,
  `LEA`, `PEA`, `LINK`, `UNLK`;
* `EXT`, `SWAP`, `EXG`, `MULU/MULS`, `DIVU/DIVS`;
* сдвиги `ASL/ASR/LSL/LSR/ROL/ROR/ROXL/RORX` — регистр (immediate/`Dn`) и память;
* `BTST/BCHG/BCLR/BSET`, `MOVEM_LOAD/MOVEM_STORE` (B/W/L, все EA), `TO_SR/TO_CCR/
  SR_OR/SR_AND/SR_EOR/CCR_*`, `FROM_SR`, `TO_USP/FROM_USP`, `TRAP`, `STOP`, `ILLEGAL`,
  `LINE_A/LINE_F`, `NOP`.

Семантические правила повторяют C:

1. `instruction_cycles` пишется **до** первого хелпера (в т.ч. при fault);
2. `pc` пишется ровно один раз в конце/на переходе; все переходы делают `return`
   (никакого fallthrough между обработчиками);
3. после `read_mem`/`write_mem`/`push32`/`pop32`/`movem`/`divide_value` — проверка
   `fault` и ранний `return`;
4. `condition` вычисляется один раз на инструкцию и переиспользуется в циклах и ветке;
5. `sign_extend`/`mask_for` инлайнятся, `index_value` — импорт;
6. `CLR` (как на 68000) сначала читает приёмник; `TST/CMP/CMPI/BTST` не пишут результат;
7. RAM-варианты: guard по байтам образа (`i32.load8_u` + немедленные константы) и
   `fail(FAIL_RAM_VARIANT)`, как `memcmp` в C. Вариантов с self-modifying absolute
   address в Dune USA не найдено (0 RAM variants), mutable-путь пока отклоняется явно.

Обязательные операции из задачи покрыты и дифференциально проверены модулем coverage
(35/35 op-семейств, см. §6.3).

---

## 5. Модуль и диспетчеризация

```
game.wasm
  import env.memory            (общая память рантайма, создаёт JS/runtime)
  import env.{16 хелперов}     (read_mem … fail)
  func page_013(c, pc)         prologue pc==0xFFFFFFFE → return (warmup)
                               slot=(pc&0xfff)>>1; 2 уровня br_table 32×64;
                               тело каждого обработчика инлайнится и завершается return;
                               отсутствующие слоты → fail(FAIL_UNTRANSLATED)
  func translated_step(c)      pc=c->pc; проверки >=0x1000000/odd;
                               16×16 br_table по page>>4 / page&15 для ROM 0x00–0xFF;
                               16-входовый br_table для RAM 0xFF0–0xFFF;
                               отсутствующая страница → fail
  func translated_step_via_table(c)  call_indirect(тип (i32)->(), table[0])
  func warmup_all(c)           каждый page(c, 0xFFFFFFFE)
  table __indirect_function_table[0] = translated_step (elem-секция)
  export translated_step, translated_step_via_table, warmup_all, таблица
```

Свойства, важные для дизайна:

* **нет data-сегментов и своей memory** — ROM и RAM живут в памяти рантайма; в модуле
  только код (и 1–2 байта образов RAM-вариантов, если они есть);
* **нет глобальных переменных** — состояние только в `CPU` по смещениям ABI;
* размер функции страницы `$013` — 6 953 Б; максимальная реальная страница Dune (`$1a`,
  1 344 инструкции) по этой цене будет ~100–140 КБ, что далеко от лимитов V8 (в PoC
  проверена страница 920 КБ);
* `translated_step` не делает fetch/decode: только сравнения и `br_table`.

Тестовая линейная память (`check_page.py`): CPU @0x10000 (391 624 Б), RAM @0x1004E
(offset 78), ROM @0x80000 (1 МиБ), всего 24 страницы по 64 КиБ. Эти адреса — тестовые;
в проде их даст дескриптор `runtime.wasm`.

---

## 6. Дифференциальная проверка против C

### 6.1. C-оракул

`oracle/build.py` генерирует wrapper:

```c
#define GENESIS_NO_MAIN
#include "/path/to/dune-base.c"
#include "/…/dune_oracle_main.c"
```

и компилирует `/usr/bin/clang -std=c11 -O0` (≈1–4 с, кэшируется по SHA-256 baseline).
Оракул имеет три режима:

* `--abi` — печатает `sizeof`/`offsetof` (см. §3.2);
* `--ram-digest SEED` — печатает два 32-битных хэша детерминированного 64 КиБ RAM;
* `--run CASES OUT` — читает бинарные кейсы, для каждого делает `CPU c = base;`,
  заполняет RAM из seed, ставит регистры/PC/SR/циклы, вызывает настоящий
  `translated_step(&c)` (тот же код, что в собранном C-ядре), считает RAM-дайджесты и
  причину `fault` (строка `c->reason` → числовой код через сгенерированный
  `fail_map.inc`).

### 6.2. Начальные состояния

Для каждой инструкции — N независимых состояний:

* случайные D0–D7, A0–A7 (A0–A6 указывают в RAM-окно `0xE00000`, A7 — в район
  `0xE0F000+` для стека; часть раундов с нечётными адресами → address error);
* SR в user/supervisor, случайные флаги, иногда trace-бит;
* случайные USP/SSP/`instruction_cycles`/`halted`, `fault=0`;
* RAM 64 КиБ детерминированно из `seed` (xorshift32; одна и та же функция в Python/C/JS,
  проверяется self-test’ом `--ram-digest`).

Сравниваются: D[8], A[8], PC, USP, SSP, SR, `instruction_cycles`, `halted`, `fault`,
`fault_address`, код причины `fail`, initial/final дайджесты RAM (два независимых
32-битных хэша = 64 бита). Формат кейсов/результатов — `oracle/format.py`
(`DWC1`/`DWO1`, little-endian, 100/116 байт на запись).

### 6.3. Выбор страницы и покрытия

**Страница `$013`** выбрана как минимальная полностью поддерживаемая реальная страница:
78 инструкций, все EA — только RAM/ROM (`LEA $fff3b0` и т.п. — это адреса в RAM-окно,
`MOVE` в `$FFE002` — тоже RAM, `MOVEM` — стек в RAM), нет абсолютных обращений в
IO/VDP/Z80. Покрывает `MOVE` (все размеры/режимы), `MOVEA`, `ADDQ`, `BSR/JSR/JMP/RTS/TO_SR`,
`LEA`, `MOVEM_LOAD/STORE`, `LSL`, `CMP`, `MOVEQ`, `BSET`, `FROM_SR/SR_OR`.

**Покрытие** (`coverage.py`): 240 инструкций из 21 страницы (1845 групп, 229 кандидатов
отброшено из-за абсолютных адресов в device-области), по одной на группу
`(op, size, EA src, EA dst)`; 35/35 обязательных op-семейств + 30 extras. Это
проверяет `MULU/MULS/DIVU/DIVS`, сдвиги (регистр и память), `NOT/NEG/EXT/SWAP`,
`BCC` разных условий, `DBCC/SCC`, `ADDX/SUBX`, `MOVEM`, `EXG`, `PEA/LINK/UNLK`, `RTE`,
`TO_CCR/CCR_*` и т.д. на реальных инструкциях, а не на синтетике.

### 6.4. JS-стабы

`oracle/run_wasm.mjs` — точный порт хелперов `runtime.h` на JS: `read_mem/write_mem`
(big-endian, address error, ROM/RAM/unaligned ошибки), `read8/write8` (RAM ≥0xE00000 по
маске 16 бит, ROM <rom_size, write-to-ROM/unmapped), `push32/pop32`, `movem`,
`set_sr` (USP/SSP swap), `logic_flags`, `arithmetic`, `extended_arithmetic`,
`bcd_arithmetic`, `bcd_negate`, `shift_value`, `divide_value` (через `BigInt`-безопасное
`Math.trunc`), `condition`, `index_value`, `fail`. Адреса устройств (IO/VDP/Z80/EEPROM)
в стабах **не моделируются**: если в кейс попадёт такое обращение, harness падает с
понятной ошибкой, а не «тихо» считает неверно; `coverage.py` такие кандидаты отбрасывает,
страница `$013` их не содержит.

### 6.5. Результаты

Полный прогон `check_page.py` (200 состояний/инструкцию, 24 для coverage, M1 Pro,
Python 3.12, Node 24.16, clang 21):

```
page $013: 78 instr × 200 = 15 600 cases;  wasm 6 953 B (5 972 B handlers, 76.6 B/instr)
           oracle 8 025 ms; wasm/Node 4 820 ms; faults 1 082/1 082 (codes 6/7/8/9);
           mismatches: 0
coverage:  240 instr × 24 = 5 760 cases;   wasm 40 959 B (35 896 B handlers, 149.6 B/instr)
           oracle 2 957 ms; wasm/Node 1 865 ms; mismatches: 0
decode:    373 entries, 40 382 instructions, 0 RAM variants, 0 errors, 3 361 ms
ABI:       hash 2e870f72c64d96cf…, matches native C probe
RAM fill/digest self-test: 2/2 seeds identical in Python/C/JS
elapsed:   21.5 s;  PASS
```

`faults` в обоих прогонах совпадают не только по количеству, но и по кодам:
privilege (6) — 787, address error read (7) — 112, address error write (8) — 171,
unmapped read (9) — 12. Это доказывает, что ранние `return` и коды `fail` совпадают с C.

---

## 7. Как запускать

### 7.1. Полная проверка (ROM + baseline)

```sh
cd dune-web

python3 tools/wasm_emitter/check_page.py \
  --rom /path/to/Dune-USA.gen \
  --baseline /path/to/dune-base.c
```

Ожидаемый хвост: `PASS: page $013 differential is 0 mismatches and coverage is 0 mismatches`,
код выхода 0. Скрипт сам перезапускается найденным `python3.12`, если системный Python 3.9
(вендорный `decode.py` использует PEP 604). Артефакты — в `.local/wasm-emitter/`
(gitignored, вне репозитория): `page_013.wasm`, `coverage.wasm`, `*.meta.json`,
`report.json`, C-оракул.

Быстрый режим без большого N:

```sh
python3 tools/wasm_emitter/check_page.py --rom … --baseline … --cases 20 --coverage-cases 4
```

### 7.2. Тесты

```sh
# без ROM: ABI, кодировщик, статическая трансляция всех op-семейств (Python 3.9 тоже)
python3 -m unittest discover -s tests/wasm_emitter -v

# полный дифференциал (нужны ROM + dune-base.c и Python 3.10+/Node)
DUNE_ROM="/…/Dune ….gen" DUNE_BASELINE="/…/dune-base.c" \
  python3.12 -m unittest discover -s tests/wasm_emitter -v

# полный N=200/24 вместо smoke (≈22 с)
DUNE_WASM_FULL=1 DUNE_ROM=… DUNE_BASELINE=… \
  python3.12 -m unittest discover -s tests/wasm_emitter -v
```

Без внешних данных тест `test_page_diff` делает `skip` с понятным сообщением
(`external ROM not available (set DUNE_ROM)`); остальные 16 тестов проходят.

### 7.3. Guard

```sh
python3 tools/check_no_game_data.py   # → game-data check: OK
```

---

## 8. Ограничения (честно)

1. **Одна страница.** Дифференциально доказана страница `$013` (78 инструкций) и 240
   репрезентативных инструкций из 21 страницы. Остальные 40 382 инструкции, 48 страниц,
   максимальная страница `$1a` (1 344 инструкции) ещё не прогнаны дифференциалом.
2. **Нет `runtime.wasm`.** C-оракул — нативный; ABI 64-битных указателей. Для wasm32
   `runtime.wasm` дескриптор должен прийти из `dune_abi_descriptor()`; эмиттер
   layout-agnostic, но сам дескриптор/рантайм ещё не собраны (emcc не запускался).
3. **JS-стабы — модель шины, не весь рантайм.** Смоделированы RAM/ROM, address error,
   write-to-ROM, fault-коды; VDP/IO/Z80/EEPROM/DMA и машинный тайминг — нет. Кандидаты с
   такими адресами отфильтрованы, а при случайном попадании harness падает, а не врёт.
   Страница `$013` не обращается к устройствам.
4. **Z80 не транслируется.** `translated_z80_step` (3 095 вариантов) — следующий этап;
   сейчас экспортируется только 68000-часть.
5. **RAM-варианты.** Движок guard’а реализован, но в Dune USA 68k RAM variants = 0;
   mutable absolute address (самомодифицирующийся код) пока `UnsupportedInstruction`.
6. **Циклы — оценка `cycles.py`**, не bus-cycle accurate; сравнивается
   `instruction_cycles`, а не VDP/прерывания/машинный цикл.
7. **Покрытие — выборка**, а не все 40 382 инструкции; cap 240 групп. `TRAP/STOP/
   ILLEGAL/LINE_*` реализованы в эмиттере и проверены структурно (валидность модуля),
   но не дифференцированы (нет реальных инструкций в выборке). `RTE` дифференцирован.
8. **Синтетический unit-test** проверяет, что все op-семейства компилируются в валидный
   WASM (stack balance), но семантику для не-выбранных форм доказывает только coverage.
9. **Кэш `game.wasm`/OPFS/Pyodide/телефон** не реализованы — это этап 5 дизайна.

---

## 9. Найденные и исправленные ошибки

Все расхождения были в эмиттере, C-семантика не менялась:

* `address()` писал `target_addr`, а `LEA/JMP/JSR/MOVEM` читали `target` → адрес 0;
* `i32.store` PC без `push_c` → стек WASM не сбалансирован (`RTS/JMP/JSR/...`);
* лишний `push_c` в `DBCC` (циклы и тело) и `CCR_OR/EOR` → мусор на стеке/неверный SR;
* `MOVEM` для `(A7)+` терял локальную `target` и получал 0;
* локальные `TO_CCR/CCR_*` и `FROM_SR` — порядок `push_c`/значения.

После исправлений: 21 360 случаев, 0 расхождений; `fault`-коды и RAM-дайджесты совпадают.

---

## 10. Следующий шаг и оценка

1. **Все 48 страниц 68000** (40 382 инструкции). Цена по замеру: 76,6 Б/инстр (страница
   `$013`) — 149,6 Б/инстр (coverage с богатыми EA и MOVE-режимами) → **3,1–6,0 МБ** кода;
   плюс диспетчеры 48 страниц ~0,2–0,4 МБ. Оценка `game.wasm` **3,5–6,5 МБ**
   (дизайн: 4–9 МБ). Генерация: 4,9 мс / 78 инструкций ≈ 0,06 мс/инстр → 2,5–3 с на
   Python 3.12 на M1; в Pyodide ожидается ~3–5× медленнее (10–20 с на телефоне) —
   измерить на устройстве.
2. **Дифференциал всех страниц.** По текущей скорости 15 600 случаев ≈ 13 с (C+JS,
   без decode). 40 382 × 20 состояний ≈ 0,8 млн кейсов ≈ **10–15 мин** на M1; для
   рисковых страниц (`$1A`, `$00`, `$01`, `$0C–$0F`, `$43–$49`) — по 200. Перед этим
   ускорить C-оракул (не копировать 391 КБ `CPU` на кейс: сбрасывать только поля
   CPU/RAM; ожидаемо 3–5×).
3. **`runtime.wasm`**: emcc 3.1.74, `dune_abi_descriptor()`, wasm32-смещения, общая
   память, таблица, `dune_set_game_steps`; прогнать differential уже против реального
   рантайма (тот же C-оракул).
4. **Z80**: перенести `z80.py` → WASM (3 095 guard-вариантов), экспорт
   `translated_z80_step`, дифференциал против `translated_z80_step` C.
5. **Полный модуль + браузер**: `warmup_all`, генерация в Pyodide-воркере, OPFS-кэш,
   ключ `sha256(rom|abi_hash|generator_version)`, метрики на телефоне; сравнить
   размер/время с оценкой.

---

## 11. Данные и лицензии

* ROM, `dune-base.c`, сгенерированные `.wasm`/C-ядро, кейсы и отчёты — **только** в
  `.local/` (gitignored) или `/tmp`; в репозиторий не попадают. `check_no_game_data.py`
  проходит.
* В репозитории — только наш MIT-код (`tools/wasm_emitter/`, `tests/wasm_emitter/`) и
  неизменённые MIT-исходники ReArrakis во `vendor/` (через существующие манифесты).
* C-оракул и тестовые модули используют внешние файлы только во время локального
  прогона и не встраивают ROM в git-артефакты.
