# WASM-бэкенд: дизайн этапа 2 (runtime.wasm + game.wasm на устройстве)

Статус: **дизайн + PoC**. Реализация — этап 5 плана ([PLAN.md](PLAN.md)); вход — спайк
(2026-11-27, `Порты игр/spikes/dune-recompiler/REPORT.md`) и точный рантайм v2.

PoC, на котором основаны числа ниже: [`prototype/wasm/`](../prototype/wasm/README.md)
(`wasm_emit.py`, `emit_poc.py`, `run_poc.mjs`; 118 проверок, Node 24, M1 Pro).

---

## 0. TL;DR — принятые решения

1. **Два модуля.** `runtime.wasm` (CPU/VDP/звук/ввод/хост/сейвы) собирается **один раз** нами
   emcc 3.1.74 и поставляется готовым. `game.wasm` (только транслированные 68000/Z80
   инструкции) генерируется **на устройстве** чистым Python внутри Pyodide. C-компилятора на
   телефоне нет и не нужно.
2. **Памятью владеет JS.** Один `WebAssembly.Memory` создаётся в JS и импортируется обоими
   модулями (`-sIMPORTED_MEMORY=1` для emcc). Внутри — C-heap рантайма, `CPU`, VDP, аудио,
   RAM 64 КиБ, Z80 RAM 8 КиБ и ROM игрока (1 МиБ). `game.wasm` **не содержит ROM и data-сегментов**:
   ему нужны только смещения полей `CPU` и адрес RAM-окна, полученные из ABI-дескриптора.
3. **ABI-дескриптор, а не «магические числа».** Рантайм экспортирует `dune_abi_descriptor()`
   (версионированный массив u32: версия, sizeof/offsets `CPU` и `Z80CPU`, абсолютные адреса
   RAM/Z80 RAM/ROM/framebuffer, коды флагов, шифт-типов, причин `fail`, ABI hash). JS читает
   его при загрузке и передаёт в Pyodide; эмиттер подставляет реальные смещения. Ключ кэша
   `game.wasm` включает ABI hash. Никакого «зашитого» layout, который может разъехаться.
4. **Направление вызовов.** `game.wasm` импортирует хелперы рантайма напрямую (замерено:
   2,1–4,4 нс/вызов против ~2,4–2,5 нс внутреннего, в зависимости от прогрева V8). Рантайм вызывает сгенерированный код через
   **`call_indirect` по funcref-таблице** (2,1 нс/вызов, замерено) — без JS на каждой
   инструкции. Общий цикл машины, прерывания, тайминг, звук и сейвы остаются в рантайме.
5. **Диспетчеризация без интерпретатора.** 4 КиБ страницы PC, два уровня `br_table`
   (16×16 страниц; 32×64 слота), тело обработчика инлайнится; ни fetch, ни decode, ни switch
   в рантайме. RAM-варианты (самомодифицирующийся код/Z80) проверяются сравнением байтов RAM
   с образом, зашитым в `game.wasm` как немедленные значения.
6. **Сохранения `DSAV v2` не меняются.** Всё состояние (CPU/RAM/VDP/Z80/PSG) живёт в рантайме;
   `game.wasm` — только код. Старые сейвы принимаются, генерация модуля на них не влияет.
7. **Оценки.** `game.wasm` ≈ 4–9 МБ (план 6–8 МБ), генерация на устройстве ≈ 3–8 с поверх
   текущих 8,3 с спайка на M1 (телефон — десятки секунд, только первый запуск), кэш в OPFS →
   повторный запуск без Pyodide. Прогрев страниц ~100 мс скрывается экраном загрузки.

Ниже — почему так, что уже есть в C-эмиттере, что придётся написать и чем это проверять.

### 0.1. Замеры PoC (M1 Pro, Node 24.16, V8; `prototype/wasm/run_poc.mjs`)

* `game.wasm` PoC — 19 641 Б (11 обработчиков + полный стресс-диспетчер на 2048 слотов);
  без стресса 2 793 Б, из них 445 Б — диспетчер/ABI, **213,5 Б на обработчик**;
* `poc-heavy.wasm` — 3 страницы × 1 344 обработчика (максимум реальной страницы Dune),
  **920 351 Б**, глубина вложенности 98, V8 компилирует модуль **1,3–1,5 мс**, первый вызов
  страницы **2,0–2,3 мс** (Liftoff), warm **0,08–0,12 мкс/инструкцию**;
* стоимость ABI-вызова (2 млн вызовов/точка): внутренний вызов **~2,4–2,5 нс**, вызов экспорта
  другого wasm-модуля через импорт **2,1–4,4 нс** (зависит от прогрева V8), JS-стаб
  **3,9–4,2 нс**, `call_indirect` **2,1–2,2 нс**;
* диспетчеризация 2048 слотов (32×64 `br_table`, default-путь 22 раза) — 0 расхождений;
  связка двух модулей (память + таблица + `call_indirect`) даёт побитово то же состояние,
  что JS-драйвер.

---

## 1. Что уже есть и что из этого переиспользуется

### 1.1. Факты этапа 0/1 (измерено)

| Факт | Значение |
|---|---|
| ROM USA | 1 048 576 Б, SHA-256 `b1bbe731…0f335ba` |
| Сгенерированный C (эталон) | 20 412 009 Б, SHA-256 `e3055a76…4ad1578` |
| Перекомпиляция в браузере (M1, Chrome 158) | 8,31 с: discovery 5,16 + трансляция/эмиссия C 2,97 + хэш 0,07 |
| Pyodide WASM heap при этом | 103,5 МБ (JS heap 36 МБ) |
| Инструкций 68000 / Z80-вариантов | 40 382 / 3 095 |
| Страниц PC (4 КиБ) | 48 (0x000…0xC7), максимум 1 344 инструкции в странице 0x1A, медиана 904 |
| Собранная C-версия (продукт старого репо) | `web/engine/dune_web.wasm` = **5 273 530 Б** (это код рантайма + UI-адаптеров + 40 382 обработчиков + 1 МиБ данных ROM) |
| Нативный C-оракул (PoC-сборка `dune-base.c`, clang -O2, headless, 30 млн шагов) | 2 542 кадра → **11 802 инструкции/кадр**, 128 044 цикла/кадр, ~0,71 млн инструкций/с |
| Динамический профиль вызовов хелперов (тот же прогон) | ~2,0 хелпера/инструкцию: `condition` 0,97, `arithmetic` 0,49, `read_mem` 0,49, `write_mem` 0,012, `logic_flags` 0,017; `shift_value` 19k, `movem` 10k, `index_value` 12k за 30 млн шагов |
| Emscripten эталона | 3.1.74, `-O2`, SDL2, `ASYNCIFY=0`, `INITIAL_MEMORY=64 MiB`, `MAXIMUM_MEMORY=512 MiB`, `STACK_SIZE=16 MiB` |

### 1.2. Точная форма сгенерированного C

Разбор `vendor/rearrakis/build/dune-base.c` (см. также `emit.py`):

```
[преамбула рантайма]                124 896 Б   — рантайм v1; v2 = 130 103 Б (см. RUNTIME.md)
static const uint8_t rom_data[] = { … } 5 570 598 Б — 1 МиБ ROM «как есть», hex-байтами
static void translated_page_XX(CPU *c) { … }       — 13 518 846 Б, 40 382 case-обработчика
static void translated_step(CPU *c) { switch (c->pc >> 12) { … } }  2 836 Б
static unsigned translated_z80_step(CPU *c) { … }  1 194 835 Б, 2 577 case-PC / 3 095 вариантов
int main(...) { return run_main(...); }
```

Один обработчик — это плоская последовательность операторов C без локального цикла:

```c
case 0x000108u: {
    /* 000108: MOVE.W (A0)+, D1 */
    c->instruction_cycles = 8;
    uint32_t src_addr = c->a[0];                      // prepare
    uint32_t src = read_mem(c, src_addr, 2);          // read + fault check
    if (c->fault) return;
    uint32_t result = src;
    c->d[1] = (c->d[1] & 0xffff0000u) | (result & 0x0000ffffu);  // write
    c->a[0] += 2;                                     // post-increment
    logic_flags(c, result, 2);                        // флаги
    c->pc = 0x00010cu;                                // next PC
    return;
}
```

RAM-вариант (самомодифицирующийся код) обёрнут в проверку образа:

```c
case 0xff0200u: {
    if (memcmp(c->ram + 0x200, c->rom + <rom_offset>, 2) == 0) {
        /* обработчик варианта */ …
    }
    fail(c, "68000 RAM instruction bytes do not match static translation", c->pc);
    return;
}
```

