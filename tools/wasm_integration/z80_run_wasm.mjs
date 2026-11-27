#!/usr/bin/env node
/**
 * Node harness for the Z80 differential: instantiate the real
 * ``runtime/wasm/runtime.wasm`` + a generated ``game.wasm`` with a real
 * ``translated_z80_step``, install the 2-slot single-dispatcher game table and
 * run every case of a ``DZC1`` case file through the runtime, writing the same
 * ``DZO1`` result bytes as the native C oracle.
 *
 * Unlike ``oracle/run_wasm.mjs`` this harness has no JS port of the helpers:
 * every Z80 helper is the runtime's own exported ``dune_z80_*`` function and
 * the dispatch goes through ``dune_rt_translated_z80_step`` exactly like
 * ``z80_tick`` does in the shipped core.
 *
 * Usage:
 *   node z80_run_wasm.mjs --runtime runtime.wasm --loader loader.mjs \
 *        --game game.wasm --meta meta.json --cases cases.bin --rom ROM --out out.bin
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const CASE_MAGIC = 'DZC1';
const OUT_MAGIC = 'DZO1';
const FORMAT_VERSION = 1;
const Z80_RAM_SIZE = 0x2000;
const HEADER_SIZE = 20;
const CASE_RECORD = 180;
const OUT_RECORD = 224;
const STATE_WORDS = 45;

const F_OFFSETS = {
  r8: 0, alternate: 24, a: 48, f: 52, a_alt: 56, f_alt: 60, i: 64, r: 68,
  iff1: 72, iff2: 76, im: 80, halted: 84, irq_line: 88, ei_delay: 92,
  pc: 96, sp: 100, ix: 104, iy: 108, wz: 112,
  debt_lo: 116, debt_hi: 120, steps_lo: 124, steps_hi: 128,
  cycles_lo: 132, cycles_hi: 136, interrupts_lo: 140, interrupts_hi: 144,
  audio_mode: 148, bus_bank: 152, bus_requested: 156, bus_reset_released: 160,
  seed_z80: 164, seed_ram: 168,
};

function fail(message) {
  process.stderr.write(`z80_run_wasm: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith('--')) fail(`unexpected argument ${key}`);
    args[key.slice(2)] = argv[i + 1];
  }
  for (const required of ['runtime', 'loader', 'game', 'meta', 'cases', 'rom', 'out']) {
    if (!args[required]) fail(`missing --${required}`);
  }
  return args;
}

const readU32 = (buffer, offset) =>
  (buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16) |
    (buffer[offset + 3] << 24)) >>> 0;

function writeU32(buffer, offset, value) {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
  buffer[offset + 2] = (value >>> 16) & 0xff;
  buffer[offset + 3] = (value >>> 24) & 0xff;
}

function fillRam(seed, size) {
  const out = new Uint8Array(size);
  let x = (seed >>> 0) || 0x9e3779b9;
  for (let i = 0; i < size; i += 1) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    out[i] = x & 0xff;
  }
  return out;
}

function ramDigest(bytes) {
  let h1 = 2166136261 >>> 0;
  let h2 = 0x9e3779b9 >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    h1 = Math.imul(h1 ^ bytes[i], 16777619) >>> 0;
    h2 = Math.imul((h2 + bytes[i]) >>> 0, 2246822519) >>> 0;
  }
  return [h1, h2];
}

function canonicalFromReason(meta, reason) {
  if (!reason) return null;
  for (const [prefix, code] of meta.fail_reasons) {
    if (reason.startsWith(prefix)) return code;
  }
  return null;
}

function canonicalFromRuntimeCode(meta, code) {
  for (const [canonical, runtime] of Object.entries(meta.canonical_to_runtime)) {
    if (Number(runtime) === Number(code)) return Number(canonical);
  }
  /* Emitter-canonical Z80 failure codes are not in the descriptor enum. */
  if (Number(code) === 17) return 17;
  return null;
}

const args = parseArgs(process.argv.slice(2));
const meta = JSON.parse(readFileSync(args.meta, 'utf8'));
const loader = await import(pathToFileURL(args.loader).href);

