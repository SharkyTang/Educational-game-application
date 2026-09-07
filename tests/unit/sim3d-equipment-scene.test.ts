import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NullEngine, Scene, Vector3 } from "@babylonjs/core";
import {
  EQUIPMENT_COMMERCE_CATALOG,
  OPERATIONAL_EQUIPMENT_ASSET_IDS,
  createEquipmentAssetState,
  purchaseEquipment,
  type EquipmentAssetState,
  type EquipmentFloorPlacement,
  type OperationalEquipmentAssetId,
  type ProductId,
} from "../../src/sim3d/equipmentCommerce";
import { equipmentPlacementBounds } from "../../src/sim3d/equipmentLayout";
import { createEquipmentSceneFixtures } from "../../src/sim3d/equipmentScene";

function buy(state: EquipmentAssetState, sequence: number, assetId: OperationalEquipmentAssetId, productId: ProductId): EquipmentAssetState {
  const result = purchaseEquipment(state, 100_000, {
    purchaseId: `scene-order-${sequence}`,
    assetId,
    productId,
    purchasedDay: sequence,
  });
  expect(result.changed, result.reason).toBe(true);
  return result.state;
}

function vectorClose(actual: Vector3, expected: Vector3): void {
  expect(actual.x).toBeCloseTo(expected.x, 5);
  expect(actual.y).toBeCloseTo(expected.y, 5);
  expect(actual.z).toBeCloseTo(expected.z, 5);
}

