/**
 * Phase 1 runtime.wasm tests: instantiate the prebuilt runtime with an
 * imported, JS-owned memory and a mocked env/WASI surface; validate the ABI
 * descriptor, the ROM buffer, per-page/single-dispatcher translated_step
 * dispatch and the DSAV v2 save/load ABI.
 *
 * Build the artifacts first:
 *   python3 tools/wasm_runtime/build_runtime.py --emsdk "<path to emsdk 3.1.74>"
 * Then:
 *   node --test tests/wasm_runtime/
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const ROOT = new URL("../../", import.meta.url);
const WASM_DIR = new URL("runtime/wasm/", ROOT);

function readJson(url) {
  return JSON.parse(readFileSync(url, "utf8"));
}

function readArtifact(name) {
  try {
    return readFileSync(new URL(name, WASM_DIR));
  } catch (error) {
    throw new Error(
      `missing runtime/wasm/${name}; run: ` +
        `python3 tools/wasm_runtime/build_runtime.py --emsdk "<path to emsdk 3.1.74>" ` +
        `(${error.message})`,
    );
  }
}

const manifest = readJson(new URL("manifest.json", WASM_DIR));
const coverageManifest = readJson(new URL("runtime/manifest.json", ROOT));
const loader = await import(new URL("loader.mjs", WASM_DIR));

const runtimeBytes = readArtifact("runtime.wasm");
const stubBytes = readArtifact("stub_game.wasm");
const runtimeModule = await WebAssembly.compile(runtimeBytes);
const stubModule = await WebAssembly.compile(stubBytes);

/** One runtime instance shared by the tests; dune_rt_init() resets it. */
const rt = await loader.loadRuntime({ wasmModule: runtimeModule });

// Capture pristine state before any dune_rt_init() call (ROM must be absent).
const pristine = {
  initialized: rt.exports.dune_rt_initialized(),
  romPointer: rt.exports.dune_rt_rom_buffer(),
  abi: loader.readAbi(rt),
};

let abi = null;
let stubExports = null;
let slots = null;

function resetRuntime() {
  rt.exports.dune_rt_init();
  abi = loader.readAbi(rt);
  if (stubExports) stubExports.stub_game_init(abi.pointer);
  return abi;
}

async function ensureStubGame() {
  if (!stubExports) {
    const instance = await WebAssembly.instantiate(stubModule, {
      env: {
        memory: rt.memory,
        dune_read_mem: rt.exports.dune_read_mem,
        dune_write_mem: rt.exports.dune_write_mem,
      },
    });
    stubExports = instance.exports;
  }
  assert.ok(abi, "resetRuntime() first");
  stubExports.stub_game_init(abi.pointer);
  return stubExports;
}

async function ensureGameSlots() {
  if (!slots) {
    const stub = await ensureStubGame();
    slots = loader.appendFunctions(rt, [
      stub.stub_page_00,
      stub.stub_page_01,
      stub.stub_page_ff0,
      stub.stub_translated_step,
      stub.stub_translated_z80_step,
    ]);
  }
  return slots;
}

function dataView() {
  return new DataView(rt.memory.buffer);
}

function readCpuU32(targetAbi, fieldName) {
  return dataView().getUint32(targetAbi.fields.ADDR_CPU + targetAbi.fields[fieldName], true);
}

function writeCpuU32(targetAbi, fieldName, value) {
  dataView().setUint32(targetAbi.fields.ADDR_CPU + targetAbi.fields[fieldName], value >>> 0, true);
}

function ramByte(targetAbi, offset) {
  return new Uint8Array(rt.memory.buffer, targetAbi.fields.ADDR_RAM + offset, 1)[0];
}

function ramBytes(targetAbi) {
  return new Uint8Array(rt.memory.buffer, targetAbi.fields.ADDR_RAM, 65536);
}

