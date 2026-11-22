// Laptop Sonar: tone out, mic in, Doppler read, gestures out.
import { Reader, Recognizer, GESTURES, SPAN, GUARD } from './dsp.js';
import { SpectrumSynth, SIM_GESTURES } from './synth.js';

const $ = (id) => document.getElementById(id);
const FFT = 4096;
const TICK_MS = 20;               // ~50 frames a second; timers keep running in audible tabs
const SETTLE_S = 0.5;             // let the tone fade in before learning the room
const CAL_S = 1.5;
const TONE_GAP = 1200;            // Hz between the two tones
const HISTORY = 64;               // waterfall rows kept
const SHOW = 24;                  // bins each side of a tone drawn in the waterfall
const RAMP = ' .·:-=+*#%@';

// ---------- settings ----------
const DEFAULTS = { base: 18600, volume: 0.25, threshold: 40, minStroke: 500, bridge: false };
const BRIDGE_URL = 'http://127.0.0.1:8650';
const settings = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('sonar.settings.v2') || '{}');
    return { ...DEFAULTS, ...saved };
  } catch { return { ...DEFAULTS }; }
})();
function save() { try { localStorage.setItem('sonar.settings.v2', JSON.stringify(settings)); } catch {} }

// ---------- state ----------
let audio = null;                 // { ctx, analyser, stream, osc: [], gains: [] }
let synth = null;                 // set in simulate mode
let buf = null;
let reader = null;
let rec = null;
let mode = 'off';                 // off | settling | calibrating | live
let phaseUntil = 0;
let calSpectra = [];
let timer = null;
let lastFrame = null;
const fall = [];                  // { L: Float32Array, R: Float32Array }
const meterHist = [];             // { up, down, valid }
let total = 0;
const counts = Object.fromEntries(Object.keys(GESTURES).map((k) => [k, 0]));

const t0 = performance.now();
const now = () => (performance.now() - t0) / 1000;

function tones() {
  const nyq = (audio?.ctx.sampleRate ?? 48000) / 2;
  const L = Math.min(settings.base, nyq - TONE_GAP - 1500);
  return { L, R: L + TONE_GAP };
}

// ---------- start / stop ----------
async function start(simulate = false) {
  $('startBtn').disabled = $('simBtn').disabled = true;
  setWarn('');
  try {
    if (simulate) {
      synth = new SpectrumSynth({ bins: FFT / 2, sampleRate: 48000, fftSize: FFT, tones: tones(), seed: 3 });
      buf = new Float32Array(FFT / 2);
      buildSimBar();
    } else {
      // Create the context inside the click so Safari lets it start.
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      await ctx.resume();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      audio = { ctx, stream, osc: [], gains: [] };
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT;
      analyser.smoothingTimeConstant = 0;
      ctx.createMediaStreamSource(stream).connect(analyser);
      audio.analyser = analyser;
      buf = new Float32Array(analyser.frequencyBinCount);
      buildTones();
      checkDevice(stream);
    }
    $('stageEmpty').hidden = true;
    $('stopBtn').disabled = $('calBtn').disabled = false;
    timer = setInterval(tick, TICK_MS);
    calibrate();
    requestAnimationFrame(draw);
  } catch (err) {
    console.error(err);
    stop();
    setWarn(err?.name === 'NotAllowedError'
      ? 'Microphone access was blocked. Allow it in the address bar and try again.'
      : `Couldn't start: ${err?.message ?? err}`);
  }
}

/** Both tones from both speakers: on a MacBook Air the right speaker alone reached the mic 20 dB weaker. */
function buildTones() {
  const { ctx } = audio;
  audio.osc.forEach((o) => { try { o.stop(); } catch {} o.disconnect(); });
  audio.gains.forEach((g) => g.disconnect());
  const f = tones();
  audio.osc = []; audio.gains = [];
  for (const freq of [f.L, f.R]) {
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(settings.volume, ctx.currentTime, 0.08);   // fade in: no click
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    audio.osc.push(osc); audio.gains.push(gain);
  }
}

function checkDevice(stream) {
  const label = stream.getAudioTracks()[0]?.label ?? '';
  if (/airpods|bluetooth|beats|headset|hands-free/i.test(label)) {
    setWarn(`The mic in use is "${label}". Sonar needs the laptop's built-in mic and speakers, so disconnect headphones or pick the MacBook mic in the address bar.`);
  }
}

