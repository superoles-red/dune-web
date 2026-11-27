# WASM audio: translated Z80 driver + YM2612/PSG → AudioWorklet

Status: **working** on the native/Nodeside path (game.wasm with a real
`translated_z80_step`, `AUDIO_ON`, non-silent PCM at 48 kHz stereo, save/load
round-trip, independent music/SFX levels).  This document records the
architecture, the ABI, how to reproduce and verify it, measured numbers and the
remaining limitations.

The port is BYOP: nothing here contains ROM bytes or translated game code in the
repository.  Z80 images are derived from the player's ROM at build time
(`.local/`, gitignored), exactly like the 68000 program.

---

## 1. Why the game was silent

Two independent stubs:

1. `game.wasm` contained only a `translated_z80_step` that reported
   `UNTRANSLATED` and returned 0 cycles (`tools/wasm_emitter/game_module.py::
   emit_z80_stub`).  Any YM2612 traffic on the real Z80 driver would fault.
2. `runtime/wasm/runtime.wasm::dune_rt_init()` hard-codes
   `em_cpu.audio_mode = AUDIO_STUB`, and `z80_tick()` returns immediately in
   that mode.  The old SDL/web-audio hooks (`dune_web_audio_worklet`,
   `em_web_audio_service`) are **path B**: they require `em_window` and an SDL
   audio device, which the standalone path-A runtime does not have.  The
   rebuilt runtime now exports `dune_rt_set_audio_mode` /
   `dune_rt_audio_pop` (§3), so the host can switch `AUDIO_ON` and drain PCM.

Both had to be removed for sound:

* the Z80 program from the original desktop build is now emitted to WASM
  (`tools/wasm_emitter/z80_translate.py`, §2);
* path A gained two tiny exports that switch the native audio mode and drain
  the 48 kHz ring (`tools/wasm_runtime/src/dune_rt_audio.inc`, §3);
* `web/host/audio.mjs` + `web/host/audio-worklet.js` move PCM to the device and
  expose music/SFX levels (§4).

---

## 2. Z80 → WASM emitter

`tools/wasm_emitter/z80_translate.py` is a direct port of the reference C
emitter `vendor/rearrakis/genesis_recompiler/z80.py`
(`z80_instruction_code`/`emit_z80`) and `z80_runtime.h`:

* **Input**: the pinned six-image plan from `tools/build_game_c.py` (upstream
  `tools/build_dune.py`), reproduced in `dune_z80_images()`/`analyze_dune_z80()`
  from the ROM:
  * image 0 `boot` = `ROM[0x2c4:0x2ea]` (38 B boot stub)
  * image 1 `base` = `ROM[0x2952:0x41dc]` (6282 B GEMS driver)
  * images 2..5 = the same driver with the verified self-modified bytes
    (`patched`/`music`/`playing`/`voice`);
  * extra entries: `2:0x2b3 3:0x2b3 4:0x2b3 5:0x2b3 5:0x2cf 1:0x38 2:0x38
    3:0x38 4:0x38 5:0x38`;
  * overlay `0:e9`; mutable displacements `0x1616`, `0x15f9` (256 variants each).
  * Result: **2577 guarded PCs / 3095 guarded instruction variants, 0 decode
    errors** (identical to the C oracle's `translated_z80_step` table, checked
    by parsing `.local/verify/dune.c`).
* **Dispatch** (2-slot game table mode): `translated_z80_step(c) -> i32` reads
  `z->pc`, rejects `pc >= 0x4000`, then dispatches 16 groups of 0x400 bytes; each
  group is a two-level `br_table` (16 chunks × 64 one-byte slots), so odd PCs and
  self-modifying variants work exactly like the C `case 0x....` labels.
* **Guards**: for every PC the C emitter compares the raw instruction bytes with
  `c->z80_bus.ram[...]`; the WASM handler does the same with
  `i32.load8_u(z80_ram + (pc & 0x1fff) + n)`, inlines every matching variant,
  then reports `FAIL_Z80` (canonical 17, the C oracle's code for both
  "Z80 PC has no static translation" and "Z80 RAM differs...").  A fault never
  advances PC, matching the C `if (c->fault) return 0;` ordering (including the
  paths where the C code writes A/BC/DE/WZ *before* the trailing fault check).
