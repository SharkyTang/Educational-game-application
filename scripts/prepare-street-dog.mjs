#!/usr/bin/env node
/** Convert Quaternius's original CC0 Dog.fbx to a self-contained runtime GLB. */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_SHA256 = "a7250b3c68857120e6da0fd9ea2cdb4a4493823b6afed371b7aa9208407af039";
const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function parseGlb(data) {
  if (data.length < 20 || data.readUInt32LE(0) !== GLB_MAGIC || data.readUInt32LE(4) !== 2 || data.readUInt32LE(8) !== data.length) {
    throw new Error("Expected a complete glTF 2.0 binary file.");
  }
  const jsonLength = data.readUInt32LE(12);
  if (data.readUInt32LE(16) !== JSON_CHUNK) throw new Error("GLB JSON chunk is missing.");
  const jsonEnd = 20 + jsonLength;
  const document = JSON.parse(data.subarray(20, jsonEnd).toString("utf8").trim());
  if (jsonEnd + 8 > data.length || data.readUInt32LE(jsonEnd + 4) !== BIN_CHUNK) throw new Error("GLB binary chunk is missing.");
  const binaryLength = data.readUInt32LE(jsonEnd);
  const binary = data.subarray(jsonEnd + 8, jsonEnd + 8 + binaryLength);
  if (jsonEnd + 8 + binaryLength !== data.length) throw new Error("Unexpected trailing GLB data.");
  return { document, binary };
}

function packGlb(document, binary) {
  const rawJson = Buffer.from(JSON.stringify(document), "utf8");
  const jsonPadding = (4 - rawJson.length % 4) % 4;
  const json = Buffer.concat([rawJson, Buffer.alloc(jsonPadding, 0x20)]);
  const binaryPadding = (4 - binary.length % 4) % 4;
  const bin = Buffer.concat([binary, Buffer.alloc(binaryPadding)]);
  const result = Buffer.alloc(12 + 8 + json.length + 8 + bin.length);
  result.writeUInt32LE(GLB_MAGIC, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(json.length, 12);
  result.writeUInt32LE(JSON_CHUNK, 16);
  json.copy(result, 20);
  const binaryHeader = 20 + json.length;
  result.writeUInt32LE(bin.length, binaryHeader);
  result.writeUInt32LE(BIN_CHUNK, binaryHeader + 4);
  bin.copy(result, binaryHeader + 8);
  return result;
}

function validate(document, data) {
  if (document.asset?.version !== "2.0" || !String(document.asset?.generator).includes("FBX2glTF v0.9.7")) {
    throw new Error("Unexpected converter or glTF version.");
  }
  if (document.scenes?.length !== 1 || document.meshes?.length !== 1 || document.skins?.length !== 1) {
    throw new Error("Patch must remain one self-contained skinned dog model.");
  }
  if (document.meshes[0]?.name !== "Dog" || document.skins[0]?.joints?.length !== 24) {
    throw new Error("Unexpected dog mesh or skeleton contract.");
  }
  if (document.meshes[0]?.primitives?.[0]?.attributes?.POSITION === undefined) {
    throw new Error("Dog mesh has no positions.");
  }
  const animations = document.animations?.map((animation) => animation.name).sort();
  if (JSON.stringify(animations) !== JSON.stringify(["idle", "walk"])) {
    throw new Error("Patch must ship exact idle and walk animation names.");
  }
  if (document.animations.some((animation) => !animation.channels?.length || !animation.samplers?.length)) {
    throw new Error("Dog animation contains no channels.");
  }
  if (document.images?.length || document.buffers?.length !== 1 || document.buffers[0].uri) {
    throw new Error("Patch must be one embedded GLB with no external images or buffers.");
  }
  if (data.length >= 256_000) throw new Error("Patch exceeds the 250 KiB runtime budget.");
}

const output = resolve(argument("--output", `${ROOT}/public/assets/sim3d/street-dog-patch.glb`));
if (process.argv.includes("--verify-only")) {
  const data = readFileSync(output);
  const { document } = parseGlb(data);
  validate(document, data);
  console.log(`Verified ${output}: ${data.length} bytes, SHA-256 ${sha256(data)}`);
  process.exit(0);
}

const source = resolve(argument("--source", `${ROOT}/tmp/street-dog-source/Dog.fbx`));
const converter = resolve(argument("--converter", `${ROOT}/tmp/customer-source/tools/FBX2glTF`));
const sourceData = readFileSync(source);
if (sha256(sourceData) !== SOURCE_SHA256) throw new Error("Dog.fbx differs from the reviewed Quaternius source.");

const buildRoot = resolve(`${ROOT}/tmp/street-dog-build`);
mkdirSync(buildRoot, { recursive: true });
const convertedBase = resolve(`${buildRoot}/street-dog-patch-converted`);
const result = spawnSync(converter, [
  "--binary", "--compute-normals", "missing", "--anim-framerate", "bake30",
  "--input", source, "--output", convertedBase,
], { encoding: "utf8" });
if (result.status !== 0) throw new Error(`FBX2glTF failed: ${result.stderr || result.stdout}`);

const converted = readFileSync(`${convertedBase}.glb`);
const { document, binary } = parseGlb(converted);
const animationNames = new Map([
  ["DogArmature|Idle", "idle"],
  ["DogArmature|Walking", "walk"],
]);
for (const animation of document.animations ?? []) animation.name = animationNames.get(animation.name) ?? animation.name;
for (const material of document.materials ?? []) {
  material.pbrMetallicRoughness ??= {};
  material.pbrMetallicRoughness.metallicFactor = 0;
  material.pbrMetallicRoughness.roughnessFactor = .86;
}
document.asset.extras = {
  source: "Quaternius, Animal Pack Vol.2, Dog.fbx",
  license: "CC0-1.0",
  sourceSha256: SOURCE_SHA256,
};
const prepared = packGlb(document, binary);
validate(document, prepared);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, prepared);
console.log(`Prepared ${output}: ${prepared.length} bytes, SHA-256 ${sha256(prepared)}`);
