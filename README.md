# Laptop Sonar (web)

Wave at your laptop to control it, with no camera. The speakers play two near-ultrasonic tones
(18.6 kHz from the left speaker, 19.8 kHz from the right). The built-in mic hears them bounce off your hand.
A hand moving towards the screen raises the echo's pitch; one moving away lowers it (Doppler: Δf = 2·v·f/c).
The left and right tones reflect at different moments as your hand sweeps across, and that timing gives the
swipe direction. Everything runs in the browser.

## Run

```bash
cd ~/website/laptop-sonar && python3 -m http.server 8644
```

Open http://localhost:8644 in Chrome (or Safari). Use the **built-in speakers and mic**: AirPods or other
Bluetooth headphones swap the mic and the tone never reaches it. Turn the Mac's volume up to about half.

`?sim` (or **No mic? Simulate**) runs on synthetic echoes. Keys 1–5 fire the five gestures, which is useful
for testing without a mic.

## Gestures

| Gesture | Do this | How it's read |
|---|---|---|
| ← swipe left / → swipe right | sweep across the keyboard 5–15 cm up | both tones disturbed, one ≥ 60 ms before the other |
| ↓ push | move your hand towards the screen | mostly upshifted echo |
| ↑ pull | draw your hand back | mostly downshifted echo |
| ● tap | quick in-and-out jab | both, approach first |

Every gesture also fires a `sonargesture` DOM event (`e.detail.gesture`, `e.detail.stats`).

If swipes come out backwards on your Mac, tick **flip L/R** (it depends on where the mic sits relative to the
speakers). If one tone has a weak echo, your speakers may be mono: untick **one tone per speaker**. Swipes
then can't be told apart, but push, pull and tap still work.

## Control other apps

A browser tab can't press keys in other apps, so `bridge.py` does it (Python 3, no packages):

```bash
python3 bridge.py
```

Then tick **send gestures to the helper**. Swipes press ← / →, tap presses space, push and pull press ⌘+ / ⌘−.
Edit `KEYS` in `bridge.py` to remap. macOS asks you to allow your terminal under Privacy & Security ›
Accessibility the first time. The helper listens on 127.0.0.1 only, accepts only the five gesture names, and
only from the origins in `ALLOWED_ORIGINS`. Add your deployed URL there if you host the page.

Keep the sonar tab open while you use Keynote or a video. Chrome doesn't throttle tabs that are playing audio.

## Files

- `dsp.js`: carrier location, rest calibration (per-bin noise floor), Doppler features, segmenter, gesture rules.
- `synth.js`: synthetic spectra for the simulator and tests.
- `app.js`: Web Audio tones and mic, ASCII waterfall, meter, deck, bridge client.
- `bridge.py`: local helper that presses keys.
- `tools/test-dsp.mjs`: `node tools/test-dsp.mjs` runs the pipeline on synthetic gestures at 44.1 and 48 kHz.

## Limits

- The tests use a modelled echo, not a real room. The thresholds will need tuning on real hardware: use
  **Recalibrate**, the trigger slider, and the gap/bal/lean numbers in the log.
- Some people (mostly younger) can hear 18–19 kHz as a faint whine. Raise the tone if so. Pets can hear it.
- Typing and moving the laptop can trigger push/pull. Stop the sonar while you type.
