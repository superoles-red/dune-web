#!/usr/bin/env node
/**
 * Node harness for the differential test: instantiate a generated game.wasm,
 * provide the runtime helper stubs (a faithful JS port of runtime.h), execute
 * every case of a binary case file and write the same binary result format as
 * the native C oracle.
 *
 * Usage:
 *   node run_wasm.mjs --wasm GAME.wasm --meta META.json \
 *                     --cases CASES.bin --rom ROM.gen --out OUT.bin
 *   node run_wasm.mjs --ram-digest SEED
 */
import { readFileSync, writeFileSync } from 'node:fs';

const CASE_MAGIC = 'DWC1';
const OUT_MAGIC = 'DWO1';
const FORMAT_VERSION = 1;
const RAM_SIZE = 0x10000;
const HEADER_SIZE = 20;
const CASE_RECORD = 96;
const OUT_RECORD = 116;

const F_C = 1, F_V = 2, F_Z = 4, F_N = 8, F_X = 16;
const SR_SUPERVISOR = 0x2000;

function fail(message) {
  process.stderr.write(`run_wasm: ${message}\n`);
  process.exit(2);
}

function readU32LE(buffer, offset) {
  return (buffer[offset] | (buffer[offset + 1] << 8) |
    (buffer[offset + 2] << 16) | (buffer[offset + 3] << 24)) >>> 0;
}
function writeU32LE(buffer, offset, value) {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
  buffer[offset + 2] = (value >>> 16) & 0xff;
  buffer[offset + 3] = (value >>> 24) & 0xff;
}

function fillRam(seed) {
  const out = new Uint8Array(RAM_SIZE);
  let x = (seed >>> 0) || 0x9E3779B9;
  for (let i = 0; i < RAM_SIZE; i += 1) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    out[i] = x & 0xff;
  }
  return out;
}

function ramDigest(ram) {
  let h1 = 2166136261 >>> 0;
  let h2 = 0x9E3779B9 >>> 0;
  for (let i = 0; i < ram.length; i += 1) {
    h1 = Math.imul(h1 ^ ram[i], 16777619) >>> 0;
    h2 = Math.imul((h2 + ram[i]) >>> 0, 2246822519) >>> 0;
  }
  return [h1, h2];
}

// ---------------------------------------------------------------------------
// Runtime helper stubs: a direct port of runtime.h with the JS oracle's bus
// model.  Only RAM/ROM and the generic "unmapped" paths are modeled; hardware
// addresses abort loudly instead of silently pretending.
// ---------------------------------------------------------------------------
const HARDWARE_RANGES = [
  [0x200000, 0x200002],
  [0xa00000, 0xa10000],
  [0xa10000, 0xa10020],
  [0xa11100, 0xa11102],
  [0xa11200, 0xa11202],
  [0xa14000, 0xa14004],
  [0xc00000, 0xc00020],
];

