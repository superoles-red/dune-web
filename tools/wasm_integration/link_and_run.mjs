#!/usr/bin/env node
/**
 * Link the generated ``game.wasm`` into the real ``runtime.wasm`` and run the
 * differential cases through the runtime's own dispatcher.
 *
 * This is the second half of the Phase-3 integration: instead of Node stubs that
 * re-implement ``runtime.h``, the game module is instantiated with
 *
 *   env.memory      = the runtime-owned 64 MiB / 512 MiB WebAssembly.Memory
 *   env.dune_<h>    = the *actual* ``dune_<h>`` exports of runtime.wasm
 *
 * (every import is verified to be the runtime's own export object, identity
 * ``===``, so no JS glue sits on the instruction path), the game function is
 * appended to the runtime's ``__indirect_function_table``, the ROM is copied
 * into ``dune_rt_rom_buffer()`` and each case is executed by calling
 * ``dune_rt_translated_step(ADDR_CPU)``.
 *
 * Byte-for-byte the same DWO1 result records as the native C oracle are written,
 * so ``tools/wasm_emitter/oracle/compare.py`` can compare them directly.
 *
 * Usage:
 *   node link_and_run.mjs --runtime runtime.wasm --loader loader.mjs \
 *        --game page_013.wasm --meta page_013.meta.json --rom ROM.gen \
 *        --cases page_013.cases.bin --out page_013.runtime.bin [--verify-only]
 *
 * stdout: one JSON report.  stderr: progress log.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const CASE_MAGIC = 'DWC1';
const OUT_MAGIC = 'DWO1';
const FORMAT_VERSION = 1;
const RAM_SIZE = 0x10000;
const HEADER_SIZE = 20;
const CASE_RECORD = 96;
const OUT_RECORD = 116;

const PAGE = 0x1000;
const ROM_PAGE = 0x13;

function fail(message) {
  process.stderr.write(`link_and_run: ${message}\n`);
  process.exit(2);
}

function log(message) {
  process.stderr.write(`link_and_run: ${message}\n`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) fail(`unexpected argument ${key}`);
    const name = key.slice(2);
    if (name === 'verify-only' || name === 'no-machine-smoke'
      || name === 'no-z80-smoke') {
      args[name] = true;
      continue;
    }
    if (i + 1 >= argv.length) fail(`missing value for ${key}`);
    args[name] = argv[i + 1];
    i += 1;
  }
  return args;
}

function readU32LE(buffer, offset) {
  return (buffer[offset] | (buffer[offset + 1] << 8)
    | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 24)) >>> 0;
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
  return [h1 >>> 0, h2 >>> 0];
}

const args = parseArgs(process.argv.slice(2));
for (const key of ['runtime', 'loader', 'game', 'meta']) {
  if (!args[key]) fail(`missing --${key}`);
}
if (!args['verify-only']) {
  for (const key of ['rom', 'cases', 'out']) {
    if (!args[key]) fail(`missing --${key}`);
  }
}

const [metaText, runtimeBytes, gameBytes] = await Promise.all([
  readFile(args.meta, 'utf8'),
  readFile(args.runtime),
  readFile(args.game),
]);
let meta;
try {
  meta = JSON.parse(metaText);
} catch (error) {
  fail(`invalid --meta JSON: ${error}`);
}
if (!meta.runtime_abi || !meta.abi) fail('--meta has no runtime_abi/abi section');

const loader = await import(pathToFileURL(args.loader).href);
const rt = await loader.loadRuntime({ wasmBytes: runtimeBytes });
const abi = loader.initRuntime(rt);
const runtimeHash = await loader.abiHashHex(abi);

const checks = {
  runtime_wasm_sha256: createHash('sha256').update(runtimeBytes).digest('hex'),
  runtime_bytes: runtimeBytes.length,
  runtime_abi_hash: runtimeHash,
  expected_abi_hash: meta.runtime_abi_hash,
  abi_hash_match: runtimeHash === meta.runtime_abi_hash,
  pinned_abi_hash: meta.pinned_abi_hash,
  abi_hash_pinned: meta.pinned_abi_hash ? runtimeHash === meta.pinned_abi_hash : null,
  game_wasm_sha256: createHash('sha256').update(gameBytes).digest('hex'),
  game_wasm_bytes: gameBytes.length,
  pointer_bits: meta.abi.pointer_bits,
  descriptor_word_count: rt.exports.dune_abi_word_count(),
};

if (!checks.abi_hash_match) {
  fail(`runtime ABI hash ${runtimeHash} != meta ${meta.runtime_abi_hash} `
    + '(game.wasm was built against a different descriptor)');
}
if (checks.abi_hash_pinned === false) {
  fail(`runtime ABI hash ${runtimeHash} != pinned manifest hash ${meta.pinned_abi_hash}`);
}
if (meta.module && meta.module.sha256
  && meta.module.sha256 !== checks.game_wasm_sha256) {
  fail(`game.wasm SHA ${checks.game_wasm_sha256} != meta ${meta.module.sha256}`);
}

/* ---------------------------------------------------------------- field map -- */
const fields = new Uint32Array(rt.memory.buffer, abi.pointer, loader.ABI.wordCount);
const descriptorFields = {};
for (let i = 0; i < loader.ABI_FIELDS.length; i += 1) descriptorFields[loader.ABI_FIELDS[i]] = fields[i];
const fieldDiffs = [];
for (const [name, value] of Object.entries(meta.runtime_abi.fields || {})) {
  if (descriptorFields[name] !== value) {
    fieldDiffs.push(`${name}: runtime=${descriptorFields[name]} meta=${value}`);
  }
}
if (fieldDiffs.length) fail(`runtime descriptor differs from build meta: ${fieldDiffs}`);
checks.descriptor_fields_checked = Object.keys(meta.runtime_abi.fields || {}).length;

