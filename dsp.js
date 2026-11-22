// Sonar signal processing, tuned on a real recording from a MacBook Air (M1).
//
// The page plays two near-ultrasonic tones. A hand moving near the laptop reflects them back to the
// mic with a small frequency shift: higher when the hand approaches, lower when it moves away
// (Δf = 2·v·f / c). With one microphone that radial speed over time is all there is to read, so
// gestures are built from strokes: runs of frames moving one way.
//
// What the recording showed, and what this file does about it:
// - Noise right next to the tone swings by ±11 dB, so a mean + 3σ floor was ~33 dB too high and the
//   detector was nearly deaf. The floor is now the per-bin median plus a fixed margin.
// - Clicks (typing, audio dropouts) light up every bin equally. A real echo sits within ~20 bins of
//   the tone, so frames where the far bins rise are thrown away.
// - Every push is followed by the hand coming back. That return is now swallowed instead of being
//   read as a pull.
// - Pulls start with a slow approach (too slow to see) or a slower one than the pull itself, so an
//   in-stroke followed by a clearly faster out-stroke is a pull.
// - Left/right swipe direction could not be told apart with the mic on one side, so swipes were
//   replaced by a wave (quick back-and-forth).

export const SPEED_OF_SOUND = 343;   // m/s at ~20 °C
export const GUARD = 2;              // bins each side of the carrier left out (window main lobe)
export const NEAR = 20;              // echoes are read out to ±20 bins (~2 m/s)
export const FAR = 26;               // bins ≥ this far out are only used to spot clicks
export const SPAN = 40;              // bins each side of the carrier that are kept
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