Свойства, которые обязана повторить WASM-эмиссия:

* ровно один обработчик на инструкцию, без интерпретации опкодов;
* `instruction_cycles` и `pc` пишутся в `CPU`; всё остальное — через хелперы;
* после каждого хелпера, который может дать `fault` (bus, movem, divide), стоит
  ранний `return`;
* переходы (`BRA/BCC/BSR/JSR/RTS/RTE/TRAP/DBCC`) меняют `pc` и возвращаются; никакого
  «перехода к следующему case» — диспетчеризация снова через `translated_step`;
* Z80-обработчик возвращает число циклов (`translated_z80_step(c) -> unsigned`), а при
  `fault` — 0;
* `sign_extend`/`index_value` — чистые функции без состояния, их можно инлайнить;
* `condition` в C зовётся до двух раз на инструкцию (циклы + сам переход) — C-компилятор
  делает CSE; в WASM это нужно сделать явно на этапе эмиссии.

### 1.3. Какую работу делает каждая часть C-кода и где она окажется

| Часть C-кода | Судьба на этапе 2 |
|---|---|
| Преамбула рантайма (CPU, VDP, звук, ввод, Z80-шина, PSG/EEPROM, сейвы, SDL-хост) | → `runtime.wasm`, почти без изменений |
| `rom_data[]`, `rom_size`, чтение ROM | → память рантайма; `game.wasm` ROM не содержит |
| 40 382 обработчика + 48 page-функций + `translated_step` | → `game.wasm`, новый Python-эмиттер |
| `translated_z80_step` + 3 095 guard-проверок | → `game.wasm`, отдельная Z80-диспетчеризация |
| `main()`, `run_main()`, `--limit/--peek/--dump-*` | → web-хост рантайма (`dune_host_*`); нативные флаги не нужны |
| `memcmp` RAM-вариантов | → сравнение байтов `i32.load8_u` с немедленными константами |
| Текстовые сообщения `fail("…")` | → числовые коды причин; строки живут в рантайме |
| `#include` склейка заголовков | → обычные единицы трансляции рантайма при сборке emcc |
| C-эмиттер `emit.py` (печать C-текста) | → **переписывается** в WASM-эмиттер; `decode.py`, `discovery.py`, `cycles.py`, `z80.py` (IR-часть) переиспользуются без изменений |

Важно: **анализ 68000/Z80 не переписывается**. `decode.py` уже отдаёт `Program` с
`Instruction`/`EA`, `ram_variants`, `target`, `condition`, `raw`; `cycles.py` — циклы;
`z80.py` — список операций Z80 с их операндами и вариантами образов. Новый бэкенд — это
«принтер» другой целевой платформы поверх того же IR.

---

## 2. Архитектура

```
  ROM игрока (File API)
        │
        ▼
  ┌────────────────────────────────────────────────────────────┐
  │ Pyodide Web Worker — только первая сборка                  │
  │   decode/discovery/cycles/z80.py  (MIT ReArrakis, без изм.)│
  │   + wasm_emitter.py   ← ABI-дескриптор рантайма            │
  │   → game.wasm (4–9 МБ) + meta.json                         │
  │   → transferable ArrayBuffer, затем воркер завершается     │
  └────────────────────────────────────────────────────────────┘
        │ game.wasm bytes
        ▼
  ┌──────────────────────────┐        ┌──────────────────────────────┐
  │ runtime.wasm             │        │ game.wasm                    │
  │  emcc 3.1.74, наша       │◄───────┤  генерируется из ROM         │
  │  сборка, стабильный ABI  │  вызов │  imports: memory + хелперы    │
  │  память, CPU, VDP, звук, │  через │  exports: translated_step,    │
  │  ввод, сейвы, хост       │  table │           translated_z80_step,│
  │                          │        │           warmup_all          │
  └──────────────────────────┘        └──────────────────────────────┘
        ▲        │ общая linear memory (создаёт JS, импортируют оба)
        │        ▼
        │  rAF: JS → runtime.dune_host_frame()
        └─ Canvas / AudioWorklet / Input (как в старой версии)
```

### 2.1. Почему не один модуль

* Собрать один модуль на устройстве нельзя: нет `wasm-ld`/clang; текстовая генерация WASM
  «целиком» означала бы эмиссию и рантайма (1–2 МБ машинного кода), и его повторную отладку
  на каждом ROM.
* Два модуля дают главное: **рантайм фиксирован и проверен один раз**, из ROM генерируется
  только код игры; сохранения (`DSAV v2`), хост и фронтенд не зависят от ROM.
* Цена — накладные на границе модулей. Замерено (PoC, V8/Node 24, M1 Pro): вызов хелпера
  рантайма через импорт **2,1–4,4 нс** против ~2,4–2,5 нс внутреннего вызова; `call_indirect`
  **2,1–2,2 нс**. При ~1,4 млн вызовов хелперов/с (измерено на оракуле, §8) это 0,3–0,6 % CPU.
  Приемлемо.
* Альтернатива «один модуль + динамическая линковка emscripten» (dlopen side-модуля) требует
  от устройства линковщика/динамических секций и нестабильна; отклонена.

### 2.2. Связь с текущим C-путём (RUNTIME.md)

Этап 5 не ломает уже собранный C-путь: `runtime/dune-runtime-v2.c` — это тот же рантайм,
что сейчас подставляется в сгенерированное ядро через `--pinned-runtime`
([RUNTIME.md](RUNTIME.md)), и он остаётся источником для `runtime.wasm`:

* C-путь (`dune-web.c` + emcc → один `dune_web.wasm`) продолжает работать как резерв и как
  **эталон для дифференциальных тестов** (нативный оракул §13);
* WASM-путь компилирует **только рантайм** (преамбулу + web-адаптеры) в отдельный
  `runtime.wasm` без `main`, `run_main` и без массива ROM; вместо `translated_step` — два
  указателя на функции и вызов через таблицу (§5);
* игровая часть (транслированный код) в обоих путях происходит из одного и того же IR
  `decode.py`/`z80.py`; поэтому сверка «C-оракул против WASM-игры» возможна на любом шаге.

### 2.3. Границы ответственности

| Сущность | Владелец | `game.wasm` доступ |
|---|---|---|
| Линейная память (весь `Memory`) | JS создаёт, рантайм использует как heap, игра импортирует | импорт, без роста |
| `CPU` (регистры, RAM 64 КиБ, fault, циклы, halted) | рантайм | чтение/запись по offsets из ABI |
| `Z80CPU`, `Z80Bus.ram` 8 КиБ, `VDP` (VRAM/CRAM/VSRAM/frame), `Audio`, `PSG`, `EEPROM` | рантайм | только через хелперы (кроме RAM-guard-чтений) |
| ROM 1 МиБ | рантайм (копируется JS из файла игрока) | не читает; байты образов зашиты как константы |
| `instruction_cycles`, `pc`, `sr`, `fault`, `halted` | рантайм хранит, игра пишет | да, offsets |
| Циклы/мастер-клок/прерывания/VDP-тайминг/звук | рантайм | игра не участвует |
| Сейвстейт `DSAV v2` | рантайм | не участвует |
| Хост (canvas, ввод, аудио, visibility, пауза) | JS ↔ рантайм | не участвует |

---

## 3. Линейная память

Карта (адреса — иллюстративные; точные значения даёт ABI-дескриптор):

```
0x00000000  ┌──────────────────────────────────────────────┐
            │ guard / null                                 │
            │ статики и bss emcc: CPU (d[8],a[8],pc,usp,ssp,│
            │ sr,fault,instruction_cycles,cycles,…,ram[64K]),│
            │ VDP (vram 64K, cram/vsram, frame 320*240*3),  │
            │ Audio (~16K ring + ymfm), PSG, EEPROM,       │
            │ дюна-вью буферы, ABI-дескриптор              │
            ├──────────────────────────────────────────────┤
            │ stack (например 1–16 МиБ)                     │
            │ heap emcc (растёт вверх до stack)             │
            └──────────────────────────────────────────────┘   ≈ 64–128 МиБ, max 256–512 МиБ
```

`game.wasm` добавляет **только код** (code section) и не содержит data-сегментов, memory-секции
или своих статических данных. Следствия:

* размер `game.wasm` не включает 1 МиБ ROM (в C-сборке это 5,57 МБ hex-текста / 1 МиБ в
  wasm-модуле) — экономия памяти и времени генерации;
* ROM обязан лежать в памяти рантайма: `c.rom = memory + rom_addr`, `c.rom_size = 1 048 576`;
  JS копирует байты игрока один раз (`HEAPU8.set(rom, ry_rom_ptr())`);