* **Semantics**: every operation calls the runtime's exported helper
  (`env.dune_z80_pair/set_pair/reg/set_reg/read/write/read16/write16/pop/push/
  m1/szxy/alu/alu16/inc/add_pair/add_hl/condition/bit/block/rotate`) and reads
  `Z80CPU` fields directly at the ABI offsets (`z80_cpu + 0 .. +64`, validated
  against the runtime descriptor in `validate_z80_layout`).  Cycle counts are
  returned exactly like the C emitter (4/7/10/11/12/13/16/17/21/23 ...).
* **Module shape unchanged**: no data segments, no memory, no globals; imports
  are `env.memory` + the 16 68000 helpers + the 21 Z80 helpers (37 functions);
  exports are `translated_step`, `translated_step_via_table`,
  `translated_z80_step`, `warmup_all`, `__indirect_function_table`.  The
  element segment now initialises **both** slots `[translated_step,
  translated_z80_step]`, matching `dune_rt_set_game_table(ptr, 2)`
  (`GAME_MODE_SINGLE`).
* **Size/time** (final, against the rebuilt runtime ABI): Z80-only module
  411 101 B (analysis 45–50 ms + emission 150 ms); full module **3 553 097 B**
  (SHA-256 `7704de7b9e5a7a61a02812e044c82b1968178399bc51f31dbeff0683b006e5fe`,
  stub was 3 142 822 B), +49 ms Z80 analysis, total build 4.4 s for all 48 pages
  (decode 3.7 s, emission 0.6 s; Apple M1 Pro, Node 24; Pyodide timings are
  larger but the code path is identical).

### Building it

```sh
# native / Node path — the playable artifact with real Z80 translation:
python3 tools/wasm_integration/build_full_module.py \
    --rom "/path/to/Dune - The Battle for Arrakis (USA).gen" \
    --z80 --out .local/wasm-full
# -> .local/wasm-full/game.wasm (real translated_z80_step)

# without --z80 the module keeps the honest UNTRANSLATED stub (existing tests).
```

The browser Pyodide build (`web/py-src/build_game_wasm.py`) emits the **same**
module: it calls `z80_translate.analyze_dune_z80(rom)` and
`game_module.build_module(..., z80_program=...)` with the same
`abi.json`/profile, so a local run of the Pyodide entry point produced
byte-identical **3 553 097 B / SHA-256 `7704de7b…`** (4.2 s in CPython;
Pyodide will be slower but deterministic).  The bundler copies every
`tools/wasm_emitter/*.py` (including `z80_translate.py`) into
`web/py-src/wasm_emitter/`.  `runtime/wasm/game-reference.json` and the three
`reference.json` files are re-pinned to `7704de7b…`; rebuilding
`web/py-package.zip` (`python3 tools/bundle_web.py`) is the only remaining
packaging step.

---

## 3. Path-A runtime audio exports

`runtime/dune-runtime-v2.c` already contains the whole native audio stack
(ymfm YM2612, PSG, 48 kHz stereo ring `AUDIO_RING_FRAMES=4096`, DC filter, peak
telemetry, `audio_sync()` called from `machine_advance` when
`audio_mode == AUDIO_ON`).  Path A only needed the SDL-side controls replaced.

`tools/wasm_runtime/src/dune_rt_audio.inc` (new) exports:

| export | signature | purpose |
|---|---|---|
| `dune_rt_audio_mode` | `() -> i32` | current mode (1 stub, 2 mute, 3 on) |
| `dune_rt_set_audio_mode` | `(i32 mode) -> i32` | switch mode; `3` lazily calls `audio_init()` and turns on ring playback (this also starts `z80_tick`, i.e. the real Z80 driver) |
| `dune_rt_audio_pop` | `(i32 ptr, i32 frames) -> i32` | drain up to `frames` interleaved i16 stereo frames into runtime memory |
| `dune_rt_audio_available` | `() -> i32` | frames currently in the ring |
| `dune_rt_audio_rate` / `dune_rt_audio_ring_frames` | `() -> i32` | 48000 / 4096 |
| `dune_rt_audio_peak` / `dune_rt_audio_frames` / `dune_rt_audio_reset_peak` | telemetry | peak \|sample\|, total generated frames |
| `dune_rt_audio_reset` | `() -> void` | drop queued output after save load / visibility change |

