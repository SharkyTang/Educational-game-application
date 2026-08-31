import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NullEngine, PBRMaterial, Ray, Scene, TransformNode, Vector3, VertexBuffer } from "@babylonjs/core";
import {
  EQUIPMENT_ASSET_IDS, EQUIPMENT_ASSET_LIST, EQUIPMENT_ASSETS, EQUIPMENT_CATEGORIES, EQUIPMENT_LIBRARY_VERSION,
  createEquipmentAsset, equipmentAssetCode, equipmentLibraryManifest, equipmentServiceWorldPosition,
  equipmentSlotFits, equipmentSlotWorldPosition, filterEquipmentAssets, getEquipmentSlots, isEquipmentAssetId,
  type EquipmentAssetId, type EquipmentPoint, type EquipmentSlot,
} from "../../src/sim3d/equipment-library";
import { PRODUCT_ASSETS, isProductAssetId } from "../../src/sim3d/product-library/catalog";
import { createProductAsset } from "../../src/sim3d/product-library";

const CAPACITIES = [2, 4, 24, 48, 72, 12, 24, 32, 48, 12, 12, 12];
function envelope(slot: EquipmentSlot, inset = 0): { centre: Vector3; half: Vector3 } {
  return { centre: new Vector3(slot.position[0], slot.position[1] + slot.maxSize[1] / 2, slot.position[2]),
    half: new Vector3(slot.maxSize[0] / 2 - inset, slot.maxSize[1] / 2 - inset, slot.maxSize[2] / 2 - inset) };
}