const cpuABI = meta.abi.offsets;
const reasonOffset = descriptorFields.OFF_REASON;
if (cpuABI.pc !== descriptorFields.OFF_PC || cpuABI.sr !== descriptorFields.OFF_SR
  || cpuABI.ram !== descriptorFields.OFF_RAM
  || cpuABI.fault !== descriptorFields.OFF_FAULT
  || cpuABI.fault_address !== descriptorFields.OFF_FAULT_ADDRESS
  || cpuABI.instruction_cycles !== descriptorFields.OFF_INSTRUCTION_CYCLES) {
  fail('game meta CPU offsets do not match the runtime descriptor');
}

const CPU = descriptorFields.ADDR_CPU;
const RAM = descriptorFields.ADDR_RAM;
const ROM_ADDR = descriptorFields.ADDR_ROM;
const ROM_CAPACITY = rt.exports.dune_rt_rom_capacity();

/* ---------------------------------------------------------------------- ROM -- */
let romBytes = null;
if (!args['verify-only']) {
  romBytes = await readFile(args.rom);
  if (romBytes.length > ROM_CAPACITY) {
    fail(`ROM is ${romBytes.length} bytes, runtime buffer is ${ROM_CAPACITY}`);
  }
  loader.loadRom(rt, romBytes);
  const roundTrip = loader.readRom(rt, 0, romBytes.length);
  if (Buffer.compare(Buffer.from(roundTrip), romBytes) !== 0) {
    fail('ROM copy into dune_rt_rom_buffer() did not round-trip');
  }
  checks.rom_bytes = romBytes.length;
  checks.rom_sha256 = createHash('sha256').update(romBytes).digest('hex');
}

/* --------------------------------------------------------------- game module -- */
let gameModule;
try {
  gameModule = new WebAssembly.Module(gameBytes);
} catch (error) {
  fail(`game.wasm does not compile: ${error}`);
}
const imports = WebAssembly.Module.imports(gameModule);
const env = {};
const importChecks = [];
let helperCount = 0;
for (const entry of imports) {
  if (entry.module !== 'env') fail(`game.wasm imports ${entry.module}.${entry.name}; expected env.*`);
  if (entry.kind === 'memory') {
    if (entry.name !== 'memory') fail(`unexpected memory import env.${entry.name}`);
    env.memory = rt.memory;
    importChecks.push({ module: entry.module, name: entry.name, kind: entry.kind,
      identity: true, note: 'runtime-owned WebAssembly.Memory' });
    continue;
  }
  if (entry.kind !== 'function') fail(`unsupported import kind ${entry.kind}`);
  if (!entry.name.startsWith('dune_')) {
    fail(`game.wasm imports env.${entry.name}; runtime helpers are dune_*`);
  }
  const exported = rt.exports[entry.name];
  if (typeof exported !== 'function') {
    fail(`game.wasm imports env.${entry.name}, runtime.wasm does not export it`);
  }
  if (exported !== rt.exports[entry.name]) fail('runtime export identity changed');
  env[entry.name] = exported;
  helperCount += 1;
  importChecks.push({ module: entry.module, name: entry.name, kind: entry.kind,
    identity: true });
}
checks.imports = importChecks;
checks.helper_imports = helperCount;
checks.memory_identity = env.memory === rt.memory;
if (!checks.memory_identity) fail('game.wasm did not receive the runtime memory object');

