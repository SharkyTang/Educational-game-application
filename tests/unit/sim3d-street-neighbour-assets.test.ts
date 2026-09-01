import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import corpus from "../../src/sim3d/streetNeighbourCorpus.json";
import manifest from "../../public/assets/sim3d/audio/street-neighbour-manifest.json";

const ROOT = new URL("../../public/assets/sim3d/", import.meta.url);
const AUDIO_ROOT = new URL("audio/", ROOT);
const PHRASES = Object.entries(corpus.profiles).flatMap(([profileId, scenes]) =>
  Object.entries(scenes).flatMap(([scene, entries]) => entries.map((entry) => ({ profileId, scene, ...entry }))),
);
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
    offset = end + length % 2;
  }
  expect(offset).toBe(data.length);
  return chunks;
}

function glbDocument(data: Buffer): Record<string, any> {
  expect(data.readUInt32LE(0)).toBe(0x46546c67);
  expect(data.readUInt32LE(4)).toBe(2);
  expect(data.readUInt32LE(8)).toBe(data.length);
  const jsonLength = data.readUInt32LE(12);
  expect(data.readUInt32LE(16)).toBe(0x4e4f534a);
  const jsonEnd = 20 + jsonLength;
  expect(data.readUInt32LE(jsonEnd + 4)).toBe(0x004e4942);
  expect(jsonEnd + 8 + data.readUInt32LE(jsonEnd)).toBe(data.length);
  return JSON.parse(data.subarray(20, jsonEnd).toString("utf8").trim());
}