* обработчики читают RAM напрямую **только** для guard-проверок вариантов:
  `i32.load8_u(ram_addr + (pc & 0xffff) + n)`; запись в RAM — всегда через `dune_write_mem`
  (иначе не будет fault-семантики, EEPROM/IO и т. д.);
* поля `CPU`/`Z80CPU` игра адресует как `i32.load/store offset=<offset> (local.get $c)`;
  смещения — из дескриптора, поэтому пересборка рантайма не ломает кэш: меняется ABI hash.

### 3.1. ABI-дескриптор

`runtime.wasm` экспортирует `dune_abi_descriptor() -> i32` (указатель на `u32[]` в своей памяти).
Поля (v1, ~80 слов):

* `magic = 'DAB1'`, `version`, `size`, `abi_hash` (sha256 первых N слов — считает сборка рантайма);
* `sizeof(CPU)`, offsets: `d`, `a`, `pc`, `usp`, `ssp`, `sr`, `fault`, `instruction_cycles`,
  `cycles`, `master_cycles`, `steps`, `halted`, `io_*`, `pad_buttons`;
* offsets `Z80CPU`: `r8`, `alternate`, `a`, `f`, `a_alt`, `f_alt`, `i`, `r`, `iff1`, `iff2`,
  `im`, `halted`, `irq_line`, `ei_delay`, `pc`, `sp`, `ix`, `iy`, `wz`, `debt`, `cycles`;
* абсолютные адреса: `cpu`, `ram`, `z80_ram`, `rom`, `rom_size`, `vdp_vram`, `cram`, `vsram`,
  `frame`, `save_buffer`, `save_buffer_size` (262 144 Б);
* значения enum: `F_C/F_V/F_Z/F_N/F_X`, `Z_C…Z_S`, shift kinds (0..3), размеры (1/2/4),
  коды `DUNE_FAIL_*`;
* сигнатуры/версия helper-ABI (`helper_abi_version`).

JS при старте: `const words = new Uint32Array(memory.buffer, rt._dune_abi_descriptor(), size)`,
проверяет magic/version, считает `abiHash` (или берёт `abi_hash`), передаёт JSON в Pyodide.
Ключ кэша: `sha256(rom_sha256 | abi_hash | generator_version)`. Если рантайм обновили —
кэш `game.wasm` автоматически инвалидируется. Старый `game.wasm` с новым рантаймом не
запустится: перед инстанцированием JS сверяет `abi_hash` из meta кэша с текущим.

Если дескриптор недоступен (ошибка сборки рантайма), используется pinned JSON
`runtime/abi/runtime-abi-v1.json` из репозитория, но JS всё равно сверяет его с рантаймом
(вызов `dune_abi_selfcheck(version, hash)`); расхождение — фатальная ошибка загрузки, не
«тихая» порча.

---

## 4. ABI

### 4.1. Импорты `game.wasm` (16 базовых функций + 22 Z80 + память)

`(c: i32 — указатель на CPU; все значения беззнаковые; размеры 1/2/4; big-endian как на шине)`

| Импорт | WASM-сигнатура | Смысл / источник в рантайме |
|---|---|---|
| `read_mem` | `(i32 c, i32 addr, i32 size) -> i32` | `read_mem()`: ROM/RAM/IO/VDP/Z80-шина, address-error, fault |
| `write_mem` | `(i32 c, i32 addr, i32 size, i32 value) -> ()` | `write_mem()`: RAM/IO/TMSS/VDP/Z80, запись в ROM → fault |
| `push32` | `(i32 c, i32 value) -> ()` | `push32()` |
| `pop32` | `(i32 c) -> i32` | `pop32()` |
| `movem` | `(i32 c, i32 mask, i32 address, i32 mode, i32 base, i32 size, i32 load) -> ()` | `movem()` |
| `set_sr` | `(i32 c, i32 sr) -> ()` | `set_sr()` (смена USP/SSP) |
| `logic_flags` | `(i32 c, i32 value, i32 size) -> ()` | `logic_flags()` |
| `arithmetic` | `(i32 c, i32 dst, i32 src, i32 size, i32 sub, i32 compare) -> i32` | `arithmetic()` |
| `extended_arithmetic` | `(i32 c, i32 dst, i32 src, i32 size, i32 sub) -> i32` | `extended_arithmetic()` |
| `bcd_arithmetic` | `(i32 c, i32 dst, i32 src, i32 sub) -> i32` | `bcd_arithmetic()` |
| `bcd_negate` | `(i32 c, i32 value) -> i32` | `bcd_negate()` |
| `shift_value` | `(i32 c, i32 value, i32 count, i32 size, i32 kind, i32 left) -> i32` | `shift_value()` |
| `divide_value` | `(i32 c, i32 dividend, i32 divisor, i32 is_signed) -> i32` | `divide_value()` |
| `condition` | `(i32 c, i32 cond) -> i32` | `condition()` |
| `index_value` | `(i32 c, i32 extension) -> i32` | `index_value()` |
| `fail` | `(i32 c, i32 reason, i32 address) -> ()` | `fail()`, но reason — код, строка в рантайме |

Плюс Z80-хелперы (импортируются только если в ROM есть Z80-программа — у Dune есть):
`z80_pair`, `z80_set_pair`, `z80_reg`, `z80_set_reg`, `z80_read`, `z80_write`, `z80_read16`,
`z80_write16`, `z80_pop`, `z80_push`, `z80_m1`, `z80_szxy`, `z80_alu`, `z80_alu16`, `z80_inc`,
`z80_add_pair`, `z80_add_hl`, `z80_condition`, `z80_bit`, `z80_block`, `z80_rotate`, `fail`.
Точные C-сигнатуры — в `genesis_recompiler/z80_runtime.h`.

Что **не** импортируется: `machine_step/advance/interrupt`, `vdp_*`, `audio_*`,
`z80_tick/reset`, `dune_*_save_*`, SDL/host. Игра не знает о тайминге и устройствах.

`sign_extend` не импортируется — инлайнится (2–3 инструкции), как и маски `mask_for`.

### 4.2. Экспорты `game.wasm`

| Экспорт | Сигнатура | Кто зовёт |
|---|---|---|
| `translated_step` | `(i32 c) -> ()` | рантайм через `call_indirect` (слот таблицы) |
| `translated_z80_step` | `(i32 c) -> i32` | рантайм через `call_indirect`; возврат — циклы Z80, 0 при fault |
| `warmup_all` | `(i32 c) -> ()` | JS один раз после инстанцирования: прогревает (Liftoff) все page-функции |

Ничего больше наружу не торчит: нет экспортов страниц, нет таблиц, нет глобалов.

### 4.3. Экспорты `runtime.wasm`

* **Хост для JS:** `dune_host_init(rom_ptr, rom_len, region)`, `dune_host_frame()`,
  `dune_host_set_paused`, `dune_host_set_hidden`, `dune_host_input_*`, `dune_host_resize`,
  `dune_abi_descriptor`, `dune_cpu_ptr`, `dune_rom_ptr`, `dune_set_game_steps(step_slot,
  z80_slot)`, `dune_host_prewarm_done`, плюс существующий набор `dune_web_*` из старой
  версии (сейвы, меню, аудио-уровни, гейсты) — сохраняем имена, чтобы не переписывать `shell.js`.
  Точные списки уже зафиксированы в `runtime/manifest.json` → `exports`: 5 экспортов преамбулы
  (`dune_get_save_buffer`, `dune_save_state_to_buffer`, `dune_load_state_from_buffer`,
  `dune_mouse_leave`, `dune_web_audio_levels`), 70 `EMSCRIPTEN_KEEPALIVE` адаптеров,
  71 web-UI функция (`exports.web_ui`) и 4 функции сейвов (`exports.save`).
* **Хелперы для игры:** 16 базовых + 22 Z80 функций из §4.1 (экспортируются с префиксом `dune_`, чтобы не
  пересечься с libc/ymfm; внутри рантайма — тонкие обёртки/`#define`).
* **Таблица функций:** `Module.wasmTable` (emscripten runtime method) — в неё JS кладёт
  `game.exports.translated_step`/`translated_z80_step`, индексы передаёт в
  `dune_set_game_steps()`. Как именно — см. §5.

### 4.4. Контракт обработчика (что игра обязана соблюдать)

1. `instruction_cycles` пишется **в начале** обработчика (до любого хелпера): рантайм начисляет
   циклы даже при fault, как C `machine_step`.