function lowByte(targetAbi, fieldName) {
  return dataView().getUint8(targetAbi.fields.ADDR_CPU + targetAbi.fields[fieldName]);
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function pageTable(entries) {
  const table = new Array(loader.ABI.dispatch.pageSlots).fill(0);
  for (const [page, slot] of entries) table[page] = slot;
  return table;
}

// ---------------------------------------------------------------------------
// 1. Artifact integrity
// ---------------------------------------------------------------------------

test("artifacts: sizes/SHA/emcc pins and the 'no game data' invariants", () => {
  assert.equal(sha256Hex(runtimeBytes), manifest.wasm.sha256);
  assert.equal(runtimeBytes.length, manifest.wasm.bytes);
  assert.ok(manifest.wasm.bytes < 4 * 1024 * 1024, "runtime.wasm must stay below 4 MiB");
  assert.ok(
    manifest.wasm.bytes < coverageManifest.savestate.max_buffer_bytes + coverageManifest.runtime_bytes + 1024 * 1024,
    "runtime.wasm cannot be carrying an uncompressed 1 MiB ROM",
  );
  assert.equal(manifest.wasm.deterministic, true);
  assert.equal(manifest.wasm.determinism.first_sha256, manifest.wasm.determinism.second_sha256);

  assert.equal(sha256Hex(stubBytes), manifest.stub_game.sha256);
  assert.equal(stubBytes.length, manifest.stub_game.bytes);
  assert.ok(manifest.stub_game.bytes < 64 * 1024);

  assert.equal(sha256Hex(readArtifact("loader.mjs")), manifest.loader.sha256);

  assert.equal(manifest.emcc.version, "3.1.74");
  assert.equal(manifest.emcc.required_version, "3.1.74");
  assert.equal(manifest.memory.imported, true);
  assert.equal(manifest.memory.initial_pages, 1024);
  assert.equal(manifest.memory.maximum_pages, 8192);

  // Pinned inputs.
  assert.equal(manifest.source.runtime_sha256, coverageManifest.runtime_sha256);
  assert.equal(manifest.source.runtime_bytes, coverageManifest.runtime_bytes);
  assert.equal(manifest.source.full_preamble_sha256, coverageManifest.full_preamble_sha256);
  assert.equal(manifest.source.generated_prefix_sha256, coverageManifest.generated_prefix_sha256);
  assert.equal(manifest.source.prepared_audio_sha256, coverageManifest.prepared_audio_sha256);
  assert.equal(manifest.source.adapters_count, coverageManifest.adapters.count);

  // No ROM / no game data inside the module.
  assert.equal(manifest.data_check.rom_embedded, false);
  assert.equal(manifest.data_check.memory_section, false);
  assert.equal(manifest.data_check.wasm_data_segments > 0, true);
  assert.ok(manifest.data_check.wasm_data_segment_bytes < 512 * 1024);
  assert.ok(manifest.data_check.wasm_largest_data_segment_bytes < 256 * 1024);

  for (const [name, value] of Object.entries(manifest.checks)) {
    assert.equal(value, true, `manifest check failed: ${name}`);
  }
});

// ---------------------------------------------------------------------------
// 2. Module surface
// ---------------------------------------------------------------------------

test("module: memory is imported from JS, exports cover the ABI contract", () => {
  const imports = WebAssembly.Module.imports(runtimeModule);
  const exports = WebAssembly.Module.exports(runtimeModule);

  const memoryImports = imports.filter((item) => item.kind === "memory");
  assert.deepEqual(memoryImports, [{ module: "env", name: "memory", kind: "memory" }]);

  const exportKinds = new Map(exports.map((item) => [item.name, item.kind]));
  assert.equal(exportKinds.get("_initialize"), "function");
  assert.equal(exportKinds.get("__indirect_function_table"), "table");
  assert.equal(exportKinds.has("memory"), false, "the module must not export its own memory");

  const required = new Set([
    ...manifest.exports.abi,
    ...manifest.exports.game_helpers,
    ...manifest.exports.runtime_preamble,
    ...manifest.exports.adapters,
    ...manifest.exports.save,
    ...manifest.exports.special.filter((name) => name !== "__indirect_function_table"),
  ]);
  for (const name of required) {
    assert.equal(exportKinds.get(name), "function", `missing export: ${name}`);
  }

  // The JS mock surface is derived from the module: every env/WASI import exists.
  const importObject = loader.makeImportObject(runtimeModule, { memory: rt.memory });
  const envNames = new Set(
    imports.filter((item) => item.module === "env" && item.kind === "function").map((item) => item.name),
  );
  for (const name of envNames) {
    assert.equal(typeof importObject.env[name], "function", `mock missing env.${name}`);
  }
  assert.deepEqual(
    imports.filter((item) => item.module === "env" && item.name !== "memory").map((item) => item.name).sort(),
    manifest.imports.env,
  );
  assert.deepEqual(
    imports.filter((item) => item.module === "wasi_snapshot_preview1").map((item) => item.name).sort(),
    manifest.imports.wasi_snapshot_preview1,
  );
});

// ---------------------------------------------------------------------------
// 3. ABI descriptor
// ---------------------------------------------------------------------------

test("abi: descriptor matches runtime/wasm/manifest.json and runtime/manifest.json", async () => {
  assert.equal(pristine.initialized, 0, "fresh runtime must report uninitialized");
  assert.equal(pristine.romPointer, 0, "ROM buffer must not exist before dune_rt_init()");
  assert.equal(pristine.abi.fields.ADDR_ROM, 0, "descriptor ROM address before init must be null");

  resetRuntime();

  // 1:1 with manifest.abi.fields/actual (the build-instantiated snapshot).
  assert.equal(abi.fields.SIZE, manifest.abi.word_count);
  assert.equal(abi.fields.SIZE, loader.ABI_FIELDS.length);
  assert.deepEqual(loader.ABI_FIELDS, manifest.abi.fields);
  assert.deepEqual(
    Object.fromEntries(loader.ABI_FIELDS.map((name, index) => [name, index])),
    manifest.abi.field_index,
  );
  for (const name of manifest.abi.fields) {
    assert.equal(abi.fields[name], manifest.abi.actual[name], `descriptor field ${name}`);
  }

  assert.equal(rt.exports.dune_abi_word_count(), manifest.abi.word_count);
  assert.equal(rt.exports.dune_abi_version(), manifest.abi.version);
  assert.equal(rt.exports.dune_abi_helper_version(), manifest.abi.helper_abi_version);
  assert.equal(abi.fields.MAGIC, 0x31424144);
  assert.equal(abi.fields.VERSION, manifest.abi.version);
  assert.equal(abi.fields.HELPER_ABI_VERSION, manifest.abi.helper_abi_version);
  assert.equal(abi.fields.SIZE, manifest.abi.word_count);
  assert.equal(manifest.abi.magic, 0x31424144);

  // Constants known before the build (sizes, enums, fail codes, DSAV numbers).
  for (const [name, expected] of Object.entries(manifest.abi.constants)) {
    assert.equal(abi.fields[name], expected, `ABI constant ${name}`);
  }

  // Cross-check the pinned save-state contract in runtime/manifest.json.
  const pinned = coverageManifest.savestate;
  assert.equal(abi.fields.SIZEOF_SAVESTATE, pinned.base_bytes);
  assert.equal(abi.fields.SIZEOF_SAVESTATE, 140056);
  assert.equal(abi.fields.SAVESTATE_RAM_OFFSET, pinned.ram_offset);
  assert.equal(abi.fields.SAVESTATE_HOUSE_OFFSET, pinned.house_offset);
  assert.equal(abi.fields.SAVESTATE_MISSION_OFFSET, pinned.mission_offset);
  assert.equal(abi.fields.SAVESTATE_YM_SIZE_FIELD_OFFSET, pinned.ym_size_field_offset);
  assert.equal(abi.fields.SAVESTATE_TOTAL_SIZE_FIELD_OFFSET, pinned.total_size_field_offset);
  assert.equal(abi.fields.SAVESTATE_MAGIC, pinned.magic);
  assert.equal(abi.fields.SAVESTATE_MAGIC, 0x56415344);
  assert.equal(abi.fields.SAVESTATE_VERSION, pinned.version);
  assert.equal(abi.fields.SAVE_BUFFER_BYTES, pinned.max_buffer_bytes);
  assert.equal(abi.fields.SAVE_BUFFER_BYTES, 262144);

  // Fail reason codes.
  for (const [name, code] of Object.entries(manifest.abi.fail_codes)) {
    assert.equal(abi.fields[name], code, `fail code ${name}`);
    const reason = loader.cString(rt, rt.exports.dune_rt_fail_reason(code));
    assert.match(reason, new RegExp(name), `reason string for ${name}`);
  }

  // Layout consistency (wasm32 C layout, verified without hardcoding addresses).
  const f = abi.fields;
  assert.equal(f.OFF_D, 0);
  assert.equal(f.OFF_A, f.OFF_D + 32);
  assert.equal(f.OFF_PC, f.OFF_A + 32);
  assert.equal(f.OFF_USP, f.OFF_PC + 4);
  assert.equal(f.OFF_SSP, f.OFF_USP + 4);
  assert.equal(f.OFF_SR, f.OFF_SSP + 4);
  assert.equal(f.OFF_RAM, f.OFF_SR + 2);
  assert.equal(f.OFF_IO_DATA, f.OFF_RAM + 65536);
  assert.equal(f.OFF_IO_CONTROL, f.OFF_IO_DATA + 3);
  assert.equal(f.OFF_TMSS, f.OFF_IO_CONTROL + 3);
  assert.equal(f.OFF_IO_TX, f.OFF_TMSS + 4);
  assert.equal(f.OFF_IO_SERIAL_CONTROL, f.OFF_IO_TX + 3);
  assert.equal(f.OFF_PAD_BUTTONS, f.OFF_IO_SERIAL_CONTROL + 3);
  assert.equal(f.OFF_VDP_REGISTERS, f.OFF_VDP);
  assert.equal(f.OFF_VDP_VRAM, f.OFF_VDP + 24);
  assert.equal(f.OFF_VDP_CRAM, f.OFF_VDP_VRAM + 65536);
  assert.equal(f.OFF_VDP_VSRAM, f.OFF_VDP_CRAM + 128);
  assert.ok(f.OFF_VDP_FRAME > f.OFF_VDP_VSRAM);
  assert.ok(f.OFF_VDP_FRAME_WIDTH > f.OFF_VDP_FRAME);
  assert.equal(f.OFF_Z80_RAM, f.OFF_Z80_BUS);
  assert.equal(f.OFF_Z80_BUS_REQUESTED, f.OFF_Z80_BUS + 8192);
  assert.equal(f.OFF_Z80_BUS_RESET_RELEASED, f.OFF_Z80_BUS_REQUESTED + 1);
  assert.equal(f.OFF_Z80_BUS_BANK, f.OFF_Z80_BUS_RESET_RELEASED + 1);
  assert.equal(f.SIZEOF_Z80CPU, 72);
  assert.equal(f.OFF_Z80_R8, f.OFF_Z80_CPU);
  assert.equal(f.OFF_Z80_ALTERNATE, f.OFF_Z80_CPU + 6);
  assert.equal(f.OFF_Z80_A, f.OFF_Z80_CPU + 12);
  assert.equal(f.OFF_Z80_F, f.OFF_Z80_CPU + 13);
  assert.equal(f.OFF_Z80_A_ALT, f.OFF_Z80_CPU + 14);
  assert.equal(f.OFF_Z80_F_ALT, f.OFF_Z80_CPU + 15);
  assert.equal(f.OFF_Z80_I, f.OFF_Z80_CPU + 16);
  assert.equal(f.OFF_Z80_R, f.OFF_Z80_CPU + 17);
  assert.equal(f.OFF_Z80_IFF1, f.OFF_Z80_CPU + 18);
  assert.equal(f.OFF_Z80_IFF2, f.OFF_Z80_CPU + 19);
  assert.equal(f.OFF_Z80_IM, f.OFF_Z80_CPU + 20);
  assert.equal(f.OFF_Z80_HALTED, f.OFF_Z80_CPU + 21);
  assert.equal(f.OFF_Z80_IRQ_LINE, f.OFF_Z80_CPU + 22);
  assert.equal(f.OFF_Z80_EI_DELAY, f.OFF_Z80_CPU + 23);
  assert.equal(f.OFF_Z80_PC, f.OFF_Z80_CPU + 24);
  assert.equal(f.OFF_Z80_SP, f.OFF_Z80_CPU + 26);
  assert.equal(f.OFF_Z80_IX, f.OFF_Z80_CPU + 28);
  assert.equal(f.OFF_Z80_IY, f.OFF_Z80_CPU + 30);
  assert.equal(f.OFF_Z80_WZ, f.OFF_Z80_CPU + 32);
  assert.equal(f.OFF_Z80_DEBT, f.OFF_Z80_CPU + 40);
  assert.equal(f.OFF_Z80_STEPS, f.OFF_Z80_CPU + 48);
  assert.equal(f.OFF_Z80_CYCLES, f.OFF_Z80_CPU + 56);
  assert.equal(f.OFF_Z80_INTERRUPTS, f.OFF_Z80_CPU + 64);
  assert.equal(f.SIZEOF_CPU % 8, 0);
  assert.ok(f.OFF_Z80_CPU + f.SIZEOF_Z80CPU <= f.SIZEOF_CPU);
  assert.ok(f.OFF_VDP_FRAME + 320 * 240 * 3 <= f.SIZEOF_CPU);

  // Absolute addresses are consistent with the offsets.
  assert.equal(f.ADDR_RAM, f.ADDR_CPU + f.OFF_RAM);
  assert.equal(f.ADDR_Z80_RAM, f.ADDR_CPU + f.OFF_Z80_RAM);
  assert.equal(f.ADDR_VDP_VRAM, f.ADDR_CPU + f.OFF_VDP_VRAM);
  assert.equal(f.ADDR_VDP_CRAM, f.ADDR_CPU + f.OFF_VDP_CRAM);
  assert.equal(f.ADDR_VDP_VSRAM, f.ADDR_CPU + f.OFF_VDP_VSRAM);
  assert.equal(f.ADDR_VDP_FRAME, f.ADDR_CPU + f.OFF_VDP_FRAME);
  assert.equal(rt.exports.dune_cpu_ptr(), f.ADDR_CPU);
  assert.ok(f.ADDR_CPU + f.SIZEOF_CPU <= rt.memory.buffer.byteLength);

  // CPU.rom points at the heap ROM buffer; CPU.rom_size is its capacity.
  assert.equal(readCpuU32(abi, "OFF_ROM"), f.ADDR_ROM);
  assert.equal(readCpuU32(abi, "OFF_ROM_SIZE"), f.ROM_CAPACITY);
  assert.equal(rt.exports.dune_get_save_buffer(), f.ADDR_SAVE_BUFFER);
  assert.equal(rt.exports.dune_rt_save_buffer_capacity(), f.SAVE_BUFFER_BYTES);

  // ABI hash: independent SHA-256 over the structural words.
  const wordBytes = Buffer.from(abi.words.buffer, abi.words.byteOffset, abi.words.byteLength);
  const hash = createHash("sha256");
  for (const [from, to] of manifest.abi.hash.input_word_ranges) {
    hash.update(wordBytes.subarray(from * 4, to * 4));
  }
  const digest = hash.digest();
  for (let i = 0; i < manifest.abi.hash.words; i += 1) {
    assert.equal(abi.words[manifest.abi.hash.first_word + i], digest.readUInt32LE(i * 4));
  }
  assert.equal(digest.toString("hex"), manifest.abi.abi_hash);
  assert.equal(rt.exports.dune_abi_selfcheck(manifest.abi.version, rt.exports.dune_abi_hash()), 1);
  assert.equal(rt.exports.dune_abi_selfcheck(manifest.abi.version + 1, rt.exports.dune_abi_hash()), 0);

  const tampered = { ...abi, words: Uint32Array.from(abi.words) };
  tampered.words[manifest.abi.hash.first_word] ^= 0xFFFFFFFF;
  assert.equal(await loader.verifyAbiHash(tampered), false, "verifyAbiHash must reject a tampered hash");
  assert.equal(await loader.verifyAbiHash(abi), true);
});

// ---------------------------------------------------------------------------
// 4. Initialisation + ROM buffer
// ---------------------------------------------------------------------------

test("init: ROM buffer is allocated at runtime, round-trips 1 MiB, init is idempotent", () => {
  assert.equal(pristine.abi.fields.ROM_CAPACITY, 1048576);
  assert.equal(rt.exports.dune_rt_rom_capacity(), 1048576);

  resetRuntime();
  assert.equal(rt.exports.dune_rt_initialized(), 1);
  const romPointer = rt.exports.dune_rt_rom_buffer();
  assert.ok(romPointer > 0, "dune_rt_init() must allocate the ROM buffer");
  assert.equal(romPointer % 8, 0, "ROM buffer should be 8-byte aligned");
  assert.equal(romPointer, abi.fields.ADDR_ROM);
  assert.equal(rt.exports.dune_rom_ptr(), romPointer);
  assert.ok(romPointer + abi.fields.ROM_CAPACITY <= rt.memory.buffer.byteLength);

  // Deterministic 1 MiB pattern written by the host, never embedded in the wasm.
  const rom = new Uint8Array(rt.memory.buffer, romPointer, abi.fields.ROM_CAPACITY);
  let state = 0x12345678;
  for (let i = 0; i < rom.length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    rom[i] = state & 0xFF;
  }
  const expected = Uint8Array.from(rom);
  assert.equal(loader.loadRom(rt, expected), 1048576);
  assert.deepEqual(new Uint8Array(loader.readRom(rt, 0, 64)), expected.subarray(0, 64));
  assert.deepEqual(new Uint8Array(loader.readRom(rt, 1048576 - 64, 64)), expected.subarray(1048576 - 64));

  // The CPU sees the ROM through the normal big-endian bus path.
  const cpu = abi.fields.ADDR_CPU;
  assert.equal(
    rt.exports.dune_read_mem(cpu, 0x1000, 2),
    (expected[0x1000] << 8) | expected[0x1001],
  );
  assert.equal(rt.exports.dune_read_mem(cpu, 0xFFFFF, 1), expected[0xFFFFF]);

  // dune_rt_init() resets the CPU but keeps the same ROM allocation.
  writeCpuU32(abi, "OFF_PC", 0xABCDEF);
  ramBytes(abi)[0x100] = 0x5A;
  resetRuntime();
  assert.equal(rt.exports.dune_rt_rom_buffer(), romPointer, "second init must not reallocate the ROM buffer");
  assert.equal(readCpuU32(abi, "OFF_PC"), 0);
  assert.equal(ramByte(abi, 0x100), 0);
  assert.equal(readCpuU32(abi, "OFF_SR"), 0x2700);
  assert.equal(readCpuU32(abi, "OFF_ROM"), romPointer);
});

// ---------------------------------------------------------------------------
// 5. Dispatch: per-page handlers through the runtime funcref table
// ---------------------------------------------------------------------------

test("dispatch: page table drives translated_step into stub_game handlers", async () => {
  resetRuntime();
  const stub = await ensureStubGame();
  const [page00, page01, pageFF0] = await ensureGameSlots();

  assert.equal(loader.installGameTable(rt, pageTable([[0x00, page00], [0x01, page01], [0xFF0, pageFF0]])), 1);
  assert.equal(rt.exports.dune_rt_game_mode(), 1);
  assert.equal(rt.exports.dune_rt_game_table_capacity(), 4096);

  // Page 0x00: no-op handler -> pc += 2, cycles = 4, registers untouched.
  writeCpuU32(abi, "OFF_PC", 0x000000);
  writeCpuU32(abi, "OFF_INSTRUCTION_CYCLES", 0);
  writeCpuU32(abi, "OFF_D", 0xDEADBEEF);
  rt.exports.dune_rt_translated_step(abi.fields.ADDR_CPU);
  assert.equal(readCpuU32(abi, "OFF_PC"), 0x2);
  assert.equal(readCpuU32(abi, "OFF_INSTRUCTION_CYCLES"), 4);
  assert.equal(readCpuU32(abi, "OFF_D"), 0xDEADBEEF);

  // Page 0x01: RAM write through the imported dune_write_mem helper.
  writeCpuU32(abi, "OFF_PC", 0x001000);
  rt.exports.dune_rt_translated_step(abi.fields.ADDR_CPU);
  assert.equal(readCpuU32(abi, "OFF_PC"), 0x001002);
  assert.equal(ramByte(abi, 0x10), 0xA5);
  assert.equal(ramByte(abi, 0x11), 0x00);

  // RAM page 0xFF0: a different handler with different cycle count.
  writeCpuU32(abi, "OFF_PC", 0xFF0000);
  rt.exports.dune_rt_translated_step(abi.fields.ADDR_CPU);
  assert.equal(readCpuU32(abi, "OFF_PC"), 0xFF0004);
  assert.equal(readCpuU32(abi, "OFF_INSTRUCTION_CYCLES"), 6);

  // Missing handler -> predictable fail code + reason + address.
  resetRuntime();
  await ensureStubGame();
  loader.installGameTable(rt, pageTable([[0x00, page00]]));
  writeCpuU32(abi, "OFF_PC", 0x005000);
  writeCpuU32(abi, "OFF_FAULT", 0);
  rt.exports.dune_rt_translated_step(abi.fields.ADDR_CPU);
  assert.equal(readCpuU32(abi, "OFF_FAULT"), 1);
  assert.equal(readCpuU32(abi, "OFF_FAULT_ADDRESS"), 0x005000);
  assert.equal(rt.exports.dune_rt_last_fail_code(), manifest.abi.fail_codes.UNTRANSLATED);
  assert.match(loader.cString(rt, rt.exports.dune_rt_fail_reason(1)), /^UNTRANSLATED:/);

  // Odd PC and out-of-range PC fail before touching the table.
  resetRuntime();
  writeCpuU32(abi, "OFF_PC", 0x001001);
  rt.exports.dune_rt_translated_step(abi.fields.ADDR_CPU);
  assert.equal(readCpuU32(abi, "OFF_FAULT"), 1);
  assert.equal(rt.exports.dune_rt_last_fail_code(), manifest.abi.fail_codes.ODD_PC);

  resetRuntime();
  writeCpuU32(abi, "OFF_PC", 0x01000000);
  rt.exports.dune_rt_translated_step(abi.fields.ADDR_CPU);
  assert.equal(readCpuU32(abi, "OFF_FAULT"), 1);
  assert.equal(rt.exports.dune_rt_last_fail_code(), manifest.abi.fail_codes.BAD_PC);

  // Cleared table = "no translated handlers".
  resetRuntime();
  rt.exports.dune_rt_clear_game_table();
  assert.equal(rt.exports.dune_rt_game_mode(), 0);
  writeCpuU32(abi, "OFF_PC", 0x000000);
  rt.exports.dune_rt_translated_step(abi.fields.ADDR_CPU);
  assert.equal(rt.exports.dune_rt_last_fail_code(), manifest.abi.fail_codes.UNTRANSLATED);

  // The real machine_step path charges cycles and counts the step.
  resetRuntime();
  await ensureStubGame();
  loader.installGameTable(rt, pageTable([[0x00, page00]]));
  writeCpuU32(abi, "OFF_PC", 0x000000);
  writeCpuU32(abi, "OFF_CYCLES", 100);
  writeCpuU32(abi, "OFF_STEPS", 7);
  rt.exports.dune_rt_machine_step();
  assert.equal(readCpuU32(abi, "OFF_PC"), 0x2);
  assert.equal(readCpuU32(abi, "OFF_CYCLES"), 104);
  assert.equal(readCpuU32(abi, "OFF_STEPS"), 8);
  assert.equal(readCpuU32(abi, "OFF_INSTRUCTION_CYCLES"), 0);
});

// ---------------------------------------------------------------------------
// 6. Dispatch: single-dispatcher (2-slot) mode from the design
// ---------------------------------------------------------------------------

test("dispatch: 2-slot mode calls the game's translated_step/z80_step exports", async () => {
  const stub = await ensureStubGame();
  const [page00, page01, pageFF0, stepSlot, z80Slot] = await ensureGameSlots();

  // dune_set_game_steps (design §5.1 names).
  resetRuntime();
  await ensureStubGame();
  assert.equal(rt.exports.dune_set_game_steps(stepSlot, z80Slot), 0);
  assert.equal(rt.exports.dune_rt_game_mode(), 2);
  new Uint8Array(rt.memory.buffer, abi.fields.ADDR_ROM, abi.fields.ROM_CAPACITY)[0x200] = 0x7E;
  writeCpuU32(abi, "OFF_PC", 0x001234);
  rt.exports.dune_rt_translated_step(abi.fields.ADDR_CPU);
  assert.equal(readCpuU32(abi, "OFF_PC"), 0x001236);
  assert.equal(ramByte(abi, 0x20), 0x7E, "stub translated_step mirrors ROM[0x200] into RAM[0x20]");
  assert.equal(rt.exports.dune_rt_translated_z80_step(abi.fields.ADDR_CPU), 8);

  // The generic table installer also accepts 2 entries.
  resetRuntime();
  await ensureStubGame();
  assert.equal(loader.installGameTable(rt, [stepSlot, z80Slot]), 2);
  writeCpuU32(abi, "OFF_PC", 0x001000);
  rt.exports.dune_rt_translated_step(abi.fields.ADDR_CPU);
  assert.equal(readCpuU32(abi, "OFF_PC"), 0x001002);

  // No z80 handler -> 0 cycles + UNTRANSLATED fault.
  resetRuntime();
  writeCpuU32(abi, "OFF_PC", 0x001000);
  writeCpuU32(abi, "OFF_Z80_PC", 0x1234);
  assert.equal(rt.exports.dune_rt_translated_z80_step(abi.fields.ADDR_CPU), 0);
  assert.equal(readCpuU32(abi, "OFF_FAULT"), 1);
  assert.equal(rt.exports.dune_rt_last_fail_code(), manifest.abi.fail_codes.UNTRANSLATED);
  assert.equal(readCpuU32(abi, "OFF_FAULT_ADDRESS"), 0x1234);
});

// ---------------------------------------------------------------------------
// 7. Helper ABI exports used by game.wasm
// ---------------------------------------------------------------------------

test("helpers: dune_* 68000/Z80 helper exports behave", () => {
  resetRuntime();
  const cpu = abi.fields.ADDR_CPU;

  // read_mem from ROM, write_mem into RAM.
  new Uint8Array(rt.memory.buffer, abi.fields.ADDR_ROM, abi.fields.ROM_CAPACITY)[0x10] = 0xAB;
  new Uint8Array(rt.memory.buffer, abi.fields.ADDR_ROM, abi.fields.ROM_CAPACITY)[0x11] = 0xCD;
  assert.equal(rt.exports.dune_read_mem(cpu, 0x10, 2), 0xABCD);
  rt.exports.dune_write_mem(cpu, 0xFF0020, 1, 0x77);
  assert.equal(ramByte(abi, 0x20), 0x77);

  // Flags/conditional evaluation.
  rt.exports.dune_logic_flags(cpu, 0, 2);
  assert.equal(rt.exports.dune_condition(cpu, 7), 1, "EQ is true after a zero result");
  assert.equal(rt.exports.dune_condition(cpu, 6), 0, "NE is false after a zero result");
  assert.equal(rt.exports.dune_condition(cpu, 0), 1, "T is always true");

  // Arithmetic / shifts.
  assert.equal(rt.exports.dune_arithmetic(cpu, 0x10, 0x05, 1, 0, 0), 0x15);
  assert.equal(rt.exports.dune_arithmetic(cpu, 0x00, 0x01, 1, 1, 0), 0xFF);
  assert.equal(rt.exports.dune_shift_value(cpu, 0x01, 1, 1, manifest.abi.constants.SHIFT_KIND_LOGICAL, 1), 0x02);
  assert.equal(rt.exports.dune_extended_arithmetic(cpu, 0x10, 0x01, 1, 0), 0x11);
  assert.equal(rt.exports.dune_bcd_negate(cpu, 0x25), 0x75);

  // push32/pop32 round-trip through the RAM window.
  writeCpuU32(abi, "OFF_A", 0); // a[0]
  const a7Offset = abi.fields.OFF_A + 7 * 4;
  dataView().setUint32(cpu + a7Offset, 0x00FFEF00, true);
  rt.exports.dune_push32(cpu, 0x11223344);
  assert.equal(dataView().getUint32(cpu + a7Offset, true), 0x00FFEEFC);
  assert.equal(rt.exports.dune_pop32(cpu), 0x11223344);
  assert.equal(dataView().getUint32(cpu + a7Offset, true), 0x00FFEF00);

  // Z80 helpers.
  assert.equal(rt.exports.dune_z80_szxy(0), 68); // Z_Z | Z_PV
  assert.equal(rt.exports.dune_z80_inc(cpu, 0x7F, 1), 0x80);
  rt.exports.dune_z80_set_pair(cpu, 2, 0x1234);
  assert.equal(rt.exports.dune_z80_pair(cpu, 2), 0x1234);
  rt.exports.dune_z80_set_pair(cpu, 7, 0xA5F0);
  assert.equal(lowByte(abi, "OFF_Z80_A"), 0xA5);
  assert.equal(lowByte(abi, "OFF_Z80_F"), 0xF0);
  rt.exports.dune_z80_set_reg(cpu, 0, 0x42);
  assert.equal(lowByte(abi, "OFF_Z80_R8"), 0x42);
  assert.equal(rt.exports.dune_z80_reg(cpu, 0), 0x42);

  // ABI fail helper.
  rt.exports.dune_fail(cpu, manifest.abi.fail_codes.ADDRESS_ERROR, 0x123456);
  assert.equal(readCpuU32(abi, "OFF_FAULT"), 1);
  assert.equal(readCpuU32(abi, "OFF_FAULT_ADDRESS"), 0x123456);
  assert.equal(rt.exports.dune_rt_last_fail_code(), manifest.abi.fail_codes.ADDRESS_ERROR);
  assert.match(loader.cString(rt, rt.exports.dune_rt_fail_reason(7)), /ADDRESS_ERROR/);
});

// ---------------------------------------------------------------------------
// 8. DSAV v2 save/load through the pinned exports
// ---------------------------------------------------------------------------

test("saves: DuneSaveState is 140056 B and save/load round-trips the CPU", () => {
  resetRuntime();
  rt.exports.dune_rt_set_window(1);
  const cpu = abi.fields.ADDR_CPU;

  writeCpuU32(abi, "OFF_PC", 0x00ABCDEF);
  writeCpuU32(abi, "OFF_D", 0x12345678);
  ramBytes(abi)[0x100] = 0x5A;
  dataView().setUint16(cpu + abi.fields.OFF_SR, 0x2700, true);

  const size = rt.exports.dune_save_state_to_buffer();
  assert.equal(size, abi.fields.SIZEOF_SAVESTATE);
  assert.equal(size, coverageManifest.savestate.base_bytes);

  const saveBuffer = rt.exports.dune_get_save_buffer();
  const save = new DataView(rt.memory.buffer);
  assert.equal(save.getUint32(saveBuffer, true), coverageManifest.savestate.magic);
  assert.equal(save.getUint32(saveBuffer + 4, true), coverageManifest.savestate.version);
  assert.equal(save.getUint32(saveBuffer + abi.fields.SAVESTATE_YM_SIZE_FIELD_OFFSET, true), 0);
  assert.equal(save.getUint32(saveBuffer + abi.fields.SAVESTATE_TOTAL_SIZE_FIELD_OFFSET, true), size);
  assert.equal(
    save.getUint16(saveBuffer + abi.fields.SAVESTATE_MISSION_OFFSET, false),
    (ramBytes(abi)[0xC050] << 8) | ramBytes(abi)[0xC051],
  );
  assert.equal(
    save.getUint16(saveBuffer + abi.fields.SAVESTATE_HOUSE_OFFSET, false),
    (ramBytes(abi)[0xC274] << 8) | ramBytes(abi)[0xC275],
  );
  const savedRam = new Uint8Array(rt.memory.buffer, saveBuffer + abi.fields.SAVESTATE_RAM_OFFSET, 65536);
  assert.deepEqual(savedRam, ramBytes(abi), "save state RAM mirrors CPU RAM");
  assert.equal(savedRam[0x100], 0x5A);

  // Mutate, then load back.
  writeCpuU32(abi, "OFF_PC", 0x001111);
  writeCpuU32(abi, "OFF_D", 0xFFFFFFFF);
  ramBytes(abi)[0x100] = 0;
  assert.equal(rt.exports.dune_load_state_from_buffer(size), 1);
  assert.equal(readCpuU32(abi, "OFF_PC"), 0x00ABCDEF);
  assert.equal(readCpuU32(abi, "OFF_D"), 0x12345678);
  assert.equal(ramByte(abi, 0x100), 0x5A);
  assert.equal(readCpuU32(abi, "OFF_FAULT"), 0);

  // Strict validation: short, oversized and bad-magic buffers are rejected.
  assert.equal(rt.exports.dune_load_state_from_buffer(0), 0);
  assert.equal(rt.exports.dune_load_state_from_buffer(size - 1), 0);
  assert.equal(rt.exports.dune_load_state_from_buffer(abi.fields.SAVE_BUFFER_BYTES + 1), 0);
  save.setUint32(saveBuffer, 0, true);
  assert.equal(rt.exports.dune_load_state_from_buffer(size), 0);
  save.setUint32(saveBuffer, coverageManifest.savestate.magic, true);
  assert.equal(rt.exports.dune_load_state_from_buffer(size), 1);
});

// ---------------------------------------------------------------------------
// 9. stub_game module shape
// ---------------------------------------------------------------------------

test("stub_game: code-only game module, imports memory + two runtime helpers", () => {
  const imports = WebAssembly.Module.imports(stubModule);
  assert.deepEqual(
    imports.map((item) => `${item.module}.${item.name}:${item.kind}`).sort(),
    [
      "env.dune_read_mem:function",
      "env.dune_write_mem:function",
      "env.memory:memory",
    ].sort(),
  );
  const exports = new Map(WebAssembly.Module.exports(stubModule).map((item) => [item.name, item.kind]));
  for (const name of ["stub_page_00", "stub_page_01", "stub_page_ff0", "stub_translated_step", "stub_translated_z80_step", "stub_warmup_all", "stub_game_init"]) {
    assert.equal(exports.get(name), "function", `missing stub export ${name}`);
  }
});