describe("street-neighbour local speech assets", () => {
  it("maps every bilingual corpus line to one profile-specific local WAV", () => {
    expect(manifest.version).toBe(1);
    expect(manifest.generatedBy).toBe("scripts/generate-street-neighbour-speech.py");
    expect(manifest.corpusSource).toBe("src/sim3d/streetNeighbourCorpus.json");
    expect(manifest.corpusVersion).toBe(corpus.version);
    expect(manifest.corpusSha256).toBe(sha256(readFileSync(new URL("../../src/sim3d/streetNeighbourCorpus.json", import.meta.url))));
    expect(manifest.clips).toHaveLength(PHRASES.length);
    expect(new Set(manifest.clips.map((clip) => clip.id)).size).toBe(PHRASES.length);
    expect(manifest.format).toEqual({
      container: "RIFF/WAVE", encoding: "PCM signed 16-bit little endian", sampleRate: 22050, channels: 1,
    });
    for (const profileId of ["sam", "ellis"] as const) {
      const phrases = PHRASES.filter((phrase) => phrase.profileId === profileId);
      const records = manifest.clips.filter((clip) => clip.profileId === profileId);
      expect(records.map((record) => record.id).sort()).toEqual(phrases.map((phrase) => phrase.id).sort());
      expect(readdirSync(new URL(`street-neighbours/${profileId}/`, AUDIO_ROOT)).sort())
        .toEqual(phrases.map((phrase) => `${phrase.id}.wav`).sort());
      for (const phrase of phrases) {
        const record = records.find((candidate) => candidate.id === phrase.id)!;
        expect(record).toMatchObject({
          profileId, scene: phrase.scene, id: phrase.id, text: phrase.text, zh: phrase.zh,
          file: `street-neighbours/${profileId}/${phrase.id}.wav`,
          src: `/assets/sim3d/audio/street-neighbours/${profileId}/${phrase.id}.wav`,
        });
      }
    }
  });

  it.each(manifest.clips)("ships $profileId/$id as audible PCM16 matching its manifest hash", (record) => {
    const data = readFileSync(new URL(record.file, AUDIO_ROOT));
    expect(data.length).toBe(record.bytes);
    expect(record.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256(data)).toBe(record.sha256);
    const chunks = readWaveChunks(data);
    const format = chunks.get("fmt ")!;
    expect(format.readUInt16LE(0)).toBe(1);
    expect(format.readUInt16LE(2)).toBe(1);
    expect(format.readUInt32LE(4)).toBe(22050);
    expect(format.readUInt32LE(8)).toBe(44100);
    expect(format.readUInt16LE(12)).toBe(2);
    expect(format.readUInt16LE(14)).toBe(16);
    const pcm = chunks.get("data")!;
    expect(pcm.length % 2).toBe(0);
    const duration = pcm.length / 44100;
    expect(duration).toBeGreaterThan(.3);
    expect(duration).toBeLessThan(7);
    expect(duration).toBeCloseTo(record.durationSeconds, 3);
    let peak = 0;
    let squareSum = 0;
    for (let index = 0; index < pcm.length; index += 2) {
      const sample = pcm.readInt16LE(index);
      peak = Math.max(peak, Math.abs(sample));
      squareSum += sample * sample;
    }
    const rms = Math.sqrt(squareSum / (pcm.length / 2)) / 32768;
    expect(rms).toBeGreaterThan(.003);
    expect(peak).toBeLessThan(32767);
    expect(20 * Math.log10(peak / 32768)).toBeCloseTo(record.peakDbFS, 2);
    expect(20 * Math.log10(rms)).toBeCloseTo(record.rmsDbFS, 2);
  });

  it("uses the two reviewed public-domain British voices within a separate eight-megabyte budget", () => {
    expect(manifest.profiles.map((profile) => ({ profileId: profile.profileId, voiceId: profile.voiceId }))).toEqual([
      { profileId: "sam", voiceId: "male" }, { profileId: "ellis", voiceId: "female" },
    ]);
    for (const profile of manifest.profiles) {
      expect(profile.modelSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(profile.configSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(profile.modelLicense).toBe("public domain");
      expect(profile.licenseUrl).toBe("https://brycebeattie.com/files/tts/");
    }
    expect(manifest.profiles.find((profile) => profile.profileId === "sam")).toMatchObject({
      modelFile: "mv2.onnx", speakerId: 15, speakerKey: "Martin_Clifton",
    });
    expect(manifest.profiles.find((profile) => profile.profileId === "ellis")).toMatchObject({
      modelFile: "cori-med.onnx", speakerId: null, speakerKey: null,
    });
    const bytes = manifest.clips.reduce((sum, clip) => sum + statSync(new URL(clip.file, AUDIO_ROOT)).size, 0);
    expect(bytes).toBe(manifest.totalBytes);
    expect(bytes).toBe(5_163_356);
    expect(bytes).toBeLessThan(8_000_000);
    const source = readFileSync(new URL("street-neighbour-SOURCES.md", AUDIO_ROOT), "utf8");
    expect(source).toMatch(/synthetic speech/i);
    expect(source).toContain("https://brycebeattie.com/files/tts/");
    expect(source).toContain("Martin_Clifton");
    expect(source).toMatch(/public-domain|public domain/);
    expect(source).toContain("streetNeighbourCorpus.json");
    expect(source).toMatch(/no pleading/i);
  });
});

describe("Patch's reviewed CC0 animated GLB", () => {
  it("ships one small embedded skinned dog with calm idle and retained walk animations", () => {
    const data = readFileSync(new URL("street-dog-patch.glb", ROOT));
    expect(data.length).toBe(125_684);
    expect(data.length).toBeLessThan(256_000);
    expect(sha256(data)).toBe("07ecec966b657ad945d91af942023f8d665e1149b5e8d215089ccf24f293e6fb");
    const gltf = glbDocument(data);
    expect(gltf.asset).toMatchObject({
      version: "2.0",
      generator: "FBX2glTF v0.9.7",
      extras: {
        source: "Quaternius, Animal Pack Vol.2, Dog.fbx",
        license: "CC0-1.0",
        sourceSha256: "a7250b3c68857120e6da0fd9ea2cdb4a4493823b6afed371b7aa9208407af039",
      },
    });
    expect(gltf.scenes).toHaveLength(1);
    expect(gltf.meshes).toHaveLength(1);
    expect(gltf.meshes[0].name).toBe("Dog");
    expect(gltf.meshes[0].primitives).toHaveLength(1);
    expect(gltf.meshes[0].primitives[0].attributes).toHaveProperty("POSITION");
    expect(gltf.skins).toHaveLength(1);
    expect(gltf.skins[0].joints).toHaveLength(24);
    expect(gltf.animations.map((animation: { name: string }) => animation.name).sort()).toEqual(["idle", "walk"]);
    for (const animation of gltf.animations) {
      expect(animation.channels.length).toBeGreaterThan(0);
      expect(animation.samplers.length).toBeGreaterThan(0);
    }
    expect(gltf.buffers).toHaveLength(1);
    expect(gltf.buffers[0].uri).toBeUndefined();
    expect(gltf.images ?? []).toHaveLength(0);
    expect(gltf.materials[0].pbrMetallicRoughness).toMatchObject({ metallicFactor: 0, roughnessFactor: .86 });
  });

  it("records the exact original pack, input hashes, CC0 permission and non-procedural conversion", () => {
    const source = readFileSync(new URL("street-dog-SOURCE.md", ROOT), "utf8");
    const license = readFileSync(new URL("street-dog-LICENSE.txt", ROOT), "utf8");
    expect(source).toContain("https://opengameart.org/content/animated-animales-low-poly");
    expect(source).toContain("https://poly.pizza/m/2kUk0QqpCg");
    expect(source).toContain("https://creativecommons.org/publicdomain/zero/1.0/");
    expect(source).toContain("6d8f6789d65dbdb352ebad98a4209f26b41b384e87d81bc05e9ca76139db1248");
    expect(source).toContain("a7250b3c68857120e6da0fd9ea2cdb4a4493823b6afed371b7aa9208407af039");
    expect(source).toContain("07ecec966b657ad945d91af942023f8d665e1149b5e8d215089ccf24f293e6fb");
    expect(source).toMatch(/not a procedural mesh/i);
    expect(source).toMatch(/No bark, growl/i);
    expect(license).toContain("CC0-1.0");
    expect(license).toContain("Quaternius");
  });
});