2. `pc` пишется ровно один раз в конце (или в ветке перехода), перед `return`.
3. После `read_mem`/`write_mem`/`pop32`/`movem`/`divide_value` — проверка `c->fault` и `return`.
4. `condition` вычисляется один раз на инструкцию (CSE вручную).
5. `FAIL_*`-коды — из ABI; адрес для `fail` — `pc`.
6. Z80-обработчик при `fault` возвращает 0; иначе — циклы инструкции (как `z80.py`).
7. В `game.wasm` нет глобального состояния; всё — в памяти рантайма (важно для сейвов и
   повторного инстанцирования).

---

## 5. Связывание модулей

### 5.1. Порядок инстанцирования

```js
// 1) memory создаёт JS (единственный владелец)
const memory = new WebAssembly.Memory({initial: 1024, maximum: 4096});   // 64..256 МиБ
// 2) runtime.wasm (emcc MODULARIZE, IMPORTED_MEMORY)
const rt = await DuneRuntime({ wasmMemory: memory, locateFile: … });
await rt.ready;                                   // emscripten инициализировал CPU/VDP/аудио
// 3) ROM игрока -> память рантайма
rt.HEAPU8.set(romBytes, rt._dune_rom_ptr());
rt._dune_host_init(rt._dune_rom_ptr(), romBytes.length, 0);
const abi = readAbiDescriptor(rt);                // JS-структура из §3.1
// 4) game.wasm: bytes из OPFS-кэша или из Pyodide-воркера
const gameModule = await WebAssembly.compile(gameBytes);
const game = await WebAssembly.instantiate(gameModule, {
  env: {
    memory,                                       // то же самое Memory
    read_mem:  rt._dune_read_mem,   write_mem: rt._dune_write_mem,
    push32:    rt._dune_push32,     pop32:     rt._dune_pop32,
    /* … 16 хелперов напрямую, без JS-обёрток … */
  },
});
// 5) указатели на сгенерированный код -> рантайм (через таблицу)
const slot = rt.wasmTable.length;
rt.wasmTable.grow(2);
rt.wasmTable.set(slot,     game.exports.translated_step);
rt.wasmTable.set(slot + 1, game.exports.translated_z80_step);
rt._dune_set_game_steps(slot, slot + 1);
// 6) прогрев страниц (Liftoff) под экраном загрузки
game.exports.warmup_all(abi.cpu);
// 7) запуск: requestAnimationFrame -> rt._dune_host_frame()
```

Почему так:

* импорты игры — **прямые ссылки на экспорты рантайма** (`rt._dune_read_mem`), а не JS-обёртки:
  это ровно те 2,1–4,4 нс/вызов, что замерены; обёртки в JS добавили бы второй переход.
* обратное направление (рантайм → `translated_step`) не может быть обычным импортом: при
  инстанцировании рантайма игра ещё не существует (циклическая зависимость). Решение —
  `call_indirect` по таблице, которую наполняет JS после сборки обоих модулей. Замер: 2,1–2,2 нс,
  то есть бесплатно; JS на каждой инструкции нет.
* `warmup_all(abi.cpu)` обходит все page-функции с магическим `pc = 0xFFFFFFFE`; prologue
  каждой страницы `if (pc == WARMUP) return;` (2–3 инструкции) позволяет скомпилировать
  функцию, ничего не исполнив. Без прогрева первый вход в страницу даёт Liftoff-паузу
  ~2 мс на максимальную страницу (замерено, §0.1).

### 5.2. Ограничение emscripten / fallback

`Module.wasmTable` доступен при `-sEXPORTED_RUNTIME_METHODS=["wasmTable"]`; `.grow/.set`
документированы и стабильны в 3.1.74. Если в пилоте всплывёт проблема (например, emscripten
уже использует этот индекс), есть два fallback’а:

1. `-Wl,--export-table` и работа с `__indirect_function_table` напрямую;
2. отдельная JS-таблица (`new WebAssembly.Table`), переданная рантайму как
   `-Wl,--import-table`; тогда таблицу создаёт JS и наполняет обе стороны.

Пилотный тест этапа 1 обязан подтвердить один из трёх путей до начала эмиттера.

---

## 6. Диспетчеризация 68000

### 6.1. Решение

* страница = 4 КиБ (2048 возможных начал инструкций, все чётные);
* два региона PC: ROM-страницы `0x00…0xFF` (1 МиБ) и RAM-страницы `0xFF0…0xFFF`;
* `translated_step`:
  1. `pc = CPU.pc`; `if pc >= 0x1000000 → fail(FAIL_BAD_PC)`;
  2. `if pc & 1 → fail(FAIL_ODD_PC)`;
  3. `page = pc >> 12`;
  4. ROM: два уровня `br_table` 16×16 → `call page_XX(c, pc)`;
  5. RAM: `br_table` 16 (по `page & 0xf`) → `call page_ffX(c, pc)`;
  6. иначе `fail(FAIL_UNMAPPED)`.
* каждая page-функция — два уровня `br_table` 32×64 (2048 слотов):
  внутренний обработчик **инлайнится** между блоками, завершается `return`.
* отсутствующие слоты/страницы ведут в `fail(FAIL_UNTRANSLATED)`; так же ведут себя
  «дырки» в ROM.
* prologue страницы: `if (pc == 0xFFFFFFFE) return;` — только для прогрева.

Псевдо-код (реальные depths — в комментарии; блоки `$out` — default):

```wat
(func $translated_step (param $c i32)
  (local $pc i32) (local $page i32)
  local.get $c; i32.load offset=CPU_PC; local.set $pc
  local.get $pc; i32.const 0x1000000; i32.ge_u; if; fail_bad_pc; return; end
  local.get $pc; i32.const 1; i32.and;       if; fail_odd_pc; return; end
  local.get $pc; i32.const 12; i32.shr_u;    local.set $page
  local.get $page; i32.const 0x100; i32.lt_u
  if
    ;; 16 групп x 16 страниц; у Dune заполнено 6 групп
    block $out
      block $g15 … block $g0
        local.get $page; i32.const 4; i32.shr_u
        br_table $g0 … $g15 $out
      end
      ;; код группы g0:
      block $out2
        block $p15 … block $p0
          local.get $page; i32.const 15; i32.and
          br_table $p0 … $p15 $out2
        end
        local.get $c; local.get $pc; call $page_0; return
      end
      fail_untranslated; return
    end
    fail_untranslated; return
  else
    ;; RAM-регион: 0xFF0..0xFFF, index = page & 0xf
    …
  end)

(func $page_1a (param $c i32) (param $pc i32)
  (local $slot i32)
  local.get $pc; i32.const 0xfffffffe; i32.eq; if; return; end  ;; warmup-зонд
  local.get $pc; i32.const 0xfff; i32.and; i32.const 1; i32.shr_u; local.set $slot
  block $out
    block $chunk31 … block $chunk0
      local.get $slot; i32.const 6; i32.shr_u
      br_table $chunk0 … $chunk31 $out
    end
    ;; код chunk0:
    block $out2
      block $s63 … block $s0
        local.get $slot; i32.const 63; i32.and
        br_table $s0 … $s63 $out2
      end
      ;; inline handler слота 0: instruction_cycles, helpers, pc, return
    end
    fail_untranslated; return
  end
  fail_untranslated; return)
```

Глубина вложенности: `translated_step` 34, page-функция 98. Это подтверждено на V8:
`poc-heavy.wasm` (3 страницы × 1 344 обработчика, глубина 98, 920 КБ) валидируется и
исполняется; см. §0.1.

### 6.2. Размеры и оценки

* `br_table`-таблицы: на страницу 32×(64 записи) + 32×64 блоков ≈ 5,8–8,4 КБ при «полных»
  блоках; при оптимизации «только присутствующие слоты» (среднее 841 из 2048) — ~3,5–5 КБ.
  Для 48 страниц это ~0,2–0,4 МБ, т.е. 3–5 % от `game.wasm`.
* обработчик: в PoC — 213,5 байт/обработчик (богатые обработчики с полными fault-check’ами);
  реальные маленькие (`BCC`, `MOVEQ`) будут 60–120 Б, большие (`MOVEM`, `MULU`, `DIVU`) —
  до 1 КБ. Верхняя оценка: 40 382 × 213 ≈ 8,6 МБ + Z80 ≈ 0,6 МБ; ориентир — 5,5–9 МБ,
  план 6–8 МБ. Точная цифра — после эмиттера на одну реальную страницу (Phase 3, §15).
* альтернативы, которые сравнивались:

