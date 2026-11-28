/* Dune path-A audio bridge: runtime.wasm PCM -> AudioWorklet.
 *
 * The shipped ``runtime/wasm/runtime.wasm`` already contains the original
 * YM2612 (ymfm) + PSG synthesizer and the translated Z80 driver; this module
 * only turns audio mode ON and drains the native 48 kHz stereo ring into an
 * AudioWorklet (web/host/audio-worklet.js).  No emulation state is duplicated
 * in JS: samples, mixing, DC removal and voice levels stay native.
 *
 * The two runtime exports this bridge needs live in
 * ``tools/wasm_runtime/src/dune_rt_audio.inc``:
 *
 *   dune_rt_set_audio_mode(3)    -> AUDIO_ON (Z80 scheduler + synthesis)
 *   dune_rt_audio_pop(ptr, n)    -> drain up to n interleaved i16 stereo frames
 *
 * Usage (host page):
 *
 *   import { DuneAudio } from './audio.mjs';
 *   const audio = new DuneAudio({ host });
 *   button.addEventListener('click', async () => { await audio.enable(); });
 *   // in the frame loop, after host.advanceSteps():
 *   audio.pump();
 *
 * ``enable()`` must run inside a user gesture (AudioContext policy).  The class
 * never creates a context at construction time so a page that is never clicked
 * stays silent and costs nothing.
 */

export const AUDIO_RATE = 48000;
export const MUSIC_LEVELS = Object.freeze([100, 50, 25, 10, 0]);

const DEFAULT_WORKLET_URL = new URL('./audio-worklet.js', import.meta.url);

export class AudioUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AudioUnavailableError';
  }
}

function clampLevel(value) {
  const level = Number(value);
  return MUSIC_LEVELS.includes(level) ? level : 100;
}

/**
 * Native-runtime audio bridge.
 *
 * ``host`` is any object with ``exports`` (WebAssembly exports object) and
 * ``memory`` (the runtime's imported ``WebAssembly.Memory``); ``DuneHost`` from
 * host.mjs satisfies this.  It is attached lazily so tests can construct the
 * bridge before boot.
 */
export class DuneAudio {
  constructor({
    host = null,
    workletUrl = DEFAULT_WORKLET_URL,
    chunkFrames = 2048,
    music = 100,
    sound = 100,
    audioContextFactory = null,
  } = {}) {
    this.host = host;
    this.workletUrl = workletUrl;
    this.chunkFrames = Math.max(64, Math.min(8192, Math.floor(chunkFrames)));
    this.music = clampLevel(music);
    this.sound = clampLevel(sound);
    this.audioContextFactory = audioContextFactory;
    this.context = null;
    this.node = null;
    this.scratchPointer = 0;
    this.pumpTimer = 0;
    this.moduleLoaded = false;
    this.enabled = false;
    this.workletReady = false;
    this.workletStats = { frames: 0, underruns: 0, overflow: 0, queued: 0, sampleRate: 0 };
    this.metrics = createMetrics();
    this.log = [];
  }

  /* ------------------------------------------------------------ runtime -- */

  /** True when the loaded runtime has the path-A audio exports. */
  get supported() {
    const exports = this.host?.exports;
    return Boolean(
      exports &&
        typeof exports.dune_rt_set_audio_mode === 'function' &&
        typeof exports.dune_rt_audio_pop === 'function',
    );
  }

  get reason() {
    if (!this.host) return 'no host attached';
    if (!this.host.exports) return 'host is not booted';
    if (!this.supported) {
      return 'runtime.wasm has no dune_rt_set_audio_mode/dune_rt_audio_pop exports';
    }
    return null;
  }

  attach(host) {
    this.host = host;
    return this;
  }

