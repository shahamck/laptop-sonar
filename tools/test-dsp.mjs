// Offline check of the sonar pipeline against synthetic spectra: node tools/test-dsp.mjs
import { Reader, Segmenter, classify } from '../dsp.js';
import { SpectrumSynth, SIM_GESTURES } from '../synth.js';

const tones = { L: 18600, R: 19800 };
let pass = 0, fail = 0;

for (const sampleRate of [44100, 48000]) {
  const fftSize = 4096, dt = 0.02;
  const synth = new SpectrumSynth({ bins: fftSize / 2, sampleRate, fftSize, tones, seed: 7 });
  const reader = new Reader({ binHz: sampleRate / fftSize, tones });

  let t = 0;
  const still = [];
  for (let i = 0; i < 75; i++, t += dt) still.push(synth.frame(t));
  const cal = reader.calibrate(still);
  console.log(`\n${sampleRate} Hz  snr L ${cal.snr.L.toFixed(1)} dB  R ${cal.snr.R.toFixed(1)} dB  threshold ${cal.threshold}`);

  const seg = new Segmenter({ threshold: cal.threshold });
  // Quiet stretch: must not trigger.
  let falseHits = 0;
  for (let i = 0; i < 250; i++, t += dt) if (seg.push(reader.read(synth.frame(t), t))) falseHits++;
  report(`no false triggers at rest (${falseHits})`, falseHits === 0);

  for (const name of SIM_GESTURES) {
    for (let rep = 0; rep < 3; rep++) {
      synth.play(name, t);
      const got = [];
      for (let i = 0; i < 70; i++, t += dt) {
        const out = seg.push(reader.read(synth.frame(t), t));
        if (out) got.push(classify(out));
      }
      const names = got.map((g) => g.name).join(',') || '(none)';
      report(`${name.padEnd(11)} → ${names.padEnd(11)} ${got[0] ? JSON.stringify(got[0].stats) : ''}`,
        got.length === 1 && got[0].name === name);
    }
  }
}

function report(msg, ok) {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