| Подход | Цена на инструкцию | Размер | Риск |
|---|---|---|---|
| **2× `br_table` + инлайн (выбран)** | 1 call + 2 br_table + сдвиги; замер warm 0,08–0,12 мкс/инстр (вместе с телом) | +0,2–0,4 МБ таблиц | огромные page-функции (V8 ок, JSC неизвестен) |
| функция на инструкцию + `call_indirect` | 1 `call_indirect` (2,1 нс) | 40 382 функции, 2048-таблицы по страницам (~16 КБ/стр) + метаданные; ленивая компиляция по одной | накладные на функции, хуже tier-up |
| бинарный поиск/дерево (как clang switch) | ~11 сравнений | минимум | медленнее, чем br_table |
| один `br_table` на 2048 без чанков | — | — | глубина 2048 — риск лимитов движков |

**Fallback:** если на JSC (Safari) глубина/размер функций окажется проблемой — chunked-вариант:
page-функция делает `br_table` по 32 чанкам и вызывает chunk-функции по 64 обработчика
(функции ≤ ~20 КБ, глубина ≤ 40, +1 вызов на инструкцию ≈ +2 нс). Переключается флагом
эмиттера; ABI не меняется. Это же решение убирает паузы Liftoff (chunk компилируется за
десятки мкс).

### 6.3. RAM-варианты (`ram_variants`)

`decode.py` уже собирает список вариантов образа для PC в RAM (`Program.ram_variants`);
в USA-дампе Dune 68000-страниц в RAM **нет** (в эталонном C — ни одного `memcmp`), но механизм
обязателен для других дампов/ревизий и полностью используется Z80 (3 095 вариантов).

Эмиссия для ROM/RAM-инструкции с вариантами (внутри слота страницы):

```wat
;; вариант 1: if (ram[pc&0xffff + 0..n] == image bytes) { handler1; return }
local.get $pc; i32.const 0xffff; i32.and; i32.const RAM_ADDR; i32.add; local.set $g
i32.const 1
local.get $g; i32.load8_u 0; i32.const 0x4e; i32.eq; i32.and
local.get $g; i32.load8_u 1; i32.const 0x75; i32.eq; i32.and
if
  ;; handler варианта (cycles/pc/return)
end
;; вариант 2 … (столько, сколько нашёл анализ)
fail(fail_ram_variant, pc); return
```

* изменяемые адреса (`mutable_source_address`) обрабатываются как в C: сравнивается только
  неизменяемая часть образа (опкод + хвост), адрес берётся из RAM;
* сравнение — немедленные байты, без ROM и без `memcmp`-вызова; в среднем 1–4 байта/вариант;
* после провала всех вариантов — `fail(FAIL_RAM_VARIANT)` (как C).

---

## 7. Z80

Z80-код игры тоже транслирован (3 095 вариантов, 2 577 разных PC) и должен переехать в
`game.wasm`:

* страницы: Z80 RAM 8 КиБ = 4 страницы по 2 КиБ; слот = **байт** `pc & 0x7FF` (2048 слотов —
  та же форма 32×64, что у 68000, глубина 98); `page = (pc >> 11) & 3`;
* каждая инструкция — набор вариантов образа: `z80_ram[pc+n] == byte` для `n=0..len-1`
  (как `c->z80_bus.ram[...] == 0x..` в C); байты RAM читаются напрямую по
  `z80_ram_addr + pc + n`;
* обработчик вызывает Z80-хелперы рантайма (§4.1) и `z80_m1`; возвращает циклы;
* `translated_z80_step` — отдельный экспорт; рантайм вызывает его через второй слот таблицы
  внутри `z80_tick` ровно как сейчас (`cycles = translated_z80_step(c)`);
* `AUDIO_STUB`-режим (звук выключен) — рантайм вообще не зовёт Z80, как и сейчас.

---

## 8. Тайминг, циклы, прерывания

Всё остаётся в рантайме, `game.wasm` не участвует:

* `machine_step`: `machine_interrupt()` → `translated_step(c)` → `machine_advance(instruction_cycles)`
  (`cycles += n; master_cycles += n*7; vdp_advance(clocks); z80_tick(clocks/15); audio_sync()`);
* `c->instruction_cycles` пишется обработчиком в начале; рантайм начисляет даже при fault —
  контракт §4.4;
* `z80_tick` сам ведёт `debt`, прерывания, `ei_delay`; игра возвращает циклы;
* пауза/скорость/`no_throttle` — хост рантайма (как `em_web_host.h`);
* `STOP` выставляет `c->halted`, рантайм решает, когда будить.

Следствие: **перф-бюджет** определяется числом инструкций, а не «кадрами»: rAF-цикл рантайма
выполняет столько `machine_step`, сколько нужно на N мастер-циклов (как старая версия).

Измерено на нативном C-оракуле (30 млн шагов, headless, `--audio stub`):

* 2 542 кадра = 30 000 000 / 2 542 = **11 802 инструкции 68000/кадр** (≈0,71 млн/с);
* 325 443 238 циклов / 2 542 = **128 044 цикла/кадр** (ровно 16,7 мс при 7,67 МГц — модель
  тайминга сходится с NTSC-кадром);
* в среднем **2,0 вызова хелперов на инструкцию** (`condition` ≈1,0; `arithmetic` ≈0,49;
  `read_mem` ≈0,49) → ~1,4 млн вызовов/с. При замеренной цене импорта 2,1–4,4 нс это 3–6 мс/с,
  т.е. **0,6 % CPU** — граница модулей не является узким местом.

Оценка стоимости собственно WASM-исполнения: warm-диспетчеризация с синтетическим телом
(20 загрузок/арифметики на обработчик) — 0,08–0,12 мкс/инструкцию (V8/Node, M1), т.е.
**1,2–1,4 мс/кадр** на 11,8 тыс. инструкций (боевые кадры могут быть тяжелее: верхняя граница
по циклам — 32 тыс. инструкций/кадр). На телефоне ожидаем 3–5× медленнее → **4–15 мс/кадр**
в зависимости от кадра, до накладных рендера/звука (они в рантайме, как в старой версии).
Это укладывается в 16,7 мс, но без большого запаса: замер на телефоне — обязательный гейт
Phase 5. Если не влезает — инлайн чистых хелперов (`condition`, `logic_flags`,
`sign_extend`), chunked-функции для tier-up, кэш горячих обработчиков, разгрузка редких
страниц.

---

## 9. Сохранения

* Формат файла и нативный payload `DSAV v2` реализованы в рантайме (`dune_savestate.h`);
  `game.wasm` не сериализуется и не участвует в save/load. Старые сейвы совместимы,
  см. [MIGRATION.md](MIGRATION.md), [PLAN.md](PLAN.md).
* Идентичность сборки в сейве — по [SAVES.md](SAVES.md) §4: `engineSha256` остаётся
  информационным полем; старые значения принимаются, **новый экспорт пишет
  `engineSha256: null`** (парсер принимает `null` всегда). Никаких `abiHash`/`gameSha256`
  в файл сохранения не добавляем: это внутренняя идентичность кэша, а не контракт сейвов.
  Нативный payload ограничен 256 КиБ (`MAX_NATIVE_SAVE_BYTES`, буфер рантайма 262 144 Б);
  точные константы `DSAV v2` уже зафиксированы в `runtime/manifest.json` → `savestate`
  (`base_bytes` 140 056, `ram_offset` 94, `house_offset` 49 874, `mission_offset` 49 326,
  `max_buffer_bytes` 262 144) — эмиттер `game.wasm` их не касается.
* Пересборка `runtime.wasm` (новый ABI hash) не ломает сейвы: layout `DSAV v2` — это
  сериализация, а не layout `CPU`; главное — не менять формат и поля `compatibility`
  (см. SAVES.md). Смещения `DSAV` (`base_bytes`, `ram_offset`, house/mission) фиксирует
  `runtime/manifest.json`.
* Кэш `game.wasm` и сейвы независимы: удаление кэша не влияет на сохранения, смена
  ABI-хэша инвалидирует только `game.wasm`.

---

## 10. Сборка `runtime.wasm`

### 10.1. Что делаем

