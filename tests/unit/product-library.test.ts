import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NullEngine, PBRMaterial, Scene, Vector3, VertexBuffer } from "@babylonjs/core";
import { PRODUCT_ASSET_IDS, PRODUCT_ASSETS, PRODUCT_ASSET_LIST, PRODUCT_CATEGORIES, createProductAsset, filterProductAssets, isProductAssetId, productAssetCode, productLibraryManifest, type ProductAssetId } from "../../src/sim3d/product-library";
import { PRODUCT_IDS, createFirstDayState, validateSimState } from "../../src/sim3d/domain";
import { existsSync, readFileSync } from "node:fs";

describe("reusable product catalogue", () => {
  it("uses the same 30 unique product identities in the model library and shop economy", () => {
    expect(PRODUCT_ASSET_IDS).toHaveLength(30);
    expect(new Set(PRODUCT_ASSET_IDS).size).toBe(30);
    expect(PRODUCT_CATEGORIES).toHaveLength(6);
    expect(PRODUCT_ASSET_LIST.filter((entry) => entry.gameplay === "active").map((entry) => entry.id)).toEqual(PRODUCT_IDS);
    expect(PRODUCT_ASSET_LIST.filter((entry) => entry.gameplay === "library-only")).toHaveLength(0);
    expect(PRODUCT_IDS).toEqual(PRODUCT_ASSET_IDS);
    expect(validateSimState(createFirstDayState())).toBe(true);
    for (const asset of PRODUCT_ASSET_LIST) {
      expect(asset.id).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
      expect(asset.nameZh.length).toBeGreaterThan(0);
      expect(asset.phraseEn).toMatch(/^(a |an )/);
      expect(asset.phraseZh.length).toBeGreaterThan(0);
      expect(asset.size.every((value) => Number.isFinite(value) && value > 0 && value < 0.6)).toBe(true);
      expect(PRODUCT_CATEGORIES.some((category) => category.id === asset.category)).toBe(true);
      expect(asset.appearance.length).toBeGreaterThan(6);
      expect(asset.modelReady).toBe(true);
      expect(productAssetCode(asset.id)).toContain(`createProductAsset(scene, "${asset.id}"`);
    }
  });

  it("retains British English and the earlier sparkling-water identity", () => {
    expect(PRODUCT_ASSETS.water.nameZh).toBe("气泡水");
    expect(PRODUCT_ASSETS.water.nameEn).toBe("sparkling water");
    expect(PRODUCT_ASSETS.crisps.unitEn).toBe("packet");
    expect(PRODUCT_ASSETS.yoghurt.nameEn).toBe("yoghurt");
    expect(PRODUCT_ASSETS.eggs.phraseEn).toBe("a box of eggs");
    expect(PRODUCT_ASSETS.banana.phraseEn).toBe("a bunch of bananas");
    expect(PRODUCT_ASSETS.lettuce.phraseEn).toBe("a head of lettuce");
  });

  it("filters Chinese, English and exact IDs, combining category and search", () => {
    expect(filterProductAssets()).toHaveLength(30);
    expect(filterProductAssets("  MILK  ").map((asset) => asset.id)).toEqual(["milk"]);
    expect(filterProductAssets("橙").map((asset) => asset.id)).toEqual(["orange-juice", "orange"]);
    expect(filterProductAssets("orange", "produce").map((asset) => asset.id)).toEqual(["orange"]);
    expect(filterProductAssets("", "household")).toHaveLength(3);
    expect(filterProductAssets("no such product")).toEqual([]);
    expect(isProductAssetId("__proto__")).toBe(false);
    expect(isProductAssetId("toString")).toBe(false);
    expect(isProductAssetId(null)).toBe(false);
    expect(isProductAssetId("orange-juice")).toBe(true);
  });

  it("does not advertise missing audio, and exports honest reusable metadata", () => {
    for (const asset of PRODUCT_ASSET_LIST) {
      if (asset.audio) {
        expect(asset.gameplay).toBe("active");
        expect(existsSync(`public${asset.audio.wordUrl}`)).toBe(true);
        expect(existsSync(`public${asset.audio.phraseUrl}`)).toBe(true);
      } else expect(asset.gameplay).toBe("active");
    }
    expect(PRODUCT_ASSET_LIST.filter((asset) => asset.audio)).toHaveLength(2);
    const manifest = JSON.parse(JSON.stringify(productLibraryManifest()));
    expect(manifest.products).toHaveLength(30);
    expect(manifest.units).toBe("metres");
    expect(manifest.origin).toBe("bottom-centre");
    expect(manifest.gameplayNote).toContain("All 30 products");
    expect(manifest.gameplayNote).toContain("optional browser speech");
    expect(manifest.products.some((entry: Record<string, unknown>) => "pricePence" in entry)).toBe(false);
    // The library's routing branch must precede either save-owning game app.
    const source = readFileSync("src/main.ts", "utf8");
    expect(source.indexOf('query.get("assets")')).toBeLessThan(source.indexOf('query.get("legacy")'));
  });
});

