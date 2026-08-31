import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import corpus from "../../src/sim3d/customerCorpus.json";
import manifest from "../../public/assets/sim3d/audio/customer-phrase-manifest.json";
import legacyManifest from "../../public/assets/sim3d/audio/phrase-manifest.json";

const AUDIO_ROOT = new URL("../../public/assets/sim3d/audio/", import.meta.url);
const VOICES = ["female", "male"] as const;
const SCENES = ["greeting", "checkout", "thanks", "checkoutCash", "tenderCash"] as const;
const SCENE_ID_PREFIX = { greeting: "greeting", checkout: "checkout", thanks: "thanks", checkoutCash: "checkout-cash", tenderCash: "tender-cash" } as const;
const PHRASES = SCENES.flatMap((scene) => corpus.scenes[scene].map((phrase) => ({ scene, ...phrase })));
const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

function readWaveChunks(data: Buffer): Map<string, Buffer> {
  expect(data.length).toBeGreaterThanOrEqual(44);
  expect(data.toString("ascii", 0, 4)).toBe("RIFF");
  expect(data.toString("ascii", 8, 12)).toBe("WAVE");
  expect(data.readUInt32LE(4) + 8).toBe(data.length);
  const chunks = new Map<string, Buffer>();
  let offset = 12;
  while (offset < data.length) {
    expect(offset + 8).toBeLessThanOrEqual(data.length);
    const id = data.toString("ascii", offset, offset + 4);
    const length = data.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    expect(end).toBeLessThanOrEqual(data.length);
    expect(chunks.has(id), `duplicate WAV chunk ${id}`).toBe(false);
    chunks.set(id, data.subarray(offset + 8, end));
    offset = end + (length % 2);
  }
  expect(offset).toBe(data.length);
  expect(chunks.has("fmt ")).toBe(true);
  expect(chunks.has("data")).toBe(true);
  return chunks;
}