1. Разрезаем зафиксированную runtime-преамбулу v2 (`runtime/dune-runtime-v2.c` 129 922 Б +
   20 заголовков `runtime/adapters/` 224 074 Б, полная преамбула 130 103 Б — см.
   [RUNTIME.md](RUNTIME.md)) на обычные единицы трансляции; убираем `main`/`run_main`/массив
   ROM, оставляем web-хост (`em_main_loop_iter`/`sdl_host_service`; 71 web-UI экспорт,
   70 из них — адаптеры, см. `runtime/manifest.json` → `exports`) и 4 экспорта сейвов;
   добавляем:
   * `dune_abi.c/h` — дескриптор + self-check;
   * `dune_game.c/h` — два указателя на функции (`translated_step`, `translated_z80_step`),
     сеттер `dune_set_game_steps`, вызовы через `call_indirect`; заменяем ровно два места:
     `translated_step(&c)` и `cycles=translated_z80_step(c)`;
   * экспорты хелперов (`dune_`-префикс) — обёртки `EMSCRIPTEN_KEEPALIVE` или переименование
     статических функций (по списку из §4.1);
   * host API: `dune_host_init/load_rom/frame/...`, прогрев, сейвы (старые имена `_dune_web_*`
     сохраняем, чтобы `web/shell.js` не переписывать).
2. Собираем emcc **3.1.74** (пин SDK, как в старом репо; `tools/bootstrap_emsdk.sh` →
   перенести в новый репо):
   ```sh
   em++ -O2 -std=c++17 -sUSE_SDL=2 -sIMPORTED_MEMORY=1 \
        -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=268435456 -sSTACK_SIZE=16777216 \
        -sALLOW_MEMORY_GROWTH=1 -sMODULARIZE=1 -sEXPORT_NAME=DuneRuntime \
        -sINVOKE_RUN=0 -sASYNCIFY=0 -sEXPORTED_RUNTIME_METHODS='["wasmTable","HEAPU8","HEAPU32","UTF8ToString"]' \
        -sEXPORTED_FUNCTIONS='["_dune_host_init",…, "_dune_read_mem",…]' \
        runtime/dune-runtime-v2.c runtime/dune_game.c runtime/ymfm/ymfm_*.cpp \
        -o build/runtime.wasm
   ```
   (точные флаги и список функций фиксируются в `runtime/manifest.json`; `-sINITIAL_MEMORY`
   согласовать с размером `Memory` из JS: emcc предупреждает/ругается, если импортируемая
   память меньше).
3. **Артефакт и манифест:** `runtime.wasm` + `runtime.js` (emcc glue) — в git или как
   release-артефакт CI; манифест: версия emcc, флаги, SHA-256 wasm/js, `abi_hash`, список
   экспортов. `tools/build_runtime.py` пересобирает, `tools/verify.py` сверяет SHA.
   Ограничение `tools/check_no_game_data.py` (бинарники > 4 МБ) придётся учесть: рантайм — наш
   код без данных игры, поэтому либо allowlist по SHA, либо сборка в CI и деплой артефактом.
4. Проверки рантайма без игры: инстанцирование с пустой заглушкой `translated_step` (trap) и
   `dune_abi_selfcheck`; smoke в headless Chrome; проверка `wasmTable.set` (см. §5.2).

### 10.2. Что нельзя менять

* семантику хелперов из §4.1 (вход/выход, fault-поведение, big-endian, маски) — иначе
  `game.wasm` врёт; любое изменение = новая `helper_abi_version` и новый `abi_hash`;
* формат `DSAV v2` и web-совместимые экспорты сейвов/меню;
* порядок полей `CPU` можно менять свободно (эмиттер получает offsets из дескриптора), но
  `abi_hash` при этом обязан измениться — иначе старый кэш `game.wasm` «прилипнет» к новому
  layout.

---

## 11. Генерация `game.wasm` на устройстве

### 11.1. Поток

1. Оболочка принимает ROM, проверяет размер/SHA по профилю (как сейчас).
2. `rom → OPFS/память`; ключ кэша `sha256(rom_sha256|abi_hash|generator_version)`.
3. Если в OPFS есть `game-<key>.wasm` + meta (и `abi_hash` совпал) — Pyodide не нужен.
4. Иначе запускается Web Worker с Pyodide (0,94 с загрузка на M1, в продукте — lazy/кэш):
   `decode/discovery/cycles/z80` — как в спайке; затем новый `wasm_emitter.py` с ABI-JSON →
   `game.wasm` bytes + метрики; воркер возвращает ArrayBuffer (transferable) и **завершается**
   (освобождает ~100 МБ Pyodide heap до старта игры).
5. JS пишет bytes в OPFS, передаёт в `WebAssembly.compile`, инстанцирует (§5.1), прогревает.
6. Ошибки (ROM не тот, сбой эмиссии) — понятные коды, ничего не кэшируется.

### 11.2. Устройство Python-эмиттера

Модуль `web/py-src/wasm_emitter.py` (stdlib, 3.9+ совместимый):

* вход: `Program` (`decode.analyze`), `ZProgram` (`z80`), ROM-образы, ABI-дескриптор,
  профиль (ROM size, entry points), `cycles.py`;
* строит:
  1. таблицу ABI-констант (offsets/enum) из дескриптора;
  2. type/import/function/export/code секции (PoC `wasm_emit.py` — основа; добавить
     данные/стриминг не нужны);
  3. постраничные функции: prologue, слот-`br_table`, инлайн-обработчики;
  4. `translated_step`, `translated_z80_step`, `warmup_all`;
  5. RAM-guard’ы 68000 (если есть) и все Z80-варианты;
* переиспользует шаблоны C-эмиттера: каждый блок `self.put("c->d[...] = ...")` превращается
  в вызов мини-функции `emit_store_reg()/emit_read_mem()/emit_arith()/emit_branch()/…`;
  покрытие — все op’ы из `emit.py` + `z80.py` (таблица соответствия op → шаблон);
* оптимизации на этапе эмиссии: `condition` один раз; `sign_extend`/`mask_for` инлайн;
  `index_value` инлайн; отсутствующие слоты не получают блоков (только default);
  immediates — короткие LEB; локальные временные — переиспользуются;
* вывод — `bytearray` (~6–9 МБ), sha256, метрики (по страницам/op’ам) для тестов и телеметрии;
* детерминизм: одинаковые ROM+ABI+версия эмиттера → побайтно одинаковый `game.wasm` (тест).

### 11.3. Оценка времени/памяти

* Спайк: discovery 5,16 с + трансляция/эмиссия C 2,97 с (M1, Pyodide 0.28.3). Новый эмиттер
  делает ту же работу, но вместо 20 МБ C-строки пишет 6–9 МБ байтов; по объёму — быстрее,
  но добавляет работу на инструкцию (шаблоны в Python). Реалистично 3–8 с поверх спайка на M1,
  то есть **9–13 с полной первой сборки**; телефон 3–5× → 30–60 с (единственный раз).
* Память: Pyodide heap в спайке 103,5 МБ при 20 МБ C; без 20 МБ C-строки и 6 МБ hex-ROM
  ожидаем 60–100 МБ, пик — на bytearray; после `terminate()` воркера heap освобождается.
  Основная вкладка после генерации: `Memory` 64–128 МБ + код `game.wasm` (V8 code space
  10–30 МБ) + ROM 1 МиБ. Итог 120–200 МБ — проверять на iPhone (Phase 4).
* Кэш: OPFS-файл 6–9 МБ; повторный старт — без Pyodide; `WebAssembly.compile` 8 МБ ≈ 10 мс
  (масштабирование от замера 920 КБ → 1,3 мс), прогрев 48 страниц ≈ 60–120 мс.

---

## 12. Что уже есть, что писать (честно)

| Работа | Есть | Нужно |
|---|---|---|
| анализ 68000 (decode/discovery/ram_variants) | ✔ ReArrakis | не трогать |
| Z80 IR и образы | ✔ | не трогать |
| циклы инструкций | ✔ `cycles.py` | не трогать |
| C-эмиттер (шаблоны операторов, диспетчер, страницы) | ✔ `emit.py` как спецификация | переписать принтер под WASM (все op’ы) |
| runtime C (CPU/VDP/звук/сейвы/хост) | ✔ преамбула v2 + 20 адаптеров (RUNTIME.md) | разделить на TU, ABI-слой, экспорты хелперов, 2 точки вызова, сборка emcc без `main`/ROM |
| кодировщик WASM | ✔ **PoC** `prototype/wasm/wasm_emit.py` | расширить при необходимости (global/data) |
| диспетчеризация/ABI/связка двух модулей | ✔ **PoC** (br_table, table+call_indirect, дескриптор-идея) | боевой ABI-дескриптор, прогревы, интеграция с emcc `wasmTable` |
| эмиттер `game.wasm` (боевой) | ✘ | 1–2 недели |
| загрузка двух модулей, OPFS-кэш, Pyodide-воркер с WASM-выходом, прогревы, кэш-ключи | ✘ (есть оболочка C-варианта) | 3–5 дней |
| дифференциальные тесты против C-оракула | ✘ (в старом репо есть нативная сборка) | 3–5 дней, параллельно эмиттеру |
| сборка/манифест `runtime.wasm`, CI | ✘ (есть старый build.sh) | 2–3 дня |
| замеры на телефоне, тюнинг | ✘ | 2–3 дня |