/** Geometry only. Real labels, WebGL rendering and exports are checked in the browser. */
describe("all 30 product model contracts", () => {
  let engine: NullEngine;
  let scene: Scene;

  beforeEach(() => {
    engine = new NullEngine({ renderWidth: 512, renderHeight: 512, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 4 });
    vi.spyOn(engine, "createCanvas").mockImplementation((width, height) => {
      const gradient = { addColorStop: vi.fn() };
      const values: Record<PropertyKey, unknown> = {
        createLinearGradient: () => gradient, createRadialGradient: () => gradient,
        measureText: () => ({ width: 100 }), getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
        fillStyle: "", strokeStyle: "", lineWidth: 1, textAlign: "left", font: "12px Arial",
      };
      const context = new Proxy(values, { get: (target, property) => property in target ? target[property] : vi.fn() });
      return { width, height, getContext: () => context, remove: vi.fn() } as unknown as ReturnType<NullEngine["createCanvas"]>;
    });
    scene = new Scene(engine);
  });

  afterEach(() => { scene?.dispose(); engine?.dispose(); vi.restoreAllMocks() });

  it.each(PRODUCT_ASSET_IDS)("%s builds finite, recognisable-scale, selectable geometry with the same root contract", (id) => {
    const root = createProductAsset(scene, id, `test-${id}`);
    expect(root.metadata).toMatchObject({ productId: id, assetType: "product", baseAnchored: true, front: "-Z", units: "metres" });
    expect(root.position.equals(Vector3.Zero())).toBe(true);
    expect(root.scaling.equals(Vector3.One())).toBe(true);
    const meshes = root.getChildMeshes();
    expect(meshes.length).toBeGreaterThan(1);
    expect(meshes.length).toBeLessThanOrEqual(18);
    let vertices = 0;
    for (const mesh of meshes) {
      expect(mesh.isPickable).toBe(true);
      expect(mesh.material).toBeInstanceOf(PBRMaterial);
      expect(mesh.getTotalVertices()).toBeGreaterThan(0);
      vertices += mesh.getTotalVertices();
      expect(mesh.getVerticesData(VertexBuffer.PositionKind)?.every(Number.isFinite)).toBe(true);
      expect(mesh.getVerticesData(VertexBuffer.NormalKind)?.every(Number.isFinite), `${id}: ${mesh.name} normals`).toBe(true);
      expect(mesh.getIndices()!.length % 3).toBe(0);
    }
    expect(vertices).toBeLessThan(35_000);
    const bounds = root.getHierarchyBoundingVectors(true);
    const measured = bounds.max.subtract(bounds.min).asArray();
    const nominal = PRODUCT_ASSETS[id].size;
    for (let axis = 0; axis < 3; axis += 1) {
      expect(measured[axis]! / nominal[axis]!).toBeGreaterThan(0.55);
      expect(measured[axis]! / nominal[axis]!).toBeLessThan(1.5);
    }
    expect(Math.abs(bounds.min.y), `${id}: base at y=0`).toBeLessThan(0.000001);
    expect(Math.abs(bounds.min.x + bounds.max.x), `${id}: horizontally centred x`).toBeLessThan(0.000001);
    expect(Math.abs(bounds.min.z + bounds.max.z), `${id}: horizontally centred z`).toBeLessThan(0.000001);
    expect(root.metadata.dimensions.width).toBeCloseTo(measured[0]!, 5);
    expect(root.metadata.dimensions.height).toBeCloseTo(measured[1]!, 5);
    expect(root.metadata.dimensions.depth).toBeCloseTo(measured[2]!, 5);
    root.dispose(false, false);
    expect(scene.meshes).toHaveLength(0);
  });

  it("shares per-scene materials without sharing product identity or destroying another instance", () => {
    for (const id of PRODUCT_ASSET_IDS) {
      const one = createProductAsset(scene, id, `one-${id}`);
      const count = scene.materials.length;
      const two = createProductAsset(scene, id, `two-${id}`);
      expect(scene.materials.length).toBe(count);
      expect(one.uniqueId).not.toBe(two.uniqueId);
      expect(one.metadata).not.toBe(two.metadata);
      one.dispose(false, false);
      expect(two.getChildMeshes().every((mesh) => !mesh.isDisposed() && mesh.material !== null)).toBe(true);
      two.dispose(false, false);
    }
  });

  it("rejects unsupported IDs before allocating anything, instead of silently making bread", () => {
    const nodes = scene.transformNodes.length;
    const meshes = scene.meshes.length;
    expect(() => createProductAsset(scene, "unknown" as ProductAssetId)).toThrow("Unknown product asset");
    expect(scene.transformNodes.length).toBe(nodes);
    expect(scene.meshes.length).toBe(meshes);
    expect(() => productAssetCode("__proto__" as ProductAssetId)).toThrow("Unknown product asset");
  });

  it.each(["apple", "orange", "tomato"] as const)("%s has outward-facing fruit-skin normals", (id) => {
    const root = createProductAsset(scene, id, `normal-${id}`);
    const skin = root.getChildMeshes().find((mesh) => mesh.material?.name === `product-${id}-skin`)!;
    expect(skin).toBeDefined();
    const positions = skin.getVerticesData(VertexBuffer.PositionKind)!;
    const normals = skin.getVerticesData(VertexBuffer.NormalKind)!;
    let checked = 0;
    for (let i = 0; i < positions.length; i += 3) {
      const radius = Math.hypot(positions[i]!, positions[i + 2]!);
      if (radius < 0.025) continue;
      expect(positions[i]! * normals[i]! + positions[i + 2]! * normals[i + 2]!).toBeGreaterThan(0);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("keeps material caches scoped to their owning scene", () => {
    const otherScene = new Scene(engine);
    const one = createProductAsset(scene, "apple", "first-scene");
    const two = createProductAsset(otherScene, "apple", "second-scene");
    expect(one.getChildMeshes()[0]!.material).not.toBe(two.getChildMeshes()[0]!.material);
    scene.dispose();
    expect(two.getChildMeshes().every((mesh) => !mesh.isDisposed())).toBe(true);
    otherScene.dispose();
  });
});