function makeRuntime(memory, layout, offsets, codes) {
  let u8 = new Uint8Array(memory.buffer);
  let view = new DataView(memory.buffer);
  let currentFailCode = 0;
  const getU32 = (addr) => view.getUint32(addr, true);
  const setU32 = (addr, value) => view.setUint32(addr, value >>> 0, true);
  const getU16 = (addr) => view.getUint16(addr, true);
  const setU16 = (addr, value) => view.setUint16(addr, value & 0xffff, true);
  const getU8 = (addr) => u8[addr];
  const setU8 = (addr, value) => { u8[addr] = value & 0xff; };
  const pcOf = (cpu) => getU32(cpu + offsets.pc);
  const srOf = (cpu) => getU16(cpu + offsets.sr);
  const setSrRaw = (cpu, value) => setU16(cpu + offsets.sr, value);

  function setFault(cpu, code, address) {
    if (getU32(cpu + offsets.fault)) return;
    setU32(cpu + offsets.fault, 1);
    setU32(cpu + offsets.fault_address, address >>> 0);
    currentFailCode = code;
  }

  function isHardware(address) {
    return HARDWARE_RANGES.some(([a, b]) => address >= a && address < b);
  }

  function read8(cpu, address) {
    address = (address >>> 0) & 0xffffff;
    if (address < layout.rom_size) return u8[layout.rom + address];
    if (address >= 0xe00000) return u8[layout.ram + (address & 0xffff)];
    if (isHardware(address)) {
      fail(`harness cannot model hardware read at 0x${address.toString(16)} (pc=0x${pcOf(cpu).toString(16)})`);
    }
    setFault(cpu, codes.unmapped_read, address);
    return 0;
  }

  function write8(cpu, address, value) {
    address = (address >>> 0) & 0xffffff;
    if (address < layout.rom_size) { setFault(cpu, codes.write_rom, address); return; }
    if (address >= 0xe00000) { setU8(layout.ram + (address & 0xffff), value); return; }
    if (isHardware(address)) {
      fail(`harness cannot model hardware write at 0x${address.toString(16)} (pc=0x${pcOf(cpu).toString(16)})`);
    }
    setFault(cpu, codes.unmapped_write, address);
  }

  function readMem(cpu, address, size) {
    address >>>= 0; size >>>= 0;
    if (size > 1 && (address & 1)) { setFault(cpu, codes.address_error_read, address); return 0; }
    let value = 0;
    for (let i = 0; i < size; i += 1) {
      value = ((value * 256) + read8(cpu, (address + i) >>> 0)) >>> 0;
      if (getU32(cpu + offsets.fault)) break;
    }
    return value >>> 0;
  }

  function writeMem(cpu, address, size, value) {
    address >>>= 0; size >>>= 0; value >>>= 0;
    if (size > 1 && (address & 1)) { setFault(cpu, codes.address_error_write, address); return; }
    for (let i = 0; i < size; i += 1) {
      write8(cpu, (address + i) >>> 0, (value >>> ((size - i - 1) * 8)) & 0xff);
      if (getU32(cpu + offsets.fault)) break;
    }
  }

  const maskFor = (size) => (size === 4 ? 0xffffffff : (1 << (size * 8)) - 1) >>> 0;
  const signFor = (size) => (size === 4 ? 0x80000000 : 1 << (size * 8 - 1)) >>> 0;

  function signExtendValue(value, size) {
    const shift = 32 - size * 8;
    return (((value << shift) >> shift) >>> 0);
  }

  function signedBits(value, size) {
    const range = 1 << (size * 8);
    value = (value & maskFor(size)) >>> 0;
    return value >= range / 2 ? value - range : value;
  }

  function logicFlags(cpu, value, size) {
    size >>>= 0;
    value = (value & maskFor(size)) >>> 0;
    const sign = signFor(size);
    let sr = srOf(cpu);
    sr = (sr & ~15) | (value === 0 ? F_Z : 0) | ((value & sign) ? F_N : 0);
    setSrRaw(cpu, sr);
  }

  function arithmetic(cpu, dst, src, size, sub, compare) {
    size >>>= 0; sub = sub ? 1 : 0; compare = compare ? 1 : 0;
    const mask = maskFor(size);
    const sign = signFor(size);
    dst = (dst & mask) >>> 0; src = (src & mask) >>> 0;
    const result = ((sub ? dst - src : dst + src) & mask) >>> 0;
    const carry = sub ? src > dst : (dst + src) > mask;
    const overflow = ((sub ? ((dst ^ src) & (dst ^ result))
      : (~(dst ^ src) & (dst ^ result))) & sign) !== 0;
    const flags = (result === 0 ? F_Z : 0) | ((result & sign) ? F_N : 0)
      | (carry ? F_C : 0) | (overflow ? F_V : 0);
    let sr = srOf(cpu);
    if (compare) sr = (sr & ~15) | flags;
    else sr = (sr & ~31) | flags | (carry ? F_X : 0);
    setSrRaw(cpu, sr);
    return result;
  }

  function extendedArithmetic(cpu, dst, src, size, sub) {
    size >>>= 0; sub = sub ? 1 : 0;
    const sr = srOf(cpu);
    const mask = maskFor(size);
    const sign = signFor(size);
    const x = (sr & F_X) ? 1 : 0;
    dst = (dst & mask) >>> 0; src = (src & mask) >>> 0;
    const result = ((sub ? dst - src - x : dst + src + x) & mask) >>> 0;
    const carry = sub ? (src + x > dst) : (dst + src + x > mask);
    const mathematical = sub
      ? signedBits(dst, size) - signedBits(src, size) - x
      : signedBits(dst, size) + signedBits(src, size) + x;
    const overflow = mathematical < -sign || mathematical >= sign;
    const flags = ((result === 0 && (sr & F_Z)) ? F_Z : 0)
      | ((result & sign) ? F_N : 0)
      | (carry ? (F_C | F_X) : 0)
      | (overflow ? F_V : 0);
    setSrRaw(cpu, (sr & ~31) | flags);
    return result;
  }

  function bcdArithmetic(cpu, dst, src, sub) {
    sub = sub ? 1 : 0;
    const sr = srOf(cpu);
    const x = (sr & F_X) ? 1 : 0;
    let low = (sub ? (dst & 15) - (src & 15) - x : (dst & 15) + (src & 15) + x) >>> 0;
    if (low > 9) low = (sub ? low - 6 : low + 6) >>> 0;
    let decimal = (sub ? low + (dst & 0xf0) - (src & 0xf0)
      : low + (dst & 0xf0) + (src & 0xf0)) >>> 0;
    const carry = decimal > 0x99;
    if (carry) decimal = (sub ? decimal + 0xa0 : decimal - 0xa0) >>> 0;
    const result = decimal & 255;
    const flags = ((result === 0 && (sr & F_Z)) ? F_Z : 0) | (carry ? (F_C | F_X) : 0);
    setSrRaw(cpu, (sr & ~(F_C | F_X | F_Z)) | flags);
    return result >>> 0;
  }

  function bcdNegate(cpu, value) {
    value &= 255;
    const sr = srOf(cpu);
    const complement = (0x9a - value - ((sr & F_X) ? 1 : 0)) & 255;
    if (complement === 0x9a) {
      setSrRaw(cpu, sr & ~(F_C | F_X));
      return value >>> 0;
    }
    const result = (((complement & 15) === 10 ? complement + 6 : complement) & 255) >>> 0;
    const flags = F_C | F_X | ((result === 0 && (sr & F_Z)) ? F_Z : 0);
    setSrRaw(cpu, (sr & ~(F_C | F_X | F_Z)) | flags);
    return result;
  }

  function shiftValue(cpu, value, count, size, kind, left) {
    const sr = srOf(cpu);
    const mask = maskFor(size);
    const sign = signFor(size);
    let x = (sr & F_X) ? 1 : 0;
    let carry = kind === 2 ? x : 0;
    let overflow = 0;
    value = (value & mask) >>> 0;
    count &= 63;
    for (let n = 0; n < count; n += 1) {
      const oldsign = (value & sign) ? 1 : 0;
      carry = left ? oldsign : (value & 1);
      let next = left ? ((value << 1) & mask) >>> 0 : (value >>> 1);
      if (kind === 0 && !left && oldsign) next = (next | sign) >>> 0;
      if (kind === 2) next = (next | (left ? x : (x ? sign : 0))) >>> 0;
      if (kind === 3) next = (next | (left ? carry : (carry ? sign : 0))) >>> 0;
      if (kind === 0 && left && oldsign !== ((next & sign) ? 1 : 0)) overflow = 1;
      if (kind !== 3) x = carry;
      value = next >>> 0;
    }
    const flags = (value === 0 ? F_Z : 0) | ((value & sign) ? F_N : 0)
      | (carry ? F_C : 0) | (overflow ? F_V : 0);
    setSrRaw(cpu, (sr & ~31) | flags | (x ? F_X : 0));
    return value >>> 0;
  }

  function divideValue(cpu, dividend, divisor, isSigned) {
    divisor &= 0xffff;
    if (!divisor) { setFault(cpu, codes.divide_by_zero, pcOf(cpu)); return dividend >>> 0; }
    const d = isSigned ? signedBits(dividend, 4) : (dividend >>> 0);
    const s = isSigned ? signedBits(divisor, 2) : (divisor >>> 0);
    const quotient = Math.trunc(d / s);
    const remainder = d - quotient * s;
    if (isSigned ? (quotient < -32768 || quotient > 32767) : quotient > 65535) {
      setSrRaw(cpu, (srOf(cpu) & ~15) | F_V);
      return dividend >>> 0;
    }
    logicFlags(cpu, quotient, 2);
    return (((remainder & 0xffff) << 16) | (quotient & 0xffff)) >>> 0;
  }

  function movem(cpu, mask, address, mode, base, size, load) {
    const registers = new Uint32Array(16);
    for (let r = 0; r < 8; r += 1) {
      registers[r] = getU32(cpu + offsets.d + r * 4);
      registers[r + 8] = getU32(cpu + offsets.a + r * 4);
    }
    address >>>= 0;
    for (let bit = 0; bit < 16; bit += 1) {
      if (!(mask & (1 << bit))) continue;
      const reg = (!load && mode === 4) ? 15 - bit : bit;
      if (!load && mode === 4) address = (address - size) >>> 0;
      if (load) {
        let value = readMem(cpu, address, size);
        if (getU32(cpu + offsets.fault)) return;
        if (size === 2) value = signExtendValue(value, 2);
        if (reg < 8) setU32(cpu + offsets.d + reg * 4, value);
        else setU32(cpu + offsets.a + (reg - 8) * 4, value);
      } else {
        writeMem(cpu, address, size, registers[reg]);
        if (getU32(cpu + offsets.fault)) return;
      }
      if (load || mode !== 4) address = (address + size) >>> 0;
    }
    if (mode === 3 || mode === 4) setU32(cpu + offsets.a + base * 4, address);
  }

  function condition(cpu, cond) {
    const sr = srOf(cpu);
    const n = !!(sr & F_N), z = !!(sr & F_Z), v = !!(sr & F_V), carry = !!(sr & F_C);
    switch (cond) {
      case 0: return 1;
      case 1: return 0;
      case 2: return (!carry && !z) ? 1 : 0;
      case 3: return (carry || z) ? 1 : 0;
      case 4: return !carry ? 1 : 0;
      case 5: return carry ? 1 : 0;
      case 6: return !z ? 1 : 0;
      case 7: return z ? 1 : 0;
      case 8: return !v ? 1 : 0;
      case 9: return v ? 1 : 0;
      case 10: return !n ? 1 : 0;
      case 11: return n ? 1 : 0;
      case 12: return n === v ? 1 : 0;
      case 13: return n !== v ? 1 : 0;
      case 14: return (!z && n === v) ? 1 : 0;
      case 15: return (z || n !== v) ? 1 : 0;
      default: return 0;
    }
  }

  function indexValue(cpu, extension) {
    extension >>>= 0;
    const value = (extension & 0x8000)
      ? getU32(cpu + offsets.a + ((extension >> 12) & 7) * 4)
      : getU32(cpu + offsets.d + ((extension >> 12) & 7) * 4);
    return (extension & 0x0800) ? value >>> 0 : signExtendValue(value, 2);
  }

  function setSr(cpu, sr) {
    const current = srOf(cpu);
    if ((current ^ sr) & 0x2000) {
      if (current & 0x2000) {
        setU32(cpu + offsets.ssp, getU32(cpu + offsets.a + 7 * 4));
        setU32(cpu + offsets.a + 7 * 4, getU32(cpu + offsets.usp));
      } else {
        setU32(cpu + offsets.usp, getU32(cpu + offsets.a + 7 * 4));
        setU32(cpu + offsets.a + 7 * 4, getU32(cpu + offsets.ssp));
      }
    }
    setSrRaw(cpu, sr & 0xa71f);
  }

  function failHelper(cpu, code, address) {
    setFault(cpu, code, address);
  }

  const imports = {
    read_mem: readMem,
    write_mem: writeMem,
    push32(cpu, value) {
      let sp = (getU32(cpu + offsets.a + 7 * 4) - 4) >>> 0;
      setU32(cpu + offsets.a + 7 * 4, sp);
      writeMem(cpu, sp, 4, value);
    },
    pop32(cpu) {
      const sp = getU32(cpu + offsets.a + 7 * 4);
      const value = readMem(cpu, sp, 4);
      if (!getU32(cpu + offsets.fault)) setU32(cpu + offsets.a + 7 * 4, (sp + 4) >>> 0);
      return value >>> 0;
    },
    movem,
    set_sr: setSr,
    logic_flags: logicFlags,
    arithmetic,
    extended_arithmetic: extendedArithmetic,
    bcd_arithmetic: bcdArithmetic,
    bcd_negate: bcdNegate,
    shift_value: shiftValue,
    divide_value: divideValue,
    condition,
    index_value: indexValue,
    fail: failHelper,
  };

  return {
    imports,
    memory,
    resetFail() { currentFailCode = 0; },
    failCode() { return currentFailCode >>> 0; },
    u32: getU32,
    u16: getU16,
    setU32,
    setU16,
    setU8,
    ramView() { return new Uint8Array(memory.buffer, layout.ram, RAM_SIZE); },
    refresh() {
      u8 = new Uint8Array(memory.buffer);
      view = new DataView(memory.buffer);
    },
  };
}