Hook-up (already wired in `tools/wasm_runtime/build_runtime.py`:
`write_runtime_c()` includes the file after `dune_rt_abi.inc` and the export
names are listed in `ABI_EXPORTS`, so the manifest records them):

```c
/* runtime.c in the build staging, after dune_rt_abi.inc */
#include "dune_rt_audio.inc"
```

`python3 tools/wasm_runtime/build_runtime.py --emsdk <emsdk>` then rebuilds
`runtime/wasm/runtime.wasm` + `runtime/wasm/manifest.json`, and
`tools/wasm_browser/export_abi.py` refreshes `runtime/wasm/abi.json` for the
Pyodide emitter.

**The ABI descriptor, `abi_hash fb47e138…`, the DSAV v2 layout (140 056 B) and
the helper ABI are untouched** — the file adds exports only, no imports, no
data, no struct changes.  Measured rebuild: `runtime.wasm` **898 726 B, SHA-256
`94b5f8a4d84d2358d1c06a2807e9de4a9f3c823b110d3f338a6e6bb56d4d3c68`**, 164
exports (10 new `dune_rt_audio*`), ABI hash still `fb47e138…`, deterministic
(two links byte-identical).

`tools/wasm_integration/build_audio_runtime.py` still exists as a fallback for
checkouts whose shipped runtime predates the exports; it links a test-only copy
from the same pinned preamble + ABI staging
(`.local/wasm-z80/runtime-build/runtime-audio.wasm`, identical bytes 898 726 B
when the staging matches).  Nothing shared is modified.

---

## 4. Host bridge (`web/host/audio.mjs` + `web/host/audio-worklet.js`)

```
machine_advance() ──audio_sync()──► YM2612+PSG → 48 kHz i16 stereo ring (4096 fr)
        ▲                                              │
        │ dune_rt_machine_step()                       │ dune_rt_audio_pop(ptr, n)
        │                                              ▼
   DuneHost ◄──────────── DuneAudio.pump() ─────► AudioWorkletNode('dune-pcm')
                                                        │ process() → destination
```

* `DuneAudio.enable()` must run inside a user gesture: creates/resumes the
  `AudioContext({sampleRate: 48000})`, loads the worklet module, allocates a PCM
  scratch buffer with the runtime's `malloc`, calls
  `dune_rt_set_audio_mode(3)` and `dune_web_audio_levels(music, sound)`.
* `DuneAudio.pump({maxChunks})` drains the ring in 2048-frame packets and posts
  transferable `Int16Array`s to the worklet; it also accumulates host-side peak /
  RMS telemetry (`stats()`).
* The worklet owns a 16384-frame playback ring, writes the device clock, reports
  `{frames, underruns, queued}` every 4800 frames and drops the oldest frame if
  JS overproduces (same policy as the SDL path — the chip clock is never
  rewound).
* `setLevels(music, sound)` forwards percent levels (100/50/25/10/0) to
  `dune_web_audio_levels`; the native `em_web_audio_levels.h` maps GEMS physical
  voices to music/SFX classes without touching CPU or save state.
* `flush()/resetPeak()/suspend()/resume()/disable()` handle save load, visibility
  and pause.  `disable()` sets the runtime back to `AUDIO_STUB`.

### Exact host wiring (for `web/host/host.mjs` / the parent shell)

```js
// 1. import once (host.mjs)
import { DuneAudio } from './audio.mjs';

// 2. in the DuneHost constructor, after this.exports exists at boot time
//    (safe before boot: DuneAudio only touches the runtime when enabled):
this.audio = new DuneAudio({ host: this });

// 3. user gesture (button/pointerdown handler in the shell or debug page)
await host.audio.enable();          // AudioContext + worklet + AUDIO_ON

// 4. frame loop, after advancing the machine (e.g. in start()'s rAF callback
//    right after host.advanceSteps(...)):
host.audio.pump();                  // no-op until enabled

// 5. pause/visibility/save-load:
host.audio.suspend(); host.audio.resume();
host.audio.flush();                 // after host.loadState(bytes)
host.audio.setLevels(musicPercent, soundPercent);  // 100/50/25/10/0
host.audio.stats();                 // {frames, peak, rms, worklet…}
```