let game;
try {
  game = await WebAssembly.instantiate(gameModule, { env });
} catch (error) {
  fail(`linking game.wasm into runtime.wasm failed (signature/layout mismatch): ${error}`);
}
for (const name of ['translated_step', 'warmup_all', 'translated_step_via_table']) {
  if (typeof game.exports[name] !== 'function') fail(`game.wasm does not export ${name}`);
}
if (!game.exports.__indirect_function_table) fail('game.wasm has no funcref table');
checks.game_exports = Object.keys(game.exports).sort();
checks.game_z80_export = typeof game.exports.translated_z80_step === 'function';

/* ---------------------------------------------------- funcref table + dispatch -- */
// Full modules export the honest translated_z80_step stub; page modules do not.
// The runtime's single-dispatcher mode stores [translated_step, z80_step].
const gameFunctions = [game.exports.translated_step];
if (checks.game_z80_export) gameFunctions.push(game.exports.translated_z80_step);
const slots = loader.appendFunctions(rt, gameFunctions);
const z80Slot = checks.game_z80_export ? slots[1] : 0;
const mode = loader.installGameTable(rt, [slots[0], z80Slot]);
const table = loader.gameTableView(rt);
checks.game_table_mode = mode;
checks.game_table_mode_ok = mode === loader.ABI.dispatch.modeSingle;
checks.game_table_slot = slots[0];
checks.game_table_slot_ok = table[0] === slots[0];
checks.game_z80_slot = z80Slot;
checks.game_z80_slot_ok = !checks.game_z80_export || table[1] === z80Slot;
checks.game_indirect_table_ok =
  game.exports.__indirect_function_table.get(0) === game.exports.translated_step;
if (!checks.game_table_mode_ok) {
  fail(`runtime game mode is ${mode}, expected SINGLE (${loader.ABI.dispatch.modeSingle})`);
}
if (!checks.game_table_slot_ok) fail('runtime page table slot 0 is not the game translated_step');
if (!checks.game_z80_slot_ok) fail('runtime page table slot 1 is not the game translated_z80_step');
if (!checks.game_indirect_table_ok) fail('game __indirect_function_table[0] != translated_step');

const warmupStarted = process.hrtime.bigint();
game.exports.warmup_all(CPU);
checks.warmup_ms = Number(process.hrtime.bigint() - warmupStarted) / 1e6;

/* --------------------------------------- game-internal call_indirect smoke -- */
// translated_step_via_table() calls table[0] inside game.wasm, which must be its
// own translated_step (element section).  One known instruction proves it.
{
  resetCpuFields();
  const ram = new Uint8Array(rt.memory.buffer, RAM, RAM_SIZE);
  ram.fill(0);
  const view = new DataView(rt.memory.buffer);
  view.setUint32(CPU + cpuABI.pc, ROM_PAGE << 12, true);
  view.setUint32(CPU + cpuABI.a + 7 * 4, 0xE0F000, true);
  game.exports.translated_step_via_table(CPU);
  const after = new DataView(rt.memory.buffer);
  const via = {
    pc: after.getUint32(CPU + cpuABI.pc, true),
    a7: after.getUint32(CPU + cpuABI.a + 7 * 4, true),
    fault: after.getUint32(CPU + cpuABI.fault, true),
  };
  via.expected_pc = (ROM_PAGE << 12) + 2;
  via.ok = via.pc === via.expected_pc && via.a7 === 0xE0F004 && via.fault === 0;
  checks.game_via_table_smoke = via;
  if (!via.ok) fail(`game translated_step_via_table() smoke failed: ${JSON.stringify(via)}`);
}

