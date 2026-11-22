// Synthetic spectra for the simulator and the offline tests: two carriers with window leakage, a
// noise floor, and a Doppler-shifted echo from a moving hand. The hand motions copy what the real
// recording in tools/fixtures showed (fast push in, slower return; slow approach, fast pull out).

import { metresPerBin } from './dsp.js';

const NOISE_DB = -118;
const CARRIER_DB = -28;
const LEAK = [0, -6, -22, -55];            // dB below the carrier at offsets 0…3 (Blackman main lobe)

const hump = (t, a, b, v) => (t < a || t > b) ? 0 : v * Math.sin(Math.PI * (t - a) / (b - a));

/** Hand speed over time (m/s, + = approaching). null = gesture over. */
const SCRIPTS = {
  push: (t) => t > 1.2 ? null : hump(t, 0, 0.3, 1.2) + hump(t, 0.6, 1.1, -0.55),
  pull: (t) => t > 1.4 ? null : hump(t, 0, 0.7, 0.55) + hump(t, 0.95, 1.25, -1.35),
  wave: (t) => t > 1.0 ? null : 1.0 * Math.sin(2 * Math.PI * t / 0.5),
};

export const SIM_GESTURES = Object.keys(SCRIPTS);

export class SpectrumSynth {
  constructor({ bins = 2048, sampleRate = 48000, fftSize = 4096, tones, seed = 1 }) {
    this.bins = bins;
    this.binHz = sampleRate / fftSize;
    this.tones = tones;                  // { L: freq, R: freq }
    this.gesture = null;
    this.seed = seed;
  }

  rand() {                               // small deterministic PRNG so tests repeat
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 2 ** 32;
  }

  play(name, t) { this.gesture = { fn: SCRIPTS[name], start: t }; }

  frame(t, out = new Float32Array(this.bins)) {
    const pow = new Float64Array(this.bins);
    for (let i = 0; i < this.bins; i++) pow[i] = 10 ** ((NOISE_DB + (this.rand() - 0.5) * 6) / 10);

    let vel = null;
    if (this.gesture) {
      vel = this.gesture.fn(t - this.gesture.start);
      if (vel === null) this.gesture = null;
    }

    for (const side of ['L', 'R']) {
      const f = this.tones[side];
      const c = Math.round(f / this.binHz);
      for (let k = -3; k <= 3; k++) {
        pow[c + k] += 10 ** ((CARRIER_DB + LEAK[Math.abs(k)] + (this.rand() - 0.5) * 0.6) / 10);
      }
      if (vel) {
        const k0 = vel / metresPerBin(this.binHz, f);
        const width = 1.2 + Math.abs(k0) * 0.15;
        const peak = CARRIER_DB - 40 + (side === 'R' ? -12 : 0);   // right tone echoes weaker, as measured
        for (let k = -30; k <= 30; k++) {
          const g = Math.exp(-0.5 * ((k - k0) / width) ** 2);
          if (g > 1e-4) pow[c + k] += 10 ** (peak / 10) * g;
        }
      }
    }
    for (let i = 0; i < this.bins; i++) out[i] = 10 * Math.log10(pow[i]);
    return out;
  }
}