describe("purchased equipment scene adapter", () => {
  let engine: NullEngine;
  let scene: Scene;

  beforeEach(() => {
    engine = new NullEngine({
      renderWidth: 800, renderHeight: 600, textureSize: 512,
      deterministicLockstep: false, lockstepMaxSteps: 4,
    });
    vi.spyOn(engine, "createCanvas").mockImplementation((width, height) => {
      const gradient = { addColorStop: vi.fn() };
      const values: Record<PropertyKey, unknown> = {
        createLinearGradient: () => gradient,
        createRadialGradient: () => gradient,
        measureText: () => ({ width: 100 }),
        getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
      };
      const context = new Proxy(values, { get: (target, key) => target[key] ?? (target[key] = vi.fn()) });
      return { width, height, getContext: () => context, remove: vi.fn() } as unknown as ReturnType<NullEngine["createCanvas"]>;
    });
    scene = new Scene(engine);
  });

  afterEach(() => {
    scene.dispose();
    engine.dispose();
    vi.restoreAllMocks();
  });

  it.each(OPERATIONAL_EQUIPMENT_ASSET_IDS)("creates the operational %s with every authored stock slot", (assetId) => {
    const productId = EQUIPMENT_COMMERCE_CATALOG[assetId].compatibleProducts[0]!;
    const state = buy(createEquipmentAssetState(), 1, assetId, productId);
    const placement: EquipmentFloorPlacement = { instanceId: "shop-equipment-1", x: 1.25, z: 6.5, rotation: 0 };
    const fixtures = createEquipmentSceneFixtures(scene, state, [placement]);

    expect(fixtures.targets).toHaveLength(1);
    expect(fixtures.targets[0]).toMatchObject({
      id: "shop-equipment-1-shelf",
      kind: "shelf",
      equipmentId: "shop-equipment-1",
      productId,
    });
    expect(fixtures.targets[0]!.root.name).toBe(`floor-shop-equipment-1-${assetId}`);
    expect(fixtures.colliders).toEqual([equipmentPlacementBounds(state.instances[0]!, placement)]);
    expect(fixtures.slot("shop-equipment-1", 0)).not.toBeNull();
    expect(fixtures.slot("shop-equipment-1", EQUIPMENT_COMMERCE_CATALOG[assetId].capacity - 1)).not.toBeNull();
    expect(fixtures.slot("shop-equipment-1", EQUIPMENT_COMMERCE_CATALOG[assetId].capacity)).toBeNull();
  });

  it.each([0, 1, 2, 3] as const)("applies quarter-turn %i to the model, stock yaw and service facing", (rotation) => {
    const state = buy(createEquipmentAssetState(), 1, "wall-shelf-narrow", "tea");
    const placement: EquipmentFloorPlacement = { instanceId: "shop-equipment-1", x: -1.4, z: 6.2, rotation };
    const fixtures = createEquipmentSceneFixtures(scene, state, [placement]);
    const target = fixtures.targets[0]!;
    const slot = fixtures.slot(target.equipmentId, 0)!;
    const service = fixtures.servicePoint(target.equipmentId, 0)!;

    expect(target.root.position).toMatchObject({ x: placement.x, y: 0, z: placement.z });
    expect(target.root.rotation.y).toBeCloseTo(rotation * Math.PI / 2, 6);
    expect(Math.sin(slot.yaw)).toBeCloseTo(Math.sin(rotation * Math.PI / 2), 6);
    expect(Math.cos(slot.yaw)).toBeCloseTo(Math.cos(rotation * Math.PI / 2), 6);
    expect(service.id).toBe("front");
    expect(service.role).toBe("customer");
    vectorClose(service.facing, new Vector3(Math.sin(rotation * Math.PI / 2), 0, Math.cos(rotation * Math.PI / 2)));
    vectorClose(target.position, service.position);
  });

  it("keeps two instances of the same model physically and interactively distinct", () => {
    let state = buy(createEquipmentAssetState(), 1, "wall-shelf-narrow", "cereal");
    state = buy(state, 2, "wall-shelf-narrow", "tea");
    const placements: EquipmentFloorPlacement[] = [
      { instanceId: "shop-equipment-1", x: -1.8, z: 6, rotation: 0 },
      { instanceId: "shop-equipment-2", x: 1.8, z: 6, rotation: 2 },
    ];
    const fixtures = createEquipmentSceneFixtures(scene, state, placements);

    expect(fixtures.targets.map(({ equipmentId, productId }) => ({ equipmentId, productId }))).toEqual([
      { equipmentId: "shop-equipment-1", productId: "cereal" },
      { equipmentId: "shop-equipment-2", productId: "tea" },
    ]);
    expect(fixtures.targets[0]!.root).not.toBe(fixtures.targets[1]!.root);
    expect(fixtures.slot("shop-equipment-1", 0)!.position.equalsWithEpsilon(fixtures.slot("shop-equipment-2", 0)!.position)).toBe(false);
    expect(fixtures.colliders).toEqual(placements.map((placement, index) => equipmentPlacementBounds(state.instances[index]!, placement)));
  });

  it("selects front and back customer service faces from the actual gondola slot side", () => {
    const state = buy(createEquipmentAssetState(), 1, "gondola-low", "biscuits");
    const fixtures = createEquipmentSceneFixtures(scene, state, [
      { instanceId: "shop-equipment-1", x: .4, z: 6.4, rotation: 3 },
    ]);

    expect(fixtures.servicePoint("shop-equipment-1", 0)?.id).toBe("front");
    expect(fixtures.servicePoint("shop-equipment-1", 15)?.id).toBe("front");
    expect(fixtures.servicePoint("shop-equipment-1", 16)?.id).toBe("back");
    expect(fixtures.servicePoint("shop-equipment-1", 31)?.id).toBe("back");
    expect(fixtures.servicePoint("shop-equipment-1", 32)).toBeNull();
    expect(fixtures.servicePoint("unknown", 0)).toBeNull();
  });

  it("refreshes public arrays in place while replacing moved model records", () => {
    const state = buy(createEquipmentAssetState(), 1, "bakery-glass", "bread");
    const fixtures = createEquipmentSceneFixtures(scene, state, [
      { instanceId: "shop-equipment-1", x: -1.5, z: 6, rotation: 0 },
    ]);
    const targets = fixtures.targets;
    const colliders = fixtures.colliders;
    const oldRoot = targets[0]!.root;
    const moved: EquipmentFloorPlacement = { instanceId: "shop-equipment-1", x: 1.6, z: 7.2, rotation: 1 };

    fixtures.apply(state, [moved]);

    expect(fixtures.targets).toBe(targets);
    expect(fixtures.colliders).toBe(colliders);
    expect(oldRoot.isDisposed()).toBe(true);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.root).not.toBe(oldRoot);
    expect(targets[0]!.root.position).toMatchObject({ x: moved.x, y: 0, z: moved.z });
    expect(colliders).toEqual([equipmentPlacementBounds(state.instances[0]!, moved)]);
  });

  it("disposes instance nodes without disposing materials shared by their meshes", () => {
    const state = buy(createEquipmentAssetState(), 1, "produce-tiered", "apple");
    const fixtures = createEquipmentSceneFixtures(scene, state, [
      { instanceId: "shop-equipment-1", x: 0, z: 6, rotation: 0 },
    ]);
    const instanceRoot = fixtures.targets[0]!.root;
    const material = instanceRoot.getChildMeshes().find((mesh) => mesh.material)?.material;
    expect(material).toBeTruthy();

    fixtures.dispose();

    expect(instanceRoot.isDisposed()).toBe(true);
    expect(material!.getScene()).toBe(scene);
    expect(scene.materials).toContain(material);
    expect(fixtures.targets).toEqual([]);
    expect(fixtures.colliders).toEqual([]);
  });
});
