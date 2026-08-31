import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core";
import { describe, expect, it } from "vitest";

interface Accessor {
  bufferView: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
}

interface GlbDocument {
  asset: { version: string; copyright: string };
  buffers: Array<{ byteLength: number; uri?: string }>;
  bufferViews: Array<{ buffer?: number; byteOffset?: number; byteLength: number; byteStride?: number }>;
  accessors: Accessor[];
  nodes: Array<{ name: string; mesh?: number; skin?: number; children?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }>;
  meshes: Array<{ primitives: Array<{ attributes: Record<string, number> }> }>;
  skins: Array<{ joints: number[]; inverseBindMatrices: number }>;
  images: Array<{ bufferView: number; mimeType: string; uri?: string }>;
  materials: Array<{ name: string; alphaMode: string; doubleSided?: boolean }>;
  animations: Array<{
    name: string;
    samplers: Array<{ input: number; output: number; interpolation: string }>;
    channels: Array<{ sampler: number; target: { node: number; path: string } }>;
  }>;
  extensionsRequired?: string[];
  extras: { source: string; sourceCommit: string; sourceAvatar: string; license: string };
}

const CUSTOMERS = [
  { file: "customer.glb", avatar: "Female_Adult_01", prefix: "f001", height: 1.74335 },
  { file: "customer-female-02.glb", avatar: "Female_Adult_02", prefix: "f002", height: 1.73516 },
  { file: "customer-male-01.glb", avatar: "Male_Adult_01", prefix: "m002", height: 1.82368 },
  { file: "customer-male-02.glb", avatar: "Male_Adult_02", prefix: "m003", height: 1.82275 },
] as const;

function loadGlb(file: string) {
  const bytes = readFileSync(new URL(`../../public/assets/sim3d/${file}`, import.meta.url));
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
  expect(bytes.readUInt32LE(4)).toBe(2);
  expect(bytes.readUInt32LE(8)).toBe(bytes.length);
  expect(bytes.readUInt32LE(16)).toBe(0x4e4f534a);
  const jsonEnd = 20 + bytes.readUInt32LE(12);
  const document = JSON.parse(bytes.subarray(20, jsonEnd).toString("utf8")) as GlbDocument;
  expect(bytes.readUInt32LE(jsonEnd + 4)).toBe(0x004e4942);
  const binary = bytes.subarray(jsonEnd + 8, jsonEnd + 8 + bytes.readUInt32LE(jsonEnd));
  return { bytes, document, binary };
}

function floatAccessor(document: GlbDocument, binary: Buffer, index: number) {
  const accessor = document.accessors[index]!;
  expect(accessor.componentType).toBe(5126);
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[accessor.type]!;
  expect(components).toBeGreaterThan(0);
  const view = document.bufferViews[accessor.bufferView]!;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const stride = view.byteStride ?? components * 4;
  const values: number[] = [];
  for (let item = 0; item < accessor.count; item += 1) {
    for (let component = 0; component < components; component += 1) {
      values.push(binary.readFloatLE(start + item * stride + component * 4));
    }
  }
  return { accessor, values };
}

