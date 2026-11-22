# Laptop Sonar (web)

Control your laptop by moving your hand at it, with no camera. The speakers play two near-ultrasonic tones
(18.6 and 19.8 kHz). The built-in mic hears them bounce off your hand: a hand moving towards the screen
raises the echo's pitch, and one moving away lowers it (Doppler: Δf = 2·v·f/c). Everything runs in the browser.

## Run

```bash
cd ~/website/laptop-sonar && python3 -m http.server 8644
```

Open http://localhost:8644 in Chrome (or Safari) and press **Start sonar**. Keep still for two seconds
while it learns the room. Use the **built-in speakers and mic**: AirPods or other Bluetooth headphones
swap the mic, and the tone never reaches it. Turn the Mac's volume to about half or more.

`?sim` (or **No mic? Simulate**) runs on synthetic echoes. Keys 1–3 fire the gestures.

## Gestures

| Gesture | Do this | What the mic sees | Deck | Mac helper |
|---|---|---|---|---|
| ↓ push | a quick move of your open hand towards the screen | fast in-stroke (the hand coming back is ignored) | next | → |
| ↑ pull | bring your hand close slowly, then pull it away fast | out-stroke faster than the approach | back | ← |
| ≈ wave | back and forth over the keyboard, 2–3 times, quickly | 3+ alternating strokes | invert | space |

Every gesture also fires a `sonargesture` DOM event (`e.detail.gesture`, `e.detail.stats`).

### Why these three

With one microphone, all the laptop can measure is how fast your hand moves towards or away from it.
Push, pull and wave are the gestures that show up differently in that one number. The first version
also had swipe left/right, worked out from the time difference between a tone in each speaker.
Measured on a MacBook Air (M1), that difference came out at ±0.1 s with a random sign, so it was
dropped. A tap is a push as far as the mic can tell.

## How it was tuned

`tools/fixtures/m1-air-session.*` is a real 80-second recording from a MacBook Air (M1): a voice
prompted push, pull, swipes, taps, typing and stillness. It showed what the first version got wrong:

- **Noise next to the tone swings by about ±11 dB.** A mean + 3σ floor sat ~33 dB too high, so real
  echoes were missed. The floor is now the per-bin median plus 10 dB.
- **Clicks (typing, audio glitches) raise every bin.** Real echoes stay within ~2 m/s of the tone, so
  frames whose far bins rise are dropped.
- **Every push is followed by the hand coming back.** The first version read that return as a pull.
  The return is now ignored.
- **Pushes come in at 1.0–1.1 m/s; pull approaches at 0.65–0.8 m/s.** A fast approach fires a push
  ~0.2 s after it ends. A slow one waits for the out-stroke and becomes a pull if that's faster.
- **The right speaker alone reached the mic 20 dB weaker than the left.** Both tones now play from both
  speakers.

```bash
node tools/test-real.mjs     # replays the real recording: 3/3 push, 3/3 pull, taps → pull, nothing while still or typing
node tools/test-dsp.mjs      # synthetic push / pull / wave at 44.1 and 48 kHz
```

The recording has no wave in it (the gesture came out of it), so wave is only checked on synthetic
data so far. `tools/probe.html` measures speaker/mic response and records a guided session in the browser.

## Tuning on your Mac

- **Trigger**: the echo level that counts as movement, set by calibration (the dashed line on the meter).
- **Stroke size**: raise it if typing or shifting in your seat triggers gestures; lower it if pushes are missed.
- **Tone**: if you can hear a whine, go higher. Some speakers fade above ~20 kHz. Pets can hear it.

## Control other apps

A browser tab can't press keys in other apps, so `bridge.py` does it (Python 3, no packages):

```bash
python3 bridge.py
```

Then tick **send gestures to the helper**. Edit `KEYS` in `bridge.py` to remap. macOS asks you to allow
your terminal under Privacy & Security › Accessibility the first time. The helper listens on 127.0.0.1
only, accepts only the three gesture names, and only from the origins in `ALLOWED_ORIGINS`. Add your
deployed URL there if you host the page.

Keep the sonar tab open while you use Keynote or a video. Chrome doesn't throttle tabs that are playing audio.

## Files

- `dsp.js`: carrier location, median floor, click rejection, Doppler features, stroke recogniser.
- `synth.js`: synthetic spectra for the simulator and tests.
- `app.js`: Web Audio tones and mic, ASCII waterfall, meter, deck, bridge client.
- `bridge.py`: local helper that presses keys.
- `tools/`: tests, the real-recording fixture, and the probe page.