/** File/data checks, not a claim of subjective naturalness or browser playback. */
describe("scene-based customer corpus and two bundled voice sets", () => {
  it("keeps one versioned, bilingual source with unique stable phrase IDs and texts", () => {
    expect(corpus.version).toBe(1);
    expect(Object.keys(corpus).sort()).toEqual(["scenes", "version"]);
    expect(Object.keys(corpus.scenes).sort()).toEqual([...SCENES].sort());
    expect(corpus.scenes.greeting.length).toBeGreaterThanOrEqual(8);
    expect(corpus.scenes.checkout.length).toBeGreaterThanOrEqual(12);
    expect(corpus.scenes.thanks.length).toBeGreaterThanOrEqual(8);
    expect(corpus.scenes.checkoutCash.length).toBeGreaterThanOrEqual(4);
    expect(corpus.scenes.tenderCash).toHaveLength(3);
    expect(new Set(PHRASES.map((phrase) => phrase.id)).size).toBe(PHRASES.length);
    const normalTexts = PHRASES.map((phrase) => phrase.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
    expect(new Set(normalTexts).size).toBe(PHRASES.length);
    for (const { scene, ...phrase } of PHRASES) {
      expect(Object.keys(phrase).sort()).toEqual(["id", "text", "zh"]);
      expect(phrase.id).toMatch(new RegExp(`^${SCENE_ID_PREFIX[scene]}-[a-z]+(?:-[a-z]+)*$`));
      expect(phrase.text).toBe(phrase.text.trim());
      expect(phrase.text).toMatch(/[A-Za-z]/);
      expect(phrase.zh).toBe(phrase.zh.trim());
      expect(phrase.zh).toMatch(/\p{Script=Han}/u);
    }
    for (const existingText of [
      "Hello!", "Can I pay by card, please?", "Sorry, can I pay by card?", "Thank you. Have a lovely day!",
    ]) {
      expect(PHRASES.filter((phrase) => phrase.text === existingText)).toHaveLength(1);
    }
  });

  it("separates card and cash requests, describes only implemented tenders, and avoids premature goodbyes", () => {
    for (const phrase of corpus.scenes.checkout) {
      expect(phrase.text).toMatch(/\bcard\b/i);
      expect(phrase.text).not.toMatch(/\b(cash|change|receipt|bag|discount|refund)\b/i);
      expect(phrase.text).not.toMatch(/\b(thank|thanks|cheers|goodbye)\b/i);
    }
    for (const phrase of corpus.scenes.checkoutCash) {
      expect(phrase.text).toMatch(/\bcash\b/i);
      expect(phrase.text).not.toMatch(/\b(card|change|receipt|bag|discount|refund)\b/i);
      expect(phrase.text).not.toMatch(/\b(thank|thanks|cheers|goodbye)\b/i);
    }
    expect(corpus.scenes.tenderCash.map((phrase) => phrase.text)).toEqual([
      "Here's five pounds.", "Here's ten pounds.", "I have the exact amount.",
    ]);
    for (const phrase of corpus.scenes.greeting) {
      expect(phrase.text).not.toMatch(/\b(morning|afternoon|evening|night|goodbye|cheers|thanks)\b/i);
    }
  });

  it("maps every phrase to exactly one female and one male local clip", () => {
    expect(manifest.version).toBe(1);
    expect(manifest.corpusSource).toBe("src/sim3d/customerCorpus.json");
    expect(manifest.corpusVersion).toBe(corpus.version);
    const corpusFile = readFileSync(new URL("../../src/sim3d/customerCorpus.json", import.meta.url));
    expect(manifest.corpusSha256).toBe(sha256(corpusFile));
    expect(manifest.clips).toHaveLength(PHRASES.length * VOICES.length);
    expect(new Set(manifest.clips.map((clip) => clip.file)).size).toBe(manifest.clips.length);
    expect(new Set(manifest.clips.map((clip) => clip.src)).size).toBe(manifest.clips.length);
    expect(manifest.format).toEqual({
      container: "RIFF/WAVE", encoding: "PCM signed 16-bit little endian", sampleRate: 22050, channels: 1,
    });
    for (const voiceId of VOICES) {
      const records = manifest.clips.filter((clip) => clip.voiceId === voiceId);
      expect(records.map((clip) => clip.id).sort()).toEqual(PHRASES.map((phrase) => phrase.id).sort());
      expect(readdirSync(new URL(`customers/${voiceId}/`, AUDIO_ROOT)).sort())
        .toEqual(PHRASES.map((phrase) => `${phrase.id}.wav`).sort());
      for (const phrase of PHRASES) {
        const matches = records.filter((clip) => clip.id === phrase.id);
        expect(matches).toHaveLength(1);
        const record = matches[0]!;
        expect(record.scene).toBe(phrase.scene);
        expect(record.text).toBe(phrase.text);
        expect(record.zh).toBe(phrase.zh);
        expect(record.file).toBe(`customers/${voiceId}/${phrase.id}.wav`);
        expect(record.src).toBe(`/assets/sim3d/audio/${record.file}`);
      }
    }
  });

  it.each(manifest.clips)("ships $voiceId/$id as valid, audible PCM16 with matching hash and levels", (record) => {
    const path = new URL(record.file, AUDIO_ROOT);
    expect(statSync(path).isFile()).toBe(true);
    const data = readFileSync(path);
    expect(data.length).toBe(record.bytes);
    expect(record.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256(data)).toBe(record.sha256);
    const chunks = readWaveChunks(data);
    const format = chunks.get("fmt ")!;
    expect(format.length).toBeGreaterThanOrEqual(16);
    expect(format.readUInt16LE(0)).toBe(1);
    expect(format.readUInt16LE(2)).toBe(1);
    expect(format.readUInt32LE(4)).toBe(22050);
    expect(format.readUInt32LE(8)).toBe(22050 * 2);
    expect(format.readUInt16LE(12)).toBe(2);
    expect(format.readUInt16LE(14)).toBe(16);
    const pcm = chunks.get("data")!;
    expect(pcm.length % 2).toBe(0);
    const duration = pcm.length / (22050 * 2);
    expect(duration).toBeGreaterThan(0.3);
    expect(duration).toBeLessThan(6);
    expect(duration).toBeCloseTo(record.durationSeconds, 3);
    let peak = 0;
    let squareSum = 0;
    for (let index = 0; index < pcm.length; index += 2) {
      const sample = pcm.readInt16LE(index);
      peak = Math.max(peak, Math.abs(sample));
      squareSum += sample * sample;
    }
    const rms = Math.sqrt(squareSum / (pcm.length / 2)) / 32768;
    expect(rms).toBeGreaterThan(0.003);
    expect(peak).toBeLessThan(32767);
    expect(20 * Math.log10(peak / 32768)).toBeCloseTo(record.peakDbFS, 2);
    expect(20 * Math.log10(rms)).toBeCloseTo(record.rmsDbFS, 2);
  });

  it("uses distinct reviewed model/speaker identities and never duplicates a female clip as male", () => {
    expect(manifest.voices.map((voice) => voice.id).sort()).toEqual([...VOICES].sort());
    const female = manifest.voices.find((voice) => voice.id === "female")!;
    const male = manifest.voices.find((voice) => voice.id === "male")!;
    expect(female.modelFile).toBe("cori-med.onnx");
    expect(male.modelFile).toBe("mv2.onnx");
    expect(female.modelSha256).not.toBe(male.modelSha256);
    expect(male.speakerId).toBe(15);
    expect(male.speakerKey).toBe("Martin_Clifton");
    for (const voice of manifest.voices) {
      expect(voice.modelSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(voice.configSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(voice.modelLicense).toBe("public domain");
      expect(voice.licenseUrl).toBe("https://brycebeattie.com/files/tts/");
    }
    for (const phrase of PHRASES) {
      const records = manifest.clips.filter((clip) => clip.id === phrase.id);
      expect(new Set(records.map((clip) => clip.sha256)).size).toBe(VOICES.length);
    }
  });

  it("keeps both complete voice sets under eight megabytes without shipping a model or runtime", () => {
    const bytes = manifest.clips.reduce((sum, clip) => sum + statSync(new URL(clip.file, AUDIO_ROOT)).size, 0);
    expect(bytes).toBe(manifest.totalBytes);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(8_000_000);
    expect(readdirSync(new URL("customers/", AUDIO_ROOT)).sort()).toEqual([...VOICES].sort());
    expect(manifest.generatedBy).toBe("scripts/generate-customer-speech.py");
    const source = readFileSync(new URL("customer-phrase-SOURCES.md", AUDIO_ROOT), "utf8");
    expect(source).toMatch(/synthetic\s+speech/);
    expect(source).toContain("https://brycebeattie.com/files/tts/");
    expect(source).toContain("Martin_Clifton");
    expect(source).toContain("public domain");
    expect(source).toContain("customerCorpus.json");
  });

  it("preserves the eight legacy phrase clips and their original manifest unchanged", () => {
    const originalManifest = readFileSync(new URL("phrase-manifest.json", AUDIO_ROOT));
    expect(sha256(originalManifest)).toBe("f56d695c419fdf9263008f576491c2bf745416e82e7cd311e6a8c7f230a5aa48");
    expect(legacyManifest.clips).toHaveLength(8);
    for (const clip of legacyManifest.clips) {
      expect(sha256(readFileSync(new URL(clip.file, AUDIO_ROOT)))).toBe(clip.sha256);
    }
  });

  it("preserves all 56 original customer recordings byte-for-byte when extending the corpus", () => {
    const originalScenes = new Set(["greeting", "checkout", "thanks"]);
    const original = manifest.clips.filter((clip) => originalScenes.has(clip.scene));
    expect(original).toHaveLength(56);
    const records = original.map(({ voiceId, id, file }) => ({ voiceId, id, sha256: sha256(readFileSync(new URL(file, AUDIO_ROOT))) }))
      .sort((a, b) => `${a.voiceId}/${a.id}`.localeCompare(`${b.voiceId}/${b.id}`));
    expect(sha256(Buffer.from(JSON.stringify(records)))).toBe("c7703f3aa6d83e28b813481684e49edd272c238fa725c5f5320aafec23eda37f");
  });
});