/* --------------------------------------------------------------- case runner -- */
function resetCpuFields() {
  const view = new DataView(rt.memory.buffer);
  for (let i = 0; i < 8; i += 1) {
    view.setUint32(CPU + cpuABI.d + i * 4, 0, true);
    view.setUint32(CPU + cpuABI.a + i * 4, 0, true);
  }
  view.setUint32(CPU + cpuABI.pc, 0, true);
  view.setUint32(CPU + cpuABI.usp, 0, true);
  view.setUint32(CPU + cpuABI.ssp, 0, true);
  view.setUint16(CPU + cpuABI.sr, 0x2700, true);
  view.setUint32(CPU + cpuABI.instruction_cycles, 0, true);
  view.setUint32(CPU + cpuABI.halted, 0, true);
  view.setUint32(CPU + cpuABI.fault, 0, true);
  view.setUint32(CPU + cpuABI.fault_address, 0, true);
  view.setUint32(CPU + reasonOffset, 0, true);
}

const failCodeMap = meta.fail_codes || {};
const inverseFailCodes = {};
for (const [runtimeCode, canonical] of Object.entries(failCodeMap.runtime_to_canonical || {})) {
  inverseFailCodes[Number(runtimeCode)] = Number(canonical);
}
const runtimeFailNames = new Set(Object.keys(failCodeMap.runtime_names || {}));
const cReasons = (failCodeMap.c_reasons || []).map(([prefix, code]) => [prefix, Number(code)]);

function classifyFault() {
  const view = new DataView(rt.memory.buffer);
  const fault = view.getUint32(CPU + cpuABI.fault, true);
  if (!fault) return { code: 0, reason: '' };
  const reasonPointer = view.getUint32(CPU + reasonOffset, true);
  if (!reasonPointer) return { code: null, reason: '' };
  const bytes = new Uint8Array(rt.memory.buffer, reasonPointer);
  let end = 0;
  while (end < 4096 && bytes[end] !== 0) end += 1;
  const reason = new TextDecoder().decode(bytes.subarray(0, end));
  const named = /^([A-Z_]+): /.exec(reason);
  if (named && runtimeFailNames.has(named[1])) {
    const runtimeCode = rt.exports.dune_rt_last_fail_code();
    const canonical = inverseFailCodes[runtimeCode];
    if (canonical === undefined) {
      fail(`runtime fail code ${runtimeCode} ("${reason}") has no canonical mapping`);
    }
    return { code: canonical, reason };
  }
  for (const [prefix, code] of cReasons) {
    if (reason.startsWith(prefix)) return { code, reason };
  }
  fail(`unknown fault reason from runtime: "${reason}"`);
  return { code: null, reason };
}

