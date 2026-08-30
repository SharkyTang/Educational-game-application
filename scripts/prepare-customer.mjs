/**
 * Build the MIT Microsoft Rocketbox adult customer without adding app deps.
 *
 * Prerequisites: Node 22+, Pillow, and the official FBX2glTF 0.9.7 executable.
 * On macOS Apple Silicon this executable uses an existing Rosetta installation.
 *
 * CUSTOMER_PYTHON=/path/to/python3 node scripts/prepare-customer.mjs
 * node scripts/prepare-customer.mjs --download  (fetch pinned source files first)
 * node scripts/prepare-customer.mjs --skip-convert (repack existing conversions)
 * node scripts/prepare-customer.mjs --verify-only (offline output checks)
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "tmp/customer-source");
const CONVERTED = join(SOURCE, "converted");
const OUTPUT = join(ROOT, "public/assets/sim3d/customer.glb");
const COMMIT = "0943055db6ec570bcef9f2c8b41c9e5467c808f9";
const BASE = `https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/${COMMIT}`;
const CONVERTER = process.env.CUSTOMER_FBX2GLTF ?? join(SOURCE, "tools/FBX2glTF");
const PYTHON = process.env.CUSTOMER_PYTHON ?? "python3";
const MAX_BYTES = 8 * 1024 * 1024;
const CONVERTER_INTEGRITY = "gKWlCZq0xA+wcqj+0R0KeD5yxtq0EqO9cmYNuJTEVeP1aKPRP3ZXoNGh4JPLmI50jkIqE0aC/7GjAmS1ZPeDmw==";
const TEXTURE_BLOBS = {
  body: "25852db0db1f44a0de0643ce1e09c88aef587e6f",
  head: "0cdc62ab47da3dca01aff0bb179159865a559c63",
  opacity: "de21a9e69c88e539da6a5050eaceadd026e99b62",
};

const DOWNLOADS = [
  ["Female_Adult_01.fbx", `${BASE}/Assets/Avatars/Adults/Female_Adult_01/Export/Female_Adult_01.fbx`],
  ["f_walk_neutral.max.fbx", `${BASE}/Assets/Animations/all_animations_max_motextr_xy/f_walk_neutral.max.fbx`],
  ["f_idle_breathe_01.max.fbx", `${BASE}/Assets/Animations/all_animations_max_motextr_static/f_idle_breathe_01.max.fbx`],
];

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit ${result.status}`);
}

function download() {
  for (const [relative, url] of DOWNLOADS) {
    const output = join(SOURCE, relative);
    mkdirSync(dirname(output), { recursive: true });
    if (existsSync(output)) continue;
    run("curl", ["--fail", "--location", "--retry", "2", "--output", output, url]);
  }
  for (const [part, sha] of Object.entries(TEXTURE_BLOBS)) {
    const cached = join(SOURCE, `${part}-blob.json`);
    if (!existsSync(cached)) {
      run("curl", [
        "--fail", "--location", "--compressed", "--retry", "2", "--output", cached,
        `https://api.github.com/repos/microsoft/Microsoft-Rocketbox/git/blobs/${sha}`,
      ]);
    }
  }
  if (!existsSync(CONVERTER)) {
    mkdirSync(dirname(CONVERTER), { recursive: true });
    const archive = join(SOURCE, "tools/fbx2gltf-0.9.7.tgz");
    run("curl", [
      "--fail", "--location", "--retry", "2", "--output", archive,
      "https://registry.npmjs.org/fbx2gltf/-/fbx2gltf-0.9.7.tgz",
    ]);
    const integrity = createHash("sha512").update(readFileSync(archive)).digest("base64");
    if (integrity !== CONVERTER_INTEGRITY) throw new Error("FBX2glTF npm integrity mismatch");
    run("tar", ["-xzf", archive, "--strip-components=3", "-C", dirname(CONVERTER), "package/bin/Darwin/FBX2glTF"]);
    run("chmod", ["+x", CONVERTER]);
  }
}

function decodeTextureBlobs() {
  mkdirSync(join(SOURCE, "Textures"), { recursive: true });
  for (const [part, expectedSha] of Object.entries(TEXTURE_BLOBS)) {
    const cached = join(SOURCE, `${part}-blob.json`);
    if (!existsSync(cached)) continue;
    const blob = JSON.parse(readFileSync(cached, "utf8"));
    const bytes = Buffer.from(blob.content, "base64");
    const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (sha !== expectedSha || blob.sha !== expectedSha) throw new Error(`Git blob integrity mismatch: ${part}`);
    writeFileSync(join(SOURCE, `Textures/f001_${part}_color.tga`), bytes);
  }
}

function convertFbx(input, output) {
  run(CONVERTER, [
    "--binary", "--anim-framerate", "bake30", "--no-khr-lights-punctual",
    "--input", join(SOURCE, input), "--output", join(CONVERTED, output),
  ]);
}

function loadGlb(path) {
  const file = readFileSync(path);
  if (file.readUInt32LE(0) !== 0x46546c67 || file.readUInt32LE(4) !== 2) {
    throw new Error(`${path} is not a glTF 2 GLB`);
  }
  let document;
  let binary = Buffer.alloc(0);
  for (let offset = 12; offset < file.length;) {
    const size = file.readUInt32LE(offset);
    const type = file.readUInt32LE(offset + 4);
    const content = file.subarray(offset + 8, offset + 8 + size);
    if (type === 0x4e4f534a) document = JSON.parse(content.toString("utf8").trim());
    if (type === 0x004e4942) binary = content;
    offset += size + 8;
  }
  if (!document) throw new Error(`${path} has no JSON chunk`);
  return { document, binary };
}

function readFloatAccessor(document, buffers, index) {
  const accessor = document.accessors[index];
  if (accessor.componentType !== 5126) throw new Error("Expected floating-point animation data");
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[accessor.type];
  const view = document.bufferViews[accessor.bufferView];
  const buffer = buffers[view.buffer ?? 0];
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = view.byteStride ?? components * 4;
  const values = [];
  for (let i = 0; i < accessor.count; i += 1) {
    for (let component = 0; component < components; component += 1) {
      values.push(buffer.readFloatLE(start + i * stride + component * 4));
    }
  }
  return { accessor, components, values };
}

function appendFloatAccessor(document, buffers, values, type) {
  const components = { SCALAR: 1, VEC3: 3, VEC4: 4 }[type];
  const binary = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => binary.writeFloatLE(value, index * 4));
  const bufferIndex = buffers.push(binary) - 1;
  const bufferView = document.bufferViews.push({ buffer: bufferIndex, byteOffset: 0, byteLength: binary.length }) - 1;
  const count = values.length / components;
  const accessor = { bufferView, componentType: 5126, count, type };
  if (type === "SCALAR") {
    accessor.min = [Math.min(...values)];
    accessor.max = [Math.max(...values)];
  }
  return document.accessors.push(accessor) - 1;
}

function addAnimation(document, buffers, source, name) {
  const targetNodes = new Map(document.nodes.map((node, index) => [node.name, index]));
  const sourceAnimation = source.document.animations?.[0];
  if (!sourceAnimation) throw new Error(`No animation was converted for ${name}`);
  const animation = { name, samplers: [], channels: [] };
  let removedRootMotion = false;
  const inputCache = new Map();
  const rootBaseline = document.nodes.find((node) => node.name === "Bip01")?.translation ?? [0, 0, 0];

  for (const channel of sourceAnimation.channels) {
    const sourceNode = source.document.nodes[channel.target.node];
    const targetIndex = targetNodes.get(sourceNode.name);
    if (targetIndex === undefined) continue;
    const path = channel.target.path;
    if (path === "scale" || path === "weights") continue;
    // Bone lengths come from the customer mesh; motion files must not resize it.
    if (path === "translation" && sourceNode.name !== "Bip01") continue;

    const sampler = sourceAnimation.samplers[channel.sampler];
    let input = inputCache.get(sampler.input);
    if (input === undefined) {
      const inputData = readFloatAccessor(source.document, [source.binary], sampler.input);
      const start = inputData.values[0] ?? 0;
      input = appendFloatAccessor(document, buffers, inputData.values.map((time) => time - start), "SCALAR");
      inputCache.set(sampler.input, input);
    }

    const outputData = readFloatAccessor(source.document, [source.binary], sampler.output);
    if (path === "translation") {
      const startingHeight = outputData.values[1] ?? 0;
      for (let i = 0; i < outputData.values.length; i += 3) {
        outputData.values[i] = rootBaseline[0];
        outputData.values[i + 1] = rootBaseline[1] + outputData.values[i + 1] - startingHeight;
        outputData.values[i + 2] = rootBaseline[2];
      }
      removedRootMotion = true;
    }
    const output = appendFloatAccessor(document, buffers, outputData.values, outputData.accessor.type);
    const samplerIndex = animation.samplers.push({ input, output, interpolation: "LINEAR" }) - 1;
    animation.channels.push({ sampler: samplerIndex, target: { node: targetIndex, path } });
  }

  if (animation.channels.length < 10) throw new Error(`Too few mapped skeleton channels in ${name}`);
  document.animations.push(animation);
  return { name, channels: animation.channels.length, removedRootMotion };
}

function replaceMaterials(document) {
  const parts = ["body", "head", "opacity"];
  const imageBytes = parts.map((part) => {
    const extension = part === "opacity" ? "png" : "jpg";
    return readFileSync(join(SOURCE, `prepared-textures/f001_${part}_color.${extension}`));
  });
  document.images = parts.map((part) => ({
    name: `Rocketbox_${part}_1024`,
    mimeType: part === "opacity" ? "image/png" : "image/jpeg",
  }));
  document.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
  document.textures = parts.map((part, index) => ({ name: part, source: index, sampler: 0 }));
  for (const material of document.materials) {
    const part = parts.find((candidate) => material.name?.toLowerCase().includes(candidate));
    if (!part) throw new Error(`Unmapped Rocketbox material: ${material.name}`);
    const index = parts.indexOf(part);
    delete material.normalTexture;
    delete material.occlusionTexture;
    delete material.emissiveTexture;
    delete material.extensions;
    material.emissiveFactor = [0, 0, 0];
    material.pbrMetallicRoughness = {
      baseColorFactor: [1, 1, 1, 1],
      baseColorTexture: { index },
      metallicFactor: 0,
      roughnessFactor: 0.88,
    };
    material.alphaMode = part === "opacity" ? "MASK" : "OPAQUE";
    if (part === "opacity") material.alphaCutoff = 0.42;
    else delete material.alphaCutoff;
    material.doubleSided = part === "opacity";
  }
  delete document.extensionsUsed;
  delete document.extensionsRequired;
  return imageBytes;
}

function repack(document, sourceBuffers, imageBytes) {
  const usedAccessors = new Set();
  for (const mesh of document.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      if (primitive.indices !== undefined) usedAccessors.add(primitive.indices);
      Object.values(primitive.attributes).forEach((index) => usedAccessors.add(index));
      for (const target of primitive.targets ?? []) {
        Object.values(target).forEach((index) => usedAccessors.add(index));
      }
    }
  }
  for (const skin of document.skins ?? []) {
    if (skin.inverseBindMatrices !== undefined) usedAccessors.add(skin.inverseBindMatrices);
  }
  for (const animation of document.animations) {
    for (const sampler of animation.samplers) {
      usedAccessors.add(sampler.input);
      usedAccessors.add(sampler.output);
    }
  }

  const oldAccessors = document.accessors;
  const oldViews = document.bufferViews;
  const accessorMap = new Map();
  const viewMap = new Map();
  const chunks = [];
  let length = 0;
  document.accessors = [];
  document.bufferViews = [];

  function appendBytes(bytes, properties = {}) {
    const padding = (4 - (length % 4)) % 4;
    if (padding > 0) {
      chunks.push(Buffer.alloc(padding));
      length += padding;
    }
    const bufferView = document.bufferViews.push({ ...properties, buffer: 0, byteOffset: length, byteLength: bytes.length }) - 1;
    chunks.push(bytes);
    length += bytes.length;
    return bufferView;
  }

  function copyView(oldIndex) {
    if (viewMap.has(oldIndex)) return viewMap.get(oldIndex);
    const old = oldViews[oldIndex];
    const bytes = sourceBuffers[old.buffer ?? 0].subarray(old.byteOffset ?? 0, (old.byteOffset ?? 0) + old.byteLength);
    const properties = {};
    if (old.byteStride !== undefined) properties.byteStride = old.byteStride;
    if (old.target !== undefined) properties.target = old.target;
    const index = appendBytes(bytes, properties);
    viewMap.set(oldIndex, index);
    return index;
  }

  for (const oldIndex of usedAccessors) {
    const accessor = structuredClone(oldAccessors[oldIndex]);
    if (accessor.bufferView !== undefined) accessor.bufferView = copyView(accessor.bufferView);
    if (accessor.sparse) {
      accessor.sparse.indices.bufferView = copyView(accessor.sparse.indices.bufferView);
      accessor.sparse.values.bufferView = copyView(accessor.sparse.values.bufferView);
    }
    accessorMap.set(oldIndex, document.accessors.push(accessor) - 1);
  }
  const mapped = (index) => {
    const result = accessorMap.get(index);
    if (result === undefined) throw new Error(`Unmapped accessor ${index}`);
    return result;
  };
  for (const mesh of document.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      if (primitive.indices !== undefined) primitive.indices = mapped(primitive.indices);
      for (const key of Object.keys(primitive.attributes)) primitive.attributes[key] = mapped(primitive.attributes[key]);
      for (const target of primitive.targets ?? []) {
        for (const key of Object.keys(target)) target[key] = mapped(target[key]);
      }
    }
  }
  for (const skin of document.skins ?? []) {
    if (skin.inverseBindMatrices !== undefined) skin.inverseBindMatrices = mapped(skin.inverseBindMatrices);
  }
  for (const animation of document.animations) {
    for (const sampler of animation.samplers) {
      sampler.input = mapped(sampler.input);
      sampler.output = mapped(sampler.output);
    }
  }
  document.images.forEach((image, index) => { image.bufferView = appendBytes(imageBytes[index]); });
  document.buffers = [{ byteLength: length }];
  return Buffer.concat(chunks);
}

function writeGlb(document, binary) {
  const json = Buffer.from(JSON.stringify(document));
  const jsonPadding = (4 - (json.length % 4)) % 4;
  const binPadding = (4 - (binary.length % 4)) % 4;
  const jsonChunk = Buffer.concat([json, Buffer.alloc(jsonPadding, 0x20)]);
  const binChunk = Buffer.concat([binary, Buffer.alloc(binPadding)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  const file = Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
  if (file.length > MAX_BYTES) throw new Error(`Customer GLB exceeds 8 MiB (${file.length} bytes)`);
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, file);
  return file;
}

function verifyPreparedGlb(document, binary) {
  const check = (condition, message) => {
    if (!condition) throw new Error(`Customer GLB validation: ${message}`);
  };
  check(document.asset.version === "2.0", "glTF version must be 2.0");
  check(document.buffers.length === 1 && !document.buffers[0].uri, "one embedded buffer is required");
  check(document.buffers[0].byteLength <= binary.length, "binary chunk is truncated");
  check(!document.extensionsRequired?.length, "external decoder extensions are not allowed");
  for (const view of document.bufferViews) {
    check((view.buffer ?? 0) === 0, "buffer view references an external buffer");
    check((view.byteOffset ?? 0) + view.byteLength <= binary.length, "buffer view is out of bounds");
  }
  for (const image of document.images) {
    check(image.bufferView !== undefined && !image.uri, "textures must be embedded");
    check(["image/jpeg", "image/png"].includes(image.mimeType), "unsupported texture type");
  }
  for (let index = 0; index < document.accessors.length; index += 1) {
    if (document.accessors[index].componentType !== 5126) continue;
    const data = readFloatAccessor(document, [binary], index);
    check(data.values.every(Number.isFinite), `non-finite float in accessor ${index}`);
  }
  const animations = document.animations.map((animation) => {
    let durationSeconds = 0;
    let rootTranslationChannels = 0;
    for (const channel of animation.channels) {
      const sampler = animation.samplers[channel.sampler];
      const input = readFloatAccessor(document, [binary], sampler.input);
      const output = readFloatAccessor(document, [binary], sampler.output);
      check(input.values[0] === 0, `${animation.name} must start at zero`);
      check(input.values.every((time, index) => index === 0 || time > input.values[index - 1]), `${animation.name} has unordered timestamps`);
      check(input.accessor.count === output.accessor.count, `${animation.name} has inconsistent key counts`);
      durationSeconds = Math.max(durationSeconds, input.values.at(-1));
      if (channel.target.path !== "translation") continue;
      const node = document.nodes[channel.target.node];
      check(node.name === "Bip01", `${animation.name} translates an unexpected node`);
      const baseline = node.translation ?? [0, 0, 0];
      for (let index = 0; index < output.values.length; index += 3) {
        check(Math.abs(output.values[index] - baseline[0]) < 1e-7, `${animation.name} contains horizontal X root motion`);
        check(Math.abs(output.values[index + 2] - baseline[2]) < 1e-7, `${animation.name} contains horizontal Z root motion`);
      }
      rootTranslationChannels += 1;
    }
    check(rootTranslationChannels === 1, `${animation.name} needs exactly one fixed-horizontal root track`);
    check(durationSeconds > 0, `${animation.name} is empty`);
    return { name: animation.name, durationSeconds, channels: animation.channels.length, horizontalRootMotion: 0 };
  });
  check(animations.map((animation) => animation.name).join(",") === "idle,walk", "idle and walk clips are required");
  return { selfContained: true, finiteFloatData: true, animations };
}

function main() {
  if (process.argv.includes("--verify-only")) {
    const output = loadGlb(OUTPUT);
    if (statSync(OUTPUT).size > MAX_BYTES) throw new Error("Customer GLB exceeds 8 MiB");
    console.log(JSON.stringify(verifyPreparedGlb(output.document, output.binary), null, 2));
    return;
  }
  mkdirSync(CONVERTED, { recursive: true });
  if (process.argv.includes("--download")) download();
  if (!process.argv.includes("--skip-convert")) {
    decodeTextureBlobs();
    run(PYTHON, [join(ROOT, "scripts/prepare-customer.py")]);
    convertFbx("Female_Adult_01.fbx", "model.glb");
    convertFbx("f_walk_neutral.max.fbx", "walk.glb");
    convertFbx("f_idle_breathe_01.max.fbx", "idle.glb");
  }

  const model = loadGlb(join(CONVERTED, "model.glb"));
  const document = structuredClone(model.document);
  const buffers = [model.binary];
  document.animations = [];
  const animationSummary = [
    addAnimation(document, buffers, loadGlb(join(CONVERTED, "idle.glb")), "idle"),
    addAnimation(document, buffers, loadGlb(join(CONVERTED, "walk.glb")), "walk"),
  ];
  const imageBytes = replaceMaterials(document);
  document.asset = {
    version: "2.0",
    generator: "FBX2glTF 0.9.7 + scripts/prepare-customer.mjs",
    copyright: "Copyright (c) 2020 Microsoft. MIT License. See customer-LICENSE.txt.",
  };
  document.extras = {
    source: "microsoft/Microsoft-Rocketbox",
    sourceCommit: COMMIT,
    sourceAvatar: "Female_Adult_01",
    license: "MIT",
    animations: "idle and walk; horizontal root motion removed; root height variation retained",
  };
  const binary = repack(document, buffers, imageBytes);
  const verification = verifyPreparedGlb(document, binary);
  const file = writeGlb(document, binary);
  const summary = {
    output: OUTPUT,
    bytes: statSync(OUTPUT).size,
    sha256: createHash("sha256").update(file).digest("hex"),
    nodes: document.nodes.length,
    meshes: document.meshes.length,
    skins: document.skins?.length ?? 0,
    materials: document.materials.map((material) => material.name),
    animations: animationSummary,
    verification,
  };
  writeFileSync(join(SOURCE, "conversion-report.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

main();