Runtime exports the bridge calls (all in the rebuilt `runtime.wasm`):
`dune_rt_set_audio_mode`, `dune_rt_audio_pop`, `dune_rt_audio_available`,
`dune_rt_audio_rate`, `dune_rt_audio_ring_frames`, `dune_rt_audio_peak`,
`dune_rt_audio_frames`, `dune_rt_audio_reset_peak`, `dune_rt_audio_reset`,
`dune_web_audio_levels`.  `enable()` requires the 2-slot game table (real
`translated_z80_step`) to be installed, otherwise `AUDIO_ON` starts the Z80 and
the machine faults.

The bridge never touches emulation state: it only moves native PCM to the
device.  Audio stays silent and costs nothing until `enable()` is called.

---

## 5. How to verify

### 5.1 Z80 differential (native C oracle ↔ runtime.wasm + game.wasm)

```sh
python3.12 tools/wasm_integration/z80_differential.py \
    --rom "/path/to/Dune - The Battle for Arrakis (USA).gen" \
    --baseline "/path/to/vendor/rearrakis/build/dune-base.c" \
    --states 2 --json
```

What it does: builds a Z80-only `game.wasm` (411 KB) against the *live* runtime
ABI, writes `DZC1` cases (one per guarded variant × N random Z80/CPU states,
instruction bytes patched into Z80 RAM at `pc&0x1fff`), runs the native C
`translated_z80_step` and the runtime's `dune_rt_translated_z80_step` (real
`dune_z80_*` exports, 2-slot game table), and compares the full Z80 register
file, PC/SP/IX/IY/WZ, IFF/IM/halted/ei_delay/debt/steps/cycles/interrupts, fault
flag/address/canonical code and both RAM digests (8 KiB Z80 RAM, 64 KiB 68000
RAM).  Fault mapping uses the C `reason` strings on both sides.

Measured on the Dune USA ROM (`.local/verify/dune.c` baseline, same bytes as
`dune-base.c e3055a76…`) against the rebuilt runtime
(`runtime.wasm 898 726 B`, ABI `fb47e138…`):

| states/variant | cases | mismatches | oracle=wasm faults | histogram (canonical) |
|---|---|---|---|---|
| 1 | 3 095 | **0** | 375 | `{11: 223, 17: 152}` |
| 2 | 6 190 | **0** | 785 | `{11: 462, 17: 323}` |
| 4 | 12 380 | **0** | 1 532 | — |

`11 = write to ROM`, `17 = Z80 failure` (UNTRANSLATED/RAM-VARIANT/peripheral);
the 462 write-to-ROM faults are Z80 writes into the ROM window, reproduced
identically by both implementations.  Runtime: build 150–173 ms, oracle 2–7 s
(cached clang −O0 binary), WASM harness 1.2–4.8 s, total 3.4–12.4 s.

### 5.2 In Node, with real gameplay (no browser)

```sh
node tools/wasm_integration/audio_probe.mjs \
  --runtime runtime/wasm/runtime.wasm \
  --game .local/wasm-full/game.wasm \
  --rom "/path/to/Dune (USA).gen" --seconds 8
```

Boots the ROM, sets `AUDIO_ON`, runs 8.01 s of emulated time (6.03 M 68000
instructions, 356 video frames), drains native PCM:

```
instructions 6 028 938   renderedFrames 356   fault null
Z80: steps 2 198 795 (22 303 468 cycles), pc 0x2b7 region
audio: 384 620 frames = 8.01 s @ 48 kHz, peak 718 / 32767, RMS 105.3
```

Zero faults during the whole boot → SEGA logo → publisher logos → title/menu
sequence: the translated Z80 driver executes the original GEMS code and the
music is audible (RMS > 0).  A 1 s run already produces 48 193 frames
(peak 378, RMS 19.4).

### 5.3 Browser end-to-end (headless Chrome)

```sh
DUNE_ROM="/path/to/Dune (USA).gen" node --test tests/host/audio.test.mjs
```

The test builds `game.wasm --z80` against an audio-enabled runtime, serves the
repository, and in headless Chrome proves:

* `AudioContext.state === 'running'`, worklet loaded and consuming packets;
* title/menu (30 M 68000 instructions, >100 video frames) has `peak > 0`,
  `RMS > 1`, >48 000 audio frames (~1 s) and >10 packets;
* DSAV v2 save/load round-trip keeps the machine fault-free and audio flowing;
* `dune_web_audio_levels(0,0)` mutes (RMS < 1/20 of title) and `(100,100)`
  restores (RMS > 5× muted): independent music/SFX levels work.

