/* Path-A browser audio control for the standalone ``runtime.wasm``.
 *
 * HOW TO HOOK UP (one line, kept out of dune_rt_abi.inc so it does not collide
 * with concurrent host edits):
 *
 *   append this line at the END of tools/wasm_runtime/src/dune_rt_abi.inc
 *   (after the virtual-window include):
 *
 *       #include "dune_rt_audio.inc"
 *
 * The preamble (``runtime/dune-runtime-v2.c``) already defines the native PCM
 * code this file drives: ``audio_init()``, ``audio_sync()`` (called from
 * ``machine_advance`` when ``audio_mode == AUDIO_ON``) and the bounded ring
 * ``audio_pop()``.  This layer only exports the path-A host controls that
 * ``run_main()``/``sdl_host_service()`` had (SDL device / em_web_audio_service
 * are path B and need a window).  It adds *no* imports, *no* data and does not
 * touch the ABI descriptor, the DSAV v2 layout (140 056 B) or the helper ABI.
 *
 * Contract for the JS host (web/host/audio.mjs):
 *   1. after boot + 2-slot game table install:
 *        dune_rt_set_audio_mode(3)      -> real YM2612 + PSG + Z80 execution
 *   2. once per animation-frame batch (after ``dune_rt_machine_step`` calls):
 *        n = dune_rt_audio_available();          // 48 kHz stereo frames
 *        n = dune_rt_audio_pop(ptr, n);          // i16[2*n] at ptr
 *      and post ``ptr`` bytes to the AudioWorklet (see audio.mjs).
 *   3. optionally ``dune_rt_audio_reset()`` on load/save/visibility changes and
 *      ``dune_web_audio_levels(music, sound)`` for independent levels.
 *
 * The ring is bounded (AUDIO_RING_FRAMES = 4096 = ~85 ms).  If the worklet
 * stalls, the oldest frames are dropped inside ``audio_sample`` exactly like
 * the SDL path; the chip clock never rewinds and never stalls the CPU.
 */
#ifndef DUNE_RT_AUDIO_INC
#define DUNE_RT_AUDIO_INC

/* Current mode: 1 = AUDIO_STUB (Z80 disabled, silent), 2 = AUDIO_MUTE
   (Z80 runs, YM writes stored only), 3 = AUDIO_ON (synthesis + ring).
   AUDIO_STRICT (0) is a debug mode and is rejected as a host setting. */
EMSCRIPTEN_KEEPALIVE int dune_rt_audio_mode(void) {
    return em_cpu.audio_mode;
}

/* 1 on success.  Enabling synthesis initialises the YM2612 lazily (the game may
   not have started yet) and turns on ring playback; the Z80 scheduler starts
   because z80_tick() only bails out on AUDIO_STUB. */
EMSCRIPTEN_KEEPALIVE int dune_rt_set_audio_mode(int mode) {
    if (mode < AUDIO_MUTE || mode > AUDIO_ON) return 0;
    if (mode == AUDIO_ON) {
        if (!em_cpu.audio.initialized && !audio_init(&em_cpu, NULL)) return 0;
        if (em_cpu.fault) return 0;
        em_cpu.audio.playback = 1;
        em_cpu.audio.read = 0;
        em_cpu.audio.count = 0;
    } else {
        em_cpu.audio.playback = 0;
        em_cpu.audio.read = 0;
        em_cpu.audio.count = 0;
    }
    em_cpu.audio_mode = mode;
    return 1;
}

/* The old SDL presentation path applied dune_audio_scale() to every output
   sample (default DUNE_VOLUME=100 -> x4, with a soft knee above 24000).  Path A
   drains the ring itself, so without this the game was exactly 12 dB quieter
   than the old web build.  Keep the same gain curve here. */
static int16_t dune_rt_audio_gain(int16_t sample) {
    int32_t value = (int32_t)sample * 4;
    int negative = value < 0;
    if (negative) value = -value;
    if (value > 24000) {
        int32_t excess = value - 24000;
        value = 24000 + (int32_t)((int64_t)excess * 8767 / (excess + 8767));
    }
    if (value > 32767) value = 32767;
    return (int16_t)(negative ? -value : value);
}

/* Drain up to ``frames`` interleaved stereo i16 frames into ``out``.
   Returns the number of frames written (0 when the ring is empty). */
EMSCRIPTEN_KEEPALIVE unsigned dune_rt_audio_pop(uint32_t out, unsigned frames) {
    unsigned count = audio_pop(&em_cpu, (int16_t *)(uintptr_t)out, frames);
    int16_t *samples = (int16_t *)(uintptr_t)out;
    for (unsigned i = 0; i < count * 2; ++i) samples[i] = dune_rt_audio_gain(samples[i]);
    return count;
}

/* 48 000 stereo frames/s, ring capacity 4096 frames and the current fill. */
EMSCRIPTEN_KEEPALIVE unsigned dune_rt_audio_rate(void) { return AUDIO_RATE; }
EMSCRIPTEN_KEEPALIVE unsigned dune_rt_audio_ring_frames(void) { return AUDIO_RING_FRAMES; }
EMSCRIPTEN_KEEPALIVE unsigned dune_rt_audio_available(void) { return em_cpu.audio.count; }

/* Telemetry: peak |sample| since the last reset and total generated frames. */
EMSCRIPTEN_KEEPALIVE unsigned dune_rt_audio_peak(void) { return em_cpu.audio.peak; }
EMSCRIPTEN_KEEPALIVE uint64_t dune_rt_audio_frames(void) { return em_cpu.audio.frames; }
EMSCRIPTEN_KEEPALIVE void dune_rt_audio_reset_peak(void) { em_cpu.audio.peak = 0; }

/* Called by the host after a portable save is loaded (the DSAV v2 contract keeps
   the chip state, but the ring is host output and must not replay old audio). */
EMSCRIPTEN_KEEPALIVE void dune_rt_audio_reset(void) {
    em_cpu.audio.read = 0;
    em_cpu.audio.count = 0;
    em_cpu.audio.peak = 0;
}

#endif /* DUNE_RT_AUDIO_INC */