const runtimeBytes = new Uint8Array(readFileSync(args.runtime));
const rt = await loader.loadRuntime({ wasmBytes: runtimeBytes });
const abi = loader.initRuntime(rt);
const fields = abi.fields;
const memory = rt.memory;
const mem = () => new Uint8Array(memory.buffer);
const rom = new Uint8Array(readFileSync(args.rom));
loader.loadRom(rt, rom);

/* Instantiate the generated game module against the runtime's own exports. */
const gameBytes = new Uint8Array(readFileSync(args.game));
const gameModule = await WebAssembly.compile(gameBytes);
const importObject = { env: {} };
for (const entry of WebAssembly.Module.imports(gameModule)) {
  if (entry.module !== 'env') fail(`unexpected import module ${entry.module}`);
  if (entry.kind === 'memory') {
    importObject.env.memory = memory;
    continue;
  }
  const fn = rt.exports[entry.name];
  if (typeof fn !== 'function') fail(`runtime does not export ${entry.name}`);
  importObject.env[entry.name] = fn;
}
const game = await WebAssembly.instantiate(gameModule, importObject);

const slots = loader.appendFunctions(rt, [
  game.exports.translated_step,
  game.exports.translated_z80_step,
]);
const mode = loader.installGameTable(rt, slots, { count: 2 });
if (mode !== 2) fail(`unexpected game mode ${mode}`);
const stepZ80 = rt.exports.dune_rt_translated_z80_step;
if (typeof stepZ80 !== 'function') fail('runtime has no dune_rt_translated_z80_step');

/* CPU state offsets come from the runtime ABI descriptor (absolute from CPU). */
const cpu = rt.exports.dune_cpu_ptr();
const cpuSize = fields.SIZEOF_CPU;
const template = new Uint8Array(memory.buffer, cpu, cpuSize).slice();
const z80RamAddr = fields.ADDR_Z80_RAM;
const ramAddr = fields.ADDR_RAM;

const caseData = new Uint8Array(readFileSync(args.cases));
const header = caseData.subarray(0, HEADER_SIZE);
if (readU32(header, 0) !== 0x31435a44 /* DZC1 LE */ ||
    readU32(header, 4) !== FORMAT_VERSION ||
    readU32(header, 12) !== CASE_RECORD) {
  fail('incompatible Z80 case file');
}
const count = readU32(header, 8);
const out = new Uint8Array(HEADER_SIZE + count * OUT_RECORD);
const outHeader = out.subarray(0, HEADER_SIZE);
outHeader.set(header.subarray(0, 16));
outHeader[0] = 0x44; outHeader[1] = 0x5a; outHeader[2] = 0x4f; outHeader[3] = 0x31;
writeU32(outHeader, 12, OUT_RECORD);
writeU32(outHeader, 16, Z80_RAM_SIZE);

function setU8(offset, value) { new DataView(memory.buffer).setUint8(cpu + offset, value & 0xff); }
function setU16(offset, value) { new DataView(memory.buffer).setUint16(cpu + offset, value & 0xffff, true); }
function setU32(offset, value) { new DataView(memory.buffer).setUint32(cpu + offset, value >>> 0, true); }
function getU8(offset) { return new DataView(memory.buffer).getUint8(cpu + offset); }
function getU16(offset) { return new DataView(memory.buffer).getUint16(cpu + offset, true); }
function getU32(offset) { return new DataView(memory.buffer).getUint32(cpu + offset, true); }