describe("independent equipment catalogue", () => {
  it("defines twelve equipment models in three categories without extending the product economy", () => {
    expect(EQUIPMENT_ASSET_IDS).toHaveLength(12);
    expect(new Set(EQUIPMENT_ASSET_IDS).size).toBe(12);
    expect(EQUIPMENT_CATEGORIES).toHaveLength(3);
    expect(EQUIPMENT_ASSET_LIST.map((asset) => asset.capacity)).toEqual(CAPACITIES);
    expect(EQUIPMENT_ASSET_LIST.filter((asset) => asset.category === "checkout")).toHaveLength(2);
    expect(EQUIPMENT_ASSET_LIST.filter((asset) => asset.category === "refrigeration")).toHaveLength(3);
    expect(EQUIPMENT_ASSET_LIST.filter((asset) => asset.category === "display")).toHaveLength(7);
    for (const asset of EQUIPMENT_ASSET_LIST) {
      expect(asset.gameplay).toBe("library-only");
      expect(asset.modelReady).toBe(true);
      expect(isProductAssetId(asset.id)).toBe(false);
      expect(asset).not.toHaveProperty("pricePence");
      expect(asset).not.toHaveProperty("inventoryCapacity");
      expect(asset.size.every((value) => Number.isFinite(value) && value > 0)).toBe(true);
      expect(asset.nameZh.length).toBeGreaterThan(4);
      expect(asset.nameEn.length).toBeGreaterThan(5);
      expect(asset.description.length).toBeGreaterThan(10);
      expect(asset.capacityLabel).toBe(asset.category === "checkout" ? "台面暂存位" : "商品陈列位");
      expect(asset.modelUrl).toBe(`/assets/sim3d/equipment/${asset.id}.glb`);
      expect(asset.thumbnailUrl).toBe(`/assets/sim3d/equipment/${asset.id}.png`);
    }
  });

  it("filters Chinese, English, exact IDs, category and capacity together", () => {
    expect(filterEquipmentAssets()).toHaveLength(12);
    expect(filterEquipmentAssets("  BAGGING  ").map((asset) => asset.id)).toEqual(["self-checkout-bagging"]);
    expect(filterEquipmentAssets("冷柜", "refrigeration")).toHaveLength(2);
    expect(filterEquipmentAssets("48").map((asset) => asset.id)).toEqual(["chest-chiller-wide", "gondola-tall"]);
    expect(filterEquipmentAssets("", "display")).toHaveLength(7);
    expect(filterEquipmentAssets("no-such-equipment")).toEqual([]);
    for (const invalid of ["__proto__", "toString", "milk", "", null, undefined, 12]) expect(isEquipmentAssetId(invalid)).toBe(false);
    expect(isEquipmentAssetId("island-chiller")).toBe(true);
  });

  it.each(EQUIPMENT_ASSET_IDS)("%s declares distinct finite display envelopes, fit hints and service points", (id) => {
    const asset = EQUIPMENT_ASSETS[id];
    expect(new Set(asset.placementSlots.map((slot) => slot.id)).size).toBe(asset.capacity);
    for (const slot of asset.placementSlots) {
      expect(slot.id).toMatch(/^slot-\d{2}$/);
      expect(slot.position.every(Number.isFinite)).toBe(true);
      expect(slot.position[1]).toBeGreaterThan(0);
      expect(slot.maxSize.every((value) => Number.isFinite(value) && value > 0)).toBe(true);
      expect([0, Math.PI]).toContain(slot.rotationY);
      expect(["shelf", "basket", "hook", "bagging"]).toContain(slot.mount);
      expect(Math.abs(slot.position[0]) + slot.maxSize[0] / 2).toBeLessThanOrEqual(asset.size[0] / 2);
      expect(Math.abs(slot.position[2]) + slot.maxSize[2] / 2).toBeLessThanOrEqual(asset.size[2] / 2);
      expect(slot.position[1] + slot.maxSize[1]).toBeLessThan(asset.size[1]);
    }
    for (let one = 0; one < asset.capacity; one++) for (let two = one + 1; two < asset.capacity; two++) {
      const a = envelope(asset.placementSlots[one]!); const b = envelope(asset.placementSlots[two]!);
      const gap = a.centre.subtract(b.centre); const sum = a.half.add(b.half);
      expect(Math.abs(gap.x) >= sum.x || Math.abs(gap.y) >= sum.y || Math.abs(gap.z) >= sum.z, `${id}: overlapping slots ${one + 1}/${two + 1}`).toBe(true);
    }
    for (const productId of asset.recommendedProducts) {
      expect(isProductAssetId(productId)).toBe(true);
      if (isProductAssetId(productId)) expect(equipmentSlotFits(asset.placementSlots[0]!, PRODUCT_ASSETS[productId].size), `${id}: ${productId} nominal fit`).toBe(true);
    }
    expect(asset.suggestedFrontClearance).toBeGreaterThanOrEqual(0.9);
    expect(asset.servicePoints[0]).toMatchObject({ id: "front", role: "customer", facing: [0, 0, 1] });
    expect(asset.servicePoints[0]!.position[2]).toBeLessThan(-asset.size[2] / 2);
    if (id.startsWith("gondola") || id === "island-chiller") {
      expect(asset.servicePoints[1]).toMatchObject({ id: "back", role: "customer", facing: [0, 0, -1] });
      expect(asset.servicePoints[1]!.position[2]).toBeGreaterThan(asset.size[2] / 2);
    }
  });

  it("exports clear capacity boundaries and keeps the equipment route outside save-owning game apps", () => {
    const manifest = JSON.parse(JSON.stringify(equipmentLibraryManifest()));
    expect(manifest.version).toBe(EQUIPMENT_LIBRARY_VERSION);
    expect(manifest.equipment).toHaveLength(12);
    expect(manifest.units).toBe("metres");
    expect(manifest.origin).toBe("bottom-centre");
    expect(manifest.front).toBe("-Z");
    expect(manifest.capacityNote).toContain("not litres");
    expect(manifest.integrationNote).toContain("No equipment purchase");
    const source = readFileSync("src/main.ts", "utf8");
    expect(source.indexOf('query.get("assets") === "equipment"')).toBeGreaterThan(0);
    expect(source.indexOf('query.get("assets") === "equipment"')).toBeLessThan(source.indexOf('query.get("legacy")'));
    expect(equipmentAssetCode("bakery-glass")).toContain('createEquipmentAsset(scene, "bakery-glass"');
    expect(equipmentAssetCode("bakery-glass")).toContain('equipmentSlotWorldPosition(equipment, "slot-01")');
    expect(() => equipmentAssetCode("__proto__" as EquipmentAssetId)).toThrow("Unknown equipment asset");
  });

  it("checks finite positive dimensions in the slot's local orientation without granting stock permissions", () => {
    const slot = EQUIPMENT_ASSETS["bakery-glass"].placementSlots[0]!;
    expect(equipmentSlotFits(slot, slot.maxSize)).toBe(true);
    expect(equipmentSlotFits(slot, [0.349, 0.146, 0.154])).toBe(true);
    for (const size of [[0.4, 0.1, 0.1], [0.1, 0.4, 0.1], [0.1, 0.1, 0.6], [0, 0.1, 0.1], [-0.1, 0.1, 0.1], [NaN, 0.1, 0.1], [0.1, Infinity, 0.1]]) {
      expect(equipmentSlotFits(slot, size as unknown as EquipmentPoint)).toBe(false);
    }
  });
});