function stop() {
  clearInterval(timer); timer = null;
  if (audio) {
    audio.stream?.getTracks().forEach((t) => t.stop());
    audio.ctx.close().catch(() => {});
    audio = null;
  }
  synth = null;
  mode = 'off';
  fall.length = meterHist.length = 0;
  $('simBar').hidden = true;
  $('simBar').querySelectorAll('button').forEach((b) => b.remove());
  $('stageEmpty').hidden = false;
  $('hold').hidden = true;
  $('startBtn').disabled = $('simBtn').disabled = false;
  $('stopBtn').disabled = $('calBtn').disabled = true;
  setStatus('off');
  $('readout').textContent = '> sonar off_';
}

// ---------- calibration ----------
function calibrate() {
  reader = new Reader({ binHz: (audio?.ctx.sampleRate ?? 48000) / FFT, tones: tones() });
  rec = null;
  calSpectra = [];
  mode = 'settling';
  phaseUntil = now() + SETTLE_S;
  $('hold').hidden = false;
  setStatus('calibrating');
}

function finishCalibration() {
  const cal = reader.calibrate(calSpectra);
  calSpectra = [];
  $('hold').hidden = true;
  if (!cal.ok) { setWarn('Calibration failed. Try again.'); calibrate(); return; }
  settings.threshold = cal.threshold;
  save();
  syncControls();
  rec = new Recognizer({ threshold: settings.threshold, minStroke: settings.minStroke });
  mode = 'live';
  const snr = Math.max(cal.snr.L, cal.snr.R);
  if (snr < 25) {
    setWarn(`The mic can barely hear the tones (${snr.toFixed(0)} dB). Turn the Mac's volume up, use the built-in speakers and mic, or lower the tone.`);
    setStatus('weak echo', 'warn');
  } else {
    setWarn('');
    setStatus('listening', 'on');
  }
  $('toneInfo').textContent = `${(reader.tones.L / 1000).toFixed(1)} + ${(reader.tones.R / 1000).toFixed(1)} kHz · snr ${snr.toFixed(0)} dB`;
}

// ---------- per-frame work ----------
function tick() {
  const t = now();
  const db = synth ? synth.frame(t, buf) : (audio.analyser.getFloatFrequencyData(buf), buf);

  if (mode === 'settling' || mode === 'calibrating') {
    pushRaw(db);
    if (mode === 'settling' && t >= phaseUntil) { mode = 'calibrating'; phaseUntil = t + CAL_S; }
    else if (mode === 'calibrating') {
      calSpectra.push(db.slice());
      if (t >= phaseUntil) finishCalibration();
    }
    return;
  }
  if (mode !== 'live') return;

  const f = reader.read(db, t);
  lastFrame = f;
  fall.unshift({ L: reader.excess.L.slice(), R: reader.excess.R.slice(), click: !f.valid });
  if (fall.length > HISTORY) fall.pop();
  meterHist.push({ up: f.up, down: f.down });
  if (meterHist.length > 240) meterHist.shift();

  for (const g of rec.push(f)) onGesture(g);
}

/** Before calibration there is no floor yet: show level relative to the carrier. */
function pushRaw(db) {
  reader.locate(db);
  const row = (s) => {
    const c = reader.center[s], top = db[c], out = new Float32Array(2 * SPAN + 1);
    for (let k = -SPAN; k <= SPAN; k++) out[k + SPAN] = Math.abs(k) <= GUARD ? 0 : Math.max(0, db[c + k] - (top - 80)) * 0.3;
    return out;
  };
  fall.unshift({ L: row('L'), R: row('R') });
  if (fall.length > HISTORY) fall.pop();
}

// ---------- gestures ----------
function onGesture(g) {
  total++;
  counts[g.name]++;
  $('gCount').textContent = `${total} read`;
  const card = document.querySelector(`.gest[data-name="${g.name}"]`);
  if (card) {
    card.classList.remove('hit'); void card.offsetWidth; card.classList.add('hit');
    card.querySelector('output').textContent = counts[g.name];
  }
  flash(g);
  log(g);
  deckGesture(g.name);
  if (settings.bridge) sendToBridge(g.name);
  window.dispatchEvent(new CustomEvent('sonargesture', { detail: { gesture: g.name, stats: g.stats } }));
}