  #note(message) {
    this.log.push(message);
    if (this.log.length > 64) this.log.shift();
  }

  /* -------------------------------------------------------------- device -- */

  /** Create/resume the AudioContext and connect the worklet. User gesture only. */
  /** Respect the phone's silent switch: the default WebAudio session type is
   *  "ambient" on iOS, which is muted by the ringer switch and mixes with other
   *  apps.  Never force "playback" here. */
  #applyAudioSession() {
    try {
      if (globalThis.navigator?.audioSession) globalThis.navigator.audioSession.type = 'ambient';
    } catch { /* not supported (Android/older Safari) */ }
  }

  async enable({ music = this.music, sound = this.sound } = {}) {
    this.#applyAudioSession();
    if (this.enabled) {
      await this.#resume();
      return this.stats();
    }
    const reason = this.reason;
    if (reason) throw new AudioUnavailableError(reason);
    const factory = this.audioContextFactory ?? globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!factory) throw new AudioUnavailableError('AudioContext is not available');
    let context;
    try {
      context = factory === globalThis.AudioContext || factory === globalThis.webkitAudioContext
        ? new factory({ sampleRate: AUDIO_RATE, latencyHint: 'interactive' })
        : factory({ sampleRate: AUDIO_RATE, latencyHint: 'interactive' });
    } catch (error) {
      throw new AudioUnavailableError(`cannot create AudioContext: ${error.message}`);
    }
    this.context = context;
    if (typeof context.resume === 'function' && context.state !== 'running') {
      try {
        await context.resume();
      } catch (error) {
        this.#note(`resume rejected: ${error.message}`);
      }
    }
    if (!context.audioWorklet || typeof context.audioWorklet.addModule !== 'function') {
      await this.#close();
      throw new AudioUnavailableError('AudioContext.audioWorklet is not available');
    }
    if (!this.moduleLoaded) {
      try {
        await context.audioWorklet.addModule(String(this.workletUrl));
      } catch (error) {
        await this.#close();
        throw new AudioUnavailableError(`cannot load audio-worklet.js: ${error.message}`);
      }
      this.moduleLoaded = true;
    }
    this.node = new AudioWorkletNode(context, 'dune-pcm', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.node.port.onmessage = (event) => this.#onWorkletMessage(event.data);
    this.node.connect(context.destination);

    const exports = this.host.exports;
    if (typeof exports.malloc === 'function') {
      this.scratchPointer = exports.malloc(this.chunkFrames * 4);
    }
    if (!this.scratchPointer) {
      await this.#close();
      throw new AudioUnavailableError('runtime malloc() failed for the PCM scratch buffer');
    }
    this.setLevels(music, sound);
    const mode = exports.dune_rt_set_audio_mode(3);
    if (!mode) {
      await this.#close();
      throw new AudioUnavailableError('dune_rt_set_audio_mode(AUDIO_ON) failed');
    }
    this.enabled = true;
    this.#startPumpTimer();
    this.metrics = createMetrics();
    this.#note(`audio ON (${AUDIO_RATE} Hz, ${this.chunkFrames}-frame packets)`);
    return this.stats();
  }

  async #resume() {
    if (this.context && this.context.state !== 'running' && this.context.resume) {
      try {
        await this.context.resume();
      } catch (error) {
        this.#note(`resume rejected: ${error.message}`);
      }
    }
  }

  #startPumpTimer() {
    if (this.pumpTimer) return;
    // Feed audio between animation frames too: the legacy UI's canvas redraw can
    // make a frame longer than the 16 ms audio period.
    this.pumpTimer = setInterval(() => {
      if (!this.enabled) return;
      try { this.pump({ maxChunks: 2 }); } catch { /* audio is best effort */ }
    }, 8);
  }

  #stopPumpTimer() {
    if (this.pumpTimer) { clearInterval(this.pumpTimer); this.pumpTimer = 0; }
  }

  async #close() {
    this.#stopPumpTimer();
    if (this.node) {
      try { this.node.disconnect(); } catch { /* already disconnected */ }
      this.node = null;
    }
    if (this.context) {
      try { await this.context.close(); } catch { /* already closed */ }
      this.context = null;
    }
    /* A new AudioContext has its own AudioWorkletGlobalScope: reload the module
       on the next enable() instead of assuming the processor is registered. */
    this.moduleLoaded = false;
    this.workletReady = false;
    this.enabled = false;
  }

  async disable() {
    if (!this.enabled) return;
    const exports = this.host?.exports;
    if (exports && typeof exports.dune_rt_set_audio_mode === 'function') {
      try { exports.dune_rt_set_audio_mode(1); } catch { /* ignore */ }
    }
    await this.#close();
    this.#note('audio OFF');
  }

  async suspend() {
    if (!this.enabled) return;
    this.#stopPumpTimer();
    if (this.context && this.context.state === 'running') {
      try { await this.context.suspend(); } catch { /* ignore */ }
    }
  }

  async resume() {
    if (!this.enabled) return;
    this.#applyAudioSession();
    await this.#resume();
    this.#startPumpTimer();
  }

  /* --------------------------------------------------------------- mixer -- */

  /** Independent music/SFX output levels (percent: 100/50/25/10/0). */
  setLevels(music, sound) {
    this.music = clampLevel(music);
    this.sound = clampLevel(sound);
    const exports = this.host?.exports;
    if (exports && typeof exports.dune_web_audio_levels === 'function') {
      return Boolean(exports.dune_web_audio_levels(this.music, this.sound));
    }
    return false;
  }

  /* ----------------------------------------------------------------- pcm -- */

  /** Drain up to ``maxChunks`` packets and post them to the worklet. */
  pump({ maxChunks = 4 } = {}) {
    if (!this.enabled || !this.node) return 0;
    const exports = this.host.exports;
    const memory = this.host.memory;
    if (!memory || !memory.buffer) return 0;
    const view = new Int16Array(memory.buffer, this.scratchPointer, this.chunkFrames * 2);
    let posted = 0;
    let framesPosted = 0;
    for (let chunk = 0; chunk < maxChunks; chunk += 1) {
      const available = exports.dune_rt_audio_available();
      if (!available) break;
      const want = Math.min(available, this.chunkFrames);
      const count = exports.dune_rt_audio_pop(this.scratchPointer, want);
      if (!count) break;
      /* Copy out of wasm memory (it must not be transferred) and accumulate
         host-side RMS/peak telemetry for the acceptance test/report. */
      const pcm = new Int16Array(count * 2);
      for (let i = 0; i < count * 2; i += 1) {
        const sample = view[i];
        pcm[i] = sample;
        const abs = sample < 0 ? -sample : sample;
        if (abs > this.metrics.peak) this.metrics.peak = abs;
        this.metrics.sumSquares += sample * sample;
      }
      this.metrics.samples += count * 2;
      this.metrics.frames += count;
      // Debug/analyser hook: when a page sets __DUNE_AUDIO_CAPTURE__, keep the
      // exact PCM posted to the worklet so tests can look for clicks/dropouts.
      const capture = globalThis.__DUNE_AUDIO_CAPTURE__;
      if (Array.isArray(capture) && capture.length < (globalThis.__DUNE_AUDIO_CAPTURE_LIMIT__ || 64)) capture.push(pcm.slice());
      framesPosted += count;
      posted += 1;
      this.node.port.postMessage({ type: 'pcm', interleaved: pcm }, [pcm.buffer]);
    }
    this.metrics.posts += posted;
    if (posted) {
      const raw = this.host.exports.dune_rt_audio_peak?.() ?? 0;
      if (raw > this.metrics.devicePeak) this.metrics.devicePeak = raw;
    }
    return framesPosted;
  }

  flush() {
    if (this.node) this.node.port.postMessage({ type: 'flush' });
    const exports = this.host?.exports;
    if (exports && typeof exports.dune_rt_audio_reset === 'function') {
      try { exports.dune_rt_audio_reset(); } catch { /* ignore */ }
    }
  }

  resetPeak() {
    this.metrics = createMetrics();
    const exports = this.host?.exports;
    if (exports && typeof exports.dune_rt_audio_reset_peak === 'function') {
      try { exports.dune_rt_audio_reset_peak(); } catch { /* ignore */ }
    }
  }

  #onWorkletMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      this.workletReady = true;
      this.workletStats.sampleRate = message.sampleRate;
      return;
    }
    if (message.type === 'stats') {
      this.workletStats = {
        frames: message.frames,
        underruns: message.underruns,
        overflow: message.overflow ?? 0,
        queued: message.queued,
        sampleRate: message.sampleRate,
      };
    }
  }

  /** JSON-able snapshot for tests and the debug overlay. */
  stats() {
    const frames = this.metrics.frames;
    const samples = this.metrics.samples;
    const rms = samples ? Math.sqrt(this.metrics.sumSquares / samples) : 0;
    const exports = this.host?.exports;
    return {
      supported: this.supported,
      reason: this.reason,
      enabled: this.enabled,
      contextState: this.context?.state ?? 'closed',
      sampleRate: this.context?.sampleRate ?? 0,
      workletReady: this.workletReady,
      packets: this.metrics.posts,
      frames,
      samples,
      peak: this.metrics.peak,
      devicePeak: this.metrics.devicePeak,
      rms: Math.round(rms * 100) / 100,
      worklet: this.workletStats,
      runtimeFrames: typeof exports?.dune_rt_audio_frames === 'function'
        ? Number(exports.dune_rt_audio_frames())
        : 0,
      runtimeAvailable: typeof exports?.dune_rt_audio_available === 'function'
        ? exports.dune_rt_audio_available()
        : 0,
      music: this.music,
      sound: this.sound,
      log: this.log.slice(-8),
    };
  }
}

function createMetrics() {
  return { frames: 0, samples: 0, posts: 0, peak: 0, devicePeak: 0, sumSquares: 0 };
}

/** Convenience: attach to a booted DuneHost and enable from a click handler. */
export function attachAudio(host, options = {}) {
  const audio = new DuneAudio({ host, ...options });
  return audio;
}
