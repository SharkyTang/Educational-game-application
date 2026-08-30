import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SPEECH_CLIPS, type SpeechClipId } from "../../src/sim3d/speechClips";
import manifest from "../../public/assets/sim3d/audio/phrase-manifest.json";

const AUDIO_ROOT = new URL("../../public/assets/sim3d/audio/", import.meta.url);
const EXPECTED_KEYS: SpeechClipId[] = [
  "greeting", "card", "thanks", "milkPhrase", "breadPhrase", "repeatRequest", "affirmative", "cardRepeat",
];
const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

/** Parse chunk boundaries too: a RIFF-looking prefix alone is not a valid WAV. */
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

/** Asset integrity only; does not claim browser autoplay or human listening QA. */
describe("bundled British-English speech assets", () => {
  it("provides the eight complete, unique local caption/audio mappings", () => {
    expect(Object.keys(SPEECH_CLIPS).sort()).toEqual([...EXPECTED_KEYS].sort());
    expect(manifest.clips.map((clip) => clip.id).sort()).toEqual([...EXPECTED_KEYS].sort());
    expect(new Set(Object.values(SPEECH_CLIPS).map((clip) => clip.src)).size).toBe(8);
    expect(new Set(manifest.clips.map((clip) => clip.file)).size).toBe(8);
    for (const clip of Object.values(SPEECH_CLIPS)) {
      expect(clip.text.trim()).toBe(clip.text);
      expect(clip.text).toMatch(/[A-Za-z]/);
      expect(clip.zh.trim()).toBe(clip.zh);
      expect(clip.zh).toMatch(/\p{Script=Han}/u);
      expect(clip.src).toMatch(/^\/assets\/sim3d\/audio\/[a-z-]+\.wav$/);
    }
    expect(manifest.format).toEqual({
      container: "RIFF/WAVE", encoding: "PCM signed 16-bit little endian", sampleRate: 22050, channels: 1,
    });
  });

  it.each(EXPECTED_KEYS)("ships %s as nonempty mono PCM16 with matching metadata and SHA-256", (id) => {
    const clip = SPEECH_CLIPS[id];
    const record = manifest.clips.find((entry) => entry.id === id)!;
    expect(record).toBeDefined();
    expect(record.text).toBe(clip.text);
    expect(record.zh).toBe(clip.zh);
    expect(clip.src).toBe(`/assets/sim3d/audio/${record.file}`);
    const asset = new URL(record.file, AUDIO_ROOT);
    expect(statSync(asset).isFile()).toBe(true);
    const data = readFileSync(asset);
    expect(data.length).toBe(record.bytes);
    expect(record.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(sha256(data)).toBe(record.sha256);

    const chunks = readWaveChunks(data);
    const format = chunks.get("fmt ")!;
    expect(format.length).toBeGreaterThanOrEqual(16);
    expect(format.readUInt16LE(0)).toBe(1); // Linear PCM, not platform-specific compression.
    expect(format.readUInt16LE(2)).toBe(1); // Mono.
    expect(format.readUInt32LE(4)).toBe(22050);
    expect(format.readUInt32LE(8)).toBe(22050 * 2); // Byte rate.
    expect(format.readUInt16LE(12)).toBe(2); // Frame alignment.
    expect(format.readUInt16LE(14)).toBe(16);

    const pcm = chunks.get("data")!;
    expect(pcm.length).toBeGreaterThan(22050 * 2 * 0.3);
    expect(pcm.length % 2).toBe(0);
    const duration = pcm.length / (22050 * 2);
    expect(duration).toBeLessThan(5);
    expect(duration).toBeCloseTo(record.durationSeconds, 3);
    let peak = 0;
    let squareSum = 0;
    for (let index = 0; index < pcm.length; index += 2) {
      const sample = pcm.readInt16LE(index);
      peak = Math.max(peak, Math.abs(sample));
      squareSum += sample * sample;
    }
    const rms = Math.sqrt(squareSum / (pcm.length / 2)) / 32768;
    expect(rms).toBeGreaterThan(0.003); // Reject a valid header around silence.
    expect(peak).toBeLessThan(32767); // No full-scale clipping.
    expect(20 * Math.log10(peak / 32768)).toBeCloseTo(record.peakDbFS, 2);
    expect(20 * Math.log10(rms)).toBeCloseTo(record.rmsDbFS, 2);
  });

  it("keeps the complete phrase download below one megabyte", () => {
    const bytes = manifest.clips.reduce((sum, clip) => sum + statSync(new URL(clip.file, AUDIO_ROOT)).size, 0);
    expect(bytes).toBe(manifest.totalBytes);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(1_000_000);
  });

  it("ships the synthetic-voice provenance separately from the human word credits", () => {
    const source = readFileSync(new URL("phrase-SOURCES.md", AUDIO_ROOT), "utf8");
    expect(source).toContain("synthetic speech");
    expect(source).toContain("https://brycebeattie.com/files/tts/");
    expect(source).toContain("public domain");
    expect(statSync(new URL("audio-SOURCES.md", AUDIO_ROOT)).isFile()).toBe(true);
  });

  it.each([
    ["milk.ogg", "c622700c3f2fa7a5d2bb4ad873cd31d800453e1a5914db07c270954233ad10f8"],
    ["bread.ogg", "5396006a38de7468b34a6da1a572b6d9620f48305ae1716cbb7f868a096f96bd"],
  ])("preserves the original human %s recording unchanged", (filename, expectedHash) => {
    const asset = new URL(filename, AUDIO_ROOT);
    expect(statSync(asset).isFile()).toBe(true);
    const data = readFileSync(asset);
    expect(data.toString("ascii", 0, 4)).toBe("OggS");
    expect(data.length).toBeGreaterThan(1000);
    expect(sha256(data)).toBe(expectedHash);
  });
});
