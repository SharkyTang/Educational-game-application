#!/usr/bin/env python3
"""Generate the shop's short, local British-English WAV clips with Piper.

This is an offline build-time tool, not a game/server dependency. Obtain the
separately licensed model as documented in phrase-SOURCES.md; no network calls
or platform/system speech voices are used by this script.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import io
import json
import re
import wave
from pathlib import Path

import numpy as np
import onnxruntime as ort
from piper import PiperVoice, SynthesisConfig


ROOT = Path(__file__).resolve().parents[1]
MODEL_SHA256 = "1899f98e5fb8310154f3c2973f4b8a929ba7245e722b3d3a85680b833d95f10d"
CONFIG_SHA256 = "4e4e862c06be95e268cb2edeb18eed39b4fc51c515d808ed3c51404f20e96fea"
SOURCE_URL = "https://sfo3.digitaloceanspaces.com/bkmdls/cori-med.onnx"
SAMPLE_RATE = 22050
SEED = 31
LENGTH_SCALE = 1.24
SENTENCE_PAUSE_SECONDS = 0.22


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_clips() -> list[dict[str, str]]:
    """The UI's text/path list is canonical: never synthesize a stale copy."""
    source = (ROOT / "src/sim3d/speechClips.ts").read_text(encoding="utf-8")
    matches = re.findall(
        r'^  (\w+): \{\s+text: ("(?:[^"\\]|\\.)*"),'
        r'\s+zh: ("(?:[^"\\]|\\.)*"),\s+src: ("(?:[^"\\]|\\.)*"),\s+\}',
        source,
        flags=re.MULTILINE,
    )
    if len(matches) != 8:
        raise ValueError("Expected the eight speechClips.ts entries; review a changed format before regenerating.")
    clips = []
    for key, text, zh, src in matches:
        uri = json.loads(src)
        filename = Path(uri).name
        if uri != f"/assets/sim3d/audio/{filename}" or not filename.endswith(".wav"):
            raise ValueError(f"Unexpected output path for {key}: {uri}")
        clips.append({"id": key, "text": json.loads(text), "zh": json.loads(zh), "file": filename})
    return clips


def prepare_pcm(raw_wav: bytes) -> np.ndarray:
    with wave.open(io.BytesIO(raw_wav), "rb") as wav:
        if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (SAMPLE_RATE, 1, 2):
            raise ValueError("Expected 22,050 Hz mono signed 16-bit PCM from Cori medium.")
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float64) / 32768.0
    if not len(samples) or not np.all(np.isfinite(samples)):
        raise ValueError("The synthesizer returned no valid audio.")
    peak = float(np.max(np.abs(samples)))
    if peak < 0.01:
        raise ValueError("The synthesizer returned silence or near-silence.")
    # Remove only excess leading/trailing silence; keep space around quiet
    # consonants, and do not shorten pauses inside a spoken sentence.
    active = np.flatnonzero(np.abs(samples) > max(0.001, peak * 0.005))
    start = max(0, int(active[0]) - round(SAMPLE_RATE * 0.09))
    end = min(len(samples), int(active[-1]) + round(SAMPLE_RATE * 0.18) + 1)
    samples = samples[start:end].copy()
    # Consistent, unclipped headroom without imposing dynamic compression.
    samples *= min(2.5, 10 ** (-3 / 20) / peak)
    fade = min(round(SAMPLE_RATE * 0.004), len(samples) // 2)
    if fade:
        samples[:fade] *= np.linspace(0, 1, fade)
        samples[-fade:] *= np.linspace(1, 0, fade)
    return np.round(np.clip(samples, -0.999, 0.999) * 32767).astype("<i2")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, default=ROOT / "tmp/piper-models/cori-med.onnx")
    parser.add_argument("--output", type=Path, default=ROOT / "public/assets/sim3d/audio")
    args = parser.parse_args()
    model = args.model.resolve()
    config = Path(str(model) + ".json")
    if sha256(model) != MODEL_SHA256 or sha256(config) != CONFIG_SHA256:
        raise ValueError("Model/config checksum differs from the reviewed Cori release; do not silently replace it.")
    if importlib.metadata.version("piper-tts") != "1.7.0":
        raise ValueError("Install piper-tts==1.7.0 in an isolated environment before regenerating.")
    ort.set_seed(SEED)
    voice = PiperVoice.load(model, config_path=config, use_cuda=False)
    synthesis = SynthesisConfig(length_scale=LENGTH_SCALE, noise_scale=0.667, noise_w_scale=0.8, normalize_audio=False)
    args.output.mkdir(parents=True, exist_ok=True)
    results = []
    total_bytes = 0
    for clip in read_clips():
        with io.BytesIO() as memory:
            with wave.open(memory, "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(SAMPLE_RATE)
                for index, chunk in enumerate(voice.synthesize(clip["text"], syn_config=synthesis)):
                    if (chunk.sample_rate, chunk.sample_channels, chunk.sample_width) != (SAMPLE_RATE, 1, 2):
                        raise ValueError("Unexpected synthesizer format.")
                    if index:
                        wav.writeframes(bytes(round(SAMPLE_RATE * SENTENCE_PAUSE_SECONDS) * 2))
                    wav.writeframes(chunk.audio_int16_bytes)
            pcm = prepare_pcm(memory.getvalue())
        path = args.output / clip["file"]
        with wave.open(str(path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(SAMPLE_RATE)
            wav.writeframes(pcm.tobytes())
        result = {
            **clip,
            "bytes": path.stat().st_size,
            "durationSeconds": round(len(pcm) / SAMPLE_RATE, 3),
            "sha256": sha256(path),
            "peakDbFS": round(float(20 * np.log10(np.max(np.abs(pcm.astype(np.float64))) / 32768)), 2),
            "rmsDbFS": round(float(20 * np.log10(np.sqrt(np.mean((pcm.astype(np.float64) / 32768) ** 2)))), 2),
        }
        results.append(result)
        total_bytes += result["bytes"]
        print(f'{clip["file"]}: {result["durationSeconds"]:.3f}s, {result["bytes"]} bytes')
    if total_bytes > 1_000_000:
        raise ValueError("The eight phrase clips exceeded the 1 MB audio budget; review settings.")
    manifest = {
        "generatedBy": "scripts/generate-speech-clips.py",
        "voice": "Cori medium, British English female, synthetic",
        "sourceUrl": SOURCE_URL,
        "modelSha256": MODEL_SHA256,
        "configSha256": CONFIG_SHA256,
        "piperVersion": importlib.metadata.version("piper-tts"),
        "onnxruntimeVersion": ort.__version__,
        "numpyVersion": np.__version__,
        "seed": SEED,
        "lengthScale": LENGTH_SCALE,
        "sentencePauseSeconds": SENTENCE_PAUSE_SECONDS,
        "format": {"container": "RIFF/WAVE", "encoding": "PCM signed 16-bit little endian", "sampleRate": SAMPLE_RATE, "channels": 1},
        "totalBytes": total_bytes,
        "clips": results,
    }
    (args.output / "phrase-manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Total: {total_bytes:,} bytes. No runtime or model is copied into the public directory.")


if __name__ == "__main__":
    main()
