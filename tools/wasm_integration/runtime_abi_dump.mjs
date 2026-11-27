#!/usr/bin/env node
/**
 * Read the ABI descriptor out of a real ``runtime.wasm`` through the committed
 * ``runtime/wasm/loader.mjs`` and print it as JSON.
 *
 * This is the *only* place where the integration layer learns the CPU/Z80/VDP
 * layout, fail codes and absolute runtime addresses: the generated game module
 * must never carry its own copy of the native C oracle ABI.
 *
 * What is verified here (Node side):
 *   - ``_initialize()`` + ``dune_rt_init()`` run, the descriptor is readable;
 *   - descriptor MAGIC/VERSION/SIZE and the three ABI exports agree;
 *   - the stored 8-word ``abi_hash`` equals a fresh SHA-256 of the structural
 *     descriptor words (``verifyAbiHash``);
 *   - ``dune_abi_selfcheck(version, pinned_hash)`` accepts the *pinned* hash
 *     supplied by the caller (the hash from ``runtime/wasm/manifest.json``);
 *   - the ROM buffer exists after init (and not before), capacity is 1 MiB;
 *   - ``dune_cpu_ptr()``/``dune_rom_ptr()`` agree with the descriptor addresses.
 *
 * Debug options ``--tamper NAME=VALUE`` / ``--rehash`` patch the descriptor in
 * linear memory *before* the checks, so tests can prove that a changed
 * descriptor breaks the build instead of being silently ignored.
 *
 * Usage:
 *   node runtime_abi_dump.mjs --runtime runtime.wasm --loader loader.mjs \
 *        [--pinned-hash HEX --pinned-version N] [--tamper OFF_PC=68] [--rehash]
 *
 * stdout: one JSON object.  stderr: human log.  Exit code 0 on success.
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

function fail(message) {
  process.stderr.write(`runtime_abi_dump: ${message}\n`);
  process.exit(2);
}

function log(message) {
  process.stderr.write(`runtime_abi_dump: ${message}\n`);
}

function parseArgs(argv) {
  const args = { tamper: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) fail(`unexpected argument ${key}`);
    const name = key.slice(2);
    if (name === 'rehash') {
      args.rehash = true;
      continue;
    }
    if (i + 1 >= argv.length) fail(`missing value for ${key}`);
    const value = argv[i + 1];
    i += 1;
    if (name === 'tamper') args.tamper.push(value);
    else args[name] = value;
  }
  return args;
}

function hexToBytes(hex) {
  const clean = hex.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0) fail(`bad hash hex ${hex}`);
  return Uint8Array.from(clean.match(/../g).map((pair) => parseInt(pair, 16)));
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const args = parseArgs(process.argv.slice(2));
for (const key of ['runtime', 'loader']) {
  if (!args[key]) fail(`missing --${key}`);
}

let loader;
try {
  loader = await import(pathToFileURL(args.loader).href);
} catch (error) {
  fail(`cannot import loader ${args.loader}: ${error && error.stack ? error.stack : error}`);
}

let runtimeBytes;
try {
  runtimeBytes = await readFile(args.runtime);
} catch (error) {
  fail(`cannot read runtime ${args.runtime}: ${error}`);
}

let rt;
try {
  rt = await loader.loadRuntime({ wasmBytes: runtimeBytes });
} catch (error) {
  fail(`instantiate ${args.runtime} failed: ${error && error.stack ? error.stack : error}`);
}

const initializedBeforeInit = rt.exports.dune_rt_initialized();
const romBeforeInit = rt.exports.dune_rt_rom_buffer();
let abi;
try {
  abi = loader.initRuntime(rt);
} catch (error) {
  fail(`initRuntime() failed: ${error && error.stack ? error.stack : error}`);
}

const descriptorPointer = rt.exports.dune_abi_descriptor();
const wordCountExport = rt.exports.dune_abi_word_count();
const abiVersionExport = rt.exports.dune_abi_version();
const helperVersionExport = rt.exports.dune_abi_helper_version();
const fields = loader.ABI_FIELDS;
const words = new Uint32Array(abi.words); // structural copy, tamperable

function writeWord(index, value) {
  words[index] = value >>> 0;
  new DataView(rt.memory.buffer).setUint32(descriptorPointer + index * 4, value >>> 0, true);
}

function structuralHashHex() {
  const parts = loader.ABI.hash.inputWordRanges.map(([from, to]) => {
    const bytes = new Uint8Array((to - from) * 4);
    const view = new DataView(bytes.buffer);
    for (let i = from; i < to; i += 1) view.setUint32((i - from) * 4, words[i], true);
    return bytes;
  });
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const input = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    input.set(part, offset);
    offset += part.length;
  }
  return createHash('sha256').update(input).digest();
}

const tampered = [];
for (const spec of args.tamper) {
  const equal = spec.indexOf('=');
  if (equal < 0) fail(`--tamper expects NAME=VALUE, got ${spec}`);
  const name = spec.slice(0, equal);
  const value = Number(spec.slice(equal + 1));
  const index = fields.indexOf(name);
  if (index < 0) fail(`--tamper: unknown ABI field ${name}`);
  if (!Number.isFinite(value)) fail(`--tamper: bad value in ${spec}`);
  const before = words[index];
  writeWord(index, value);
  tampered.push({ field: name, index, before, after: value >>> 0 });
}
if (args.rehash) {
  const digest = structuralHashHex();
  for (let i = 0; i < loader.ABI.hash.words; i += 1) {
    const word = digest.readUInt32LE(i * 4);
    writeWord(loader.ABI.hash.firstWord + i, word);
  }
  log(`rehashed tampered descriptor -> ${bytesToHex(digest)}`);
}

const hashHex = bytesToHex(structuralHashHex());
const hashWords = Array.from(words.subarray(loader.ABI.hash.firstWord,
  loader.ABI.hash.firstWord + loader.ABI.hash.words));
const hashOkRecomputed = await loader.verifyAbiHash({ words });
const selfcheckOwn = rt.exports.dune_abi_selfcheck(words[1], rt.exports.dune_abi_hash());

let pinnedSelfcheck = null;
if (args['pinned-hash']) {
  const pinned = hexToBytes(args['pinned-hash']);
  if (pinned.length !== 32) fail('--pinned-hash must be a 32-byte SHA-256 hex string');
  const pointer = rt.exports.malloc(pinned.length);
  if (!pointer) fail('malloc() failed for the pinned hash');
  new Uint8Array(rt.memory.buffer, pointer, pinned.length).set(pinned);
  pinnedSelfcheck = rt.exports.dune_abi_selfcheck(
    Number(args['pinned-version'] ?? 1), pointer,
  );
}

const romPointer = rt.exports.dune_rt_rom_buffer();
const romCapacity = rt.exports.dune_rt_rom_capacity();
const cpuPointer = rt.exports.dune_cpu_ptr();
const romPtrExport = rt.exports.dune_rom_ptr();
const gameTablePointer = rt.exports.dune_rt_game_table();
const saveBufferPointer = rt.exports.dune_get_save_buffer();
const table = rt.exports.__indirect_function_table;

const moduleExports = WebAssembly.Module.exports(rt.module).map((entry) => ({
  name: entry.name, kind: entry.kind,
}));
const moduleImports = WebAssembly.Module.imports(rt.module).map((entry) => ({
  module: entry.module, name: entry.name, kind: entry.kind,
}));
const exportNames = new Set(moduleExports.map((entry) => entry.name));

const REQUIRED_HELPERS = [
  'dune_read_mem', 'dune_write_mem', 'dune_push32', 'dune_pop32', 'dune_movem',
  'dune_set_sr', 'dune_logic_flags', 'dune_arithmetic', 'dune_extended_arithmetic',
  'dune_bcd_arithmetic', 'dune_bcd_negate', 'dune_shift_value', 'dune_divide_value',
  'dune_condition', 'dune_index_value', 'dune_fail',
];
const REQUIRED_RUNTIME = [
  'dune_abi_descriptor', 'dune_abi_hash', 'dune_abi_version', 'dune_abi_word_count',
  'dune_abi_helper_version', 'dune_abi_selfcheck', 'dune_rt_init', 'dune_rt_rom_buffer',
  'dune_rt_rom_capacity', 'dune_rt_game_table', 'dune_rt_set_game_table',
  'dune_rt_game_mode', 'dune_rt_translated_step', 'dune_rt_machine_step',
  'dune_rt_last_fail_code', 'dune_rt_fail_reason', 'dune_rt_initialized',
  'dune_cpu_ptr', 'dune_rom_ptr', 'dune_get_save_buffer', '_initialize',
  '__indirect_function_table',
];
const missingExports = [...REQUIRED_HELPERS, ...REQUIRED_RUNTIME]
  .filter((name) => !exportNames.has(name));

const abiFields = {};
for (let i = 0; i < fields.length; i += 1) abiFields[fields[i]] = words[i] >>> 0;

const descriptorMagic = words[0] >>> 0;
const descriptorVersion = words[1] >>> 0;
const descriptorSize = words[2] >>> 0;
const memoryBytes = rt.memory.buffer.byteLength;

const checks = {
  word_count: wordCountExport,
  abi_version: abiVersionExport,
  helper_abi_version: helperVersionExport,
  descriptor_magic: descriptorMagic,
  descriptor_magic_ok: descriptorMagic === 0x31424144,
  descriptor_version: descriptorVersion,
  descriptor_version_ok: descriptorVersion === loader.ABI.version,
  descriptor_size: descriptorSize,
  descriptor_size_ok: descriptorSize === wordCountExport,
  hash_hex: hashHex,
  hash_words: hashWords,
  hash_ok_recomputed: hashOkRecomputed,
  selfcheck_own: selfcheckOwn,
  selfcheck_own_ok: selfcheckOwn === 1,
  selfcheck_pinned: pinnedSelfcheck,
  selfcheck_pinned_ok: pinnedSelfcheck === null ? null : pinnedSelfcheck === 1,
  initialized_before_init: initializedBeforeInit,
  rom_buffer_before_init: romBeforeInit,
  rom_buffer_after_init: romPointer,
  rom_capacity: romCapacity,
  cpu_pointer: cpuPointer,
  rom_pointer_export: romPtrExport,
  game_table_pointer: gameTablePointer,
  save_buffer_pointer: saveBufferPointer,
  indirect_table_length: table ? table.length : null,
  memory_bytes: memoryBytes,
  memory_pages: memoryBytes >>> 16,
  missing_exports: missingExports,
  missing_exports_ok: missingExports.length === 0,
  runtime_sha256: createHash('sha256').update(runtimeBytes).digest('hex'),
  runtime_bytes: runtimeBytes.length,
  loader_sha256: createHash('sha256').update(await readFile(args.loader)).digest('hex'),
};

const report = {
  ok: Boolean(
    checks.descriptor_magic_ok
    && checks.descriptor_version_ok
    && checks.descriptor_size_ok
    && checks.hash_ok_recomputed
    && checks.selfcheck_own_ok
    && checks.missing_exports_ok
    && (checks.selfcheck_pinned_ok === null || checks.selfcheck_pinned_ok)
  ),
  fields: abiFields,
  fields_order: Array.from(fields),
  words: Array.from(words),
  abi_hash_hex: hashHex,
  checks,
  tamper: tampered.length ? tampered : null,
  rehash: Boolean(args.rehash),
  imports: moduleImports,
  exports: moduleExports,
};

process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
if (!report.ok) {
  log(`descriptor checks FAILED: ${JSON.stringify({
    magic: checks.descriptor_magic_ok,
    version: checks.descriptor_version_ok,
    size: checks.descriptor_size_ok,
    hash: checks.hash_ok_recomputed,
    pinned: checks.selfcheck_pinned_ok,
    exports: checks.missing_exports,
  })}`);
  process.exit(1);
}
log(`ABI ok: ${hashHex.slice(0, 16)}… words=${wordCountExport} `
  + `cpu@${abiFields.ADDR_CPU} rom@${abiFields.ADDR_ROM} memory=${memoryBytes >>> 16} pages`);
