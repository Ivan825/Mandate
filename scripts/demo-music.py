# Generates the demo's background bed: a slow, warm synth pad over a soft
# chord progression. Deterministic, royalty-free by construction.
#   python3 scripts/demo-music.py <seconds> <out.wav>
import sys, numpy as np, soundfile as sf
dur, out = float(sys.argv[1]), sys.argv[2]
sr = 44100
t_total = int(dur * sr)
rng = np.random.default_rng(7)

def note(f): return f
A = 220.0
def midi(n): return 440.0 * 2 ** ((n - 69) / 12)
# Am9 – Fmaj7 – Cmaj9 – G6, 8 s each, looping.
chords = [[57, 64, 67, 71, 74], [53, 60, 64, 69, 72], [48, 55, 64, 67, 74], [55, 62, 66, 71, 76]]
bar = 8.0
bars = int(np.ceil(dur / bar)) + 1

def pad(freq, length, sr):
    t = np.arange(int(length * sr)) / sr
    # three slightly detuned oscillators: sine + soft triangle for warmth
    s = np.zeros_like(t)
    for d in (-0.35, 0.0, 0.35):
        f = freq * 2 ** (d / 1200)
        s += np.sin(2 * np.pi * f * t) * 0.55
        tri = 2 * np.abs(2 * ((t * f) % 1) - 1) - 1
        s += tri * 0.12
    # slow attack / release envelope
    env = np.minimum(1, t / 2.2) * np.minimum(1, (length - t) / 2.6)
    return s * env

mix = np.zeros(t_total + int(bar * sr) * 2)
for b in range(bars):
    ch = chords[b % len(chords)]
    start = int(b * bar * sr)
    seg = np.zeros(int((bar + 1.5) * sr))
    for i, n in enumerate(ch):
        gain = 0.9 if i == 0 else 0.6
        seg += pad(midi(n), bar + 1.5, sr) * gain
    # a sub an octave below the root
    t = np.arange(len(seg)) / sr
    seg += np.sin(2 * np.pi * midi(ch[0] - 12) * t) * 0.5 * np.minimum(1, t / 2.5) * np.minimum(1, (bar + 1.5 - t) / 3)
    mix[start:start + len(seg)] += seg
mix = mix[:t_total]

# Softening (low-pass, a touch of room) is applied by ffmpeg in the video script.
left = mix
right = np.concatenate([np.zeros(int(0.012 * sr)), mix[:-int(0.012 * sr)]])
stereo = np.stack([left * 0.96 + right * 0.04, right * 0.96 + left * 0.04], axis=1)
# fade in/out and normalise to a quiet bed
fade = int(3 * sr)
stereo[:fade] *= np.linspace(0, 1, fade)[:, None]
stereo[-fade:] *= np.linspace(1, 0, fade)[:, None]
stereo /= (np.abs(stereo).max() + 1e-9)
stereo *= 0.5
sf.write(out, stereo.astype(np.float32), sr)
print(out, dur)