/** Exact triangle/box SAT. The inset excludes legitimate shelf contact surfaces. */
function triangleIntersectsEnvelope(points: readonly Vector3[], centre: Vector3, half: Vector3): boolean {
  const p = points.map((point) => point.subtract(centre));
  const edges = [p[1]!.subtract(p[0]!), p[2]!.subtract(p[1]!), p[0]!.subtract(p[2]!)];
  const axes = [Vector3.Right(), Vector3.Up(), Vector3.Forward(), Vector3.Cross(edges[0]!, edges[1]!),
    ...edges.flatMap((edge) => [Vector3.Cross(edge, Vector3.Right()), Vector3.Cross(edge, Vector3.Up()), Vector3.Cross(edge, Vector3.Forward())])];
  for (const axis of axes) {
    if (axis.lengthSquared() < 1e-16) continue;
    const projected = p.map((point) => Vector3.Dot(point, axis));
    const radius = half.x * Math.abs(axis.x) + half.y * Math.abs(axis.y) + half.z * Math.abs(axis.z);
    if (Math.min(...projected) > radius || Math.max(...projected) < -radius) return false;
  }
  return true;
}

describe("equipment geometry and reusable placement contracts", () => {
  let engine: NullEngine;
  let scene: Scene;
  beforeEach(() => {
    engine = new NullEngine({ renderWidth: 512, renderHeight: 512, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 4 });
    vi.spyOn(engine, "createCanvas").mockImplementation((width, height) => {
      const gradient = { addColorStop: vi.fn() };
      const values: Record<PropertyKey, unknown> = { createLinearGradient: () => gradient, createRadialGradient: () => gradient,
        measureText: () => ({ width: 100 }), getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
        fillStyle: "", strokeStyle: "", lineWidth: 1, textAlign: "left", font: "12px Arial" };
      const context = new Proxy(values, { get: (target, property) => property in target ? target[property] : vi.fn() });
      return { width, height, getContext: () => context, remove: vi.fn() } as unknown as ReturnType<NullEngine["createCanvas"]>;
    });
    scene = new Scene(engine);
  });
  afterEach(() => { scene?.dispose(); engine?.dispose(); vi.restoreAllMocks() });

  it.each(EQUIPMENT_ASSET_IDS)("%s builds finite geometry at its measured bottom-centred metre scale", (id) => {
    const root = createEquipmentAsset(scene, id, `test-${id}`);
    expect(root.metadata).toMatchObject({ equipmentId: id, assetType: "equipment", libraryVersion: EQUIPMENT_LIBRARY_VERSION,
      baseAnchored: true, front: "-Z", units: "metres", gameplay: "library-only", capacity: EQUIPMENT_ASSETS[id].capacity });
    expect(root.position.equals(Vector3.Zero())).toBe(true);
    expect(root.scaling.equals(Vector3.One())).toBe(true);
    const meshes = root.getChildMeshes();
    expect(meshes.length).toBeGreaterThan(2);
    expect(meshes.length).toBeLessThanOrEqual(32);
    let vertices = 0;
    for (const mesh of meshes) {
      expect(mesh.isPickable).toBe(true);
      expect(mesh.material).toBeInstanceOf(PBRMaterial);
      expect(mesh.getTotalVertices()).toBeGreaterThan(0);
      vertices += mesh.getTotalVertices();
      expect(mesh.getVerticesData(VertexBuffer.PositionKind)?.every(Number.isFinite), `${id}: positions`).toBe(true);
      expect(mesh.getVerticesData(VertexBuffer.NormalKind)?.every(Number.isFinite), `${id}: normals`).toBe(true);
      expect(mesh.getIndices()!.length % 3).toBe(0);
    }
    expect(vertices).toBeLessThan(180_000);
    const bounds = root.getHierarchyBoundingVectors(true);
    const measured = bounds.max.subtract(bounds.min).asArray();
    const nominal = EQUIPMENT_ASSETS[id].size;
    for (let axis = 0; axis < 3; axis++) expect(measured[axis]!).toBeCloseTo(nominal[axis]!, 3);
    expect(bounds.min.y).toBeCloseTo(0, 6);
    expect(bounds.min.x + bounds.max.x).toBeCloseTo(0, 6);
    expect(bounds.min.z + bounds.max.z).toBeCloseTo(0, 6);
    expect(root.metadata.dimensions.width).toBeCloseTo(measured[0]!, 5);
    expect(root.metadata.dimensions.height).toBeCloseTo(measured[1]!, 5);
    expect(root.metadata.dimensions.depth).toBeCloseTo(measured[2]!, 5);
    expect(root.metadata.footprint).toEqual({ width: root.metadata.dimensions.width, depth: root.metadata.dimensions.depth });
    expect(getEquipmentSlots(root)).toHaveLength(EQUIPMENT_ASSETS[id].capacity);
    root.dispose(false, false);
    expect(scene.meshes).toHaveLength(0);
  });

  it.each(EQUIPMENT_ASSET_IDS)("%s leaves its standard display envelopes clear and supported", (id) => {
    const root = createEquipmentAsset(scene, id);
    const meshes = root.getChildMeshes();
    const triangles = meshes.flatMap((mesh) => {
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!; const indices = mesh.getIndices()!;
      const matrix = mesh.computeWorldMatrix(true);
      const vertices = Array.from({ length: positions.length / 3 }, (_, index) => Vector3.TransformCoordinates(Vector3.FromArray(positions, index * 3), matrix));
      return Array.from({ length: indices.length / 3 }, (_, index) => {
        const points = [vertices[indices[index * 3]!]!, vertices[indices[index * 3 + 1]!]!, vertices[indices[index * 3 + 2]!]!];
        return { mesh: mesh.name, points, min: Vector3.Minimize(Vector3.Minimize(points[0]!, points[1]!), points[2]!), max: Vector3.Maximize(Vector3.Maximize(points[0]!, points[1]!), points[2]!) };
      });
    });
    for (const slot of getEquipmentSlots(root)) {
      const { centre, half } = envelope(slot, 0.002); const min = centre.subtract(half); const max = centre.add(half);
      const intrusion = triangles.find((triangle) => triangle.min.x < max.x && triangle.max.x > min.x && triangle.min.y < max.y && triangle.max.y > min.y && triangle.min.z < max.z && triangle.max.z > min.z
        && triangleIntersectsEnvelope(triangle.points, centre, half));
      expect(intrusion?.mesh, `${id}/${slot.id}: structure inside the usable slot`).toBeUndefined();
      if (slot.mount !== "hook") {
        const ray = new Ray(new Vector3(slot.position[0], slot.position[1] + 0.002, slot.position[2]), Vector3.Down(), 0.022);
        const support = scene.pickWithRay(ray, (mesh) => mesh.isDescendantOf(root));
        expect(support?.hit, `${id}/${slot.id}: missing support below the slot centre`).toBe(true);
        expect(support!.pickedPoint!.y).toBeLessThanOrEqual(slot.position[1] + 0.001);
        expect(support!.pickedPoint!.y).toBeGreaterThan(slot.position[1] - 0.020);
      }
    }
  });

  it("isolates instance metadata and shares only per-scene materials", () => {
    for (const id of EQUIPMENT_ASSET_IDS) {
      const one = createEquipmentAsset(scene, id, `one-${id}`); const count = scene.materials.length;
      const two = createEquipmentAsset(scene, id, `two-${id}`);
      expect(scene.materials.length).toBe(count);
      expect(one.metadata).not.toBe(two.metadata);
      expect(one.metadata.placementSlots).not.toBe(two.metadata.placementSlots);
      const copy = getEquipmentSlots(one); (copy[0]!.position as [number, number, number])[0] = 999;
      expect(getEquipmentSlots(one)[0]!.position[0]).not.toBe(999);
      one.metadata.placementSlots[0].position[0] = 888;
      expect(getEquipmentSlots(two)[0]!.position[0]).not.toBe(888);
      expect(EQUIPMENT_ASSETS[id].placementSlots[0]!.position[0]).not.toBe(888);
      one.dispose(false, false);
      expect(two.getChildMeshes().every((mesh) => !mesh.isDisposed() && mesh.material !== null)).toBe(true);
      two.dispose(false, false);
    }
  });

  it("keeps the bakery wooden cap above its cream fascia without coplanar top surfaces", () => {
    const root = createEquipmentAsset(scene, "bakery-glass");
    const ray = new Ray(new Vector3(0, 1.9, 0), Vector3.Down(), 0.5);
    const wooden = scene.pickWithRay(ray, (mesh) => mesh.isDescendantOf(root) && mesh.material?.name === "product-equipment-birch");
    const cream = scene.pickWithRay(ray, (mesh) => mesh.isDescendantOf(root) && mesh.material?.name === "product-equipment-cream");
    expect(wooden?.hit).toBe(true); expect(cream?.hit).toBe(true);
    expect(wooden!.pickedPoint!.y - cream!.pickedPoint!.y).toBeCloseTo(0.019, 5);
  });

  it.each(EQUIPMENT_ASSET_IDS)("%s fits the actual measured meshes of its suggested products", (id) => {
    const root = createEquipmentAsset(scene, id); const slot = getEquipmentSlots(root)[0]!;
    for (const productId of EQUIPMENT_ASSETS[id].recommendedProducts) {
      if (!isProductAssetId(productId)) throw new Error(`Unknown suggested product ${productId}`);
      const product = createProductAsset(scene, productId);
      const { width, height, depth } = product.metadata.dimensions;
      expect(equipmentSlotFits(slot, [width, height, depth]), `${id}: actual ${productId} ${width} x ${height} x ${depth}`).toBe(true);
      product.dispose(false, false);
    }
  });

  it("transforms slots and service points with the equipment and a parent using Babylon positive yaw", () => {
    const root = createEquipmentAsset(scene, "gondola-low"); const slot = getEquipmentSlots(root)[0]!;
    root.position.set(3, 0.2, -4); root.rotation.y = Math.PI / 2;
    const actual = equipmentSlotWorldPosition(root, slot.id);
    expect(actual.x).toBeCloseTo(3 + slot.position[2], 5);
    expect(actual.y).toBeCloseTo(0.2 + slot.position[1], 5);
    expect(actual.z).toBeCloseTo(-4 - slot.position[0], 5);
    const parent = new TransformNode("layout-parent", scene); parent.position.set(-2, 1, 5); parent.rotation.y = -Math.PI / 2;
    root.parent = parent; root.scaling.set(1.25, 1.25, 1.25);
    const expected = Vector3.TransformCoordinates(Vector3.FromArray(slot.position), root.computeWorldMatrix(true));
    expect(Vector3.Distance(equipmentSlotWorldPosition(root, slot.id), expected)).toBeLessThan(1e-6);
    const service = root.metadata.servicePoints[0];
    const serviceExpected = Vector3.TransformCoordinates(Vector3.FromArray(service.position), root.computeWorldMatrix(true));
    expect(Vector3.Distance(equipmentServiceWorldPosition(root, service.id), serviceExpected)).toBeLessThan(1e-6);
  });

  it("rejects unknown IDs, wrong roots, disposed roots and disposed scenes without allocating a fallback", () => {
    const count = scene.transformNodes.length;
    expect(() => createEquipmentAsset(scene, "milk" as EquipmentAssetId)).toThrow("Unknown equipment asset");
    expect(scene.transformNodes.length).toBe(count);
    const wrong = new TransformNode("not-equipment", scene);
    expect(() => getEquipmentSlots(wrong)).toThrow("live equipment asset root");
    const root = createEquipmentAsset(scene, "self-checkout-compact");
    expect(() => equipmentSlotWorldPosition(root, "slot-99")).toThrow("Unknown equipment slot");
    expect(() => equipmentServiceWorldPosition(root, "wrong")).toThrow("Unknown equipment service point");
    root.dispose(false, false);
    expect(() => getEquipmentSlots(root)).toThrow("live equipment asset root");
    scene.dispose();
    expect(() => createEquipmentAsset(scene, "self-checkout-compact")).toThrow("disposed scene");
  });

  it("does not share materials across scenes", () => {
    const other = new Scene(engine);
    const one = createEquipmentAsset(scene, "self-checkout-compact"); const two = createEquipmentAsset(other, "self-checkout-compact");
    expect(one.getChildMeshes()[0]!.material).not.toBe(two.getChildMeshes()[0]!.material);
    scene.dispose();
    expect(two.getChildMeshes().every((mesh) => !mesh.isDisposed())).toBe(true);
    other.dispose();
  });
});
