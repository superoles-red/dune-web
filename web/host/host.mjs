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

const DEFAULT_RUNTIME_URL = new URL('../runtime/runtime.wasm', import.meta.url).href;
const DEFAULT_GAME_URL = new URL('../../.local/wasm-full/game.wasm', import.meta.url).href;

const FALLBACK_MASTER_HZ = 53693175; // Genesis NTSC master clock (68k × 7)
const EMULATED_FPS = 60;
const ROM_BYTES_EXPECTED = 1024 * 1024;

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

    this.imageData = null;
    this.lastSerial = -1;
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
      this.rt = await loadRuntime({ wasmBytes: runtimeBytes });
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

  writeU32(offset, value) {
    this.#view().setUint32(this.cpuPointer + offset, value >>> 0, true);
  }

  writeU16(offset, value) {
    this.#view().setUint16(this.cpuPointer + offset, value & 0xffff, true);
  }

  #syncCpu() {
    this.metrics.instructions = this.readU32(this.offsets.OFF_STEPS);
    this.metrics.masterCycles = this.readU32(this.offsets.OFF_MASTER_CYCLES);
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

  /* --------------------------------------------------------------- loop -- */

  /** Advance exactly ``count`` machine steps (one translated 68000 instruction each). */
  advanceSteps(count) {
    if (!this.booted) throw new HostError('boot() before advancing the machine');
    const step = this.exports.dune_rt_machine_step;
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
      const step = this.exports.dune_rt_machine_step;
      while (this.metrics.masterCycles < target && !this.fault) {
        const remaining = target - this.metrics.masterCycles;
        const block = Math.min(512, Math.max(16, Math.ceil(remaining / 32)));
        for (let i = 0; i < block; i += 1) step();
        this.#syncCpu();
      }
      this.lastCycles = this.metrics.masterCycles;
      if (this.metrics.renderedFrames !== this.lastSerial) this.drawFrame();
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
      campaignInput: has('dune_web_campaign_input'),
      campaignJson: has('dune_web_campaign_json'),
      menuSelectReset: has('dune_web_menu_select_reset'),
      resetClock: has('dune_web_reset_clock'),
      save: has('dune_save_state_to_buffer') && has('dune_load_state_from_buffer'),
      audioLevels: has('dune_web_audio_levels'),
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

  tap(x, y) {
    if (!this.exports?.dune_web_tap_screen) return 0;
    return this.exports.dune_web_tap_screen(x, y);
  }

  pan(dx, dy) {
    if (!this.exports?.dune_web_pan) return 0;
    return this.exports.dune_web_pan(dx, dy);
  }

  zoom(factor, anchorX = 160, anchorY = 112) {
    if (!this.exports?.dune_web_zoom) return 0;
    return this.exports.dune_web_zoom(factor, anchorX, anchorY);
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
    if (ok) this.#syncCpu();
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