let casesReport = null;
if (!args['verify-only']) {
  const cases = await readFile(args.cases);
  if (cases.subarray(0, 4).toString('latin1') !== CASE_MAGIC
    || readU32LE(cases, 4) !== FORMAT_VERSION
    || readU32LE(cases, 12) !== CASE_RECORD
    || readU32LE(cases, 16) !== RAM_SIZE) {
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

  const faultHistogram = {};
  let faults = 0;
  let unknownFaults = 0;
  const started = process.hrtime.bigint();
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

    const ram = new Uint8Array(rt.memory.buffer, RAM, RAM_SIZE);
    ram.set(fillRam(seed));
    const view = new DataView(rt.memory.buffer);
    for (let i = 0; i < 8; i += 1) {
      view.setUint32(CPU + cpuABI.d + i * 4, d[i], true);
      view.setUint32(CPU + cpuABI.a + i * 4, a[i], true);
    }
    view.setUint32(CPU + cpuABI.pc, pc, true);
    view.setUint32(CPU + cpuABI.usp, usp, true);
    view.setUint32(CPU + cpuABI.ssp, ssp, true);
    view.setUint16(CPU + cpuABI.sr, sr, true);
    view.setUint32(CPU + cpuABI.instruction_cycles, instructionCycles, true);
    view.setUint32(CPU + cpuABI.halted, halted, true);
    view.setUint32(CPU + cpuABI.fault, fault, true);
    view.setUint32(CPU + cpuABI.fault_address, 0, true);
    view.setUint32(CPU + reasonOffset, 0, true);
    const initial = ramDigest(ram);

    rt.exports.dune_rt_translated_step(CPU);

    // Re-fetch the view: a memory.grow during the instruction would detach it.
    const final = ramDigest(new Uint8Array(rt.memory.buffer, RAM, RAM_SIZE));
    const classified = classifyFault();
    if (classified.code === null) unknownFaults += 1;
    const after = new DataView(rt.memory.buffer);
    const outBase = HEADER_SIZE + index * OUT_RECORD;
    for (let i = 0; i < 8; i += 1) {
      writeU32LE(out, outBase + i * 4, after.getUint32(CPU + cpuABI.d + i * 4, true));
      writeU32LE(out, outBase + 32 + i * 4, after.getUint32(CPU + cpuABI.a + i * 4, true));
    }
    const faultAfter = after.getUint32(CPU + cpuABI.fault, true);
    if (faultAfter) {
      faults += 1;
      const code = classified.code;
      faultHistogram[code] = (faultHistogram[code] || 0) + 1;
    }
    writeU32LE(out, outBase + 64, after.getUint32(CPU + cpuABI.pc, true));
    writeU32LE(out, outBase + 68, after.getUint32(CPU + cpuABI.usp, true));
    writeU32LE(out, outBase + 72, after.getUint32(CPU + cpuABI.ssp, true));
    writeU32LE(out, outBase + 76, after.getUint16(CPU + cpuABI.sr, true));
    writeU32LE(out, outBase + 80, after.getUint32(CPU + cpuABI.instruction_cycles, true));
    writeU32LE(out, outBase + 84, after.getUint32(CPU + cpuABI.halted, true));
    writeU32LE(out, outBase + 88, faultAfter);
    writeU32LE(out, outBase + 92, after.getUint32(CPU + cpuABI.fault_address, true));
    writeU32LE(out, outBase + 96, classified.code ?? 0);
    writeU32LE(out, outBase + 100, initial[0]);
    writeU32LE(out, outBase + 104, initial[1]);
    writeU32LE(out, outBase + 108, final[0]);
    writeU32LE(out, outBase + 112, final[1]);
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  await writeFile(args.out, out);
  casesReport = {
    count,
    elapsed_ms: elapsedMs,
    cases_per_second: elapsedMs > 0 ? (count / (elapsedMs / 1000)) : null,
    faults,
    unknown_faults: unknownFaults,
    fault_code_histogram: Object.fromEntries(
      Object.entries(faultHistogram).sort((left, right) => Number(left[0]) - Number(right[0])),
    ),
    out_bytes: out.length,
    out_sha256: createHash('sha256').update(out).digest('hex'),
  };
  checks.cases = casesReport;
  if (unknownFaults) fail(`${unknownFaults} fault(s) could not be classified`);
}

/* ----------------------------------------------------- z80 stub link smoke -- */
// The full module's translated_z80_step must report the canonical UNTRANSLATED
// failure (Z80 translation is out of scope), never a fake success.
let z80Smoke = null;
if (!args['no-z80-smoke'] && checks.game_z80_export) {
  resetCpuFields();
  const ram = new Uint8Array(rt.memory.buffer, RAM, RAM_SIZE);
  ram.fill(0);
  const view = new DataView(rt.memory.buffer);
  const z80pc = 0x1234;
  view.setUint32(CPU + cpuABI.z80_cpu + cpuABI.z80cpu_pc, z80pc, true);
  const cycles = rt.exports.dune_rt_translated_z80_step(CPU);
  const classified = classifyFault();
  const after = new DataView(rt.memory.buffer);
  const expected = meta.fail_codes ? meta.fail_codes.untranslated_canonical : 1;
  z80Smoke = {
    cycles,
    fault: after.getUint32(CPU + cpuABI.fault, true),
    fault_code: classified.code,
    fault_reason: classified.reason,
    expected_fault_code: expected,
    z80_pc: z80pc,
  };
  z80Smoke.ok = z80Smoke.fault !== 0 && z80Smoke.cycles === 0
    && z80Smoke.fault_code === expected
    && after.getUint32(CPU + cpuABI.z80_cpu + cpuABI.z80cpu_pc, true) === z80pc;
  checks.z80_stub_smoke = z80Smoke;
  if (!z80Smoke.ok) {
    fail(`game translated_z80_step stub smoke failed: ${JSON.stringify(z80Smoke)}`);
  }
}

/* --------------------------------------------------- machine_step link smoke -- */
let machineSmoke = null;
if (!args['verify-only'] && !args['no-machine-smoke'] && romBytes) {
  // dune_rt_machine_step() is the host hook that runs one full machine step
  // (interrupt check + translated_step + VDP/Z80/audio timing).  Run it after
  // the differential so the compared states are unaffected.
  const expectedPC = (ROM_PAGE << 12) + 2; // page $013 starts with ADDQ.L #4,A7
  resetCpuFields();
  const ram = new Uint8Array(rt.memory.buffer, RAM, RAM_SIZE);
  ram.fill(0);
  let view = new DataView(rt.memory.buffer);
  view.setUint32(CPU + cpuABI.pc, ROM_PAGE << 12, true);
  view.setUint32(CPU + cpuABI.a + 7 * 4, 0xE0F000, true);
  rt.exports.dune_rt_machine_step();
  view = new DataView(rt.memory.buffer);
  machineSmoke = {
    pc: view.getUint32(CPU + cpuABI.pc, true),
    a7: view.getUint32(CPU + cpuABI.a + 7 * 4, true),
    fault: view.getUint32(CPU + cpuABI.fault, true),
    instruction_cycles: view.getUint32(CPU + cpuABI.instruction_cycles, true),
    cycles: view.getUint32(CPU + cpuABI.cycles, true),
  };
  machineSmoke.expected_pc = expectedPC;
  machineSmoke.ok = machineSmoke.pc === expectedPC
    && machineSmoke.a7 === 0xE0F004
    && machineSmoke.fault === 0
    && machineSmoke.cycles > 0;
  checks.machine_step_smoke = machineSmoke;
  if (!machineSmoke.ok) {
    fail(`dune_rt_machine_step() smoke failed: ${JSON.stringify(machineSmoke)}`);
  }
}

const ok = Object.entries(checks).every(([name, value]) => {
  if (name.endsWith('_ok') || name === 'abi_hash_match') return value !== false;
  return true;
});
const report = {
  ok,
  runtime: {
    sha256: checks.runtime_wasm_sha256,
    bytes: checks.runtime_bytes,
    abi_hash: runtimeHash,
    abi_hash_matches_build: checks.abi_hash_match,
    pinned_abi_hash: checks.pinned_abi_hash,
    pointer_bits: checks.pointer_bits,
    word_count: checks.descriptor_word_count,
    memory_pages: rt.memory.buffer.byteLength >>> 16,
    indirect_table_length: rt.exports.__indirect_function_table.length,
  },
  game: {
    sha256: checks.game_wasm_sha256,
    bytes: checks.game_wasm_bytes,
    page: meta.page ?? null,
    instructions: meta.instruction_count
      ?? (meta.instructions ? meta.instructions.length : null),
  },
  link: {
    imports: importChecks,
    helper_imports: helperCount,
    memory_identity: checks.memory_identity,
    game_table_mode: checks.game_table_mode,
    game_table_slot: checks.game_table_slot,
    game_z80_export: checks.game_z80_export,
    game_z80_slot: checks.game_z80_slot,
    game_z80_slot_ok: checks.game_z80_slot_ok,
    z80_stub_smoke: z80Smoke,
    game_table_mode_ok: checks.game_table_mode_ok,
    game_indirect_table_ok: checks.game_indirect_table_ok,
    game_via_table_smoke: checks.game_via_table_smoke,
    warmup_ms: checks.warmup_ms,
    machine_step_smoke: machineSmoke,
    descriptor_fields_checked: checks.descriptor_fields_checked,
  },
  cases: casesReport,
};
process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
log(`link ok: ${helperCount} runtime helper exports + env.memory, mode=${checks.game_table_mode}`
  + (casesReport ? `; ${casesReport.count} cases in ${casesReport.elapsed_ms.toFixed(0)} ms,`
    + ` faults ${casesReport.faults}` : ''));
if (!ok) process.exit(1);
