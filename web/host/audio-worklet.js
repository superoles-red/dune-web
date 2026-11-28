/* Dune path-A PCM sink (AudioWorklet).
 *
 * The runtime's native YM2612/PSG synthesizer produces 48 kHz stereo i16
 * frames; the JS host drains them with dune_rt_audio_pop() and posts each
 * packet here (transferable ArrayBuffer).  This processor owns the playback
 * ring and the output device clock; it never touches emulation state.
 *
 * The processor resamples 48 kHz runtime frames to the AudioContext rate (some
 * devices run at 44.1 kHz even when a 48 kHz context was requested), primes a
 * small jitter buffer before playback, keeps the stream continuous on overflow
 * (drops whole incoming blocks instead of shifting the ring) and fades the last
 * sample on an underrun instead of hard zeroing — all of which used to sound
 * like hiccups/crackle while the map was redrawn.
 *
 * Messages in:
 *   {type:'pcm', interleaved: Int16Array}   (may be transferred)
 *   {type:'flush'}                          drop queued audio (pause/save load)
 *   {type:'playing', value:boolean}
 * Messages out:
 *   {type:'ready', sampleRate}
 *   {type:'stats', frames, underruns, overflow, queued}
 */
const RUNTIME_RATE = 48000;
const RING_FRAMES = 65536; // 1.36 s at 48 kHz
const PRIME_FRAMES = 4800; // 0.1 s before playback starts
const REPORT_EVERY_FRAMES = 4800;

class DunePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(RING_FRAMES * 2);
    this.read = 0;
    this.write = 0;
    this.count = 0;
    this.phase = 0;
    this.primed = false;
    this.playing = true;
    this.frames = 0;
    this.underruns = 0;
    this.overflow = 0;
    this.sinceReport = 0;
    this.lastL = 0;
    this.lastR = 0;
    this.step = RUNTIME_RATE / sampleRate;
    this.port.onmessage = (event) => this.handle(event.data);
    this.port.postMessage({ type: 'ready', sampleRate, runtimeRate: RUNTIME_RATE });
  }

  reset() {
    this.read = this.write = this.count = 0;
    this.phase = 0;
    this.primed = false;
    this.lastL = this.lastR = 0;
  }

  dropOldest(frames) {
    const drop = Math.min(frames, this.count);
    this.read = (this.read + drop) % RING_FRAMES;
    this.count -= drop;
    this.overflow += drop;
  }

  handle(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'pcm') {
      const pcm = message.interleaved;
      if (!pcm || !pcm.length) return;
      const frames = pcm.length >> 1;
      if (frames > RING_FRAMES - this.count) {
        // Keep the stream continuous: if the host bursts faster than the device
        // clock (render hiccup, fast-forward), drop incoming frames instead of
        // sliding the whole ring, which used to produce audible clicks.
        const accepted = RING_FRAMES - this.count;
        if (accepted <= 0) { this.overflow += frames; return; }
        for (let i = 0; i < accepted; i += 1) this.#push(pcm, i);
        this.overflow += frames - accepted;
      } else {
        for (let i = 0; i < frames; i += 1) this.#push(pcm, i);
      }
      this.frames += frames;
      this.sinceReport += frames;
      if (this.sinceReport >= REPORT_EVERY_FRAMES) {
        this.sinceReport = 0;
        this.port.postMessage({
          type: 'stats', frames: this.frames, underruns: this.underruns,
          overflow: this.overflow, queued: this.count, sampleRate,
        });
      }
      return;
    }
    if (message.type === 'flush') { this.reset(); return; }
    if (message.type === 'playing') {
      this.playing = !!message.value;
      if (!this.playing) this.reset();
    }
  }

  #push(pcm, index) {
    const at = this.write * 2;
    this.ring[at] = pcm[index * 2] / 32768;
    this.ring[at + 1] = pcm[index * 2 + 1] / 32768;
    this.write = (this.write + 1) % RING_FRAMES;
    this.count += 1;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || output[0];
    const total = left.length;
    if (!this.playing) {
      left.fill(0);
      if (right !== left) right.fill(0);
      return true;
    }
    if (!this.primed) {
      if (this.count < PRIME_FRAMES) {
        left.fill(0);
        if (right !== left) right.fill(0);
        return true;
      }
      this.primed = true;
    }
    let i = 0;
    for (; i < total; i += 1) {
      if (this.count <= 0) break;
      const aL = this.ring[this.read * 2];
      const aR = this.ring[this.read * 2 + 1];
      const next = this.count > 1 ? (this.read + 1) % RING_FRAMES : this.read;
      const bL = this.ring[next * 2];
      const bR = this.ring[next * 2 + 1];
      const t = this.phase;
      this.lastL = aL + (bL - aL) * t;
      this.lastR = aR + (bR - aR) * t;
      left[i] = this.lastL;
      right[i] = this.lastR;
      this.phase += this.step;
      while (this.phase >= 1) {
        this.phase -= 1;
        this.read = (this.read + 1) % RING_FRAMES;
        this.count -= 1;
        if (this.count <= 0) break;
      }
    }
    if (i < total) {
      // Underrun: fade the last sample over the remainder instead of a click.
      const remaining = total - i;
      for (let k = 0; k < remaining; k += 1) {
        const fade = 1 - k / remaining;
        left[i + k] = this.lastL * fade;
        if (right !== left) right[i + k] = this.lastR * fade;
      }
      this.count = 0;
      this.phase = 0;
      this.underruns += 1;
      this.primed = false; // rebuild the jitter buffer
    }
    return true;
  }
}

registerProcessor('dune-pcm', DunePcmProcessor);
