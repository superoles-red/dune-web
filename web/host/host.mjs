/* Dune BYOP browser host (path A: standalone ``runtime.wasm`` + JS import mocks).
 *
 * The runtime is the shipped ``runtime/wasm/runtime.wasm`` (STANDALONE_WASM with
 * imported memory).  Every ``env``/WASI import is satisfied by the loader's
 * defaults (zero-returning stubs): the game loop never calls into SDL/GL/audio,
 * it only needs the emulated CPU/VDP, and the VDP software renderer writes RGB
 * frames that ``dune_web_frame_rgb()`` points at.  The generated ``game.wasm``
 * imports ``env.memory`` plus the ``env.dune_*`` helper exports and is wired to
 * the runtime through its exported funcref table (``GAME_MODE_SINGLE``).
 *
 * Everything here is MIT code with no game data: the player ROM is copied into
 * the runtime's 1 MiB ``dune_rt_rom_buffer()`` and never leaves memory.
 *
 * Usage (browser):
 *   import { DuneHost } from './host.mjs';
 *   const host = new DuneHost({ canvas: document.querySelector('canvas') });
 *   await host.init({ gameUrl: '/.local/wasm-full/game.wasm' });
 *   await host.loadRomFromBytes(romBytes);   // ROM -> dune_rt_rom_buffer()
 *   host.boot();                             // reset vector -> CPU, window=1
 *   host.start();                            // rAF: step + draw RGB frames
 */

import {
  loadRuntime,
  initRuntime,
  loadRom,
  appendFunctions,
  installGameTable,
  cString,
} from '../runtime/loader.mjs';
import { DuneAudio } from './audio.mjs';

const DEFAULT_RUNTIME_URL = new URL('../runtime/runtime.wasm', import.meta.url).href;
const DEFAULT_GAME_URL = new URL('../../.local/wasm-full/game.wasm', import.meta.url).href;

const FALLBACK_MASTER_HZ = 53693175; // Genesis NTSC master clock (68k × 7)
const EMULATED_FPS = 60;
const ROM_BYTES_EXPECTED = 1024 * 1024;
/* Path A has no SDL window; the camera/tap adapters read this virtual surface
   (native frame coordinates, not CSS pixels).  See docs/WASM-TOUCH.md. */
const TOUCH_WIDTH = 320;
const TOUCH_HEIGHT = 224;

function be32(bytes, offset) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function decodeCString(rt, pointer) {
  try {
    return cString(rt, pointer);
  } catch {
    return '';
  }
}

/** Runtime/config failure that the debug page should show verbatim. */
export class HostError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'HostError';
    this.cause = cause;
  }
}

export class DuneHost {
  constructor(options = {}) {
    this.canvas = options.canvas ?? null;
    this.ctx = this.canvas ? this.canvas.getContext('2d', { alpha: false }) : null;
    this.runtimeUrl = options.runtimeUrl ?? DEFAULT_RUNTIME_URL;
    this.gameUrl = options.gameUrl ?? DEFAULT_GAME_URL;
    this.onStatus = options.onStatus ?? (() => {});
    this.log = options.log ?? ((...args) => console.log('[host]', ...args));
    /* Virtual SDL surface for the pinned camera/tap adapters (path A). */
    this.virtualWindow = options.virtualWindow ?? { width: TOUCH_WIDTH, height: TOUCH_HEIGHT };
    /* Run the path-B input observers before each native step so queued touch
       input reaches the original game code (disable for pure-emulation runs). */
    this.touchStepping = options.touchStepping ?? true;

    this.rt = null;
    this.abi = null;
    this.game = null;
    this.memory = null;
    this.exports = null;
    this.cpuPointer = 0;
    this.offsets = {};
    this.addresses = {};
    this.masterHz = FALLBACK_MASTER_HZ;

    this.romBytes = null;
    this.gameBytes = null;
    this.loadedAt = null;
    this.booted = false;
    this.fault = null;
    this.touch = { attached: false, width: TOUCH_WIDTH, height: TOUCH_HEIGHT, dragging: false, error: null };

    this.imageData = null;
    this.lastSerial = -1;
    this.audio = new DuneAudio({ host: this });
    this.presentation = 'auto';        // 'auto' | 'native' | 'expanded'
    this.expandedIntervalMs = 33;      // expanded overview redraw budget (~30 fps)
    this.lastExpandedAt = 0;
    this.lastFrameWidth = 0;
    this.lastFrameHeight = 0;
    this.frameCount = 0;

    this.running = false;
    this.rafHandle = 0;
    this.lastTick = 0;
    this.lastCycles = 0;

    this._dataView = null;
    this._dataBuffer = null;

    this.metrics = {
      status: 'created',
      runtimeBytes: 0,
      gameBytes: 0,
      gamePages: 0,
      gameInstructions: 0,
      instructions: 0,
      masterCycles: 0,
      emulatedSeconds: 0,
      renderedFrames: 0,
      frameWidth: 0,
      frameHeight: 0,
      steps: 0,
      lastRunSteps: 0,
      lastRunMs: 0,
      stepsPerSecond: 0,
      frameMs: 0,
      fps: 0,
      loadMs: 0,
      linkMs: 0,
      bootMs: 0,
      fault: false,
      failCode: 0,
      failReason: '',
      failAddress: 0,
    };
    this.timings = { runtimeLoadMs: 0, gameCompileMs: 0, linkMs: 0, bootMs: 0 };
    this._rafFrameTimes = [];
    this._lastRafTime = 0;
  }