Оценка этапа: **2–3 недели** (сходится с PLAN §9.1: 1–2 недели бэкенд + 1–2 недели интеграция),
из них самая рискованная часть — эмиттер + дифференциальная отладка.

---

## 13. Верификация

Уровни (каждый следующий включает предыдущие):

1. **Кодировщик:** unit-тесты LEB128/секций (есть в PoC), `WebAssembly.validate` каждого
   сгенерированного модуля в CI, детерминизм сборки (sha256).
2. **Обработчики:** «золотые» тесты эмиттера на IR: для набора инструкций (по семействам EA и
   op’ов) сравниваем последовательность wasm-инструкций с ожидаемой (snapshot), плюс
   выполнение одиночного обработчика на подготовленном `CPU`/RAM и сверка состояния с
   эталонным состоянием, посчитанным на C-оракуле (см. п. 3, режим одной инструкции).
3. **C-оракул (главный):** эталонный `dune-base.c` компилируется нативно (headless, как в
   старом репо) и даёт точное состояние `CPU`+RAM+VRAM+Z80 RAM на любом шаге. Тестовый стенд:
   * обе реализации стартуют с одного ROM и одинакового `DSAV`-состояния;
   * фиксированный бюджет шагов (например 5/10/30 млн) и одинаковые входы (в headless — без
     ввода, но с детерминированным `pad_buttons`, включая сценарии меню/миссий);
   * на границе шага сравниваются: `d`, `a`, `pc`, `usp`, `ssp`, `sr`, `fault`, `cycles`,
     `master_cycles`, `steps`, `halted`, RAM 64 КиБ, VRAM 64 КиБ, CRAM/VSRAM, Z80 RAM, PSG/
     YM-регистры, `vdp.line/line_clock/frames/rendered_frames`.
   * при расхождении — бисер: обе стороны с `--trace` (PC на шаг) и/или бинарный поиск по
     номеру шага до первой различающейся инструкции; в WASM-рантайме для этого предусмотреть
     кольцевой trace-буфер (флаг окружения/QA-режим, не в продакшн-пути).
4. **Побайтовая сверка вывода кадра:** старая версия умеет `--dump-frame`/`--dump-vram`; новый
   стенд повторяет это на стороне WASM (экспорт рантайма в QA-режиме) — сравнение PNG/PPM.
5. **Браузерный smoke:** headless Chrome — ROM → генерация → старт → 60 c эмуляции →
   сейв/лоад; метрики времени/памяти/размера; iPhone Safari — вручную владельцем.
6. **Перф:** счётчики рантайма (инструкций/кадр, мс/кадр, доля в бюджете), на M1 и телефоне;
   гейт: 60 Гц в бою с запасом ≥20 %.
7. **Сейвы:** старый файл → новая версия → миссия продолжается; экспорт → старая версия;
   повторный запуск с кэшем и без кэша `game.wasm`; несовместимый ABI/ROM → понятная ошибка.

Критерий приёмки этапа: три сценария (загрузка до титульного экрана, 60 с миссии, save→load)
дают побитово одинаковое состояние против C-оракула на выбранных границах; браузерный smoke
зелёный; перф-гейт выполнен.

---

## 14. Риски и деградации

| # | Риск | Вероятн. | Влияние | Меры / триггер / fallback |
|---|---|---|---|---|
| R1 | Перф на телефоне: hand-emitted WASM медленнее emcc | средняя | 60 Гц под угрозой | измерено: 11,8 тыс. инструкций/кадр, 2,0 хелпера/инструкцию, warm 0,08–0,12 мкс/инстр (M1) → 1,2–1,4 мс/кадр на M1, 4–15 мс/кадр на телефоне; гейт Phase 5 — 60 Гц в бою с запасом ≥20 %; меры: инлайн чистых хелперов (даёт ~30 % вызовов), chunked-функции для tier-up, устранение лишних local.set; триггер — >14 мс/кадр |
| R2 | JSC (Safari) не любит глубину 98 / функции ~300 КБ | низкая-средняя | не запустится/лаги | V8 подтверждён PoC; триггер — Safari smoke; fallback — chunked (глубина ≤40, функции ≤20 КБ), флаг эмиттера |
| R3 | Разъезд ABI рантайм↔игра | средняя | краши/порча | дескриптор + selfcheck + ABI hash в ключе кэша + boot-check; CI-тест «старый game.wasm с новым рантаймом → отказ» |
| R4 | Память iPhone при генерации (Pyodide + модули) | средняя | OOM/выгрузка вкладки | воркер-генератор + terminate; не грузить рантайм до конца генерации; OPFS-кэш; замер на устройстве; fallback — разбить Pyodide-процесс на два (анализ/эмиссия) или генерировать в OPFS-стрим |
| R5 | Точность: 40 382 обработчика, ошибки в редких op’ах/флагах | высокая (объём) | неверное поведение игры | дифференциальный C-оракул + trace-бисер + покрытие всех op’ов тестами; релиз после 3 сценариев |
| R6 | Сборка рантайма/emcc-таблица | средняя | этап 1 блокируется | PoC подтвердил `call_indirect`-связку; три пути для таблицы (§5.2); pinned SDK 3.1.74 |
| R7 | Размер `game.wasm` >10 МБ | средняя | время компиляции/память | оптимизации таблиц/слотов, «только присутствующие»; триггер — реальная страница; fallback — chunked+shared tails |
| R8 | Pyodide/офлайн/12 МБ на телефоне | низкая | первый запуск | lazy + кэш (уже в оболочке C-варианта); генерация только по кнопке; прогресс по фазам |
| R9 | Легальность: `game.wasm` — производная ROM | — | блокер | в git/Pages не попадает, только OPFS у игрока; runtime.wasm (наш код) — можно; сейв/кэш не загружаются на сервер |
| R10 | SDL2/аудио-путь в рантайме после разделения | низкая | звук/видео | рантайм меняется только в 2 точках вызова; старый web-адаптер сохраняется; smoke старой версии как эталон |

---

## 15. Поэтапный план (что можно проверить раньше)

| Phase | Содержание | Выход/гейт | Оценка |
|---|---|---|---|
| **0** | PoC (этот репозиторий): кодировщик, диспетчеризация, ABI, heavy-страница, стоимость вызовов | `run_poc.mjs` → 118 OK ✔ | сделано |
| **1** | `runtime.wasm` v2: разделение, ABI-дескриптор, экспорты хелперов, таблица, заглушка игры `trap`; smoke-загрузка в Chrome | загружается, `dune_abi_descriptor` валиден, `wasmTable.set` работает, аудио/видео старой версии живы | 2–3 дня |
| **2** | Эмиттер v0: 12–15 op’ов (MOVE/MOVEA/MOVEQ/ADDQ/SUBQ/BCC/BRA/JSR/RTS/LEA/push/pop/read/write), `translated_step`, одна-две реальные страницы ROM; прогон против C-оракула | первые 10–50 тыс. шагов побитово совпадают | 2–3 дня |
| **3** | Полный эмиттер 68000 + Z80 + RAM-варианты + все хелперы + CSE/инлайн | 3 сценария против оракула; `game.wasm` 5–9 МБ, все op’ы покрыты | 5–7 дней |
| **4** | Устройство: Pyodide-воркер → `game.wasm`, OPFS-кэш, загрузка двух модулей, прогревы, save/load, прогресс | Chrome Android smoke, iPhone Safari smoke, повторный старт из кэша <3 с | 3–4 дня |
| **5** | Перф/память на телефоне, тюнинг (chunked при необходимости), телеметрия, финальные тесты | 60 Гц с запасом, память в лимите, известные дефекты перечислены | 2–3 дня |

Что можно проверить **до** готового рантайма (полезно начать параллельно):

1. эмиттер на реальных `Program`/`ZProgram` без исполнения: размеры, покрытие op’ов, детерминизм,
   время генерации в Pyodide (выход — bytes, без C);
2. одну реальную ROM-страницу (например, page 0 с точкой входа `$000200`) прогнать в PoC-рантайме
   (JS-стабы) до шага N и сверить с нативным C-оракулом; это самая дешёвая проверка шаблонов и
   семантики ABI;
