#!/usr/bin/env python3
"""Build the customer corpus's two local synthetic voice sets with Piper.

Run from the isolated, ignored tmp/piper-env environment. Model downloads and
permissions are documented in customer-phrase-SOURCES.md. This authoring script
makes no network calls; only newly generated WAV files ship with the game.
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
CORPUS = ROOT / "src/sim3d/customerCorpus.json"
SCENES = ("greeting", "checkout", "thanks", "checkoutCash", "tenderCash")
SAMPLE_RATE = 22050
SEED = 31
SENTENCE_PAUSE_SECONDS = 0.18
AUDIO_BUDGET_BYTES = 8_000_000
MAX_CLIP_SECONDS = 6
VOICE_SPECS = (
    {
        "id": "female",
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
    {
        "id": "male",
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
)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_phrases() -> tuple[dict, list[dict[str, str]]]:
    """JSON is canonical for captions and synthesis; no second text list."""
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    if corpus.get("version") != 1 or set(corpus.get("scenes", {})) != set(SCENES):
        raise ValueError(f"Expected corpus v1 with exactly these scenes: {', '.join(SCENES)}.")
    phrases = []
    ids: set[str] = set()
    texts: set[str] = set()
    for scene in SCENES:
        entries = corpus["scenes"][scene]
        if not isinstance(entries, list) or not entries:
            raise ValueError(f"The {scene} scene must have phrases.")
        for phrase in entries:
            if not isinstance(phrase, dict) or set(phrase) != {"id", "text", "zh"}:
                raise ValueError("Each phrase must contain only id, text and zh.")
            if not all(isinstance(value, str) and value.strip() == value and value for value in phrase.values()):
                raise ValueError("Phrase fields must be nonempty, trimmed strings.")
            phrase_id = phrase["id"]
            normal_text = re.sub(r"[^a-z0-9]+", " ", phrase["text"].lower()).strip()
            if not re.fullmatch(r"[a-z]+(?:-[a-z]+)*", phrase_id):
                raise ValueError(f"Unsafe or non-kebab phrase id: {phrase_id}")
            if phrase_id in ids or normal_text in texts:
                raise ValueError(f"Duplicate phrase id or spoken text: {phrase_id}")
            if not re.search(r"[A-Za-z]", phrase["text"]) or not re.search(r"[\u3400-\u9fff]", phrase["zh"]):
                raise ValueError(f"Missing English or Chinese caption: {phrase_id}")
            ids.add(phrase_id)
            texts.add(normal_text)
            phrases.append({"scene": scene, **phrase})
    return corpus, phrases


def prepare_pcm(raw_wav: bytes) -> np.ndarray:
    """Use the legacy authoring tool's conservative edge trimming and gain."""
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
        raise ValueError(f"Invalid duration or too quiet: {spec['id']}/{phrase['id']}")
    with io.BytesIO() as output:
        with wave.open(output, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(SAMPLE_RATE)
            wav.writeframes(pcm.tobytes())
        data = output.getvalue()
    file = f"customers/{spec['id']}/{phrase['id']}.wav"
    return data, {
        **phrase,
        "voiceId": spec["id"],
        "file": file,
        "src": f"/assets/sim3d/audio/{file}",
        "bytes": len(data),
        "durationSeconds": round(duration, 3),
        "sha256": sha256(data),
        "peakDbFS": round(float(20 * np.log10(np.max(np.abs(pcm.astype(np.float64))) / 32768)), 2),
        "rmsDbFS": round(float(20 * np.log10(rms)), 2),
    }


def reusable_clips(output: Path, phrases: list[dict[str, str]]) -> dict[tuple[str, str], dict]:
    """Preserve reviewed clips byte-for-byte; refuse stale text or changed files."""
    source = json.loads((output / "customer-phrase-manifest.json").read_text(encoding="utf-8"))
    if (source.get("version") != 1 or source.get("corpusVersion") != 1
            or source.get("voices") != list(VOICE_SPECS) or source.get("seed") != SEED
            or source.get("sentencePauseSeconds") != SENTENCE_PAUSE_SECONDS
            or source.get("piperVersion") != importlib.metadata.version("piper-tts")
            or source.get("onnxruntimeVersion") != ort.__version__ or source.get("numpyVersion") != np.__version__):
        raise ValueError("Existing voice/authoring settings differ; explicitly review a full regeneration.")
    entries = {phrase["id"]: phrase for phrase in phrases}
    voices = {spec["id"] for spec in VOICE_SPECS}
    records = {}
    for record in source.get("clips", []):
        voice_id, phrase_id = record.get("voiceId"), record.get("id")
        phrase = entries.get(phrase_id)
        key = (voice_id, phrase_id)
        if voice_id not in voices or phrase is None or key in records:
            raise ValueError("Existing manifest contains unknown, retired or duplicate clips; review it first.")
        if any(record.get(field) != phrase[field] for field in ("id", "scene", "text")):
            raise ValueError(f"Existing captions changed for {voice_id}/{phrase_id}; review regeneration first.")
        expected_file = f"customers/{voice_id}/{phrase_id}.wav"
        if record.get("file") != expected_file or record.get("src") != f"/assets/sim3d/audio/{expected_file}":
            raise ValueError(f"Unexpected existing clip path: {voice_id}/{phrase_id}")
        data = (output / expected_file).read_bytes()
        if len(data) != record.get("bytes") or sha256(data) != record.get("sha256"):
            raise ValueError(f"Existing clip differs from its reviewed hash: {expected_file}")
        # Translation-only edits do not change what the existing English clip says.
        records[key] = {**record, "zh": phrase["zh"]}
    if not records or source.get("totalBytes") != sum(record["bytes"] for record in records.values()):
        raise ValueError("Existing manifest has no clips or its total bytes do not match.")
    return records


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--models", type=Path, default=ROOT / "tmp/piper-models")
    parser.add_argument("--output", type=Path, default=ROOT / "public/assets/sim3d/audio")
    parser.add_argument("--reuse-existing", action="store_true",
                        help="Verify and preserve existing manifested clips; synthesize only new phrases.")
    args = parser.parse_args()
    corpus, phrases = read_phrases()
    if importlib.metadata.version("piper-tts") != "1.7.0":
        raise ValueError("Install piper-tts==1.7.0 in an isolated environment before regenerating.")
    models = []
    for spec in VOICE_SPECS:
        model = (args.models / spec["modelFile"]).resolve()
        config = Path(str(model) + ".json")
        if file_sha256(model) != spec["modelSha256"] or file_sha256(config) != spec["configSha256"]:
            raise ValueError(f"The {spec['id']} model/config differs from the reviewed release.")
        settings = json.loads(config.read_text(encoding="utf-8"))
        if settings["audio"]["sample_rate"] != SAMPLE_RATE:
            raise ValueError("Unexpected model sample rate.")
        if spec["speakerKey"] is not None and settings.get("speaker_id_map", {}).get(spec["speakerKey"]) != spec["speakerId"]:
            raise ValueError("The reviewed male speaker identity no longer matches the model.")
        models.append((spec, model, config))

    existing = reusable_clips(args.output, phrases) if args.reuse_existing else {}
    # Generate and validate the entire batch before touching published clips.
    # Only customers/ and customer-phrase-manifest.json are ever written.
    results = []
    payloads = []
    total_bytes = 0
    for spec, model, config in models:
        voice = None
        for phrase in phrases:
            record = existing.get((spec["id"], phrase["id"]))
            if record is None:
                if voice is None:
                    ort.set_seed(SEED)
                    voice = PiperVoice.load(model, config_path=config, use_cuda=False)
                data, record = synthesize(voice, phrase, spec)
                payloads.append((record["file"], data))
                action = "Generated"
            else:
                action = "Reused"
            results.append(record)
            total_bytes += record["bytes"]
            if total_bytes >= AUDIO_BUDGET_BYTES:
                raise ValueError("Customer speech exceeded the 8 MB download budget; review the corpus/settings.")
            print(f"{action} {record['file']}: {record['durationSeconds']:.3f}s, {record['bytes']} bytes", flush=True)
    manifest = {
        "version": 1,
        "generatedBy": "scripts/generate-customer-speech.py",
        "corpusSource": "src/sim3d/customerCorpus.json",
        "corpusVersion": corpus["version"],
        "corpusSha256": file_sha256(CORPUS),
        "voices": list(VOICE_SPECS),
        "piperVersion": importlib.metadata.version("piper-tts"),
        "onnxruntimeVersion": ort.__version__,
        "numpyVersion": np.__version__,
        "seed": SEED,
        "sentencePauseSeconds": SENTENCE_PAUSE_SECONDS,
        "format": {"container": "RIFF/WAVE", "encoding": "PCM signed 16-bit little endian", "sampleRate": SAMPLE_RATE, "channels": 1},
        "totalBytes": total_bytes,
        "clips": results,
    }
    args.output.mkdir(parents=True, exist_ok=True)
    for file, data in payloads:
        path = args.output / file
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    (args.output / "customer-phrase-manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8",
    )
    print(f"Total: {len(phrases)} phrases, {len(results)} clips ({len(payloads)} new), {total_bytes:,} bytes. Legacy audio unchanged.")


if __name__ == "__main__":
    main()
