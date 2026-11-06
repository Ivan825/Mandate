# Narration for the demo video: Kokoro (open-weights TTS) via kokoro-onnx.
#   python3 scripts/demo-tts.py lines.json outdir [voice] [speed]
# lines.json: [{"id": "...", "text": "..."}, ...] → outdir/<id>.wav and outdir/durations.json
# Model files (~350 MB) are fetched once from the kokoro-onnx GitHub release into ~/.cache/kokoro-onnx.
import sys, json, os, hashlib, urllib.request, pathlib
import soundfile as sf
from kokoro_onnx import Kokoro

lines = json.load(open(sys.argv[1]))
outdir = pathlib.Path(sys.argv[2]); outdir.mkdir(parents=True, exist_ok=True)
voice = sys.argv[3] if len(sys.argv) > 3 else "af_heart"
speed = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
cache = pathlib.Path(os.environ.get("KOKORO_DIR", pathlib.Path.home() / ".cache" / "kokoro-onnx")); cache.mkdir(parents=True, exist_ok=True)
REL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
for f in ("kokoro-v1.0.onnx", "voices-v1.0.bin"):
    if not (cache / f).exists():
        print("downloading", f, file=sys.stderr); urllib.request.urlretrieve(REL + f, cache / f)
k = Kokoro(str(cache / "kokoro-v1.0.onnx"), str(cache / "voices-v1.0.bin"))
durations = {}
for l in lines:
    key = hashlib.sha1(f"{voice}|{speed}|{l['text']}".encode()).hexdigest()[:10]
    wav = outdir / f"{l['id']}.wav"; meta = outdir / f"{l['id']}.key"
    if not wav.exists() or not meta.exists() or meta.read_text() != key:
        samples, sr = k.create(l["text"], voice=voice, speed=speed, lang="en-us")
        sf.write(wav, samples, sr); meta.write_text(key)
    info = sf.info(wav); durations[l["id"]] = info.frames / info.samplerate
json.dump(durations, open(outdir / "durations.json", "w"), indent=1)
print(json.dumps(durations))