  /* ------------------------------------------------------------ loading -- */

  async init({ gameUrl = this.gameUrl, gameBytes = null, runtimeUrl = this.runtimeUrl } = {}) {
    this.runtimeUrl = runtimeUrl;
    this.gameUrl = gameUrl;
    const started = performance.now();
    try {
      const response = await fetch(this.runtimeUrl, { cache: 'no-store' });
      if (!response.ok) {
        throw new HostError(`cannot fetch runtime.wasm: HTTP ${response.status} ${this.runtimeUrl}`);
      }
      const runtimeBytes = new Uint8Array(await response.arrayBuffer());
      this.rt = await loadRuntime({ wasmBytes: runtimeBytes, virtualWindow: this.virtualWindow });
      this.abi = initRuntime(this.rt);
      this.memory = this.rt.memory;
      this.exports = this.rt.exports;
      this.cpuPointer = this.exports.dune_cpu_ptr();
      this.offsets = this.abi.fields;
      this.addresses = this.abi.addresses;
      this.metrics.runtimeBytes = runtimeBytes.byteLength;
      this.timings.runtimeLoadMs = performance.now() - started;

      if (this.exports.dune_web_debug) {
        try {
          const debug = JSON.parse(decodeCString(this.rt, this.exports.dune_web_debug()));
          if (Number.isFinite(debug.masterHz) && debug.masterHz > 0) this.masterHz = debug.masterHz;
        } catch {
          /* keep the fallback clock */
        }
      }

      await this.loadGame(gameBytes ?? this.gameUrl);
      this.metrics.loadMs = performance.now() - started;
      this.metrics.status = 'runtime+game loaded';
      this.onStatus(this.metrics);
      return this;
    } catch (error) {
      this.metrics.status = `load failed: ${error.message}`;
      this.onStatus(this.metrics);
      throw error instanceof HostError ? error : new HostError(`init failed: ${error.message}`, error);
    }
  }

