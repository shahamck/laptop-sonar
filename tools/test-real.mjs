// Replays a real recording through the sonar pipeline: node tools/test-real.mjs [--verbose]
// Fixture: tools/fixtures/m1-air-session.* (see the .json for how it was made).
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Reader, Recognizer } from '../dsp.js';

const dir = new URL('./fixtures/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('m1-air-session.json', dir)));
const raw = new Int8Array(gunzipSync(readFileSync(new URL('m1-air-session.bin.gz', dir))).buffer.slice(0));
const verbose = process.argv.includes('--verbose');

const { sampleRate, fftSize, span, tones } = meta;
const binHz = sampleRate / fftSize;
const W = 2 * span + 1;
const centers = { L: Math.round(tones.L / binHz), R: Math.round(tones.R / binHz) };

/** Rebuilds a spectrum with each tone's slice at its bin and silence elsewhere. */
function spectrum(i) {
  const db = new Float32Array(fftSize / 2).fill(-150);
  for (const [s, off] of [['L', 0], ['R', W]]) {
    for (let k = -span; k <= span; k++) db[centers[s] + k] = raw[i * 2 * W + off + k + span];
  }
  return db;
}

const time = (i) => meta.t0 + i * meta.dt;
const reader = new Reader({ binHz, tones });
const cal = [];
for (let i = 0; i < meta.frames; i++) {
  const t = time(i);
  if (t >= meta.calibrate[0] && t < meta.calibrate[1]) cal.push(spectrum(i));
}
const c = reader.calibrate(cal);
console.log(`calibrated on ${cal.length} frames · snr L ${c.snr.L.toFixed(0)} dB, R ${c.snr.R.toFixed(0)} dB · threshold ${c.threshold}`);

const rec = new Recognizer({ threshold: c.threshold });
const got = [];
let clicks = 0;
for (let i = 0; i < meta.frames; i++) {
  const f = reader.read(spectrum(i), time(i));
  if (!f.valid) clicks++;
  for (const g of rec.push(f)) got.push(g);
}
for (let i = 1; i <= 150; i++) for (const g of rec.push({ t: time(meta.frames) + i * meta.dt, valid: true, up: 0, down: 0, score: 0 })) got.push(g);
console.log(`${got.length} gestures · ${(100 * clicks / meta.frames).toFixed(0)}% of frames rejected as clicks\n`);

const segOf = (t) => meta.segments.find((s) => t >= s.start && t < s.end);
let pass = 0, fail = 0;
for (const s of meta.segments) {
  const inSeg = got.filter((g) => segOf(g.t) === s);
  const names = inSeg.map((g) => g.name);
  const summary = names.join(', ') || '(none)';
  if (!s.expect) { console.log(`  --  ${s.label.padEnd(12)} ${summary}   (not scored)`); continue; }
  const want = Object.entries(s.expect).flatMap(([n, k]) => Array(k).fill(n));
  const ok = names.length === want.length && want.every((n) => names.filter((x) => x === n).length === s.expect[n]);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${s.label.padEnd(12)} ${summary}   want ${want.join(', ') || '(none)'}`);
}
const outside = got.filter((g) => !segOf(g.t));
if (outside.length) console.log(`\n  (between prompts: ${outside.map((g) => `${g.name}@${g.t.toFixed(1)}s`).join(', ')})`);
if (verbose) for (const g of got) console.log(`  ${g.t.toFixed(2)} ${g.name} ${JSON.stringify(g.stats)} ${segOf(g.t)?.label ?? '-'}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