let flashTimer = 0;
function flash(g) {
  $('flashGlyph').textContent = g.glyph;
  $('flashLabel').textContent = g.label;
  $('flash').classList.add('show');
  $('stage').classList.add('hit');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { $('flash').classList.remove('show'); $('stage').classList.remove('hit'); }, 380);
}

function log(g) {
  const ol = $('log');
  ol.querySelector('.empty-log')?.remove();
  const li = document.createElement('li');
  const time = new Date().toLocaleTimeString([], { hour12: false });
  const s = g.stats;
  const detail = g.name === 'wave' ? `${s.strokes} strokes`
    : [s.vIn ? `in ${s.vIn.toFixed(2)} m/s` : '', s.vOut ? `out ${s.vOut.toFixed(2)} m/s` : ''].filter(Boolean).join(' · ');
  li.innerHTML = `<span>${time}</span><b>${g.glyph} ${g.label}</b><i>${detail}</i>`;
  ol.prepend(li);
  while (ol.children.length > 8) ol.lastChild.remove();
}

function buildGestureList() {
  const ul = $('gestures');
  for (const [name, g] of Object.entries(GESTURES)) {
    const li = document.createElement('li');
    li.className = 'gest';
    li.dataset.name = name;
    li.innerHTML = `<span class="glyph">${g.glyph}</span><span><b>${g.label}</b><small>${g.hint}</small></span><output>0</output>`;
    ul.append(li);
  }
}

function buildSimBar() {
  const bar = $('simBar');
  bar.hidden = false;
  SIM_GESTURES.forEach((name, i) => {
    const b = document.createElement('button');
    b.className = 'btn small';
    b.textContent = `${i + 1} ${GESTURES[name].glyph} ${GESTURES[name].label}`;
    b.addEventListener('click', () => synth?.play(name, now()));
    bar.append(b);
  });
}

// ---------- drawing ----------
function fit(canvas) {
  const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  return { w, h, dpr };
}

let lastReadout = 0;
function draw() {
  if (mode === 'off') return;
  drawFall();
  drawMeter();
  const t = performance.now();
  if (t - lastReadout > 70) { lastReadout = t; readout(); }
  requestAnimationFrame(draw);
}

function drawFall() {
  const canvas = $('fall'), ctx = canvas.getContext('2d');
  const { w, h } = fit(canvas);
  const css = getComputedStyle(document.documentElement);
  const blue = css.getPropertyValue('--blue').trim(), line = css.getPropertyValue('--line').trim();
  const width = SHOW * 2 + 1, gapCols = 3, cols = width * 2 + gapCols;
  const cw = w / cols, fs = cw / 0.6;
  const lh = fs * 1.05, rows = Math.min(Math.floor(h / lh), fall.length);
  ctx.clearRect(0, 0, w, h);
  ctx.font = `${fs}px "JetBrains Mono", ui-monospace, monospace`;
  ctx.textBaseline = 'top';
  for (let r = 0; r < rows; r++) {
    const row = fall[r];
    const fade = 1 - (r / Math.max(rows, 1)) * 0.75;
    ['L', 'R'].forEach((s, side) => {
      const x0 = side * (width + gapCols) * cw;
      const vals = row[s];
      for (let k = -SHOW; k <= SHOW; k++) {
        let ch, color = blue, alpha = fade;
        if (Math.abs(k) <= GUARD) { ch = k === 0 ? '|' : ':'; color = line; alpha = 1; }
        else if (row.click) { if (k % 6) continue; ch = '~'; color = line; alpha = 1; }
        else {
          const lvl = Math.min(1, vals[k + SPAN] / 24);
          if (lvl <= 0.02) continue;
          ch = RAMP[Math.max(1, Math.round(lvl * (RAMP.length - 1)))];
        }
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.fillText(ch, x0 + (k + SHOW) * cw, r * lh);
      }
    });
  }
  ctx.globalAlpha = 1;
}