Measured run (Apple M1 Pro, headless Chrome 120+, shipped audio runtime):

| metric | value |
|---|---|
| instructions / video frames | 36 058 225 / 3 115 |
| wall clock for the whole scenario | **6.9 s** (emulation runs faster than realtime) |
| AudioContext / worklet | `running`, 48 000 Hz, loaded, consuming |
| title/menu PCM (host drain) | 2 037 396 frames, peak **4 836** / 32767, RMS **530.1** |
| worklet consumed | 2 036 265 frames (same audio, ring overflow drops while the test drains at ~6× realtime) |
| DSAV v2 save | 140 921 B = 140 056 B base + 865 B YM2612 state |
| after load | context running, 139 373 frames pumped, RMS 559.0 |
| levels muted (0/0) | RMS 3.41 |
| levels restored (100/100) | RMS 368.5 |
| fault | none |

Without the ROM the test skips.  Without a runtime that exports the audio hooks,
it builds the test-only runtime (§3) automatically.

### 5.4 Test suites

```sh
python3.12 -m unittest discover -s tests/wasm_z80 -v      # 14 ROM-free + differential
python3.12 -m unittest discover -s tests/wasm_full
python3.12 -m unittest discover -s tests/wasm_emitter
python3.12 -m unittest discover -s tests/wasm_integration
node --test 'tests/wasm_runtime/**/*.test.mjs'
DUNE_ROM=... node --test tests/host/audio.test.mjs
node tests/browser/play.mjs
```

ROM-free `tests/wasm_z80/test_z80_emitter.py` checks the layout against the live
ABI, the module shape/imports/exports and executes NOP/LD16/LD8/DI/EI/JP/guard
mismatch/out-of-range PC through `runtime.wasm` (14 assertions groups).
`tests/wasm_z80/test_z80_differential.py` runs the full 3095-variant differential
and skips without `DUNE_ROM`/`DUNE_BASELINE`.

---

## 6. Limitations / what is left

1. **Browser bundles.** `web/runtime/{runtime.wasm,loader.mjs}`,
   `web/py-src/abi.json` and `web/reference.json` were refreshed with
   `tools/bundle_web.py` after the runtime rebuild (12:08) and now point at
   `runtime.wasm 898 726 B / SHA 94b5f8a4…`; the Pyodide build still emits the
   Z80 stub, so `web/reference.json` pins the stub artifact (`e79ba876…`,
   3 142 823 B) until the Pyodide emitter is switched to real Z80 (below).
   `web/host/host.mjs` / `web/host/play.html` already work against
   `runtime/wasm/runtime.wasm` directly.
2. **Pyodide package must be re-bundled once.** `web/py-src/build_game_wasm.py`
   now emits the real Z80 module (3 553 097 B / `7704de7b…`, +410 KB and a few
   seconds of build time), and the reference JSONs are re-pinned, but
   `web/py-package.zip` and `web/vendor` are generated: run
   `python3 tools/bundle_web.py` once to publish the new Pyodide package.  Until
   then the page checks the build against the committed reference and rejects
   the old (stub) build.
3. **UI wiring.** `web/host/host.mjs` does not call `DuneAudio` yet (the audio
   path is tested directly on `DuneHost`; the parent adds the one import + two
   call sites after the concurrent host edits land).  `web/app.mjs` is out of
   scope for this task.
4. **Audio during fast-forward / hidden tab.** The bridge handles
   `suspend()/resume()/flush()` but the app shell must call them on
   `visibilitychange`/pause; otherwise the ring drops frames (native `dropped`
   counter) while the worklet is suspended.
5. **Save-state audio.** DSAV v2 keeps the chip state (`ym_size` field) but the
   host output ring is deliberately not saved; `audio.flush()` is called after
   load.  A few milliseconds of pre-save PCM are discarded — by design.
6. **Accuracy limits inherited from the original port.** The Z80 translation only
   covers the guarded images (2577 PCs); a PC outside them, or RAM bytes that
   match no variant, faults with canonical 17 exactly like the C core.  The
   differential proves equivalence with the C oracle, not with a silicon
   Genesis: ymfm/PSG details and the audio clock come from the pinned runtime
   (`AUDIO_RATE=48000`, master/7), not from a hardware capture.
