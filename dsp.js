// Sonar signal processing: per-tone Doppler features, rest calibration, segmentation, gesture rules.
//
// The page plays two near-ultrasonic tones, one from each speaker. A hand moving near the laptop
// reflects them back to the mic with a small frequency shift: higher when the hand approaches,
// lower when it moves away (Δf = 2·v·f / c). We read that shift from the FFT bins around each tone.

export const SPEED_OF_SOUND = 343;   // m/s at ~20 °C
export const GUARD = 2;              // bins each side of the carrier that are left out (window main lobe)
export const SPAN = 26;              // bins each side of the carrier that are examined
export const WIDTH = SPAN * 2 + 1;

/** Metres per second of hand speed that one FFT bin of shift stands for. */
export function metresPerBin(binHz, freq) {
  return (binHz * SPEED_OF_SOUND) / (2 * freq);
}

/** The bin that holds the carrier: the loudest one within ±3 bins of where the tone should be. */
export function findCarrier(db, freq, binHz) {
  const expected = Math.round(freq / binHz);
  let best = expected, top = -Infinity;
  for (let k = -3; k <= 3; k++) {
    const v = db[expected + k];
    if (v > top) { top = v; best = expected + k; }
  }
  return best;
}

/** dB values around the carrier, offsets -SPAN…+SPAN. */
export function slice(db, center, out = new Float32Array(WIDTH)) {
  for (let k = -SPAN; k <= SPAN; k++) out[k + SPAN] = db[center + k];
  return out;
}

/**
 * How loud the tone is over the background a bit further out. Below ~20 dB the mic is
 * not hearing the speakers (muted, Bluetooth output, AirPods mic, or a filter in the way).
 */
export function toneSnr(row) {
  const far = [];
  for (let i = 0; i < WIDTH; i++) if (Math.abs(i - SPAN) > SPAN - 8) far.push(row[i]);
  far.sort((a, b) => a - b);
  return row[SPAN] - far[Math.floor(far.length / 2)];
}

/**
 * Noise floor per offset bin, learnt while nothing moves. The window's own leakage around the
 * carrier is part of that floor, so only reflections from moving things rise above it.
 */
export class Floor {
  constructor(values, restScores) { this.values = values; this.restScores = restScores; }

  static fromRows(rows) {
    if (rows.length < 20) return null;
    const n = rows.length;
    const mean = new Float32Array(WIDTH), sd = new Float32Array(WIDTH);
    for (const r of rows) for (let i = 0; i < WIDTH; i++) mean[i] += r[i] / n;
    for (const r of rows) for (let i = 0; i < WIDTH; i++) sd[i] += (r[i] - mean[i]) ** 2 / n;
    const values = new Float32Array(WIDTH);
    for (let i = 0; i < WIDTH; i++) values[i] = mean[i] + Math.max(2.5 * Math.sqrt(sd[i]), 1.5) + 2;
    const floor = new Floor(values, []);
    floor.restScores = rows.map((r) => floor.read(r, 1).score);
    return floor;
  }

  /** Doppler reading for one spectrum slice. */
  read(row, mPerBin, excess = null) {
    let up = 0, down = 0, moment = 0;
    for (let k = -SPAN; k <= SPAN; k++) {
      const i = k + SPAN;
      const e = Math.max(0, row[i] - this.values[i]);
      if (excess) excess[i] = e;
      if (Math.abs(k) <= GUARD) continue;
      if (k > 0) up += e; else down += e;
      moment += k * e;
    }
    const score = up + down;
    return { up, down, score, vel: score > 0 ? (moment / score) * mPerBin : 0 };
  }
}

/** A threshold that sits clear of the motion score seen while still. */
export function autoThreshold(restScores) {
  if (!restScores.length) return 30;
  const s = restScores.slice().sort((a, b) => a - b);
  const p99 = s[Math.min(s.length - 1, Math.floor(s.length * 0.99))];
  return Math.round(Math.max(18, p99 * 2 + 10));
}

/** Cuts the live frame stream into gesture-sized pieces. Times are in seconds. */
export class Segmenter {
  constructor({ threshold = 30, pre = 0.12, hang = 0.2, minActive = 0.05, max = 1.8, cooldown = 0.35 } = {}) {
    Object.assign(this, { threshold, pre, hang, minActive, max, cooldown });
    this.reset();
  }

  reset() {
    this.history = [];
    this.segment = null;
    this.smoothed = 0;
    this.lastActive = 0;
    this.firstActive = 0;
    this.activeTime = 0;
    this.blockedUntil = 0;
    this.prevT = null;
  }

  get capturing() { return !!this.segment; }

  /** Feed one frame ({ t, score, … }). Returns the frames of a finished gesture, or null. */
  push(f) {
    const dt = this.prevT == null ? 0 : Math.min(0.1, f.t - this.prevT);
    this.prevT = f.t;
    this.smoothed = 0.5 * this.smoothed + 0.5 * f.score;
    const active = this.smoothed > this.threshold && f.t >= this.blockedUntil;

    if (!this.segment) {
      this.history.push(f);
      while (this.history.length && f.t - this.history[0].t > this.pre) this.history.shift();
      if (active) {
        this.segment = this.history;
        this.history = [];
        this.firstActive = this.lastActive = f.t;
        this.activeTime = 0;
      }
      return null;
    }

    this.segment.push(f);
    if (active) { this.lastActive = f.t; this.activeTime += dt; }
    const ended = f.t - this.lastActive > this.hang || f.t - this.firstActive > this.max;
    if (!ended) return null;

    const out = this.segment.filter((x) => x.t <= this.lastActive + 0.06);
    const ok = this.activeTime >= this.minActive;
    this.segment = null;
    this.history = [];
    this.blockedUntil = f.t + this.cooldown;
    return ok ? out : null;
  }
}

