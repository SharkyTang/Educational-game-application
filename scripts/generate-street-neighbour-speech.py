#!/usr/bin/env python3
"""Build Sam and Ellis's local British-English speech with reviewed Piper voices.

Run with the isolated, ignored ``tmp/piper-env`` environment. The script makes
no network calls and writes only the dedicated street-neighbour audio tree and
manifest; the existing customer voice sets are never read or changed.
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
CORPUS = ROOT / "src/sim3d/streetNeighbourCorpus.json"
PROFILE_SCENES = {
    "sam": ("consent", "chat", "needs", "dog", "donationOne", "donationTwo", "alreadyHelped", "noDonation", "outreach"),
    "ellis": ("consent", "chat", "needs", "donationOne", "donationTwo", "alreadyHelped", "noDonation", "outreach"),
}
SAMPLE_RATE = 22050
SEED = 31
SENTENCE_PAUSE_SECONDS = 0.18
AUDIO_BUDGET_BYTES = 8_000_000
MAX_CLIP_SECONDS = 7
PROFILE_SPECS = (
    {
        "profileId": "sam",
        "voiceId": "male",
        "voice": "ManyVoice medium, Martin_Clifton speaker 15, British English male, synthetic",
        "modelFile": "mv2.onnx",
        "sourceUrl": "https://sfo3.digitaloceanspaces.com/bkmdls/mv2.onnx",
        "modelSha256": "3cc7b8f55b82146c09265e909beaa539254a882b9a6ac915792cbfc7d41ba235",
        "configSha256": "1dae6569843412ace557acdc2f2136405219ab75219efb3ddf882af2055a4c1c",
        "speakerId": 15,
        "speakerKey": "Martin_Clifton",
        "lengthScale": 1.12,
        "modelLicense": "public domain",
        "licenseUrl": "https://brycebeattie.com/files/tts/",
    },
    {
        "profileId": "ellis",
        "voiceId": "female",
        "voice": "Cori medium, British English female, synthetic",
        "modelFile": "cori-med.onnx",
        "sourceUrl": "https://sfo3.digitaloceanspaces.com/bkmdls/cori-med.onnx",
        "modelSha256": "1899f98e5fb8310154f3c2973f4b8a929ba7245e722b3d3a85680b833d95f10d",
        "configSha256": "4e4e862c06be95e268cb2edeb18eed39b4fc51c515d808ed3c51404f20e96fea",
        "speakerId": None,
        "speakerKey": None,
        "lengthScale": 1.18,
        "modelLicense": "public domain",
        "licenseUrl": "https://brycebeattie.com/files/tts/",
    },
)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_phrases() -> tuple[dict, dict[str, list[dict[str, str]]]]:
    """Validate the single bilingual corpus and return phrases by profile."""
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    if corpus.get("version") != 1 or set(corpus.get("profiles", {})) != set(PROFILE_SCENES):
        raise ValueError("Expected street-neighbour corpus v1 with exactly Sam and Ellis.")
    result: dict[str, list[dict[str, str]]] = {}
    ids: set[str] = set()
    texts: set[str] = set()
    for profile_id, required_scenes in PROFILE_SCENES.items():
        profile = corpus["profiles"][profile_id]
        if set(profile) != set(required_scenes):
            raise ValueError(f"Unexpected scenes for {profile_id}.")
        phrases = []
        for scene in required_scenes:
            entries = profile[scene]
            if not isinstance(entries, list) or len(entries) < 2:
                raise ValueError(f"The {profile_id}/{scene} scene needs at least two lines.")
            for phrase in entries:
                if not isinstance(phrase, dict) or set(phrase) != {"id", "text", "zh"}:
                    raise ValueError("Each phrase must contain only id, text and zh.")
                if not all(isinstance(value, str) and value.strip() == value and value for value in phrase.values()):
                    raise ValueError("Phrase fields must be nonempty, trimmed strings.")
                phrase_id = phrase["id"]
                normal_text = re.sub(r"[^a-z0-9]+", " ", phrase["text"].lower()).strip()
                if not re.fullmatch(fr"{profile_id}-[a-z]+(?:-[a-z]+)*", phrase_id):
                    raise ValueError(f"Unsafe or incorrectly prefixed phrase id: {phrase_id}")
                if phrase_id in ids or normal_text in texts:
                    raise ValueError(f"Duplicate phrase id or spoken text: {phrase_id}")
                if not re.search(r"[A-Za-z]", phrase["text"]) or not re.search(r"[\u3400-\u9fff]", phrase["zh"]):
                    raise ValueError(f"Missing English or Chinese caption: {phrase_id}")
                ids.add(phrase_id)
                texts.add(normal_text)
                phrases.append({"profileId": profile_id, "scene": scene, **phrase})
        result[profile_id] = phrases
    return corpus, result


def prepare_pcm(raw_wav: bytes) -> np.ndarray:
    """Conservatively trim silence, cap gain and add tiny edge fades."""
    with wave.open(io.BytesIO(raw_wav), "rb") as wav:
        if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (SAMPLE_RATE, 1, 2):
            raise ValueError("Expected 22,050 Hz mono signed 16-bit PCM.")
        samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float64) / 32768.0
    if not len(samples) or not np.all(np.isfinite(samples)):
        raise ValueError("The synthesizer returned no valid audio.")
    peak = float(np.max(np.abs(samples)))
    if peak < 0.01:
        raise ValueError("The synthesizer returned silence or near-silence.")
    active = np.flatnonzero(np.abs(samples) > max(0.001, peak * 0.005))
    start = max(0, int(active[0]) - round(SAMPLE_RATE * 0.09))
    end = min(len(samples), int(active[-1]) + round(SAMPLE_RATE * 0.18) + 1)
    samples = samples[start:end].copy()
    samples *= min(2.5, 10 ** (-3 / 20) / peak)
    fade = min(round(SAMPLE_RATE * 0.004), len(samples) // 2)
    if fade:
        samples[:fade] *= np.linspace(0, 1, fade)
        samples[-fade:] *= np.linspace(1, 0, fade)
    return np.round(np.clip(samples, -0.999, 0.999) * 32767).astype("<i2")


def synthesize(voice: PiperVoice, phrase: dict, spec: dict) -> tuple[bytes, dict]:
    synthesis = SynthesisConfig(
        speaker_id=spec["speakerId"],
        length_scale=spec["lengthScale"],
        noise_scale=0.667,
        noise_w_scale=0.8,
        normalize_audio=False,
    )
    with io.BytesIO() as raw:
        with wave.open(raw, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(SAMPLE_RATE)
            for index, chunk in enumerate(voice.synthesize(phrase["text"], syn_config=synthesis)):
                if (chunk.sample_rate, chunk.sample_channels, chunk.sample_width) != (SAMPLE_RATE, 1, 2):
                    raise ValueError("Unexpected synthesizer format.")
                if index:
                    wav.writeframes(bytes(round(SAMPLE_RATE * SENTENCE_PAUSE_SECONDS) * 2))
                wav.writeframes(chunk.audio_int16_bytes)
        pcm = prepare_pcm(raw.getvalue())
    duration = len(pcm) / SAMPLE_RATE
    rms = float(np.sqrt(np.mean((pcm.astype(np.float64) / 32768) ** 2)))
    if not 0.3 < duration < MAX_CLIP_SECONDS or rms < 0.003:
        raise ValueError(f"Invalid duration or too quiet: {phrase['id']}")
    with io.BytesIO() as output:
        with wave.open(output, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(SAMPLE_RATE)
            wav.writeframes(pcm.tobytes())
        data = output.getvalue()
    file = f"street-neighbours/{spec['profileId']}/{phrase['id']}.wav"
    return data, {
        **phrase,
        "voiceId": spec["voiceId"],
        "file": file,
        "src": f"/assets/sim3d/audio/{file}",
        "bytes": len(data),
        "durationSeconds": round(duration, 3),
        "sha256": sha256(data),
        "peakDbFS": round(float(20 * np.log10(np.max(np.abs(pcm.astype(np.float64))) / 32768)), 2),
        "rmsDbFS": round(float(20 * np.log10(rms)), 2),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", type=Path, default=ROOT / "tmp/piper-models")
    parser.add_argument("--output", type=Path, default=ROOT / "public/assets/sim3d/audio")
    args = parser.parse_args()
    corpus, phrases_by_profile = read_phrases()
    if importlib.metadata.version("piper-tts") != "1.7.0":
        raise ValueError("Install piper-tts==1.7.0 in an isolated environment before regenerating.")

    records = []
    payloads = []
    total_bytes = 0
    for spec in PROFILE_SPECS:
        model = (args.models / spec["modelFile"]).resolve()
        config = Path(str(model) + ".json")
        if file_sha256(model) != spec["modelSha256"] or file_sha256(config) != spec["configSha256"]:
            raise ValueError(f"The {spec['profileId']} model/config differs from the reviewed release.")
        settings = json.loads(config.read_text(encoding="utf-8"))
        if settings["audio"]["sample_rate"] != SAMPLE_RATE:
            raise ValueError("Unexpected model sample rate.")
        if spec["speakerKey"] is not None and settings.get("speaker_id_map", {}).get(spec["speakerKey"]) != spec["speakerId"]:
            raise ValueError("The reviewed male speaker identity no longer matches the model.")
        ort.set_seed(SEED)
        voice = PiperVoice.load(model, config_path=config, use_cuda=False)
        for phrase in phrases_by_profile[spec["profileId"]]:
            data, record = synthesize(voice, phrase, spec)
            payloads.append((record["file"], data))
            records.append(record)
            total_bytes += record["bytes"]
            if total_bytes >= AUDIO_BUDGET_BYTES:
                raise ValueError("Street-neighbour speech exceeded the 8 MB download budget.")
            print(f"Generated {record['file']}: {record['durationSeconds']:.3f}s, {record['bytes']} bytes", flush=True)

    manifest = {
        "version": 1,
        "generatedBy": "scripts/generate-street-neighbour-speech.py",
        "corpusSource": "src/sim3d/streetNeighbourCorpus.json",
        "corpusVersion": corpus["version"],
        "corpusSha256": file_sha256(CORPUS),
        "profiles": list(PROFILE_SPECS),
        "piperVersion": importlib.metadata.version("piper-tts"),
        "onnxruntimeVersion": ort.__version__,
        "numpyVersion": np.__version__,
        "seed": SEED,
        "sentencePauseSeconds": SENTENCE_PAUSE_SECONDS,
        "format": {
            "container": "RIFF/WAVE",
            "encoding": "PCM signed 16-bit little endian",
            "sampleRate": SAMPLE_RATE,
            "channels": 1,
        },
        "totalBytes": total_bytes,
        "clips": records,
    }
    for file, data in payloads:
        path = args.output / file
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    manifest_path = args.output / "street-neighbour-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Total: {len(records)} clips, {total_bytes:,} bytes. Existing customer audio unchanged.")


if __name__ == "__main__":
    main()