  /** Compile + instantiate the generated game module and install its table. */
  async loadGame(source) {
    let bytes = null;
    if (source instanceof Uint8Array || source instanceof ArrayBuffer) {
      bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    } else if (typeof source === 'string' && source) {
      const response = await fetch(source, { cache: 'no-store' });
      if (!response.ok) {
        throw new HostError(
          `cannot fetch game.wasm: HTTP ${response.status} ${source} — build it with ` +
            '`python3 tools/host/build_game_module.py --rom <rom>`',
        );
      }
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    if (!bytes || bytes.byteLength < 1024) {
      throw new HostError('game.wasm is empty or missing');
    }
    if (!this.rt) throw new HostError('load the runtime before the game module');

    const compileStart = performance.now();
    const module = await WebAssembly.compile(bytes);
    this.timings.gameCompileMs = performance.now() - compileStart;

    const imports = { env: {} };
    for (const entry of WebAssembly.Module.imports(module)) {
      if (entry.module !== 'env') {
        throw new HostError(`game.wasm imports unsupported module "${entry.module}" (${entry.name})`);
      }
      if (entry.kind === 'memory') {
        imports.env[entry.name] = this.memory;
      } else if (entry.kind === 'function') {
        const fn = this.exports[entry.name];
        if (typeof fn !== 'function') {
          throw new HostError(`runtime.wasm does not export game import env.${entry.name}`);
        }
        imports.env[entry.name] = fn;
      } else {
        throw new HostError(`game.wasm imports unsupported ${entry.kind} env.${entry.name}`);
      }
    }

    const linkStart = performance.now();
    const instance = await WebAssembly.instantiate(module, imports);
    const exportsObject = instance.exports;
    if (typeof exportsObject.translated_step !== 'function') {
      throw new HostError('game.wasm does not export translated_step');
    }

    const entries = [exportsObject.translated_step];
    if (typeof exportsObject.translated_z80_step === 'function') {
      entries.push(exportsObject.translated_z80_step);
    }
    const slots = appendFunctions(this.rt, entries);
    const table = slots.slice();
    while (table.length < 2) table.push(0);
    const mode = installGameTable(this.rt, table, { count: 2 });
    this.timings.linkMs = performance.now() - linkStart;

    this.game = instance;
    this.gameBytes = bytes.byteLength;
    this.tableSlots = slots;
    this.gameMode = mode;
    this.metrics.gameBytes = bytes.byteLength;
    this.metrics.linkMs = this.timings.linkMs;
    this.metrics.status = `linked game.wasm (${bytes.byteLength} B, mode ${mode})`;
    this.log(
      `game.wasm ${bytes.byteLength} B linked in ${this.timings.linkMs.toFixed(1)} ms`,
      `slots=${JSON.stringify(slots)} mode=${mode}`,
    );
    this.onStatus(this.metrics);
    return instance;
  }

  /* ----------------------------------------------------------------- ROM -- */

  /** Copy the player ROM into the runtime's ROM buffer (1 MiB). */
  async loadRomFromBytes(bytes) {
    if (!this.rt) throw new HostError('load the runtime first');
    const rom = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (rom.byteLength === 0) throw new HostError('ROM is empty');
    if (rom.byteLength > ROM_BYTES_EXPECTED) {
      throw new HostError(`ROM is ${rom.byteLength} B; the runtime buffer is ${ROM_BYTES_EXPECTED} B`);
    }
    loadRom(this.rt, rom);
    this.romBytes = rom;
    this.metrics.status = `ROM ${rom.byteLength} B copied to dune_rt_rom_buffer()`;
    this.log(`ROM ${rom.byteLength} B -> runtime (sha-agnostic, BYOP)`);
    this.onStatus(this.metrics);
    return rom.byteLength;
  }

  /**
   * Reset the emulated console from the ROM reset vector, like the C ``main()``:
   * ``a7 = ssp = ROM[0..4]``, ``pc = ROM[4..8] & 0xFFFFFF``, ``sr = 0x2700``.
   * Also opens the host window flag so the save API and input hooks work.
   */
  boot({ warmup = true } = {}) {
    if (!this.romBytes) throw new HostError('load the ROM before boot()');
    if (!this.game) throw new HostError('load game.wasm before boot()');
    const started = performance.now();
    const rom = this.romBytes;
    const ssp = be32(rom, 0);
    const entry = be32(rom, 4) & 0xffffff;
    this.writeU32(this.offsets.OFF_A + 7 * 4, ssp);
    this.writeU32(this.offsets.OFF_SSP, ssp);
    this.writeU32(this.offsets.OFF_PC, entry);
    this.writeU16(this.offsets.OFF_SR, 0x2700);
    this.writeU32(this.offsets.OFF_HALTED, 0);
    this.writeU32(this.offsets.OFF_FAULT, 0);
    this.exports.dune_rt_set_window(1);
    if (warmup && typeof this.game.exports.warmup_all === 'function') {
      // Compile every page handler before the first frame (no emulated steps).
      this.game.exports.warmup_all(this.cpuPointer);
    }
    // Path A has no run_main()/sdl_host_open(); attach the virtual 320x224 SDL
    // surface so the pinned camera/tap/pan/zoom adapters get real geometry.
    this.attachVirtualWindow();
    this.booted = true;
    this.fault = null;
    this.#syncCpu();
    this.timings.bootMs = performance.now() - started;
    this.metrics.bootMs = this.timings.bootMs;
    this.metrics.status = `booted: ssp=0x${ssp.toString(16)} pc=0x${entry.toString(16)}`;
    this.log(this.metrics.status);
    this.onStatus(this.metrics);
    return { ssp, entry };
  }

  /* ----------------------------------------------------------- CPU state -- */

  #view() {
    const buffer = this.memory.buffer;
    if (buffer !== this._dataBuffer) {
      this._dataBuffer = buffer;
      this._dataView = new DataView(buffer);
    }
    return this._dataView;
  }

  readU32(offset) {
    return this.#view().getUint32(this.cpuPointer + offset, true);
  }

  readU64(offset) {
    const view = this.#view();
    const base = this.cpuPointer + offset;
    return view.getUint32(base, true) + view.getUint32(base + 4, true) * 0x100000000;
  }

  writeU32(offset, value) {
    this.#view().setUint32(this.cpuPointer + offset, value >>> 0, true);
  }

  writeU16(offset, value) {
    this.#view().setUint16(this.cpuPointer + offset, value & 0xffff, true);
  }

