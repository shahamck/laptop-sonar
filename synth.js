// Synthetic spectra for the simulator and the offline tests. It models what the mic should see:
// two carriers with window leakage, a noise floor, and a Doppler-shifted echo from a moving hand.
// It checks the processing logic, not the acoustics of any particular laptop.

import { metresPerBin } from './dsp.js';

const NOISE_DB = -118;
const CARRIER_DB = -28;
const LEAK = [0, -6, -22, -55];            // dB below the carrier at offsets 0…3 (Blackman main lobe)

/** Hand motion over time for each gesture: per-tone velocity (m/s, + = approaching) and echo strength. */
const SCRIPTS = {
  push: (t) => t > 0.4 ? null : both(0.9 * Math.sin(Math.PI * t / 0.4), 1),
  pull: (t) => t > 0.4 ? null : both(-0.9 * Math.sin(Math.PI * t / 0.4), 1),
  tap:  (t) => t > 0.44 ? null : both(1.1 * Math.sin(2 * Math.PI * t / 0.44), 0.9),
  'swipe-right': (t) => swipe(t, 'L', 'R'),
  'swipe-left':  (t) => swipe(t, 'R', 'L'),
};

function both(vel, gain) { return { L: { vel, gain }, R: { vel, gain } }; }

/** The hand passes over the first speaker, then the second: approach then recede over each. */
function swipe(t, first, second) {
  const pass = 0.32, delay = 0.16;
  if (t > pass + delay) return null;
  const side = (tt) => (tt < 0 || tt > pass)
    ? { vel: 0, gain: 0.08 }
    : { vel: 0.8 * Math.cos(Math.PI * tt / pass), gain: Math.sin(Math.PI * tt / pass) + 0.1 };
  return { [first]: side(t), [second]: side(t - delay) };
}

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

    let motion = null;
    if (this.gesture) {
      motion = this.gesture.fn(t - this.gesture.start);
      if (!motion) this.gesture = null;
    }

    for (const side of ['L', 'R']) {
      const f = this.tones[side];
      const c = Math.round(f / this.binHz);
      for (let k = -3; k <= 3; k++) {
        pow[c + k] += 10 ** ((CARRIER_DB + LEAK[Math.abs(k)] + (this.rand() - 0.5) * 0.6) / 10);
      }
      const m = motion?.[side];
      if (m && m.gain > 0) {
        const k0 = m.vel / metresPerBin(this.binHz, f);
        const width = 1.2 + Math.abs(k0) * 0.15;
        const peak = CARRIER_DB - 38 + 10 * Math.log10(m.gain);
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