function drawMeter() {
  const canvas = $('meter'), ctx = canvas.getContext('2d');
  const { w, h, dpr } = fit(canvas);
  const css = getComputedStyle(document.documentElement);
  const ink = css.getPropertyValue('--ink').trim(), blue = css.getPropertyValue('--blue').trim(), muted = css.getPropertyValue('--muted').trim();
  ctx.clearRect(0, 0, w, h);
  if (!rec) return;
  const thr = settings.threshold;
  let peak = 0;
  for (const m of meterHist) peak = Math.max(peak, m.up, m.down);
  const top = Math.max(thr * 2.5, peak * 1.1, 1);
  const y = (v) => h - Math.min(1, v / top) * (h - 6 * dpr) - 3 * dpr;
  const n = 240, dx = w / (n - 1), off = n - meterHist.length;
  const plot = (key, color) => {
    ctx.beginPath();
    meterHist.forEach((m, i) => { const X = (i + off) * dx, Y = y(m[key]); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
    ctx.strokeStyle = color; ctx.lineWidth = 1.5 * dpr; ctx.stroke();
  };
  plot('down', ink);
  plot('up', blue);
  ctx.setLineDash([5 * dpr, 4 * dpr]);
  ctx.beginPath(); ctx.moveTo(0, y(thr)); ctx.lineTo(w, y(thr));
  ctx.strokeStyle = muted; ctx.lineWidth = dpr; ctx.stroke();
  ctx.setLineDash([]);
  ctx.font = `${10 * dpr}px "JetBrains Mono", monospace`;
  ctx.fillStyle = blue; ctx.fillText('■ toward', 6 * dpr, 13 * dpr);
  ctx.fillStyle = ink; ctx.fillText('■ away', 70 * dpr, 13 * dpr);
}

function readout() {
  const el = $('readout');
  if (mode !== 'live' || !lastFrame) { el.textContent = '> hold still · learning the room_'; return; }
  const f = lastFrame;
  if (!f.valid) { el.innerHTML = '&gt; click or tap noise · ignored'; return; }
  const v = f.score > settings.threshold ? f.vel : 0;
  const n = 10, x = Math.max(-1, Math.min(1, v / 1.2)), k = Math.round(Math.abs(x) * n);
  const left = x < 0 ? '░'.repeat(n - k) + '█'.repeat(k) : '░'.repeat(n);
  const right = x > 0 ? '█'.repeat(k) + '░'.repeat(n - k) : '░'.repeat(n);
  const sign = v >= 0 ? '+' : '−';
  el.innerHTML = `&gt; away ${left}|${right} toward  <b>${sign}${Math.abs(v).toFixed(2)} m/s</b>  motion <b>${Math.round(f.score)}</b>/${settings.threshold}${rec?.active ? '  ● reading' : ''}`;
}

// ---------- demo deck ----------
const SLIDES = [
  { title: 'Push to begin', art: String.raw`
    _.-._
   | | | |_
   | | | | |
   | | | | |    )))
 _ |  '-._ |  )))))
 \'\`  .--' ) ))))))
  \  '    /    )))
   \     /
    '---'` },
  { title: 'Ultrasound, ~19 kHz', art: String.raw`
  speaker ))) ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ )))  hand
     mic  ((( ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ (((  echo
          |<------------  5 – 30 cm  ---------->|` },
  { title: 'Doppler does the rest', art: String.raw`
  toward  ->  |  . : = # @ # = : .          pitch up
  still   ->  .  :  =  #|#  =  :  .          no shift
  away    ->     . : = # @ # = : . |         pitch down` },
  { title: 'Push, pull, wave', art: String.raw`
   push   fast in .............. slow out   = next
   pull   slow in .............. fast out   = back
   wave   in-out-in-out, quick              = invert` },
  { title: 'No camera. Just sound.', art: String.raw`
   01100010 01101001 01110100
       ______________________
      |  ))   b1t studios  ((|
      |______________________|
       \  [][][][][][][][]  /
        \__________________/` },
];
let slideIdx = 0;

function renderSlide(dir = 0) {
  const s = $('slide');
  const apply = () => {
    $('slideArt').textContent = SLIDES[slideIdx].art.replace(/^\n/, '');
    $('slideTitle').textContent = SLIDES[slideIdx].title;
    $('deckPos').textContent = `${slideIdx + 1} / ${SLIDES.length}`;
  };
  if (!dir) { apply(); return; }
  s.classList.add(dir > 0 ? 'out-left' : 'out-right');
  setTimeout(() => { apply(); s.classList.remove('out-left', 'out-right'); }, 180);
}

function deckGesture(name) {
  if (name === 'push') { slideIdx = (slideIdx + 1) % SLIDES.length; renderSlide(1); }
  else if (name === 'pull') { slideIdx = (slideIdx - 1 + SLIDES.length) % SLIDES.length; renderSlide(-1); }
  else if (name === 'wave') $('deck').classList.toggle('invert');
}

// ---------- mac bridge ----------
let bridgePing = null;
async function sendToBridge(gesture) {
  try {
    const r = await fetch(`${BRIDGE_URL}/gesture`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gesture }),
    });
    setBridge(r.ok ? 'sent' : `error ${r.status}`, r.ok ? 'on' : 'warn');
  } catch { setBridge('not running', 'warn'); }
}

