import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRODUCT_ASSET_IDS, PRODUCT_ASSETS, PRODUCT_LIBRARY_VERSION, productLibraryManifest } from "../../src/sim3d/product-library/catalog";

interface ProductGlb {
  asset: { version: string };
  buffers: { byteLength: number; uri?: string }[];
  bufferViews: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  accessors: { bufferView: number; byteOffset?: number; count: number; componentType: number; type: string }[];
  nodes: { name?: string; extras?: { productId?: string; libraryVersion?: string; baseAnchored?: boolean; units?: string; gameplay?: string } }[];
  meshes: { primitives: { attributes: Record<string, number> }[] }[];
  images?: { bufferView?: number; uri?: string; mimeType?: string }[];
  cameras?: unknown[];
}

const directory = "public/assets/sim3d/products";

describe("shipped reusable product files", () => {
  it("ships exactly the live catalogue's 30 GLBs and 30 previews, with a current JSON manifest", () => {
    const files = readdirSync(directory);
    for (const extension of ["glb", "png"]) {
      expect(files.filter((file) => file.endsWith(`.${extension}`)).sort()).toEqual(PRODUCT_ASSET_IDS.map((id) => `${id}.${extension}`).sort());
    }
    expect(JSON.parse(readFileSync(`${directory}/catalog.json`, "utf8"))).toEqual(productLibraryManifest());
  });

  it.each(PRODUCT_ASSET_IDS)("%s has a self-contained GLB with finite geometry and a valid PNG preview", (id) => {
    const asset = PRODUCT_ASSETS[id];
    const preview = readFileSync(`public${asset.thumbnailUrl}`);
    expect(preview.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(preview.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(preview.readUInt32BE(16)).toBeGreaterThanOrEqual(300);
    expect(preview.readUInt32BE(20)).toBeGreaterThanOrEqual(300);

    const bytes = readFileSync(`public${asset.modelUrl}`);
    expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
    expect(bytes.readUInt32LE(4)).toBe(2);
    expect(bytes.readUInt32LE(8)).toBe(bytes.length);
    expect(bytes.readUInt32LE(16)).toBe(0x4e4f534a);
    const jsonLength = bytes.readUInt32LE(12);
    const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8")) as ProductGlb;
    const binaryHeader = 20 + jsonLength;
    expect(bytes.readUInt32LE(binaryHeader + 4)).toBe(0x004e4942);
    const binary = bytes.subarray(binaryHeader + 8);
    expect(bytes.readUInt32LE(binaryHeader)).toBe(binary.length);
    expect(gltf.asset.version).toBe("2.0");
    expect(gltf.buffers).toHaveLength(1);
    expect(gltf.buffers[0]!.uri).toBeUndefined();
    expect(gltf.buffers[0]!.byteLength).toBeLessThanOrEqual(binary.length);
    expect(gltf.cameras ?? []).toHaveLength(0);
    expect(gltf.nodes.some((node) => /plinth|camera|soft-fill|library-key|library-rim/.test(node.name ?? ""))).toBe(false);
    expect(gltf.nodes.find((node) => node.extras?.productId === id)?.extras).toMatchObject({
      productId: id, libraryVersion: PRODUCT_LIBRARY_VERSION, baseAnchored: true, units: "metres", gameplay: "active",
    });
    for (const view of gltf.bufferViews) {
      expect(view.buffer).toBe(0);
      expect((view.byteOffset ?? 0) + view.byteLength).toBeLessThanOrEqual(binary.length);
    }
    for (const image of gltf.images ?? []) {
      expect(image.uri).toBeUndefined();
      expect(typeof image.bufferView).toBe("number");
      expect(["image/png", "image/jpeg"]).toContain(image.mimeType);
    }
    expect(gltf.meshes.length).toBeGreaterThan(0);
    for (const mesh of gltf.meshes) {
      for (const primitive of mesh.primitives) {
        for (const kind of ["POSITION", "NORMAL"]) {
          const accessor = gltf.accessors[primitive.attributes[kind]!]!;
          expect(accessor, kind).toBeDefined();
          expect(accessor.type).toBe("VEC3");
          expect(accessor.componentType).toBe(5126);
          expect(accessor.count).toBeGreaterThan(0);
          const view = gltf.bufferViews[accessor.bufferView]!;
          const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
          const stride = view.byteStride ?? 12;
          expect(offset + (accessor.count - 1) * stride + 12).toBeLessThanOrEqual((view.byteOffset ?? 0) + view.byteLength);
          let finite = true;
          for (let vertex = 0; vertex < accessor.count && finite; vertex += 1) {
            for (let axis = 0; axis < 3; axis += 1) {
              if (!Number.isFinite(binary.readFloatLE(offset + vertex * stride + axis * 4))) finite = false;
            }
          }
          expect(finite, `${id}: exported ${kind}`).toBe(true);
        }
      }
    }
  });
});
