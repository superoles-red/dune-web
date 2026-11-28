/* Dune path-A PCM sink (AudioWorklet).
 *
 * The runtime's native YM2612/PSG synthesizer produces 48 kHz stereo i16
 * frames; the JS host drains them with dune_rt_audio_pop() and posts each
 * packet here (transferable ArrayBuffer).  This processor owns the playback
 * ring and the output device clock; it never touches emulation state.
 *
 * Messages in:
 *   {type:'pcm', interleaved: Int16Array}   (may be transferred)
 *   {type:'flush'}                          drop queued audio (pause/save load)
 *   {type:'playing', value:boolean}
 * Messages out:
 *   {type:'ready', sampleRate}
 *   {type:'stats', frames, underruns, queued}
 */
const RING_FRAMES = 32768; // 0.68 s jitter buffer: renders must not starve on slow frames
const REPORT_EVERY_FRAMES = 4800;

class DunePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(RING_FRAMES * 2);
    this.read = 0;
    this.write = 0;
    this.count = 0;
    this.playing = true;
    this.frames = 0;
    this.underruns = 0;
    this.sinceReport = 0;
    this.port.onmessage = (event) => this.handle(event.data);
    this.port.postMessage({ type: 'ready', sampleRate });
  }

  reset() {
    this.read = this.write = this.count = 0;
  }

  handle(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'pcm') {
      const pcm = message.interleaved;
      if (!pcm || !pcm.length) return;
      const frames = pcm.length >> 1;
      for (let i = 0; i < frames; i += 1) {
        if (this.count === RING_FRAMES) {
          /* Host wrote faster than the device clock: drop the oldest frame. */
          this.read = (this.read + 1) % RING_FRAMES;
          this.count -= 1;
          this.underruns += 1;
        }
        const at = this.write * 2;
        const scale = 1 / 32768;
        this.ring[at] = pcm[i * 2] * scale;
        this.ring[at + 1] = pcm[i * 2 + 1] * scale;
        this.write = (this.write + 1) % RING_FRAMES;
        this.count += 1;
      }
      this.frames += frames;
      this.sinceReport += frames;
      if (this.sinceReport >= REPORT_EVERY_FRAMES) {
        this.sinceReport = 0;
        this.port.postMessage({
          type: 'stats', frames: this.frames, underruns: this.underruns,
          queued: this.count, sampleRate,
        });
      }
      return;
    }
    if (message.type === 'flush') {
      this.reset();
      return;
    }
    if (message.type === 'playing') {
      this.playing = !!message.value;
      if (!this.playing) this.reset();
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1] || output[0];
    if (!this.playing || this.count === 0) {
      left.fill(0);
      if (right !== left) right.fill(0);
      if (this.playing && this.count < left.length) this.underruns += 1;
      return true;
    }
    const frames = Math.min(left.length, this.count);
    for (let i = 0; i < frames; i += 1) {
      const at = this.read * 2;
      left[i] = this.ring[at];
      right[i] = this.ring[at + 1];
      this.read = (this.read + 1) % RING_FRAMES;
    }
    this.count -= frames;
    if (frames < left.length) {
      left.fill(0, frames);
      if (right !== left) right.fill(0, frames);
      this.underruns += 1;
    }
    return true;
  }
}

registerProcessor('dune-pcm', DunePcmProcessor);