async function pingBridge() {
  try {
    const r = await fetch(`${BRIDGE_URL}/ping`, { cache: 'no-store' });
    setBridge(r.ok ? 'connected' : `error ${r.status}`, r.ok ? 'on' : 'warn');
  } catch { setBridge('not running', 'warn'); }
}

function setBridge(text, cls = '') {
  const p = $('bridgeStatus');
  p.textContent = text;
  p.className = `pill ${cls}`;
}

function toggleBridge(on) {
  settings.bridge = on; save();
  clearInterval(bridgePing);
  if (on) { pingBridge(); bridgePing = setInterval(pingBridge, 4000); }
  else setBridge('off');
}

// ---------- controls ----------
function setStatus(text, cls = '') { const p = $('status'); p.textContent = text; p.className = `pill ${cls}`; }
function setWarn(text) { $('warn').textContent = text; }

function syncControls() {
  $('base').value = settings.base; $('baseOut').textContent = `${(settings.base / 1000).toFixed(1)} kHz`;
  $('vol').value = settings.volume; $('volOut').textContent = `${Math.round(settings.volume * 100)}%`;
  $('thr').value = settings.threshold; $('thrOut').textContent = settings.threshold;
  $('stroke').value = settings.minStroke; $('strokeOut').textContent = settings.minStroke;
  $('bridgeToggle').checked = settings.bridge;
}

let recalTimer = 0;
function retune() {
  clearTimeout(recalTimer);
  recalTimer = setTimeout(() => {
    if (mode === 'off') return;
    if (audio) buildTones();
    if (synth) synth.tones = tones();
    calibrate();
  }, 500);
}

function wire() {
  $('startBtn').addEventListener('click', () => start(false));
  $('simBtn').addEventListener('click', () => start(true));
  $('stopBtn').addEventListener('click', stop);
  $('calBtn').addEventListener('click', calibrate);

  $('base').addEventListener('input', (e) => { settings.base = +e.target.value; save(); syncControls(); retune(); });
  $('vol').addEventListener('input', (e) => {
    settings.volume = +e.target.value; save(); syncControls();
    if (audio) for (const g of audio.gains) g.gain.setTargetAtTime(settings.volume, audio.ctx.currentTime, 0.05);
    retune();
  });
  $('thr').addEventListener('input', (e) => {
    settings.threshold = +e.target.value; save(); syncControls();
    if (rec) rec.rules.threshold = settings.threshold;
  });
  $('stroke').addEventListener('input', (e) => {
    settings.minStroke = +e.target.value; save(); syncControls();
    if (rec) rec.rules.minStroke = settings.minStroke;
  });
  $('bridgeToggle').addEventListener('change', (e) => toggleBridge(e.target.checked));

  // Keyboard: arrows drive the deck for comparison; 1–3 fire simulated gestures.
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input')) return;
    const n = +e.key;
    if (synth && n >= 1 && n <= SIM_GESTURES.length) synth.play(SIM_GESTURES[n - 1], now());
    if (document.activeElement === $('deck')) {
      if (e.key === 'ArrowRight') deckGesture('push');
      if (e.key === 'ArrowLeft') deckGesture('pull');
    }
  });

  if (!navigator.mediaDevices?.getUserMedia) {
    $('startBtn').disabled = true;
    $('startNote').textContent = 'This page needs HTTPS or localhost to use the microphone.';
  }
}

buildGestureList();
syncControls();
renderSlide();
wire();
if (settings.bridge) toggleBridge(true);
if (new URLSearchParams(location.search).has('sim')) start(true);
