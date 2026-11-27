#!/usr/bin/env node
/* Probe: real runtime.wasm (with path-A audio exports) + full game.wasm with a
 * real translated_z80_step: boot the game, enable AUDIO_ON, run machine steps,
 * drain native PCM and report peak/RMS + faults.  Used by tests/host/audio
 * before/without the browser to separate emulation problems from AudioContext
 * problems.
 *
 * node tools/wasm_integration/audio_probe.mjs \
 *   --runtime .local/wasm-z80/runtime-build/runtime-audio.wasm \
 *   --game .local/wasm-z80/full/game.wasm --rom ROM --seconds 3
 */
import { readFileSync } from 'node:fs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  return process.argv[index + 1] ?? true;
}

const runtimePath = arg('runtime');
const gamePath = arg('game');
const romPath = arg('rom');
const seconds = Number(arg('seconds', '3'));
const latencyMs = Number(arg('latency', '85'));

const loader = await import(new URL('../../runtime/wasm/loader.mjs', import.meta.url).href);

const rt = await loader.loadRuntime({
  wasmBytes: new Uint8Array(readFileSync(runtimePath)),
  virtualWindow: { width: 320, height: 224 },
});
const abi = loader.initRuntime(rt);
const fields = abi.fields;
rt.exports.dune_rt_set_window(1);
loader.attachVirtualWindow(rt, 320, 224);
loader.loadRom(rt, new Uint8Array(readFileSync(romPath)));

const gameModule = await WebAssembly.compile(new Uint8Array(readFileSync(gamePath)));
const importObject = { env: {} };
for (const entry of WebAssembly.Module.imports(gameModule)) {
  if (entry.module !== 'env') throw new Error(`unexpected import ${entry.module}.${entry.name}`);
  if (entry.kind === 'memory') importObject.env.memory = rt.memory;
  else {
    const fn = rt.exports[entry.name];
    if (typeof fn !== 'function') throw new Error(`missing runtime export ${entry.name}`);
    importObject.env[entry.name] = fn;
  }
}
const game = await WebAssembly.instantiate(gameModule, importObject);
const slots = loader.appendFunctions(rt, [game.exports.translated_step, game.exports.translated_z80_step]);
loader.installGameTable(rt, slots, { count: 2 });

const cpu = rt.exports.dune_cpu_ptr();
const memory = rt.memory;
const u8 = () => new Uint8Array(memory.buffer);
const view = () => new DataView(memory.buffer);
const rom = new Uint8Array(readFileSync(romPath));
const be32 = (bytes, at) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
const ssp = be32(rom, 0);
const entry = be32(rom, 4) & 0xffffff;
view().setUint32(cpu + fields.OFF_A + 28, ssp, true);
view().setUint32(cpu + fields.OFF_SSP, ssp, true);
view().setUint32(cpu + fields.OFF_PC, entry, true);
view().setUint16(cpu + fields.OFF_SR, 0x2700, true);
game.exports.warmup_all(cpu);

if (typeof rt.exports.dune_rt_set_audio_mode !== 'function') {
  console.log(JSON.stringify({ ok: false, error: 'runtime has no dune_rt_set_audio_mode' }));
  process.exit(2);
}
if (!rt.exports.dune_rt_set_audio_mode(3)) {
  console.log(JSON.stringify({ ok: false, error: 'dune_rt_set_audio_mode(3) failed' }));
  process.exit(2);
}
const rate = rt.exports.dune_rt_audio_rate();
const chunkFrames = Math.min(4096, rt.exports.dune_rt_audio_ring_frames());
const scratch = rt.exports.malloc(chunkFrames * 4);
const pcm = () => new Int16Array(memory.buffer, scratch, chunkFrames * 2);

const masterHz = 53693175;
const masterOf = () => view().getUint32(cpu + fields.OFF_MASTER_CYCLES, true)
  + view().getUint32(cpu + fields.OFF_MASTER_CYCLES + 4, true) * 2 ** 32;
const step = rt.exports.dune_rt_machine_step;
const started = Date.now();
let peak = 0;
let frames = 0;
let sumSquares = 0;
let posts = 0;
let faultAt = null;
const checkpoints = [];
const progressEvery = 2_000_000;
let nextProgress = progressEvery;
let steps = 0;
const targetSeconds = seconds;
const targetMaster = targetSeconds * masterHz;

while (masterOf() < targetMaster && !faultAt) {
  for (let i = 0; i < 16384; i += 1) step();
  steps += 16384;
  for (;;) {
    const available = rt.exports.dune_rt_audio_available();
    if (!available) break;
    const want = Math.min(available, chunkFrames);
    const n = rt.exports.dune_rt_audio_pop(scratch, want);
    if (!n) break;
    const samples = pcm();
    for (let i = 0; i < n * 2; i += 1) {
      const s = samples[i];
      const abs = s < 0 ? -s : s;
      if (abs > peak) peak = abs;
      sumSquares += s * s;
      frames += 1;
    }
    posts += 1;
  }
  if (steps >= nextProgress) {
    const fault = view().getUint32(cpu + fields.OFF_FAULT, true);
    if (fault) {
      const code = rt.exports.dune_rt_last_fail_code();
      faultAt = {
        code,
        reason: loader.cString(rt, rt.exports.dune_rt_fail_reason(code)),
        z80pc: view().getUint16(cpu + fields.OFF_Z80_PC, true),
        pc: view().getUint32(cpu + fields.OFF_PC, true),
      };
      break;
    }
    const z80pc = view().getUint16(cpu + fields.OFF_Z80_PC, true);
    checkpoints.push({
      steps,
      instructions: view().getUint32(cpu + fields.OFF_STEPS, true),
      renderedFrames: rt.exports.dune_web_frame_serial(),
      z80pc,
      z80steps: Number(view().getBigUint64(cpu + fields.OFF_Z80_STEPS, true)),
      audioFrames: frames,
      peak,
      rms: frames ? Math.sqrt(sumSquares / frames) : 0,
    });
    nextProgress += progressEvery;
  }
  void latencyMs;
}
const elapsed = Date.now() - started;
const instr = view().getUint32(cpu + fields.OFF_STEPS, true);
const report = {
  ok: faultAt === null,
  fault: faultAt,
  rate,
  steps,
  instructions: instr,
  elapsedMs: elapsed,
  emulatedSeconds: masterOf() / masterHz,
  renderedFrames: rt.exports.dune_web_frame_serial(),
  audio: {
    frames,
    seconds: frames / rate,
    peak,
    rms: frames ? Math.round(Math.sqrt(sumSquares / frames) * 100) / 100 : 0,
    posts,
    runtimeFrames: Number(rt.exports.dune_rt_audio_frames()),
  },
  z80: {
    steps: Number(view().getBigUint64(cpu + fields.OFF_Z80_STEPS, true)),
    cycles: Number(view().getBigUint64(cpu + fields.OFF_Z80_CYCLES, true)),
    pc: view().getUint16(cpu + fields.OFF_Z80_PC, true),
  },
  checkpoints,
};
console.log(JSON.stringify(report, null, 1));
process.exit(report.ok && report.audio.peak > 0 ? 0 : 1);
