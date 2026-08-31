import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EQUIPMENT_ASSET_IDS, EQUIPMENT_ASSETS, EQUIPMENT_LIBRARY_VERSION, equipmentLibraryManifest, type EquipmentSlot } from "../../src/sim3d/equipment-library/catalog";

interface EquipmentGlb {
  asset: { version: string };
  buffers: { byteLength: number; uri?: string }[];
  bufferViews: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  accessors: { bufferView: number; byteOffset?: number; count: number; componentType: number; type: string }[];
  nodes: { name?: string; mesh?: number; children?: number[]; extras?: {
    equipmentId?: string; libraryVersion?: string; baseAnchored?: boolean; units?: string; gameplay?: string;
    capacity?: number; placementSlots?: EquipmentSlot[]; servicePoints?: unknown[];
  } }[];
  meshes: { primitives: { attributes: Record<string, number> }[] }[];
  images?: { bufferView?: number; uri?: string; mimeType?: string }[];
  cameras?: unknown[];
  extensionsUsed?: string[];
}

const directory = "public/assets/sim3d/equipment";

describe("shipped equipment library files", () => {
  it("ships all twelve GLBs and real model previews with the current placement manifest", () => {
    const files = readdirSync(directory);
    for (const extension of ["glb", "png"]) {
      expect(files.filter((file) => file.endsWith(`.${extension}`)).sort()).toEqual(EQUIPMENT_ASSET_IDS.map((id) => `${id}.${extension}`).sort());
    }
    expect(JSON.parse(readFileSync(`${directory}/catalog.json`, "utf8"))).toEqual(equipmentLibraryManifest());
    expect(readFileSync(`${directory}/SOURCES.md`, "utf8")).toContain("project-authored procedural equipment");
  });

  it.each(EQUIPMENT_ASSET_IDS)("%s is a self-contained finite GLB carrying matching placement data", (id) => {
    const asset = EQUIPMENT_ASSETS[id];
    const preview = readFileSync(`public${asset.thumbnailUrl}`);
    expect(preview.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(preview.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(preview.readUInt32BE(16)).toBeGreaterThanOrEqual(300);
    expect(preview.readUInt32BE(20)).toBeGreaterThanOrEqual(300);
    expect(preview.length).toBeGreaterThan(6000);

    const bytes = readFileSync(`public${asset.modelUrl}`);
    expect(bytes.length).toBeLessThan(8 * 1024 * 1024);
    expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
    expect(bytes.readUInt32LE(4)).toBe(2);
    expect(bytes.readUInt32LE(8)).toBe(bytes.length);
    expect(bytes.readUInt32LE(16)).toBe(0x4e4f534a);
    const jsonLength = bytes.readUInt32LE(12);
    const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8")) as EquipmentGlb;
    const binaryHeader = 20 + jsonLength;
    expect(bytes.readUInt32LE(binaryHeader + 4)).toBe(0x004e4942);
    const binary = bytes.subarray(binaryHeader + 8);
    expect(bytes.readUInt32LE(binaryHeader)).toBe(binary.length);
    expect(gltf.asset.version).toBe("2.0");
    expect(gltf.buffers).toHaveLength(1);
    expect(gltf.buffers[0]!.uri).toBeUndefined();
    expect(gltf.buffers[0]!.byteLength).toBeLessThanOrEqual(binary.length);
    expect(gltf.cameras ?? []).toHaveLength(0);
    expect(gltf.extensionsUsed ?? []).not.toContain("KHR_lights_punctual");
    expect(gltf.nodes.some((node) => /slot-envelope|slot-marker|library-plinth|preview-platform/.test(node.name ?? ""))).toBe(false);
    const rootIndex = gltf.nodes.findIndex((node) => node.extras?.equipmentId === id);
    expect(rootIndex).toBeGreaterThanOrEqual(0);
    const metadata = gltf.nodes[rootIndex]!.extras!;
    expect(metadata).toMatchObject({ equipmentId: id, libraryVersion: EQUIPMENT_LIBRARY_VERSION, baseAnchored: true,
      units: "metres", gameplay: "library-only", capacity: asset.capacity });
    expect(metadata.placementSlots).toHaveLength(asset.capacity);
    expect(metadata.servicePoints).toHaveLength(asset.servicePoints.length);
    for (let index = 0; index < asset.capacity; index++) {
      const actual = metadata.placementSlots![index]!; const expected = asset.placementSlots[index]!;
      expect(actual).toMatchObject({ id: expected.id, maxSize: expected.maxSize, rotationY: expected.rotationY, mount: expected.mount });
      for (let axis = 0; axis < 3; axis++) expect(actual.position[axis]).toBeCloseTo(expected.position[axis]!, 5);
    }
    const descendants = new Set<number>();
    const visit = (index: number): void => { if (descendants.has(index)) return; descendants.add(index); for (const child of gltf.nodes[index]!.children ?? []) visit(child) };
    visit(rootIndex);
    gltf.nodes.forEach((node, index) => { if (node.mesh !== undefined) expect(descendants.has(index), `${id}: preview mesh leaked into GLB`).toBe(true) });

    for (const view of gltf.bufferViews) {
      expect(view.buffer).toBe(0);
      expect((view.byteOffset ?? 0) + view.byteLength).toBeLessThanOrEqual(binary.length);
    }
    expect((gltf.images ?? []).length).toBeGreaterThan(0);
    for (const image of gltf.images ?? []) {
      expect(image.uri).toBeUndefined();
      expect(typeof image.bufferView).toBe("number");
      expect(["image/png", "image/jpeg"]).toContain(image.mimeType);
    }
    expect(gltf.meshes.length).toBeGreaterThan(0);
    for (const mesh of gltf.meshes) for (const primitive of mesh.primitives) for (const kind of ["POSITION", "NORMAL"]) {
      const accessor = gltf.accessors[primitive.attributes[kind]!]!;
      expect(accessor, kind).toBeDefined();
      expect(accessor.type).toBe("VEC3");
      expect(accessor.componentType).toBe(5126);
      expect(accessor.count).toBeGreaterThan(0);
      const view = gltf.bufferViews[accessor.bufferView]!;
      const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0); const stride = view.byteStride ?? 12;
      expect(offset + (accessor.count - 1) * stride + 12).toBeLessThanOrEqual((view.byteOffset ?? 0) + view.byteLength);
      let finite = true;
      for (let vertex = 0; vertex < accessor.count && finite; vertex++) for (let axis = 0; axis < 3; axis++) {
        if (!Number.isFinite(binary.readFloatLE(offset + vertex * stride + axis * 4))) finite = false;
      }
      expect(finite, `${id}: exported ${kind}`).toBe(true);
    }
  });
});