function median(xs) {
  const s = Array.from(xs).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/** How far the tone stands above the background further out. Under ~20 dB the mic isn't hearing it. */
export function toneSnr(row) {
  const far = [];
  for (let i = 0; i < WIDTH; i++) if (Math.abs(i - SPAN) >= FAR) far.push(row[i]);
  return row[SPAN] - median(far);
}

/**
 * Turns whole spectra into frames. calibrate() learns the room from spectra taken while nothing
 * moves; read() then gives, per frame, how much echo sits above (approaching) and below (receding)
 * each tone.
 */
export class Reader {
  constructor({ binHz, tones, margin = 10, clickDb = 6 }) {
    this.binHz = binHz;
    this.tones = tones;                                   // { L: freq, R: freq }
    this.margin = margin;                                 // dB above the resting median that counts
    this.clickDb = clickDb;                               // far-bin rise that marks a click
    this.mpb = (metresPerBin(binHz, tones.L) + metresPerBin(binHz, tones.R)) / 2;
    this.center = null;
    this.floor = null;
    this.rows = { L: new Float32Array(WIDTH), R: new Float32Array(WIDTH) };
    this.excess = { L: new Float32Array(WIDTH), R: new Float32Array(WIDTH) };
  }

  locate(db) {
    this.center = { L: findCarrier(db, this.tones.L, this.binHz), R: findCarrier(db, this.tones.R, this.binHz) };
    return this.center;
  }

  /** spectra: dB arrays taken while still. Returns { ok, snr: {L, R}, threshold }. */
  calibrate(spectra) {
    if (spectra.length < 20) return { ok: false };
    this.locate(spectra[Math.floor(spectra.length / 2)]);
    const rows = { L: [], R: [] };
    for (const db of spectra) for (const s of ['L', 'R']) rows[s].push(slice(db, this.center[s]));
    this.floor = {};
    for (const s of ['L', 'R']) {
      const f = new Float32Array(WIDTH);
      for (let i = 0; i < WIDTH; i++) f[i] = median(rows[s].map((r) => r[i]));
      this.floor[s] = f;
    }
    const snr = { L: median(rows.L.map(toneSnr)), R: median(rows.R.map(toneSnr)) };
    const rest = spectra.map((db) => this.read(db, 0)).filter((f) => f.valid).map((f) => f.score).sort((a, b) => a - b);
    const p999 = rest.length ? rest[Math.min(rest.length - 1, Math.floor(rest.length * 0.999))] : 0;
    return { ok: true, snr, threshold: Math.round(Math.max(40, p999 * 2 + 10)) };
  }

  /** One frame: { t, valid, up, down, score, vUp, vDown (m/s), vel (signed m/s), L, R }. */
  read(db, t) {
    const f = { t, up: 0, down: 0 };
    let far = [], mUp = 0, mDown = 0;
    for (const s of ['L', 'R']) {
      const row = slice(db, this.center[s], this.rows[s]);
      const floor = this.floor[s], ex = this.excess[s];
      let up = 0, down = 0;
      for (let k = -SPAN; k <= SPAN; k++) {
        const i = k + SPAN, a = Math.abs(k);
        const rel = row[i] - floor[i];
        if (a >= FAR) { far.push(rel); ex[i] = 0; continue; }
        const e = a > GUARD && a <= NEAR ? Math.max(0, rel - this.margin) : 0;
        ex[i] = e;
        if (k > 0) { up += e; mUp += k * e; } else { down += e; mDown -= k * e; }
      }
      f[s] = { up, down, score: up + down };
      f.up += up; f.down += down;
    }
    f.valid = median(far) < this.clickDb;
    if (!f.valid) { f.up = f.down = 0; }
    f.score = f.up + f.down;
    f.vUp = f.up > 0 ? (mUp / f.up) * this.mpb : 0;
    f.vDown = f.down > 0 ? (mDown / f.down) * this.mpb : 0;
    f.vel = f.score > 0 ? (f.vUp * f.up - f.vDown * f.down) / f.score : 0;
    return f;
  }
}

export const GESTURES = {
  push: { label: 'push', glyph: '↓', hint: 'A quick move of your open hand towards the screen. Bringing it back is ignored.' },
  pull: { label: 'pull', glyph: '↑', hint: 'Bring your hand close slowly, then pull it away fast.' },
  wave: { label: 'wave', glyph: '≈', hint: 'Wave back and forth over the keyboard, 2–3 times, quickly.' },
};

export const DEFAULT_RULES = {
  threshold: 40,    // frame echo energy that counts as motion
  lean: 0.35,       // how one-sided a frame must be to have a direction
  gap: 0.12,        // s of stillness that ends a stroke
  merge: 0.25,      // s: same-direction strokes this close are one stroke
  minStroke: 500,   // stroke energy needed for push / pull (filters typing and fidgeting)
  minWave: 200,     // stroke energy that counts towards a wave
  rest: 0.5,        // s of stillness before an out-stroke for it to be a pull on its own
  ret: 1.2,         // s after a gesture during which the return stroke is ignored
  pair: 0.6,        // s an in-stroke waits for its out-stroke
  ratio: 1.3,       // out-stroke this much faster than the in-stroke → pull
  minSpeed: 0.6,    // m/s the deciding stroke must reach (real gestures: 0.9+, drifting hands: ~0.45)
  fastPush: 0.95,   // m/s: an in-stroke this fast is a push (measured: pushes 1.0–1.1, pull approaches 0.65–0.8)
  waveGuard: 0.2,   // s to wait for an immediate reversal before firing (a wave reverses at once, a push's return comes 0.45 s+ later)
  waveN: 3,         // alternating strokes in a wave
  waveGap: 0.45,    // s allowed between them
};

/**
 * Reads gestures from frames. push(frame) returns an array (usually empty) of { name, … }.
 * Frames must keep arriving while still so that waiting strokes resolve.
 *
 * A stroke that could start a gesture becomes `pending` with a deadline. Strokes that follow quickly
 * are attached to it (an out-stroke after an in-stroke, or a reversal that might be a wave). When
 * the deadline passes with no stroke under way, the pending strokes are decided.
 */
export class Recognizer {
  constructor(rules = {}) {
    this.rules = { ...DEFAULT_RULES, ...rules };
    this.reset();
  }

  reset() {
    this.strokes = [];
    this.cur = null;
    this.pending = null;
    this.swallow = { until: -Infinity, dir: 0 };
    this.lock = -Infinity;
    this.out = [];
  }

  get active() { return !!this.cur || !!this.pending; }

  push(f) {
    const R = this.rules;
    this.out = [];
    if (this.pending && !this.cur && f.t > this.pending.deadline) this.decide(f.t);
    if (!f.valid) return this.out;

    let dir = 0;
    if (f.score > R.threshold) {
      const lean = (f.up - f.down) / f.score;
      dir = lean > R.lean ? 1 : lean < -R.lean ? -1 : 0;
    }
    if (this.cur && (f.t - this.cur.last > R.gap || (dir && dir !== this.cur.dir))) this.close();
    if (dir) {
      if (!this.cur) {
        const p = this.strokes[this.strokes.length - 1];
        if (p && p.dir === dir && f.t - p.last <= R.merge && !p.done) {
          this.strokes.pop();                          // same direction after a blip: carry on
          const P = this.pending;
          if (P?.first === p) this.pending = null;
          else if (P?.second === p) P.second = null;
          else if (P?.third === p) P.third = null;
          this.cur = p;
        } else {
          this.cur = { dir, start: f.t, last: f.t, e: 0, v: 0 };
        }
      }
      const c = this.cur;
      c.last = f.t;
      c.e += f.score;
      c.v = Math.max(c.v, dir > 0 ? f.vUp : f.vDown);
    }
    return this.out;
  }

  close() {
    const R = this.rules, c = this.cur;
    this.cur = null;
    if (c.e < R.minWave) return;
    const prev = this.strokes[this.strokes.length - 1];
    c.gap = prev ? c.start - prev.last : Infinity;
    this.strokes.push(c);
    if (this.strokes.length > 12) this.strokes.shift();

    // Wave: several alternating strokes close together.
    const run = [c];
    for (let i = this.strokes.length - 2; i >= 0; i--) {
      const p = this.strokes[i], q = run[run.length - 1];
      if (q.start - p.last <= R.waveGap && p.dir === -q.dir) run.push(p); else break;
    }
    if (run.length >= R.waveN && c.last > this.lock) {
      this.pending = null;
      for (const s of run) s.done = true;
      this.emit('wave', c.last, { strokes: run.length });
      this.lock = c.last + 0.8;
      return;
    }
    if (c.start < this.lock) { this.lock = Math.max(this.lock, c.last + 0.3); c.done = true; return; }

    const P = this.pending;
    if (P) {
      const last = P.third ?? P.second ?? P.first;
      const quick = c.dir === -last.dir && c.start - last.last <= R.waveGap;
      if (!P.second && P.first.dir > 0 && c.dir < 0 && c.start - P.first.last <= R.pair) {
        P.second = c;                                  // the out-stroke of an in-stroke: push or pull
        P.deadline = c.last + R.waveGap;
        return;
      }
      if (quick && !P.third) {                         // a reversal: maybe the start of a wave
        (P.second ? (P.third = c) : (P.second = c));
        P.deadline = c.last + R.waveGap;
        return;
      }
      this.decide(c.start);
    }

    if (c.done || c.e < R.minStroke) return;
    const swallowing = c.start < this.swallow.until && c.dir === this.swallow.dir;
    if (c.dir > 0) {
      this.pending = { first: c, setup: swallowing, deadline: c.last + (!swallowing && c.v >= R.fastPush ? R.waveGuard : R.pair) };
    } else if (!swallowing && c.gap >= R.rest) {
      this.pending = { first: c, deadline: c.last + R.waveGuard };
    }
  }

  /** Name what's pending: push, or pull if the out-stroke beat the approach (or came on its own). */
  decide(t) {
    const R = this.rules, P = this.pending;
    this.pending = null;
    for (const s of [P.first, P.second, P.third]) if (s) s.done = true;
    const a = P.first, b = P.second;
    if (a.dir < 0) {
      if (a.v < R.minSpeed) return;
      this.emit('pull', t, { vOut: a.v });
      this.swallow = { until: t + R.ret, dir: 1 };
    } else if (b && b.dir < 0 && b.v > a.v * R.ratio) {
      this.emit('pull', t, { vIn: a.v, vOut: b.v });
      this.swallow = { until: t + R.ret, dir: 1 };
    } else if (!P.setup && a.v >= R.minSpeed) {
      this.emit('push', t, { vIn: a.v, vOut: b?.v ?? 0 });
      this.swallow = { until: t + R.ret, dir: -1 };
    }
  }

  emit(name, t, stats) {
    this.out.push({ name, t, ...GESTURES[name], stats: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, +(+v).toFixed(2)])) });
  }
}