3. `memory`/время/`wasmTable` — на текущем `runtime.wasm` v2 (даже заглушечном);
4. размеры `game.wasm` по реальным страницам — экстраполяция на 48 страниц до полной реализации.

---

## 16. Открытые вопросы / вне scope

* Кто владеет `runtime/abi/*.json` и генератором дескриптора (сборка рантайма vs эмиттер) —
  зафиксировать в Phase 1; сейчас ответственность сборки рантайма.
* Политика репозитория для артефакта `runtime.wasm` (коммит vs CI-артефакт vs GitHub
  release) — влияет на `tools/check_no_game_data.py` (allowlist по SHA).
* `wasmTable` vs `--export-table` vs `--import-table` — решить по результату Phase 1 (§5.2).
* Аудио: остаётся emscripten SDL2 + AudioWorklet старой версии; при переезде на «родной»
  bridge менять только хост рантайма.
* Фронтенд, тач/зум/меню, локализация, PWA/офлайн — этапы 6–7, здесь не рассматриваются.
* iPhone: `performance.measureUserAgentSpecificMemory`, лимиты вкладки — только замер.

---

## Приложение A. Полный список helper-ABI

C-сигнатуры — из `genesis_recompiler/runtime.h` и `z80_runtime.h` (эталон), в WASM все
целые — `i32`, указатель `c` — `i32`.

68000:

```
read_mem(c, addr, size) -> u32
write_mem(c, addr, size, value)
push32(c, value) / pop32(c) -> u32
movem(c, mask, address, mode, base, size, load)
set_sr(c, sr)
logic_flags(c, value, size)
arithmetic(c, dst, src, size, sub, compare) -> u32
extended_arithmetic(c, dst, src, size, sub) -> u32
bcd_arithmetic(c, dst, src, sub) -> u32
bcd_negate(c, value) -> u32
shift_value(c, value, count, size, kind, left) -> u32
divide_value(c, dividend, divisor, is_signed) -> u32
condition(c, cond) -> u32
index_value(c, extension) -> u32
fail(c, reason, address)
```

Z80 (все через `c`):

```
z80_pair(c, pair) -> u16        z80_set_pair(c, pair, value)
z80_reg(c, reg) -> u8           z80_set_reg(c, reg, value)
z80_read(c, addr16) -> u8       z80_write(c, addr16, value)
z80_read16(c, addr16) -> u16    z80_write16(c, addr16, value)
z80_pop(c) -> u16               z80_push(c, value16)
z80_m1(c, fetches)              z80_szxy(value) -> u8
z80_alu(c, kind, src)           z80_alu16(c, kind, value)
z80_inc(c, value, delta) -> u8  z80_add_pair(c, pair, value) -> u16
z80_add_hl(c, value)            z80_condition(c, cond) -> u32
z80_bit(c, value, bit, xy)      z80_block(c, op, direction) -> u32
z80_rotate(c, value, kind) -> u8
```

Плюс `fail(c, reason, address)` — общий. `sign_extend`/`mask_for` инлайнятся.

Статическая частота вызовов в эталонном C (call sites, 68000+Z80): `logic_flags` ~17,9k,
`condition` ~10,7k, `read_mem` ~7,6k, `write_mem` ~7,0k, `arithmetic` ~4,5k, `z80_m1` 3,1k,
`push32` ~3,3k, `fail` ~2,8k, `z80_pair` ~1,1k, остальные — сотни. Итого ~67k call sites;
динамически — ~1,4 млн/с, стоимость на границе модулей измерена (§0.1).

## Приложение B. Поля ABI-дескриптора v1

`magic`, `version`, `size`, `abi_hash`, `helper_abi_version`, `sizeof_cpu`,
`off_d`, `off_a`, `off_pc`, `off_usp`, `off_ssp`, `off_sr`, `off_fault`,
`off_instruction_cycles`, `off_cycles`, `off_master_cycles`, `off_steps`, `off_halted`,
`off_io_data`, `off_io_control`, `off_pad_buttons`,
Z80: `off_z80_r8`, `off_z80_alternate`, `off_z80_a`, `off_z80_f`, `off_z80_a_alt`,
`off_z80_f_alt`, `off_z80_i`, `off_z80_r`, `off_z80_iff1`, `off_z80_iff2`, `off_z80_im`,
`off_z80_halted`, `off_z80_irq_line`, `off_z80_ei_delay`, `off_z80_pc`, `off_z80_sp`,
`off_z80_ix`, `off_z80_iy`, `off_z80_wz`, `off_z80_debt`, `off_z80_cycles`,
адреса: `cpu`, `ram`, `z80_ram`, `rom`, `rom_size`, `vdp_vram`, `vdp_cram`, `vdp_vsram`,
`frame`, `save_buffer`, `save_buffer_size`,
enum: `F_C/V/Z/N/X`, `Z_C/N/PV/X/H/Y/Z/S`, `SHIFT_KIND_ARITH/LOGICAL/ROX/ROT`,
`SIZE_B/W/L`, `FAIL_*` (коды ниже).

Коды `fail` (числа — ABI): `UNTRANSLATED=1`, `BAD_PC=2`, `ODD_PC=3`, `UNMAPPED=4`,
`RAM_VARIANT=5`, `PRIVILEGE=6`, `ADDRESS_ERROR=7`, `UNMAPPED_READ=8`, `UNMAPPED_WRITE=9`,
`ILLEGAL_INSTRUCTION=10`, `DIVISION_BY_ZERO=11`, `SERIAL_NOT_IMPLEMENTED=12`,
`VDP_ACCESS=13`, `Z80_PERIPHERAL=14`. Строки — в рантайме; C-эмиттер → коды.

## Приложение C. Будущая карта файлов

```
runtime/
  dune-runtime-v2.c        рантайм v2 (из преамбулы; см. RUNTIME.md), MIT
  adapters/                20 web-адаптеров (224 074 Б) — источник рантайма
  dune_game.c/h            указатели на translated_step/z80 + сеттер; call_indirect
  dune_abi.c/h             дескриптор, selfcheck, коды причин
  dune_host.c/h            web-хост (init/frame/input/save), старые _dune_web_* имена
  abi/runtime-abi-v1.json  pinned fallback-дескриптор (+ hash)
  manifest.json            версия emcc, флаги, SHA-256, abi_hash, экспорты
  ymfm/                    BSD-3 YMFM (без изменений)
tools/
  build_runtime.py         сборка runtime.wasm/js + манифест
  verify.py                сверка SHA/ABI/workspace
web/py-src/
  wasm_emitter.py          боевой эмиттер (stdlib; PoC prototype/wasm — основа)
  wasm_emit.py             кодировщик (переезжает из prototype/wasm)
  driver.py                Pyodide entry: ROM → game.wasm + meta
web/
  engine.js / shell.js     загрузка двух модулей, кэш, прогревы, rAF
prototype/wasm/            PoC и его команды (этот репозиторий)
```

## Приложение D. Команды PoC (воспроизводимость)

```sh
cd "/Users/oleskarpov/Documents/My Gamedev/dune-web"
/Users/oleskarpov/.local/bin/python3.12 prototype/wasm/emit_poc.py
/usr/local/bin/node prototype/wasm/run_poc.mjs
# self-test кодировщика:
/Users/oleskarpov/.local/bin/python3.12 prototype/wasm/wasm_emit.py
```

Ожидаемый вывод: `OK: 118 checks passed`. Числа из §0.1/§6.2 получены этим прогоном
(M1 Pro, Node 24.16.0, V8): heavy-модуль 920 351 Б, компиляция 1,3–1,5 мс, первый вызов
страницы ~2,0–2,3 мс, warm 0,08–0,12 мкс/инструкцию; ABI-вызов: internal ~2,4–2,5 нс,
import 2,1–4,4 нс, JS 3,9–4,2 нс, call_indirect 2,1–2,2 нс.

Нативный C-оракул для дифференциальных тестов и профиля (§8, §13) воспроизводится так
(20 МБ C компилируются clang ~30 с):

```sh
mkdir -p /tmp/dune-oracle && cd /tmp/dune-oracle
cp "/Users/oleskarpov/Documents/My Gamedev/Dune Sega Web/vendor/rearrakis/build/dune-base.c" .
clang -std=c11 -O2 -Wno-unused-function dune-base.c -o dune-headless
./dune-headless --headless --audio stub --limit 30000000
# status=budget steps=30000000 … timing cycles=325443238 frames=2542 …
```

На этом стенде же проверяется дифференциальный тест этапа 3: тот же ROM, тот же бюджет
шагов, сравнение `CPU`/RAM/VRAM/Z80 RAM с WASM-рантаймом.