  #syncCpu() {
    // `steps` and `master_cycles` are 64-bit counters; reading only the low
    // word wrapped after ~80 s of emulated time and stalled the frame loop.
    this.metrics.instructions = this.readU64(this.offsets.OFF_STEPS);
    this.metrics.masterCycles = this.readU64(this.offsets.OFF_MASTER_CYCLES);
    this.metrics.emulatedSeconds = this.metrics.masterCycles / this.masterHz;
    this.metrics.renderedFrames = this.exports.dune_web_frame_serial
      ? this.exports.dune_web_frame_serial()
      : 0;
    if (this.exports.dune_web_frame_width) {
      this.metrics.frameWidth = this.exports.dune_web_frame_width();
      this.metrics.frameHeight = this.exports.dune_web_frame_height();
    }
    const fault = this.readU32(this.offsets.OFF_FAULT);
    this.metrics.fault = !!fault;
    if (fault && !this.fault) {
      const code = this.exports.dune_rt_last_fail_code();
      this.fault = {
        code,
        reason: decodeCString(this.rt, this.exports.dune_rt_fail_reason(code)),
        address: this.readU32(this.offsets.OFF_FAULT_ADDRESS),
        pc: this.readU32(this.offsets.OFF_PC),
      };
      this.metrics.failCode = code;
      this.metrics.failReason = this.fault.reason;
      this.metrics.failAddress = this.fault.address;
      this.log('fault', this.fault);
    }
    return this.metrics;
  }

  /* -------------------------------------------------------- building menu -- */

  /** Read a NUL-terminated UTF-8 string from wasm memory. */
  readCString(pointer) {
    const bytes = new Uint8Array(this.memory.buffer, pointer);
    let end = 0;
    while (end < bytes.length && bytes[end]) end += 1;
    return new TextDecoder().decode(bytes.subarray(0, end));
  }

  /** Live native building/Starport menu state (JSON) or null outside a menu. */
  buildingUi() {
    try {
      const pointer = this.exports?.dune_web_building_ui_json?.();
      if (!pointer) return null;
      const text = this.readCString(pointer);
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  /** Native 320x224 building-menu frame as RGBA pixels, or null. */
  buildingFrame() {
    try {
      const pointer = this.exports?.dune_web_building_ui_frame_rgb?.();
      if (!pointer) return null;
      const rgb = new Uint8Array(this.memory.buffer, pointer, 320 * 224 * 3);
      const data = new Uint8ClampedArray(320 * 224 * 4);
      for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
        data[j] = rgb[i];
        data[j + 1] = rgb[i + 1];
        data[j + 2] = rgb[i + 2];
        data[j + 3] = 255;
      }
      return { width: 320, height: 224, data };
    } catch {
      return null;
    }
  }

  /** Queue one native cell intent for the active building menu. */
  tapBuildingCell(col, row) {
    try {
      const checked = this.exports?.dune_web_building_ui_tap_checked;
      const ui = this.buildingUi();
      if (checked && ui && Number.isFinite(ui.context) && Number.isFinite(ui.producer?.pointer)) {
        return checked(ui.context, ui.producer.pointer, col, row) ?? 0;
      }
      return this.exports?.dune_web_building_ui_tap?.(col, row) ?? 0;
    } catch {
      return 0;
    }
  }

  /* ---------------------------------------------------------- touch/input -- */

  /**
   * Attach the path-A virtual SDL window (320x224 by default).
   *
   * Must run after init()/loadGame(); boot() calls it automatically.  The
   * pinned adapter code only needs ``em_host.window``/``renderer`` to be non-NULL
   * and the SDL geometry queries to answer 320x224; no SDL window/renderer/GL
   * context is created (the C build wraps the SDL geometry symbols).
   * Returns the touch state (never throws: an older runtime just reports why).
   */
  attachVirtualWindow({ width = this.virtualWindow?.width ?? TOUCH_WIDTH, height = this.virtualWindow?.height ?? TOUCH_HEIGHT } = {}) {
    if (!this.rt) return (this.touch = { ...this.touch, attached: false, error: 'runtime not loaded' });
    try {
      if (typeof this.exports.dune_web_attach_virtual_window !== 'function') {
        throw new HostError('runtime.wasm has no dune_web_attach_virtual_window (rebuild runtime/wasm)');
      }
      const attached = this.exports.dune_web_attach_virtual_window(width, height);
      if (attached) this.exports.dune_web_resize(width, height);
      const w = this.exports.dune_web_virtual_window_width?.() ?? width;
      const h = this.exports.dune_web_virtual_window_height?.() ?? height;
      if (this.virtualWindow) {
        this.virtualWindow.width = w;
        this.virtualWindow.height = h;
      }
      this.touch = {
        attached: !!attached,
        width: w,
        height: h,
        dragging: false,
        error: attached ? null : 'dune_web_attach_virtual_window returned 0',
        webStep: typeof this.exports.dune_rt_web_step === 'function',
        cssMock: !!this.virtualWindow,
      };
      this.log(`virtual window ${w}x${h} attached=${this.touch.attached} webStep=${this.touch.webStep}`);
    } catch (error) {
      this.touch = { ...this.touch, attached: false, error: error.message };
      this.log(`virtual window unavailable: ${error.message}`);
    }
    return this.touch;
  }

  /** The step function the host loop should use (touch observers when attached). */
  stepFunction() {
    if (this.touch?.attached && this.touchStepping && typeof this.exports?.dune_rt_web_step === 'function') {
      return this.exports.dune_rt_web_step;
    }
    return this.exports?.dune_rt_machine_step;
  }

  /** Advance exactly ``count`` machine steps (one translated 68000 instruction each). */
  advanceSteps(count) {
    if (!this.booted) throw new HostError('boot() before advancing the machine');
    const step = this.stepFunction();
    const started = performance.now();
    const total = Math.max(0, Math.floor(count));
    let done = 0;
    while (done < total) {
      const block = Math.min(8192, total - done);
      for (let i = 0; i < block; i += 1) step();
      done += block;
      this.metrics.steps += block;
      this.#syncCpu();
      if (this.fault) break;
    }
    const elapsed = performance.now() - started;
    this.metrics.lastRunSteps = done;
    this.metrics.lastRunMs = elapsed;
    this.metrics.stepsPerSecond = elapsed > 0 ? (done * 1000) / elapsed : 0;
    this.onStatus(this.metrics);
    return { steps: done, ms: elapsed, stepsPerSecond: this.metrics.stepsPerSecond };
  }

  /** Alias that says what is really being stepped. */
  advanceInstructions(count) {
    return this.advanceSteps(count);
  }

  /** Advance to an absolute CPU instruction count (deterministic, ROM-driven). */
  advanceToInstructions(target, { maxSteps = 500_000_000 } = {}) {
    let done = 0;
    while (this.metrics.instructions < target && done < maxSteps && !this.fault) {
      const remaining = target - this.metrics.instructions;
      const chunk = Math.min(1_000_000, Math.max(8192, remaining));
      this.advanceSteps(chunk);
      done += chunk;
    }
    return { instructions: this.metrics.instructions, steps: done, ...this.snapshot() };
  }

  /** Step until ``count`` more emulated video frames have been produced. */
  advanceFrames(count, { maxSteps = 200_000_000 } = {}) {
    if (!this.booted) throw new HostError('boot() before advancing frames');
    const target = this.metrics.renderedFrames + Math.max(1, Math.floor(count));
    const started = performance.now();
    let done = 0;
    while (this.metrics.renderedFrames < target && done < maxSteps && !this.fault) {
      this.advanceSteps(16384);
      done += 16384;
    }
    this.metrics.lastRunSteps = done;
    this.metrics.lastRunMs = performance.now() - started;
    this.onStatus(this.metrics);
    return { steps: done, renderedFrames: this.metrics.renderedFrames };
  }

  /** Run until the first non-empty displayed frame (or ``maxSteps``). */
  waitForFirstFrame({ maxSteps = 8_000_000 } = {}) {
    let done = 0;
    while (done < maxSteps && !this.fault) {
      this.advanceSteps(8192);
      done += 8192;
      if (this.metrics.renderedFrames > 0 && this.metrics.frameWidth > 0) break;
    }
    return { steps: done, ...this.snapshot() };
  }

  start({ maxCatchUpSeconds = 0.1 } = {}) {
    if (this.running) return;
    if (!this.booted) throw new HostError('boot() before start()');
    this.running = true;
    this.lastTick = performance.now();
    this.lastCycles = this.metrics.masterCycles;
    const maxCatchUp = this.masterHz * maxCatchUpSeconds;
    const tick = (now) => {
      if (!this.running) return;
      const elapsedMs = Math.min(now - this.lastTick, 1000);
      this.lastTick = now;
      let credit = (elapsedMs * this.masterHz) / 1000;
      if (credit > maxCatchUp) credit = maxCatchUp;
      const target = this.lastCycles + credit;
      const started = performance.now();
      const step = this.stepFunction();
      // A frame may never emulate more than a bounded number of chunks, and a
      // stalled machine (paused/halted/observer hold) must not spin the page.
      let chunks = 0;
      let stalledChunks = 0;
      let progressed = this.metrics.masterCycles;
      while (this.metrics.masterCycles < target && !this.fault) {
        const remaining = target - this.metrics.masterCycles;
        const block = Math.min(512, Math.max(16, Math.ceil(remaining / 32)));
        for (let i = 0; i < block; i += 1) step();
        this.#syncCpu();
        chunks += 1;
        if (this.metrics.masterCycles > progressed) {
          progressed = this.metrics.masterCycles;
          stalledChunks = 0;
        } else {
          stalledChunks += 1;
        }
        if (stalledChunks > 3 || chunks > 4096) {
          this.metrics.stalled = true;
          if (!this.stallLogged) {
            this.stallLogged = true;
            try {
              console.warn('[host] emulation stalled', JSON.stringify({ chunks, target, masterCycles: this.metrics.masterCycles, debug: this.debugJson(), camera: this.cameraDebug() }).slice(0, 2000));
            } catch { /* diagnostics only */ }
          }
          break;
        }
      }
      if (!this.metrics.stalled) this.stallLogged = false;
      this.lastCycles = this.metrics.masterCycles;
      this.audio.pump();
      // 'building' means the app owns the canvas: it paints the native
      // building-menu frame and routes cell taps through building_ui_tap.
      const expanded = this.presentation === 'expanded'
        || (this.presentation === 'auto' && this.#missionMap());
      if (this.presentation === 'building') {
        /* app-owned frame */
      } else if (expanded) {
        if (now - this.lastExpandedAt >= this.expandedIntervalMs) {
          this.drawExpandedFrame();
          this.lastExpandedAt = now;
        }
      } else if (this.metrics.renderedFrames !== this.lastSerial) {
        this.drawFrame();
      }
      this.metrics.frameMs = performance.now() - started;
      this._rafFrameTimes.push(now);
      while (this._rafFrameTimes.length > 30) this._rafFrameTimes.shift();
      if (this._rafFrameTimes.length >= 2) {
        const span = this._rafFrameTimes[this._rafFrameTimes.length - 1] - this._rafFrameTimes[0];
        this.metrics.fps = span > 0 ? ((this._rafFrameTimes.length - 1) * 1000) / span : 0;
      }
      this.onStatus(this.metrics);
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }

  /* --------------------------------------------------------- presentation -- */

  /** Presentation policy: 'auto' shows the expanded mission overview on the map. */
  setPresentation(mode) {
    if (!['auto', 'native', 'expanded', 'building'].includes(mode)) throw new HostError(`unknown presentation ${mode}`);
    this.presentation = mode;
    this.refreshPresentation();
    return this.presentation;
  }

  #missionMap() {
    try {
      const camera = this.cameraDebug();
      return !!(camera && camera.map);
    } catch {
      return false;
    }
  }

  /** Redraw the current view immediately (after a pan/zoom or scene change). */
  refreshPresentation() {
    if (this.presentation === 'expanded' || (this.presentation === 'auto' && this.#missionMap())) {
      const drawn = this.drawExpandedFrame();
      this.lastExpandedAt = performance.now();
      if (drawn) return 'expanded';
    }
    this.drawFrame();
    return 'native';
  }

  /* ------------------------------------------------------------- frames -- */

  framePointer() {
    if (!this.exports.dune_web_frame_rgb) return 0;
    return this.exports.dune_web_frame_rgb();
  }

  frameSize() {
    const width = this.exports.dune_web_frame_width ? this.exports.dune_web_frame_width() : 0;
    const height = this.exports.dune_web_frame_height ? this.exports.dune_web_frame_height() : 0;
    return { width, height };
  }

  /** Latest complete RGB frame as a Uint8Array view of runtime memory (RGB24). */
  frameRgb() {
    const { width, height } = this.frameSize();
    const pointer = this.framePointer();
    if (!width || !height || !pointer) return null;
    return new Uint8Array(this.memory.buffer, pointer, width * height * 3);
  }

  /** Pixel statistics for the current frame (nonzero pixels, unique colours, hash). */
  frameStats() {
    const { width, height } = this.frameSize();
    const rgb = this.frameRgb();
    if (!rgb) {
      return { width: 0, height: 0, serial: this.metrics.renderedFrames, nonzero: 0, unique: 0, colors: [], hash: '0' };
    }
    let nonzero = 0;
    let hash = 2166136261 >>> 0;
    const colors = new Map();
    for (let i = 0; i < rgb.length; i += 3) {
      hash ^= rgb[i];
      hash = Math.imul(hash, 16777619) >>> 0;
      const packed = (rgb[i] << 16) | (rgb[i + 1] << 8) | rgb[i + 2];
      if (packed) nonzero += 1;
      colors.set(packed, (colors.get(packed) || 0) + 1);
    }
    const top = [...colors.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([packed, count]) => [packed.toString(16).padStart(6, '0'), count]);
    return {
      width,
      height,
      serial: this.metrics.renderedFrames,
      nonzero,
      unique: colors.size,
      colors: top,
      hash: hash.toString(16).padStart(8, '0'),
    };
  }

  /** Copy the hardware RGB frame to the canvas (RGB24 -> ImageData RGBA). */
  drawFrame() {
    const { width, height } = this.frameSize();
    if (!this.canvas || !this.ctx || !width || !height) return false;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.imageData = null;
    }
    if (!this.imageData || this.imageData.width !== width) {
      this.imageData = this.ctx.createImageData(width, height);
      const data = this.imageData.data;
      for (let i = 3; i < data.length; i += 4) data[i] = 255;
    }
    const rgb = this.frameRgb();
    if (!rgb) return false;
    const rgba = this.imageData.data;
    for (let pixel = 0, src = 0; pixel < width * height; pixel += 1, src += 3) {
      const dst = pixel * 4;
      rgba[dst] = rgb[src];
      rgba[dst + 1] = rgb[src + 1];
      rgba[dst + 2] = rgb[src + 2];
    }
    this.ctx.putImageData(this.imageData, 0, 0);
    this.lastSerial = this.metrics.renderedFrames;
    this.frameCount += 1;
    return true;
  }

  /** PNG data URL of the current canvas (native 320×224 pixels). */
  canvasDataUrl() {
    if (!this.canvas) return null;
    return this.canvas.toDataURL('image/png');
  }

  /** Everything the debug page/test needs in one JSON-safe object. */
  snapshot() {
    return {
      ...this.metrics,
      booted: this.booted,
      faulted: this.metrics.fault,
      fault: this.fault,
      tableSlots: this.tableSlots ?? null,
      gameMode: this.gameMode ?? null,
      timings: { ...this.timings },
    };
  }

  /* -------------------------------------------------------------- input -- */

  capabilities() {
    const has = (name) => typeof this.exports?.[name] === 'function';
    return {
      pad: has('dune_web_pad'),
      tapScreen: has('dune_web_tap_screen'),
      hoverScreen: has('dune_web_hover_screen'),
      pan: has('dune_web_pan'),
      zoom: has('dune_web_zoom'),
      begin: has('dune_web_begin'),
      end: has('dune_web_end'),
      virtualWindow: has('dune_web_attach_virtual_window'),
      virtualWindowAttached: !!this.touch?.attached,
      expandedView: has('dune_web_expanded_frame_rgba'),
      webStep: has('dune_rt_web_step'),
      campaignInput: has('dune_web_campaign_input'),
      campaignJson: has('dune_web_campaign_json'),
      menuSelectReset: has('dune_web_menu_select_reset'),
      resetClock: has('dune_web_reset_clock'),
      save: has('dune_save_state_to_buffer') && has('dune_load_state_from_buffer'),
      audioLevels: has('dune_web_audio_levels'),
    };
  }

  /**
   * Screen coordinates are native-frame coordinates of the virtual window
   * (default 320x224).  Map a DOM pointer position to that space with
   * ``canvas.getBoundingClientRect()``: ``x = (clientX - rect.left) * 320 /
   * rect.width`` (same for y with 224/rect.height).  The app pages mobile
   * video at CSS size, so do not feed raw CSS pixels here.
   *
   * ``tapScreen`` returns the adapter's context:
   *   1 = world/map (queued a native world select, not an A/B/C edge),
   *   2 = native UI/menu hotspot (queued a native select click),
   *   3 = minimap recentre, 0 = outside/invalid/no window.
   */
  tapScreen(x, y) {
    if (!this.exports?.dune_web_tap_screen) return 0;
    return this.exports.dune_web_tap_screen(x, y);
  }

  /** Position the native pointer/preview without clicking (returns 1 world / 2 UI). */
  hoverScreen(x, y) {
    if (!this.exports?.dune_web_hover_screen) return 0;
    return this.exports.dune_web_hover_screen(x, y);
  }

  /** Begin an explicit drag gesture in virtual-window coordinates (returns 1). */
  beginPan(x = this.touch.width / 2, y = this.touch.height / 2) {
    if (!this.exports?.dune_web_begin) {
      this.touch.dragging = false;
      return 0;
    }
    const begun = this.exports.dune_web_begin(x, y);
    this.touch.dragging = !!begun;
    return begun;
  }

  /**
   * Pan the expanded mission camera by a screen delta while a drag is active
   * (call beginPan() first).  For a one-shot pan use pan(), which begins and
   * ends the gesture around a single delta.
   */
  panCamera(dx, dy) {
    if (!this.exports?.dune_web_pan) return 0;
    return this.exports.dune_web_pan(dx, dy);
  }

  /** End the drag gesture (also clears minimap drag state). */
  endPan() {
    this.touch.dragging = false;
    if (this.exports?.dune_web_end) this.exports.dune_web_end();
    return 1;
  }

  /**
   * One-shot pan: begins a world drag at the window centre when needed, applies
   * the delta and ends it.  Returns dune_web_pan() (1 while a mission map drag
   * is accepted).  For continuous gestures use beginPan/panCamera/endPan.
   */
  pan(dx, dy) {
    if (!this.exports?.dune_web_pan) return 0;
    const auto = !this.touch.dragging;
    if (auto && !this.beginPan()) return 0;
    const result = this.exports.dune_web_pan(dx, dy);
    if (auto) this.endPan();
    return result;
  }

  /**
   * Zoom the mission camera.  ``factor`` multiplies the current zoom
   * (100 = native 1:1, 50 = widest overview); the adapter clamps to [50,100],
   * so the first call with 1.2 returns 100 and ``0.8`` is the useful "zoom out"
   * step.  Returns the new zoom percentage, or 0 on a non-map screen.
   */
  zoomCamera(factor, anchorX = this.touch.width / 2, anchorY = this.touch.height / 2) {
    if (!this.exports?.dune_web_zoom) return 0;
    return this.exports.dune_web_zoom(factor, anchorX, anchorY);
  }

  /** Kept for earlier callers: aliases for tapScreen/pan/zoomCamera. */
  tap(x, y) {
    return this.tapScreen(x, y);
  }

  zoom(factor, anchorX = this.touch.width / 2, anchorY = this.touch.height / 2) {
    return this.zoomCamera(factor, anchorX, anchorY);
  }

  /**
   * Software expanded mission overview (what path B draws through SDL).
   *
   * Returns ``{ width, height, rgba }`` for a frame-sized RGBA buffer, or null
   * outside the mission map.  This is a presentation-only traversal (shadow CPU,
   * no game-state writes); it is expensive, so call it on demand (screenshots,
   * overview UI), not inside the rAF loop.
   */
  expandedFrame() {
    if (!this.exports?.dune_web_expanded_frame_rgba) return null;
    const pointer = this.exports.dune_web_expanded_frame_rgba();
    if (!pointer) return null;
    const width = this.exports.dune_web_expanded_frame_width();
    const height = this.exports.dune_web_expanded_frame_height();
    if (!width || !height) return null;
    return { width, height, rgba: new Uint8Array(this.memory.buffer, pointer, width * height * 4) };
  }

  /** Draw the expanded mission overview (pan/zoom result) into the canvas. */
  drawExpandedFrame() {
    const frame = this.expandedFrame();
    if (!frame || !this.canvas || !this.ctx) return null;
    if (this.canvas.width !== frame.width || this.canvas.height !== frame.height) {
      this.canvas.width = frame.width;
      this.canvas.height = frame.height;
      this.imageData = null;
    }
    if (!this.imageData || this.imageData.width !== frame.width) {
      this.imageData = this.ctx.createImageData(frame.width, frame.height);
    }
    this.imageData.data.set(frame.rgba);
    this.ctx.putImageData(this.imageData, 0, 0);
    return { width: frame.width, height: frame.height };
  }

  /** Pose/geometry as seen by the pinned adapters (null without a map frame). */
  cameraDebug() {
    if (!this.exports?.dune_web_camera_debug) return null;
    try {
      return JSON.parse(decodeCString(this.rt, this.exports.dune_web_camera_debug()));
    } catch {
      return null;
    }
  }

  /** Selection/world-intent state of the mission adapters. */
  selectionDebug() {
    if (!this.exports?.dune_web_selection_debug) return null;
    try {
      return JSON.parse(decodeCString(this.rt, this.exports.dune_web_selection_debug()));
    } catch {
      return null;
    }
  }

  /** Touch readiness plus the last observed adapter state (for UI/tests). */
  touchInfo() {
    return {
      ...this.touch,
      canvas: this.canvas ? { width: this.canvas.width, height: this.canvas.height } : null,
      camera: this.cameraDebug(),
      selection: this.selectionDebug(),
    };
  }

  pad(mask, down) {
    if (!this.exports?.dune_web_pad) return 0;
    this.exports.dune_web_pad(mask, down ? 1 : 0);
    return 1;
  }

  /**
   * Pulse one controller button mask (Genesis: U=1,D=2,L=4,R=8,B=16,C=32,A=64,Start=128).
   * This is the input path that works without an SDL window.
   */
  pressPad(mask, { holdSteps = 120_000, settleSteps = 0 } = {}) {
    this.pad(mask, true);
    this.advanceSteps(holdSteps);
    this.pad(mask, false);
    if (settleSteps) this.advanceSteps(settleSteps);
    return 1;
  }

  pressStart(options = {}) {
    return this.pressPad(0x80, options);
  }

  /** Frontend input request (0 = pad, value = button mask), if supported. */
  campaignInput(action, value) {
    if (!this.exports?.dune_web_campaign_input) return 0;
    return this.exports.dune_web_campaign_input(action, value);
  }

  /* --------------------------------------------------------------- save -- */

  saveState() {
    const size = this.exports.dune_save_state_to_buffer();
    if (!size) return null;
    const pointer = this.exports.dune_get_save_buffer();
    return new Uint8Array(this.memory.buffer, pointer, size).slice();
  }

  loadState(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const pointer = this.exports.dune_get_save_buffer();
    const capacity = this.exports.dune_rt_save_buffer_capacity();
    if (data.byteLength > capacity) throw new HostError(`save state is ${data.byteLength} B, buffer is ${capacity} B`);
    new Uint8Array(this.memory.buffer, pointer, data.byteLength).set(data);
    const ok = this.exports.dune_load_state_from_buffer(data.byteLength);
    if (ok) {
      this.#syncCpu();
      this.audio.flush();
    }
    return ok === 1;
  }

  /* -------------------------------------------------------------- misc --- */

  /** Call any exported runtime/game symbol by name (frontend adapters, debug). */
  call(name, ...args) {
    const fn = this.exports[name];
    if (typeof fn !== 'function') throw new HostError(`runtime.wasm has no export ${name}`);
    return fn(...args);
  }

  debugJson() {
    if (!this.exports.dune_web_debug) return null;
    try {
      return JSON.parse(decodeCString(this.rt, this.exports.dune_web_debug()));
    } catch {
      return null;
    }
  }

  destroy() {
    this.stop();
    this.rt = null;
    this.game = null;
    this.memory = null;
    this.exports = null;
  }
}

export async function createHost(options = {}) {
  const host = new DuneHost(options);
  await host.init(options);
  return host;
}

export default DuneHost;
