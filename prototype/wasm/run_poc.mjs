#!/usr/bin/env node
/**
 * run_poc.mjs — verifies the WASM backend PoC without npm dependencies.
 *
 * Loads `build/poc.wasm` (the generated "game" module) and instantiates it the
 * same way the real port will: the memory is provided by the host/runtime, and
 * every runtime helper the generated code calls (read_mem, write_mem,
 * logic_flags, arithmetic, condition, push32, pop32, set_sr, fail) is an
 * imported function.  The JS stubs below implement exactly the C helpers from
 * vendor/rearrakis/genesis_recompiler/runtime.h, so the checks prove the ABI,
 * not a JS re-implementation of the 68000.
 *
 * Two checks run:
 *   1. "JS-driven":  JS plays the runtime loop; game.wasm is imported-memory game.
 *   2. "linked":     build/poc-runtime.wasm plays the runtime: it owns memory and
 *                    a funcref table, calls translated_step through call_indirect
 *                    and accumulates cycles in uint64 — the production direction.
 * Both must produce byte-identical CPU/RAM state and the same trace/cycles.
 *
 * Usage:
 *   node prototype/wasm/run_poc.mjs
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// PoC ABI v1 (must match emit_poc.py; poc-meta.json is cross-checked below).
// ---------------------------------------------------------------------------
const MEMORY_PAGES = 2;
const CPU = 0x0000;
const OFF_D = 0x00;
const OFF_A = 0x20;
const OFF_PC = 0x40;
const OFF_SR = 0x44;
const OFF_FAULT = 0x48;
const OFF_FAULT_CODE = 0x4c;
const OFF_CYCLES = 0x50; // uint64
const OFF_HALTED = 0x58;
const OFF_INSTR_CYCLES = 0x5c;
const RAM_BASE = 0x4000;
const RAM_BYTES = 0x10000;
const STACK_BUS = 0xe01000; // RAM offset 0x1000 -> linear RAM_BASE + 0x1000
const A0_START_BUS = 0xe00100; // RAM offset 0x0100 -> linear RAM_BASE + 0x0100
const RAM_IMAGE_BUS = 0x000200; // (pc & 0xffff) of the guarded RAM instruction

// 68000 status flags — same bit values as runtime.h.
const F_C = 1, F_V = 2, F_Z = 4, F_N = 8, F_X = 16;
const SR_SUPERVISOR = 0x2000;

// Failure reasons (ABI, mirrored from emit_poc.py).
const FAIL = {
  untranslated: 1,
  bad_pc: 2,
  odd_pc: 3,
  unmapped: 4,
  ram_variant: 5,
  privilege: 6,
  address_error: 7,
  unmapped_read: 8,
  unmapped_write: 9,
};

// ---------------------------------------------------------------------------
// Expected result of the synthetic program (hard-coded on purpose: the test
// must fail if the emitter changes behaviour, not silently follow it).
// ---------------------------------------------------------------------------
const EXPECTED = {
  steps: 18,
  cycles: 152,
  trace: [
    0x0100, 0x0104, 0x0108, 0x010c, 0x0110,
    0x0104, 0x0108, 0x010c, 0x0110,
    0x0104, 0x0108, 0x010c, 0x0110,
    0x0114, 0x1100, 0x1104, 0xff0200, 0x1210,
  ],
  d: [0x1234567b, 0x0000abcf, 7, 0, 0, 0, 0, 0],
  a: [0xe00108, 0, 0, 0, 0, 0, 0, 0xe01004],
  pc: 0x1214,
  sr: 0x2700,
  halted: 1,
  fault: 0,
  writes: [
    // linear address, bytes (A0 = 0xE04100 -> RAM offset 0x100)
    [RAM_BASE + 0x100, [0x56, 0x78]],
    [RAM_BASE + 0x102, [0xab, 0xcd]],
    [RAM_BASE + 0x104, [0xab, 0xce]],
    [RAM_BASE + 0x106, [0xab, 0xcf]],
  ],
  stackAfter: 0xe01004,
  helperCalls: {
    read_mem: 3,
    write_mem: 1,
    logic_flags: 5,
    arithmetic: 6,
    condition: 3,
    push32: 0,
    pop32: 1,
    set_sr: 1,
    fail: 0,
  },
};

const failures = [];
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

function checkEqual(actual, expected, message) {
  checks += 1;
  if (actual !== expected) {
    failures.push(`${message}: expected ${hex(expected)}, got ${hex(actual)}`);
  }
}

function hex(value) {
  if (typeof value === 'bigint') return '0x' + value.toString(16);
  if (typeof value !== 'number') return String(value);
  if (!Number.isInteger(value)) return String(value);
  return '0x' + (value >>> 0).toString(16).padStart(value > 0xffff ? 8 : 2, '0');
}

function bytesEqual(actual, expected) {
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < actual.length; i += 1) if (actual[i] !== expected[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Runtime stubs: the C helpers from runtime.h, behind the WASM import boundary.
// ---------------------------------------------------------------------------
const MASK_FOR = { 1: 0xff, 2: 0xffff, 4: 0xffffffff };
const SIGN_FOR = { 1: 0x80, 2: 0x8000, 4: 0x80000000 };

function createStubs(memory) {
  const counters = {};
  const failEvents = [];
  let u8 = new Uint8Array(memory.buffer);
  let view = new DataView(memory.buffer);

  function refresh() {
    u8 = new Uint8Array(memory.buffer);
    view = new DataView(memory.buffer);
  }

  const getU32 = (address) => view.getUint32(address, true);
  const setU32 = (address, value) => view.setUint32(address, value >>> 0, true);
  const getU8 = (address) => u8[address];

  function setFault(cpu, code, address) {
    if (getU32(cpu + OFF_FAULT)) return;
    setU32(cpu + OFF_FAULT, 1);
    setU32(cpu + OFF_FAULT_CODE, code);
    setU32(cpu + OFF_FAULT + 8, address >>> 0); // spare scratch: fault address
    failEvents.push({ code, address: address >>> 0 });
  }

  // Bus byte access (mirrors runtime.h read8/write8 for the PoC's address map:
  // only the 64 KiB RAM window 0xE00000..0xE0FFFF is mapped).
  function busRead8(cpu, address) {
    address >>>= 0;
    address &= 0xffffff;
    if (address >= 0xe00000) return u8[RAM_BASE + (address & 0xffff)];
    setFault(cpu, FAIL.unmapped_read, address);
    return 0;
  }

  function busWrite8(cpu, address, value) {
    address >>>= 0;
    address &= 0xffffff;
    if (address >= 0xe00000) {
      u8[RAM_BASE + (address & 0xffff)] = value & 0xff;
      return;
    }
    setFault(cpu, FAIL.unmapped_write, address);
  }

  function readBytes(cpu, address, size) {
    let value = 0;
    for (let i = 0; i < size; i += 1) {
      value = (value << 8) | busRead8(cpu, (address + i) >>> 0);
      if (getU32(cpu + OFF_FAULT)) break;
    }
    return value >>> 0;
  }

  function writeBytes(cpu, address, size, value) {
    for (let i = 0; i < size; i += 1) {
      busWrite8(cpu, (address + i) >>> 0, (value >>> ((size - i - 1) * 8)) & 0xff);
      if (getU32(cpu + OFF_FAULT)) break;
    }
  }

  const imports = {
    read_mem(cpu, address, size) {
      counters.read_mem += 1;
      address >>>= 0;
      size >>>= 0;
      if (size > 1 && (address & 1)) {
        setFault(cpu, FAIL.address_error, address);
        return 0;
      }
      return readBytes(cpu, address, size);
    },

    write_mem(cpu, address, size, value) {
      counters.write_mem += 1;
      address >>>= 0;
      size >>>= 0;
      value >>>= 0;
      if (size > 1 && (address & 1)) {
        setFault(cpu, FAIL.address_error, address);
        return;
      }
      writeBytes(cpu, address, size, value);
    },

    logic_flags(cpu, value, size) {
      counters.logic_flags += 1;
      size >>>= 0;
      const mask = MASK_FOR[size];
      value = (value & mask) >>> 0;
      const sign = SIGN_FOR[size];
      let sr = getU32(cpu + OFF_SR);
      sr = (sr & ~15) | (value === 0 ? F_Z : 0) | ((value & sign) ? F_N : 0);
      setU32(cpu + OFF_SR, sr);
    },

    arithmetic(cpu, dst, src, size, sub, compare) {
      counters.arithmetic += 1;
      size >>>= 0;
      sub = sub ? 1 : 0;
      compare = compare ? 1 : 0;
      const mask = MASK_FOR[size];
      const sign = SIGN_FOR[size];
      dst = (dst & mask) >>> 0;
      src = (src & mask) >>> 0;
      const result = (((sub ? dst - src : dst + src) >>> 0) & mask) >>> 0;
      const carry = sub ? src > dst : dst + src > mask;
      const overflow = (sub
        ? ((dst ^ src) & (dst ^ result))
        : (~(dst ^ src) & (dst ^ result))) & sign;
      const flags = (result === 0 ? F_Z : 0) | ((result & sign) ? F_N : 0)
        | (carry ? F_C : 0) | (overflow ? F_V : 0);
      let sr = getU32(cpu + OFF_SR);
      if (compare) sr = (sr & ~15) | flags;
      else sr = (sr & ~31) | flags | (carry ? F_X : 0);
      setU32(cpu + OFF_SR, sr);
      return result;
    },

    condition(cpu, cond) {
      counters.condition += 1;
      const sr = getU32(cpu + OFF_SR);
      const n = !!(sr & F_N), z = !!(sr & F_Z);
      const v = !!(sr & F_V), c = !!(sr & F_C);
      switch (cond) {
        case 0: return 1;
        case 1: return 0;
        case 2: return !c && !z ? 1 : 0;
        case 3: return c || z ? 1 : 0;
        case 4: return !c ? 1 : 0;
        case 5: return c ? 1 : 0;
        case 6: return !z ? 1 : 0;
        case 7: return z ? 1 : 0;
        case 8: return !v ? 1 : 0;
        case 9: return v ? 1 : 0;
        case 10: return !n ? 1 : 0;
        case 11: return n ? 1 : 0;
        case 12: return n === v ? 1 : 0;
        case 13: return n !== v ? 1 : 0;
        case 14: return !z && n === v ? 1 : 0;
        case 15: return z || n !== v ? 1 : 0;
        default: return 0;
      }
    },

    push32(cpu, value) {
      counters.push32 += 1;
      const sp = (getU32(cpu + OFF_A + 7 * 4) - 4) >>> 0;
      setU32(cpu + OFF_A + 7 * 4, sp);
      writeBytes(cpu, sp, 4, value);
    },

    pop32(cpu) {
      counters.pop32 += 1;
      const sp = getU32(cpu + OFF_A + 7 * 4);
      const value = readBytes(cpu, sp, 4);
      if (!getU32(cpu + OFF_FAULT)) setU32(cpu + OFF_A + 7 * 4, (sp + 4) >>> 0);
      return value >>> 0;
    },

    set_sr(cpu, sr) {
      counters.set_sr += 1;
      // PoC CPU has no usp/ssp slots (the real runtime keeps them); mask as C.
      setU32(cpu + OFF_SR, sr & 0xa71f);
    },

    fail(cpu, code, address) {
      counters.fail += 1;
      setFault(cpu, code, address);
    },
  };

  return {
    imports,
    counters,
    failEvents,
    refresh,
    resetCounters() {
      for (const name of Object.keys(imports)) counters[name] = 0;
      failEvents.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// CPU/RAM initial state and observations.
// ---------------------------------------------------------------------------
function resetState(memory) {
  const u8 = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  u8.fill(0, CPU, CPU + 0x60);
  u8.fill(0, RAM_BASE, RAM_BASE + RAM_BYTES); // 64 KiB RAM window
  const setU32 = (address, value) => view.setUint32(address, value >>> 0, true);
  setU32(CPU + OFF_D + 0 * 4, 0x12345678);
  setU32(CPU + OFF_D + 3 * 4, 3);
  setU32(CPU + OFF_A + 0 * 4, A0_START_BUS);
  setU32(CPU + OFF_A + 7 * 4, STACK_BUS);
  setU32(CPU + OFF_PC, 0x0100);
  setU32(CPU + OFF_SR, 0x2700);
  // Data at A0: first word is overwritten by MOVE.W D0,(A0)+, the next three
  // words are read back by the loop.
  const ram = (offset, bytes) => u8.set(bytes, RAM_BASE + offset);
  ram(0x102, [0xab, 0xcd]);
  ram(0x104, [0xab, 0xce]);
  ram(0x106, [0xab, 0xcf]);
  // Guarded RAM instruction image 4e 75 (RTS) at bus 0xFF0200 -> RAM +0x200.
  ram(RAM_IMAGE_BUS, [0x4e, 0x75]);
  // RTS return address (big-endian 0x00001210) at A7 = 0xE05000.
  ram(0x1000, [0x00, 0x00, 0x12, 0x10]);
}

function readU32(memory, address) {
  return new DataView(memory.buffer).getUint32(address, true);
}

function readU64(memory, address) {
  return new DataView(memory.buffer).getBigUint64(address, true);
}

function readRam(memory, offset, length) {
  const start = RAM_BASE + offset;
  return new Uint8Array(memory.buffer).slice(start, start + length);
}

function snapshotState(memory) {
  return {
    cpu: new Uint8Array(memory.buffer).slice(CPU, CPU + 0x60),
    ram: new Uint8Array(memory.buffer).slice(RAM_BASE, RAM_BASE + RAM_BYTES),
  };
}

// ---------------------------------------------------------------------------
// Drivers.
// ---------------------------------------------------------------------------
function runJsDriven(game, memory, maxSteps = 64) {
  resetState(memory);
  const trace = [];
  let steps = 0;
  for (; steps < maxSteps; steps += 1) {
    if (readU32(memory, CPU + OFF_HALTED) || readU32(memory, CPU + OFF_FAULT)) break;
    trace.push(readU32(memory, CPU + OFF_PC));
    game.exports.translated_step(CPU);
    // machine_advance() lives in the runtime: c->cycles += instruction_cycles.
    const cycles = readU64(memory, CPU + OFF_CYCLES)
      + BigInt(readU32(memory, CPU + OFF_INSTR_CYCLES));
    new DataView(memory.buffer).setBigUint64(CPU + OFF_CYCLES, cycles, true);
  }
  return { trace, cycles: Number(readU64(memory, CPU + OFF_CYCLES)), steps };
}

function runLinked(runtime, game, memory, maxSteps = 64) {
  resetState(memory);
  runtime.exports.__indirect_function_table.set(0, game.exports.translated_step);
  const steps = runtime.exports.run(maxSteps);
  return {
    steps,
    cycles: Number(readU64(memory, CPU + OFF_CYCLES)),
  };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
async function main() {
  const buildDir = new URL('./build/', import.meta.url);
  const gamePath = fileURLToPath(new URL('poc.wasm', buildDir));
  const runtimePath = fileURLToPath(new URL('poc-runtime.wasm', buildDir));
  const metaPath = fileURLToPath(new URL('poc-meta.json', buildDir));

  const [gameBytes, runtimeBytes, meta] = await Promise.all([
    readFile(gamePath),
    readFile(runtimePath),
    readFile(metaPath, 'utf8').then(JSON.parse),
  ]);

  // --- 0. ABI / metadata sanity (generator and test must agree) -----------
  check(meta.format === 'dune-wasm-backend-poc/1', 'meta format');
  check(meta.abi.cpu_base === CPU, 'ABI cpu_base');
  check(meta.abi.memory_pages === MEMORY_PAGES, 'ABI memory pages');
  check(meta.abi.offsets.pc === OFF_PC, 'ABI pc offset');
  check(meta.abi.offsets.instruction_cycles === OFF_INSTR_CYCLES, 'ABI instruction_cycles');
  check(meta.abi.ram_base === RAM_BASE, 'ABI ram_base');
  check(meta.abi.helpers.join(',') ===
    'read_mem,write_mem,logic_flags,arithmetic,condition,push32,pop32,set_sr,fail',
  'ABI helper list/order');

  // --- 1. Compile and instantiate the game module -------------------------
  const compileStarted = performance.now();
  const gameModule = await WebAssembly.compile(gameBytes);
  const compileMs = performance.now() - compileStarted;
  check(WebAssembly.validate(gameBytes), 'game module validates');

  const memory = new WebAssembly.Memory({ initial: MEMORY_PAGES });
  const stubs = createStubs(memory);
  const game = await WebAssembly.instantiate(gameModule, {
    env: { memory, ...stubs.imports },
  });
  check(typeof game.exports.translated_step === 'function', 'translated_step export');
  check(typeof game.exports.stress_dispatch === 'function', 'stress_dispatch export');
  const gameImports = WebAssembly.Module.imports(gameModule).map((entry) => entry.name);
  check(gameImports.length === 10, `game imports count (got ${gameImports.length})`);
  check(gameImports.includes('memory'), 'game imports memory from the runtime');

  // --- 2. JS-driven execution --------------------------------------------
  stubs.resetCounters();
  const runStarted = performance.now();
  const result = runJsDriven(game, memory);
  const runMs = performance.now() - runStarted;

  checkEqual(result.steps, EXPECTED.steps, 'steps');
  checkEqual(result.cycles, EXPECTED.cycles, 'cycles');
  checkEqual(result.trace.length, EXPECTED.trace.length, 'trace length');
  for (let i = 0; i < EXPECTED.trace.length; i += 1) {
    checkEqual(result.trace[i], EXPECTED.trace[i], `trace[${i}]`);
  }
  checkEqual(readU32(memory, CPU + OFF_PC), EXPECTED.pc, 'final PC');
  checkEqual(readU32(memory, CPU + OFF_SR), EXPECTED.sr, 'final SR');
  checkEqual(readU32(memory, CPU + OFF_HALTED), EXPECTED.halted, 'halted flag');
  checkEqual(readU32(memory, CPU + OFF_FAULT), EXPECTED.fault, 'fault flag');
  for (let i = 0; i < 8; i += 1) {
    checkEqual(readU32(memory, CPU + OFF_D + i * 4), EXPECTED.d[i], `D${i}`);
    checkEqual(readU32(memory, CPU + OFF_A + i * 4), EXPECTED.a[i], `A${i}`);
  }
  checkEqual(readU32(memory, CPU + OFF_A + 7 * 4), EXPECTED.stackAfter, 'A7 after RTS');
  for (const [address, bytes] of EXPECTED.writes) {
    check(bytesEqual(readRam(memory, address - RAM_BASE, bytes.length), bytes),
      `RAM write at ${hex(address)}`);
  }
  for (const [name, expected] of Object.entries(EXPECTED.helperCalls)) {
    checkEqual(stubs.counters[name], expected, `helper ${name} calls`);
  }
  check(stubs.failEvents.length === 0, 'no fail() during normal run');
  // Baseline for the linked-mode comparison: captured before the fault tests
  // deliberately overwrite CPU/RAM state.
  const baselineState = snapshotState(memory);

  // --- 3. Dispatch stress: full 2048-slot two-level br_table --------------
  let stressMismatches = 0;
  let stressMissing = 0;
  for (let slot = 0; slot < 2048; slot += 1) {
    const expected = slot % 97 === 0 ? -1 : slot;
    const got = game.exports.stress_dispatch(slot);
    if (expected === -1) stressMissing += 1;
    if (got !== expected) stressMismatches += 1;
  }
  checkEqual(stressMismatches, 0, 'stress dispatch mismatches');
  checkEqual(stressMissing, 22, 'stress dispatch default-path hits');

  // --- 4. Failure paths (same failures as the C runtime) ------------------
  function expectFault(pc, code, label) {
    resetState(memory);
    stubs.resetCounters();
    const view = new DataView(memory.buffer);
    view.setUint32(CPU + OFF_PC, pc >>> 0, true);
    const before = view.getUint32(CPU + OFF_PC, true);
    game.exports.translated_step(CPU);
    checkEqual(readU32(memory, CPU + OFF_FAULT_CODE), code, `${label}: reason`);
    check(readU32(memory, CPU + OFF_FAULT) === 1, `${label}: fault set`);
    checkEqual(view.getUint32(CPU + OFF_PC, true), before, `${label}: pc unchanged`);
    checkEqual(stubs.counters.fail, 1, `${label}: one fail() call`);
  }
  expectFault(0x0300, FAIL.untranslated, 'bug: untranslated slot');
  expectFault(0x0101, FAIL.odd_pc, 'bug: odd pc');
  expectFault(0x01000000, FAIL.bad_pc, 'bug: pc out of 24-bit space');
  expectFault(0x200000, FAIL.unmapped, 'bug: ROM hole (page 0x200)');
  expectFault(0xff0300, FAIL.untranslated, 'bug: empty RAM page slot');
  // Self-modifying-code guard: RAM no longer holds the compiled instruction.
  {
    resetState(memory);
    stubs.resetCounters();
    new DataView(memory.buffer).setUint32(CPU + OFF_PC, 0xff0200, true);
    new Uint8Array(memory.buffer)[RAM_BASE + RAM_IMAGE_BUS] = 0x00;
    game.exports.translated_step(CPU);
    checkEqual(readU32(memory, CPU + OFF_FAULT_CODE), FAIL.ram_variant,
      'RAM variant mismatch: reason');
    checkEqual(stubs.counters.fail, 1, 'RAM variant mismatch: fail() called');
  }

  // --- 5. Linked mode: runtime-owned memory + call_indirect --------------
  const runtimeModule = await WebAssembly.compile(runtimeBytes);
  check(WebAssembly.validate(runtimeBytes), 'runtime module validates');
  const runtime = await WebAssembly.instantiate(runtimeModule, {});
  const rtImports = WebAssembly.Module.imports(runtimeModule);
  check(rtImports.length === 0, 'runtime module has no imports');
  const rtExports = WebAssembly.Module.exports(runtimeModule).map((entry) => entry.name);
  check(rtExports.includes('memory'), 'runtime exports memory');
  check(rtExports.includes('__indirect_function_table'), 'runtime exports function table');
  check(rtExports.includes('run'), 'runtime exports run()');

  const rtMemory = runtime.exports.memory;
  check(rtMemory.buffer.byteLength >= MEMORY_PAGES * 65536, 'runtime memory size');
  const rtStubs = createStubs(rtMemory);
  const rtGame = await WebAssembly.instantiate(gameModule, {
    env: { memory: rtMemory, ...rtStubs.imports },
  });

  // Primary baseline (captured above) and the linked run must agree.
  const linked = runLinked(runtime, rtGame, rtMemory);
  checkEqual(linked.steps, EXPECTED.steps, 'linked: steps');
  checkEqual(linked.cycles, EXPECTED.cycles, 'linked: cycles');
  checkEqual(readU32(rtMemory, CPU + OFF_PC), EXPECTED.pc, 'linked: final PC');
  checkEqual(readU32(rtMemory, CPU + OFF_SR), EXPECTED.sr, 'linked: final SR');
  checkEqual(readU32(rtMemory, CPU + OFF_HALTED), EXPECTED.halted, 'linked: halted');
  checkEqual(readU32(rtMemory, CPU + OFF_FAULT), EXPECTED.fault, 'linked: fault');
  const linkedState = snapshotState(rtMemory);
  check(bytesEqual(linkedState.cpu, baselineState.cpu), 'linked: CPU state identical');
  check(bytesEqual(linkedState.ram, baselineState.ram), 'linked: RAM state identical');

  // --- 5b. Heavy page stress: the largest real page shape -----------------
  // The reference C core's biggest 4 KiB page holds 1,344 68000 instructions.
  // poc-heavy.wasm puts three such pages (each ~300 KB of wasm code, a 32x64
  // br_table and ~98 nested blocks) into one module and checks that V8 accepts
  // and compiles it, and how expensive the first call per page is.
  const heavyBytes = await readFile(fileURLToPath(new URL('poc-heavy.wasm', buildDir)));
  const heavyCompileStarted = performance.now();
  const heavyModule = await WebAssembly.compile(heavyBytes);
  const heavyCompileMs = performance.now() - heavyCompileStarted;
  check(WebAssembly.validate(heavyBytes), 'heavy module validates');
  const heavy = await WebAssembly.instantiate(heavyModule, {});
  check(WebAssembly.Module.exports(heavyModule).some((entry) => entry.name === 'memory'),
    'heavy module defines and exports its own memory');
  const heavyInfo = meta.heavy;
  check(heavyInfo.handled_per_page === 1344, 'heavy: 1344 handlers per page');
  const firstCallMs = [];
  for (let page = 0; page < heavyInfo.pages; page += 1) {
    const started = performance.now();
    const result = heavy.exports.heavy_dispatch(page * heavyInfo.slots_per_page);
    firstCallMs.push(performance.now() - started);
    checkEqual(result, page * heavyInfo.slots_per_page, `heavy: page ${page} first call`);
  }
  let heavyMismatches = 0;
  let heavyHandled = 0;
  for (let page = 0; page < heavyInfo.pages; page += 1) {
    for (const slot of [0, 1, 63, 64, 500, 1000, 1343]) {
      heavyHandled += 1;
      if (heavy.exports.heavy_dispatch(page * heavyInfo.slots_per_page + slot)
        !== page * heavyInfo.slots_per_page + slot) heavyMismatches += 1;
    }
  }
  // Slots past the 1344 handled instructions of a page, and a page index that
  // does not exist, must fall through to -1.
  for (const slot of [1344, 2047, 2048 + 1344, 4096 + 2000, 6144]) {
    if (heavy.exports.heavy_dispatch(slot) !== -1) heavyMismatches += 1;
  }
  checkEqual(heavyMismatches, 0, 'heavy: dispatch ids/missing slots');
  const heavyWarmStarted = performance.now();
  for (let slot = 0; slot < heavyInfo.handled_per_page; slot += 1) {
    heavy.exports.heavy_dispatch(slot);
  }
  const heavyWarmUs = ((performance.now() - heavyWarmStarted) * 1000)
    / heavyInfo.handled_per_page;

  // --- 5c. ABI call-overhead benchmark (informs the helper ABI decision) --
  // Three ways for generated code to call a runtime helper:
  //   local  — a function in the same module (baseline, not available to us);
  //   import — env.callee bound to another wasm module's export (JS wrapper);
  //   table  — call_indirect through an imported funcref table (direct wasm);
  //   js     — a plain JavaScript function (worst case, shown for scale).
  const abiA = await WebAssembly.compile(
    await readFile(fileURLToPath(new URL('poc-abi-a.wasm', buildDir))));
  const abiB = await WebAssembly.compile(
    await readFile(fileURLToPath(new URL('poc-abi-b.wasm', buildDir))));
  check(WebAssembly.validate(
    await readFile(fileURLToPath(new URL('poc-abi-b.wasm', buildDir)))),
  'ABI benchmark module validates');
  const abiAInstance = await WebAssembly.instantiate(abiA, {});
  const helperTable = new WebAssembly.Table({ element: 'anyfunc', initial: 1, maximum: 1 });
  helperTable.set(0, abiAInstance.exports.callee);
  const abiBInstance = await WebAssembly.instantiate(abiB, {
    env: {
      callee: abiAInstance.exports.callee,
      js_callee: (value) => (value + 1) | 0,
      helper_table: helperTable,
    },
  });
  const benchCalls = 2000000;
  const abiNs = {};
  for (const kind of ['local', 'import', 'js', 'table']) {
    const loop = abiBInstance.exports['loop_' + kind];
    loop(200000); // warm-up
    const started = performance.now();
    const result = loop(benchCalls);
    const elapsed = performance.now() - started;
    abiNs[kind] = (elapsed * 1e6) / benchCalls;
    checkEqual(result, benchCalls % 0x100000000, `ABI bench ${kind} result`);
  }

  // --- 6. Throughput metric (not a pass/fail criterion) ------------------
  const repeats = 300;
  const throughputStarted = performance.now();
  for (let i = 0; i < repeats; i += 1) runJsDriven(game, memory);
  const perRunUs = ((performance.now() - throughputStarted) * 1000) / repeats;

  // --- 7. Report ---------------------------------------------------------
  const minBytes = meta.modules.game_bytes_without_stress ?? null;
  console.log('WASM backend PoC — synthetic translated program');
  console.log('  game.wasm           %s bytes (%s compile, %s handlers + stress 2048)',
    meta.modules.game_bytes, `${compileMs.toFixed(2)} ms`, meta.program.length);
  if (minBytes !== null) {
    const skeleton = meta.modules.game_bytes_no_handlers ?? 0;
    const marginal = (minBytes - skeleton) / meta.program.length;
    console.log('  game.wasm (no stress) %s bytes: dispatch/ABI overhead %s, %s bytes per handler',
      minBytes, skeleton, marginal.toFixed(1));
  }
  console.log('  runtime.wasm        %s bytes (memory + table + run loop)',
    meta.modules.runtime_bytes);
  console.log('  dispatch            4 KiB pages, 2048 slots/page (32x64 br_table), nesting<=98');
  console.log('  execution           steps=%d cycles=%d trace=%d (%s per run, %s us/run)',
    result.steps, result.cycles, result.trace.length, runMs.toFixed(3) + ' ms',
    perRunUs.toFixed(1));
  console.log('  helper calls        %s',
    Object.entries(EXPECTED.helperCalls).map(([name, value]) => `${name}=${value}`).join(' '));
  console.log('  linked driver       steps=%d cycles=%d state identical=%s',
    linked.steps, linked.cycles,
    bytesEqual(linkedState.cpu, baselineState.cpu) && bytesEqual(linkedState.ram, baselineState.ram));
  console.log('  stress dispatch     2048 slots, %d default-path hits, %d mismatches',
    stressMissing, stressMismatches);
  console.log('  ABI call cost       internal %s ns | wasm-export import %s ns | JS stub %s ns | call_indirect %s ns',
    abiNs.local.toFixed(2), abiNs.import.toFixed(2), abiNs.js.toFixed(2), abiNs.table.toFixed(2));
  console.log('  heavy pages         %d x 1344 handlers: %s bytes, compile %s ms',
    heavyInfo.pages, meta.modules.heavy_bytes, heavyCompileMs.toFixed(1));
  console.log('                      first-call per page %s ms, warm %s us/instruction',
    firstCallMs.map((ms) => ms.toFixed(2)).join('/'), heavyWarmUs.toFixed(2));
  console.log('');
  if (failures.length) {
    console.error('FAIL: %d of %d checks failed', failures.length, checks);
    for (const failure of failures) console.error('  - ' + failure);
    process.exitCode = 1;
    return;
  }
  console.log('OK: %d checks passed', checks);
}

main().catch((error) => {
  console.error('run_poc.mjs crashed:', error);
  process.exitCode = 1;
});