// ---------------------------------------------------------------------------
async function runCases(args) {
  const wasmBytes = readFileSync(args.wasm);
  const meta = JSON.parse(readFileSync(args.meta, 'utf8'));
  const cases = readFileSync(args.cases);
  const rom = readFileSync(args.rom);
  const abi = meta.abi || {};
  const offsets = abi.offsets || {};
  const codes = abi.fail_codes || {};
  const layout = meta.memory;
  if (!layout) fail('metadata has no memory layout');
  if (rom.length !== layout.rom_size) {
    fail(`ROM is ${rom.length} bytes, expected ${layout.rom_size}`);
  }
  const memory = new WebAssembly.Memory({ initial: layout.pages, maximum: layout.pages });
  const runtime = makeRuntime(memory, layout, offsets, codes);
  runtime.refresh();
  new Uint8Array(memory.buffer).set(rom, layout.rom);

  let instance;
  try {
    ({ instance } = await WebAssembly.instantiate(wasmBytes, { env: { ...runtime.imports, memory } }));
  } catch (error) {
    fail(`instantiate failed: ${error && error.stack ? error.stack : error}`);
  }
  const exports = instance.exports;
  if (!exports.translated_step) fail('game.wasm does not export translated_step');
  const table = exports.__indirect_function_table;
  if (table) {
    if (table.length < 1 || table.get(0) !== exports.translated_step) {
      fail('__indirect_function_table[0] is not translated_step');
    }
  }
  const step = exports.translated_step_via_table || exports.translated_step;
  if (exports.warmup_all) {
    // Production calls this once under the loading screen; it must compile every
    // page function without executing an instruction (magic pc 0xFFFFFFFE).
    exports.warmup_all(layout.cpu);
  }

  const magic = cases.subarray(0, 4).toString('latin1');
  if (magic !== CASE_MAGIC || readU32LE(cases, 4) !== FORMAT_VERSION ||
      readU32LE(cases, 12) !== CASE_RECORD || readU32LE(cases, 16) !== RAM_SIZE) {
    fail('incompatible case file');
  }
  const count = readU32LE(cases, 8);
  if (cases.length !== HEADER_SIZE + count * CASE_RECORD) fail('case file length mismatch');

  const out = new Uint8Array(HEADER_SIZE + count * OUT_RECORD);
  out.set(Buffer.from(OUT_MAGIC, 'latin1'), 0);
  writeU32LE(out, 4, FORMAT_VERSION);
  writeU32LE(out, 8, count);
  writeU32LE(out, 12, OUT_RECORD);
  writeU32LE(out, 16, RAM_SIZE);

  const cpu = layout.cpu;
  const started = Date.now();
  for (let index = 0; index < count; index += 1) {
    const base = HEADER_SIZE + index * CASE_RECORD;
    const d = [];
    const a = [];
    for (let i = 0; i < 8; i += 1) d.push(readU32LE(cases, base + i * 4));
    for (let i = 0; i < 8; i += 1) a.push(readU32LE(cases, base + 32 + i * 4));
    const pc = readU32LE(cases, base + 64);
    const usp = readU32LE(cases, base + 68);
    const ssp = readU32LE(cases, base + 72);
    const sr = readU32LE(cases, base + 76);
    const instructionCycles = readU32LE(cases, base + 80);
    const halted = readU32LE(cases, base + 84);
    const fault = readU32LE(cases, base + 88);
    const seed = readU32LE(cases, base + 92);

    // RAM first, then CPU fields (RAM lives inside the CPU struct but does not
    // overlap d/a/pc/usp/ssp/sr/cycles/fault).
    runtime.refresh();
    const ram = runtime.ramView();
    ram.set(fillRam(seed));
    for (let i = 0; i < 8; i += 1) runtime.setU32(cpu + offsets.d + i * 4, d[i]);
    for (let i = 0; i < 8; i += 1) runtime.setU32(cpu + offsets.a + i * 4, a[i]);
    runtime.setU32(cpu + offsets.pc, pc);
    runtime.setU32(cpu + offsets.usp, usp);
    runtime.setU32(cpu + offsets.ssp, ssp);
    runtime.setU16(cpu + offsets.sr, sr);
    runtime.setU32(cpu + offsets.instruction_cycles, instructionCycles);
    runtime.setU32(cpu + offsets.halted, halted);
    runtime.setU32(cpu + offsets.fault, fault);
    runtime.setU32(cpu + offsets.fault_address, 0);
    runtime.resetFail();
    const initial = ramDigest(ram);
    step(cpu);
    const final = ramDigest(ram);
    const outBase = HEADER_SIZE + index * OUT_RECORD;
    for (let i = 0; i < 8; i += 1) writeU32LE(out, outBase + i * 4, runtime.u32(cpu + offsets.d + i * 4));
    for (let i = 0; i < 8; i += 1) writeU32LE(out, outBase + 32 + i * 4, runtime.u32(cpu + offsets.a + i * 4));
    writeU32LE(out, outBase + 64, runtime.u32(cpu + offsets.pc));
    writeU32LE(out, outBase + 68, runtime.u32(cpu + offsets.usp));
    writeU32LE(out, outBase + 72, runtime.u32(cpu + offsets.ssp));
    writeU32LE(out, outBase + 76, runtime.u16(cpu + offsets.sr));
    writeU32LE(out, outBase + 80, runtime.u32(cpu + offsets.instruction_cycles));
    writeU32LE(out, outBase + 84, runtime.u32(cpu + offsets.halted));
    writeU32LE(out, outBase + 88, runtime.u32(cpu + offsets.fault));
    writeU32LE(out, outBase + 92, runtime.u32(cpu + offsets.fault_address));
    writeU32LE(out, outBase + 96, runtime.failCode());
    writeU32LE(out, outBase + 100, initial[0]);
    writeU32LE(out, outBase + 104, initial[1]);
    writeU32LE(out, outBase + 108, final[0]);
    writeU32LE(out, outBase + 112, final[1]);
  }
  writeFileSync(args.out, out);
  process.stdout.write(`wasm: ran ${count} cases in ${Date.now() - started} ms\n`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) fail(`unexpected argument ${key}`);
    args[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args['ram-digest'] !== undefined) {
    const [h1, h2] = ramDigest(fillRam(Number(args['ram-digest']) >>> 0));
    process.stdout.write(`${h1} ${h2}\n`);
    return;
  }
  for (const key of ['wasm', 'meta', 'cases', 'rom', 'out']) {
    if (!args[key]) fail(`missing --${key}`);
  }
  await runCases(args);
}

main().catch((error) => fail(error && error.stack ? error.stack : String(error)));