/** Binary/rig contracts. The real browser checks hair, faces and gait separately. */
describe("four independently modelled Rocketbox customers", () => {
  it.each(CUSTOMERS)("ships $file as a bounded, self-contained and licensed GLB", ({ file, avatar, prefix }) => {
    const { bytes, document, binary } = loadGlb(file);
    expect(bytes.length).toBeLessThan(8 * 1024 * 1024);
    expect(document.asset.version).toBe("2.0");
    expect(document.asset.copyright).toContain("MIT License");
    expect(document.extras).toMatchObject({
      source: "microsoft/Microsoft-Rocketbox",
      sourceCommit: "0943055db6ec570bcef9f2c8b41c9e5467c808f9",
      sourceAvatar: avatar,
      license: "MIT",
    });
    expect(document.extensionsRequired ?? []).toEqual([]);
    expect(document.buffers).toHaveLength(1);
    expect(document.buffers[0]!.uri).toBeUndefined();
    expect(document.buffers[0]!.byteLength).toBeLessThanOrEqual(binary.length);
    for (const view of document.bufferViews) {
      expect(view.buffer ?? 0).toBe(0);
      expect((view.byteOffset ?? 0) + view.byteLength).toBeLessThanOrEqual(binary.length);
    }
    expect(document.images).toHaveLength(3);
    for (const image of document.images) {
      expect(image.uri).toBeUndefined();
      expect(document.bufferViews[image.bufferView]!.byteLength).toBeGreaterThan(10_000);
      expect(["image/jpeg", "image/png"]).toContain(image.mimeType);
    }
    expect(document.materials.map((material) => material.name)).toEqual([`${prefix}_body`, `${prefix}_head`, `${prefix}_opacity`]);
    expect(document.materials[2]).toMatchObject({ alphaMode: "MASK", doubleSided: true });
    for (let index = 0; index < document.accessors.length; index += 1) {
      if (document.accessors[index]!.componentType === 5126) {
        expect(floatAccessor(document, binary, index).values.every(Number.isFinite)).toBe(true);
      }
    }
  });

  it.each(CUSTOMERS)("preserves $file adult proportions and usable hand/head bones", ({ file, height }) => {
    const { document, binary } = loadGlb(file);
    expect(document.skins).toHaveLength(1);
    expect(document.skins[0]!.joints).toHaveLength(80);
    expect(document.accessors[document.skins[0]!.inverseBindMatrices]!.count).toBe(80);
    expect(document.nodes.map((node) => node.name)).toEqual(expect.arrayContaining(["Bip01", "Bip01 Head", "Bip01 L Hand", "Bip01 R Hand"]));
    const parents = new Map<number, number>();
    document.nodes.forEach((node, index) => node.children?.forEach((child) => parents.set(child, index)));
    const transforms = new Map<number, Matrix>();
    const transformFor = (index: number): Matrix => {
      const cached = transforms.get(index);
      if (cached) return cached;
      const node = document.nodes[index]!;
      const local = Matrix.Compose(
        Vector3.FromArray(node.scale ?? [1, 1, 1]),
        Quaternion.FromArray(node.rotation ?? [0, 0, 0, 1]),
        Vector3.FromArray(node.translation ?? [0, 0, 0]),
      );
      const parent = parents.get(index);
      const world = parent === undefined ? local : local.multiply(transformFor(parent));
      transforms.set(index, world);
      return world;
    };
    let minimumY = Infinity;
    let maximumY = -Infinity;
    document.nodes.forEach((node, index) => {
      if (node.mesh === undefined) return;
      expect(node.skin).toBe(0);
      const transform = transformFor(index);
      for (const primitive of document.meshes[node.mesh]!.primitives) {
        const positions = floatAccessor(document, binary, primitive.attributes.POSITION!).values;
        for (let vertex = 0; vertex < positions.length; vertex += 3) {
          const point = Vector3.TransformCoordinates(Vector3.FromArray(positions, vertex), transform);
          minimumY = Math.min(minimumY, point.y);
          maximumY = Math.max(maximumY, point.y);
        }
      }
    });
    expect(maximumY - minimumY).toBeCloseTo(height, 4);
    expect(Math.abs(minimumY)).toBeLessThan(0.01);
  });

  it.each(CUSTOMERS)("gives $file looping idle/walk clips without bone resizing or horizontal drift", ({ file }) => {
    const { document, binary } = loadGlb(file);
    expect(document.animations.map((animation) => animation.name)).toEqual(["idle", "walk"]);
    for (const animation of document.animations) {
      expect(animation.channels.length).toBeGreaterThan(20);
      let translations = 0;
      for (const channel of animation.channels) {
        const sampler = animation.samplers[channel.sampler]!;
        const input = floatAccessor(document, binary, sampler.input);
        const output = floatAccessor(document, binary, sampler.output);
        expect(sampler.interpolation).toBe("LINEAR");
        expect(input.values[0]).toBe(0);
        expect(input.values.at(-1)).toBeGreaterThan(1);
        expect(input.values.every((time, index) => index === 0 || time > input.values[index - 1]!)).toBe(true);
        expect(input.accessor.count).toBe(output.accessor.count);
        expect(["rotation", "translation"]).toContain(channel.target.path);
        if (channel.target.path === "rotation") {
          expect(output.accessor.type).toBe("VEC4");
          for (let index = 0; index < output.values.length; index += 4) {
            expect(Math.hypot(...output.values.slice(index, index + 4))).toBeCloseTo(1, 5);
          }
        } else {
          const node = document.nodes[channel.target.node]!;
          expect(node.name).toBe("Bip01");
          const baseline = node.translation ?? [0, 0, 0];
          for (let index = 0; index < output.values.length; index += 3) {
            expect(output.values[index]).toBeCloseTo(baseline[0]!, 7);
            expect(output.values[index + 2]).toBeCloseTo(baseline[2]!, 7);
            expect(Math.abs(output.values[index + 1]! - baseline[1]!)).toBeLessThan(0.12);
          }
          translations += 1;
        }
      }
      expect(translations).toBe(1);
    }
  });

  it("has four different meshes/faces/outfits within an 8 MiB total download budget", () => {
    const geometries = new Set<string>();
    const heads = new Set<string>();
    const outfits = new Set<string>();
    let total = 0;
    for (const customer of CUSTOMERS) {
      const { bytes, document, binary } = loadGlb(customer.file);
      total += bytes.length;
      const positions = document.meshes.flatMap((mesh) => mesh.primitives.flatMap((primitive) => floatAccessor(document, binary, primitive.attributes.POSITION!).values));
      geometries.add(createHash("sha256").update(JSON.stringify(positions)).digest("hex"));
      for (const [imageIndex, hashes] of [[0, outfits], [1, heads]] as const) {
        const view = document.bufferViews[document.images[imageIndex]!.bufferView]!;
        const offset = view.byteOffset ?? 0;
        hashes.add(createHash("sha256").update(binary.subarray(offset, offset + view.byteLength)).digest("hex"));
      }
    }
    expect(geometries.size).toBe(4);
    expect(heads.size).toBe(4);
    expect(outfits.size).toBe(4);
    expect(total).toBeLessThan(8 * 1024 * 1024);
    expect(readFileSync(new URL("../../public/assets/sim3d/customer-LICENSE.txt", import.meta.url), "utf8")).toContain("Permission is hereby granted");
  });
});