export const GESTURES = {
  'swipe-left':  { label: 'swipe left',  glyph: '←', hint: 'Sweep your hand across the keyboard from right to left, 5–15 cm above it.' },
  'swipe-right': { label: 'swipe right', glyph: '→', hint: 'Sweep your hand across the keyboard from left to right, 5–15 cm above it.' },
  'push':        { label: 'push',        glyph: '↓', hint: 'Move your open hand towards the screen and stop.' },
  'pull':        { label: 'pull',        glyph: '↑', hint: 'Start with your hand close to the screen and draw it back.' },
  'tap':         { label: 'tap',         glyph: '●', hint: 'A quick in-and-out jab towards the screen.' },
};

/**
 * Names a finished segment.
 * - Swipe: both tones are disturbed, one clearly before the other (hand passes one speaker, then the other).
 * - Push / pull: mostly upshift (approaching) or mostly downshift (receding).
 * - Tap: both, approach first.
 */
export function classify(frames, { swipeGap = 0.06, flip = false, lean = 0.3 } = {}) {
  let eL = 0, eR = 0, tL = 0, tR = 0, U = 0, D = 0, tU = 0, tD = 0, peakV = 0;
  for (const f of frames) {
    eL += f.L.score; tL += f.t * f.L.score;
    eR += f.R.score; tR += f.t * f.R.score;
    const u = f.L.up + f.R.up, d = f.L.down + f.R.down;
    U += u; tU += f.t * u;
    D += d; tD += f.t * d;
    const v = (f.L.vel * f.L.score + f.R.vel * f.R.score) / Math.max(f.L.score + f.R.score, 1e-9);
    if (Math.abs(v) > Math.abs(peakV)) peakV = v;
  }
  if (eL + eR <= 0) return null;
  tL = eL ? tL / eL : 0;
  tR = eR ? tR / eR : 0;
  tU = U ? tU / U : 0;
  tD = D ? tD / D : 0;

  const balance = Math.min(eL, eR) / Math.max(eL, eR);  // 1 = both sides equally, 0 = one side only
  const gap = tR - tL;                                     // > 0: left side moved first
  const lean_ = (U - D) / (U + D);                         // +1 all approach, −1 all recede
  const t0 = frames[0].t;
  const stats = {
    balance: +balance.toFixed(2), gap: +gap.toFixed(3), lean: +lean_.toFixed(2),
    peakVel: +peakV.toFixed(2), duration: +(frames[frames.length - 1].t - t0).toFixed(2),
    energy: Math.round(eL + eR),
  };

  let name;
  if (balance > 0.2 && Math.abs(gap) >= swipeGap) {
    const right = flip ? gap < 0 : gap > 0;
    name = right ? 'swipe-right' : 'swipe-left';
  } else if (lean_ > lean) name = 'push';
  else if (lean_ < -lean) name = 'pull';
  else name = tU <= tD ? 'tap' : 'pull';
  return { name, ...GESTURES[name], stats };
}

/**
 * Turns whole spectra into frames for both tones. Call calibrate() with spectra taken while
 * nothing moves, then read() on each new spectrum.
 */
export class Reader {
  constructor({ binHz, tones }) {
    this.binHz = binHz;
    this.tones = tones;                                   // { L: freq, R: freq }
    this.mpb = { L: metresPerBin(binHz, tones.L), R: metresPerBin(binHz, tones.R) };
    this.center = null;
    this.floor = null;
    this.rows = { L: new Float32Array(WIDTH), R: new Float32Array(WIDTH) };
    this.excess = { L: new Float32Array(WIDTH), R: new Float32Array(WIDTH) };
  }

  locate(db) {
    this.center = { L: findCarrier(db, this.tones.L, this.binHz), R: findCarrier(db, this.tones.R, this.binHz) };
    return this.center;
  }

  /** spectra: array of dB arrays. Returns { ok, snr: {L, R}, threshold }. */
  calibrate(spectra) {
    this.locate(spectra[Math.floor(spectra.length / 2)]);
    const rows = { L: [], R: [] };
    for (const db of spectra) for (const s of ['L', 'R']) rows[s].push(slice(db, this.center[s]));
    const snr = {
      L: median(rows.L.map(toneSnr)),
      R: median(rows.R.map(toneSnr)),
    };
    this.floor = { L: Floor.fromRows(rows.L), R: Floor.fromRows(rows.R) };
    const rest = rows.L.map((_, i) => this.floor.L.restScores[i] + this.floor.R.restScores[i]);
    return { ok: !!(this.floor.L && this.floor.R), snr, threshold: autoThreshold(rest) };
  }

  /** One frame: { t, L: {up, down, score, vel}, R: {…}, score, vel }. */
  read(db, t) {
    const f = { t };
    for (const s of ['L', 'R']) {
      slice(db, this.center[s], this.rows[s]);
      f[s] = this.floor[s].read(this.rows[s], this.mpb[s], this.excess[s]);
    }
    f.score = f.L.score + f.R.score;
    f.vel = f.score > 0 ? (f.L.vel * f.L.score + f.R.vel * f.R.score) / f.score : 0;
    return f;
  }
}

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