const started = Date.now();
let faults = 0;
const faultHistogram = {};
for (let index = 0; index < count; index += 1) {
  const r = HEADER_SIZE + index * CASE_RECORD;
  const rd = (field) => readU32(caseData, r + F_OFFSETS[field]);

  /* Reset the whole CPU to the post-dune_rt_init() template (rom pointer,
     rom_size, sr, audio_mode=AUDIO_STUB) and apply the case state. */
  mem().set(template, cpu);
  for (let n = 0; n < 6; n += 1) {
    setU8(fields.OFF_Z80_R8 + n, readU32(caseData, r + n * 4));
    setU8(fields.OFF_Z80_ALTERNATE + n, readU32(caseData, r + 24 + n * 4));
  }
  setU8(fields.OFF_Z80_A, rd('a'));
  setU8(fields.OFF_Z80_F, rd('f'));
  setU8(fields.OFF_Z80_A_ALT, rd('a_alt'));
  setU8(fields.OFF_Z80_F_ALT, rd('f_alt'));
  setU8(fields.OFF_Z80_I, rd('i'));
  setU8(fields.OFF_Z80_R, rd('r'));
  setU8(fields.OFF_Z80_IFF1, rd('iff1'));
  setU8(fields.OFF_Z80_IFF2, rd('iff2'));
  setU8(fields.OFF_Z80_IM, rd('im'));
  setU8(fields.OFF_Z80_HALTED, rd('halted'));
  setU8(fields.OFF_Z80_IRQ_LINE, rd('irq_line'));
  setU8(fields.OFF_Z80_EI_DELAY, rd('ei_delay'));
  setU16(fields.OFF_Z80_PC, rd('pc'));
  setU16(fields.OFF_Z80_SP, rd('sp'));
  setU16(fields.OFF_Z80_IX, rd('ix'));
  setU16(fields.OFF_Z80_IY, rd('iy'));
  setU16(fields.OFF_Z80_WZ, rd('wz'));
  const debtLo = readU32(caseData, r + F_OFFSETS.debt_lo);
  const debtHi = readU32(caseData, r + F_OFFSETS.debt_hi);
  new DataView(memory.buffer).setBigInt64(cpu + (fields.OFF_Z80_DEBT),
    BigInt(debtLo) | (BigInt(debtHi) << 32n), true);
  for (const [field, base] of [['steps', fields.OFF_Z80_STEPS], ['cycles', fields.OFF_Z80_CYCLES],
    ['interrupts', fields.OFF_Z80_INTERRUPTS]]) {
    const lo = readU32(caseData, r + F_OFFSETS[`${field}_lo`]);
    const hi = readU32(caseData, r + F_OFFSETS[`${field}_hi`]);
    new DataView(memory.buffer).setBigUint64(cpu + (base),
      BigInt(lo) | (BigInt(hi) << 32n), true);
  }
  setU32(fields.OFF_Z80_BUS_BANK, rd('bus_bank'));
  setU8(fields.OFF_Z80_BUS_REQUESTED, rd('bus_requested'));
  setU8(fields.OFF_Z80_BUS_RESET_RELEASED, rd('bus_reset_released'));

  const z80 = fillRam(rd('seed_z80'), Z80_RAM_SIZE);
  /* Write the selected guarded variant at pc&0x1fff (little-endian). */
  const patchLen = readU32(caseData, r + 172);
  const patchBits = readU32(caseData, r + 176);
  const pcValue = rd('pc');
  for (let i = 0; i < patchLen && i < 4; i += 1) {
    z80[(pcValue + i) & 0x1fff] = (patchBits >>> (8 * i)) & 0xff;
  }
  mem().set(z80, z80RamAddr);
  const ram = fillRam(rd('seed_ram'), 0x10000);
  mem().set(ram, ramAddr);
  const [z80i1, z80i2] = ramDigest(z80);
  const [rami1, rami2] = ramDigest(ram);

  stepZ80(cpu);

  const o = HEADER_SIZE + index * OUT_RECORD;
  out.set(caseData.subarray(r, r + STATE_WORDS * 4), o);
  for (let n = 0; n < 6; n += 1) {
    writeU32(out, o + n * 4, getU8(fields.OFF_Z80_R8 + n));
    writeU32(out, o + 24 + n * 4, getU8(fields.OFF_Z80_ALTERNATE + n));
  }
  const byteFields = [
    ['a', fields.OFF_Z80_A], ['f', fields.OFF_Z80_F],
    ['a_alt', fields.OFF_Z80_A_ALT], ['f_alt', fields.OFF_Z80_F_ALT],
    ['i', fields.OFF_Z80_I], ['r', fields.OFF_Z80_R],
    ['iff1', fields.OFF_Z80_IFF1], ['iff2', fields.OFF_Z80_IFF2],
    ['im', fields.OFF_Z80_IM], ['halted', fields.OFF_Z80_HALTED],
    ['irq_line', fields.OFF_Z80_IRQ_LINE], ['ei_delay', fields.OFF_Z80_EI_DELAY],
  ];
  for (const [name, base] of byteFields) writeU32(out, o + F_OFFSETS[name], getU8(base));
  for (const [name, base] of [['pc', fields.OFF_Z80_PC], ['sp', fields.OFF_Z80_SP],
    ['ix', fields.OFF_Z80_IX], ['iy', fields.OFF_Z80_IY], ['wz', fields.OFF_Z80_WZ]]) {
    writeU32(out, o + F_OFFSETS[name], getU16(base));
  }
  const debt = new DataView(memory.buffer).getBigInt64(cpu + (fields.OFF_Z80_DEBT), true);
  writeU32(out, o + F_OFFSETS.debt_lo, Number(debt & 0xffffffffn) >>> 0);
  writeU32(out, o + F_OFFSETS.debt_hi, Number((debt >> 32n) & 0xffffffffn) >>> 0);
  for (const [field, base] of [['steps', fields.OFF_Z80_STEPS], ['cycles', fields.OFF_Z80_CYCLES],
    ['interrupts', fields.OFF_Z80_INTERRUPTS]]) {
    const value = new DataView(memory.buffer).getBigUint64(cpu + (base), true);
    writeU32(out, o + F_OFFSETS[`${field}_lo`], Number(value & 0xffffffffn) >>> 0);
    writeU32(out, o + F_OFFSETS[`${field}_hi`], Number((value >> 32n) & 0xffffffffn) >>> 0);
  }
  writeU32(out, o + F_OFFSETS.audio_mode, rd('audio_mode'));
  writeU32(out, o + F_OFFSETS.bus_bank, getU16(fields.OFF_Z80_BUS_BANK));
  writeU32(out, o + F_OFFSETS.bus_requested, getU8(fields.OFF_Z80_BUS_REQUESTED));
  writeU32(out, o + F_OFFSETS.bus_reset_released, getU8(fields.OFF_Z80_BUS_RESET_RELEASED));
  writeU32(out, o + F_OFFSETS.seed_z80, rd('seed_z80'));
  writeU32(out, o + F_OFFSETS.seed_ram, rd('seed_ram'));

  const fault = getU32(fields.OFF_FAULT);
  const faultAddress = getU32(fields.OFF_FAULT_ADDRESS);
  let failCode = 0;
  if (fault) {
    faults += 1;
    const reasonPtr = getU32(fields.OFF_REASON);
    const reason = reasonPtr ? loader.cString(rt, reasonPtr) : '';
    let canonical = canonicalFromReason(meta, reason);
    if (canonical === null) {
      canonical = canonicalFromRuntimeCode(meta, rt.exports.dune_rt_last_fail_code());
    }
    failCode = canonical === null ? 0xffffffff : canonical;
    if (failCode === 0xffffffff) fail(`cannot classify Z80 fault reason ${JSON.stringify(reason)}`);
    faultHistogram[failCode] = (faultHistogram[failCode] ?? 0) + 1;
  }
  writeU32(out, o + 180, fault);
  writeU32(out, o + 184, faultAddress);
  writeU32(out, o + 188, failCode);
  writeU32(out, o + 192, z80i1); writeU32(out, o + 196, z80i2);
  writeU32(out, o + 200, rami1); writeU32(out, o + 204, rami2);
  const finalZ80 = ramDigest(new Uint8Array(memory.buffer, z80RamAddr, Z80_RAM_SIZE));
  const finalRam = ramDigest(new Uint8Array(memory.buffer, ramAddr, 0x10000));
  writeU32(out, o + 208, finalZ80[0]); writeU32(out, o + 212, finalZ80[1]);
  writeU32(out, o + 216, finalRam[0]); writeU32(out, o + 220, finalRam[1]);
}

writeFileSync(args.out, out);
process.stderr.write(`z80_run_wasm: ran ${count} cases in ${Date.now() - started} ms, ` +
  `faults=${faults} histogram=${JSON.stringify(faultHistogram)}\n`);
